use cocoa::appkit::{NSView, NSWindow, NSWindowButton};
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSString};
use objc::runtime::{Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use super::{send_switch, FrontmostApp};

/// 相对系统默认位置的偏移：向右 2pt、向下 2pt。
/// AppKit 里按钮 superview 不是 flipped 的（y 向上），所以"向下"= y 减小。
const TRAFFIC_LIGHT_DX: f64 = 3.0;
const TRAFFIC_LIGHT_DY: f64 = -2.0;

/// 缓存系统首次给出的三颗按钮默认原点。i64::MIN 表示"尚未采样"。
/// 每次 titlebar 触发 layout，系统会把按钮位置重置到这三个默认值，
/// 我们在观察者里把它们再挪回 default + 偏移。
static DEFAULT_ORIGINS_X: [std::sync::atomic::AtomicI64; 3] = [
    std::sync::atomic::AtomicI64::new(i64::MIN),
    std::sync::atomic::AtomicI64::new(i64::MIN),
    std::sync::atomic::AtomicI64::new(i64::MIN),
];
static DEFAULT_ORIGINS_Y: [std::sync::atomic::AtomicI64; 3] = [
    std::sync::atomic::AtomicI64::new(i64::MIN),
    std::sync::atomic::AtomicI64::new(i64::MIN),
    std::sync::atomic::AtomicI64::new(i64::MIN),
];

static PINNED_WINDOW: AtomicUsize = AtomicUsize::new(0);

fn encode_pt(v: f64) -> i64 {
    // 用 f64 位模式塞进 i64，避开浮点原子和额外锁
    v.to_bits() as i64
}

fn decode_pt(v: i64) -> f64 {
    f64::from_bits(v as u64)
}

unsafe fn read_default_origins(ns_window: id) -> Option<[NSPoint; 3]> {
    let buttons = [
        NSWindowButton::NSWindowCloseButton,
        NSWindowButton::NSWindowMiniaturizeButton,
        NSWindowButton::NSWindowZoomButton,
    ];
    let mut out = [NSPoint::new(0.0, 0.0); 3];
    for (i, btn) in buttons.iter().enumerate() {
        let b = ns_window.standardWindowButton_(*btn);
        if b == nil {
            return None;
        }
        let frame: NSRect = msg_send![b, frame];
        out[i] = frame.origin;
    }
    Some(out)
}

/// 把三颗按钮挪到 系统默认位置 + (DX, DY)。
/// 首次调用时把系统默认位置采样进 static 缓存；后续调用直接用缓存值，
/// 避免读到我们已经挪过的位置再叠加偏移。
pub unsafe fn reposition_traffic_lights(ns_window: id) {
    if ns_window == nil {
        return;
    }

    // 首次采样：如果缓存为空，先读一次当前（= 系统默认）位置
    if DEFAULT_ORIGINS_X[0].load(Ordering::SeqCst) == i64::MIN {
        if let Some(defaults) = read_default_origins(ns_window) {
            for i in 0..3 {
                DEFAULT_ORIGINS_X[i].store(encode_pt(defaults[i].x), Ordering::SeqCst);
                DEFAULT_ORIGINS_Y[i].store(encode_pt(defaults[i].y), Ordering::SeqCst);
            }
        } else {
            return;
        }
    }

    let buttons = [
        NSWindowButton::NSWindowCloseButton,
        NSWindowButton::NSWindowMiniaturizeButton,
        NSWindowButton::NSWindowZoomButton,
    ];
    for (i, btn) in buttons.iter().enumerate() {
        let b = ns_window.standardWindowButton_(*btn);
        if b == nil {
            continue;
        }
        let dx = decode_pt(DEFAULT_ORIGINS_X[i].load(Ordering::SeqCst));
        let dy = decode_pt(DEFAULT_ORIGINS_Y[i].load(Ordering::SeqCst));
        b.setFrameOrigin(NSPoint::new(dx + TRAFFIC_LIGHT_DX, dy + TRAFFIC_LIGHT_DY));
    }
}

extern "C" fn traffic_light_repin_callback(_this: &Object, _cmd: Sel, _notification: id) {
    let w = PINNED_WINDOW.load(Ordering::SeqCst);
    if w == 0 {
        return;
    }
    unsafe {
        reposition_traffic_lights(w as id);
        // 系统在通知后可能还会跑一次 layout 把位置拨回默认，performSelector 兜底
        let sel_name = sel!(snoopRepinNow:);
        let _: () = msg_send![_this, performSelector: sel_name withObject: nil afterDelay: 0.0f64];
    }
}

extern "C" fn traffic_light_repin_now(_this: &Object, _cmd: Sel, _obj: id) {
    let w = PINNED_WINDOW.load(Ordering::SeqCst);
    if w == 0 {
        return;
    }
    unsafe {
        reposition_traffic_lights(w as id);
    }
}

/// 配置 titlebar 并把红绿灯挪到 系统默认 + (右2, 下2)：
/// - 关掉 titlebar 与内容之间的分隔线（macOS 11+）
/// - 首次采样系统默认按钮位置并缓存
/// - 注册 NSWindow 通知观察者，layout pass 后自动重放偏移
///
/// 相对偏移的好处：基准是系统给的位置，跨 Mac / 跨 macOS 版本一致，
/// 不会因为 titlebar 高度差异而漂移。
///
/// 必须在主线程调用（Tauri setup 是主线程）。
pub unsafe fn configure_titlebar(ns_window: id) {
    if ns_window == nil {
        return;
    }

    // NSTitlebarSeparatorStyleNone = 1，去掉 titlebar 与内容的那根分割线
    let sel_set_sep = sel!(setTitlebarSeparatorStyle:);
    let responds_sep: bool = msg_send![ns_window, respondsToSelector: sel_set_sep];
    if responds_sep {
        let sep_none: i64 = 1;
        let _: () = msg_send![ns_window, setTitlebarSeparatorStyle: sep_none];
    }

    PINNED_WINDOW.store(ns_window as usize, Ordering::SeqCst);
    reposition_traffic_lights(ns_window);

    let observer_class = {
        let superclass = class!(NSObject);
        match objc::declare::ClassDecl::new("SnoopTrafficLightPinner", superclass) {
            Some(mut decl) => {
                decl.add_method(
                    sel!(windowStateChanged:),
                    traffic_light_repin_callback as extern "C" fn(&Object, Sel, id),
                );
                decl.add_method(
                    sel!(snoopRepinNow:),
                    traffic_light_repin_now as extern "C" fn(&Object, Sel, id),
                );
                decl.register()
            }
            None => class!(SnoopTrafficLightPinner),
        }
    };

    let observer: id = msg_send![observer_class, alloc];
    let observer: id = msg_send![observer, init];

    let notification_center: id = msg_send![class!(NSNotificationCenter), defaultCenter];

    let notif_names = [
        "NSWindowDidResizeNotification",
        "NSWindowDidBecomeMainNotification",
        "NSWindowDidBecomeKeyNotification",
        "NSWindowDidEnterFullScreenNotification",
        "NSWindowDidExitFullScreenNotification",
        "NSWindowDidMiniaturizeNotification",
        "NSWindowDidDeminiaturizeNotification",
        "NSWindowDidChangeScreenNotification",
        "NSWindowDidChangeBackingPropertiesNotification",
    ];
    for name in notif_names {
        let name_ns: id = NSString::alloc(nil).init_str(name);
        let _: () = msg_send![
            notification_center,
            addObserver: observer
            selector: sel!(windowStateChanged:)
            name: name_ns
            object: ns_window
        ];
    }

    println!(
        "✅ 红绿灯偏移已应用（默认 +({}, {})）",
        TRAFFIC_LIGHT_DX, TRAFFIC_LIGHT_DY
    );
}

pub fn get_frontmost_app() -> FrontmostApp {
    // 关键：NSWorkspace / NSString / UTF8String 返回的都是 autoreleased 对象。
    // 在非主线程调用 Cocoa API 时，必须自己开 NSAutoreleasePool，否则这些
    // 临时对象没有 pool 兜底，会在不可预期的时刻被释放，随后其它线程
    // (rdev 内部读键盘布局也会走 Cocoa) 踩到已释放内存 → 堆损坏 → 闪退。
    unsafe {
        let pool: id = NSAutoreleasePool::new(nil);

        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let frontmost_app: id = msg_send![workspace, frontmostApplication];

            if frontmost_app == nil {
                return FrontmostApp::unknown();
            }

            let pid: i32 = msg_send![frontmost_app, processIdentifier];
            if pid > 0 && pid as u32 == std::process::id() {
                #[cfg(debug_assertions)]
                return FrontmostApp {
                    name: "Snoop (Dev)".to_string(),
                    bundle_id: "org.feedra.snoop.dev".to_string(),
                };
                #[cfg(not(debug_assertions))]
                return FrontmostApp {
                    name: "Snoop".to_string(),
                    bundle_id: "org.feedra.snoop".to_string(),
                };
            }

            let app_name: id = msg_send![frontmost_app, localizedName];
            let bundle_id: id = msg_send![frontmost_app, bundleIdentifier];

            let name = nsstring_to_string(app_name).unwrap_or_else(|| "Unknown".to_string());
            let bundle = nsstring_to_string(bundle_id)
                .unwrap_or_else(|| "unknown.bundle.id".to_string());

            FrontmostApp {
                name,
                bundle_id: bundle,
            }
        }));

        let _: () = msg_send![pool, drain];

        result.unwrap_or_else(|_| FrontmostApp::unknown())
    }
}

unsafe fn nsstring_to_string(ns: id) -> Option<String> {
    if ns == nil {
        return None;
    }
    let ptr: *const i8 = msg_send![ns, UTF8String];
    if ptr.is_null() {
        return None;
    }
    // CStr → String 会立刻做一次拷贝，脱离 autorelease 内存
    Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned())
}

pub fn spawn_switch_observer() {
    thread::spawn(|| {
        start_nsworkspace_observer();
    });
}

extern "C" fn app_activated_callback(_self: &Object, _cmd: Sel, _notification: id) {
    // 回调也在专用线程分发，get_frontmost_app 内部已经自带 autoreleasepool
    let app = get_frontmost_app();
    send_switch(app);
}

fn start_nsworkspace_observer() {
    unsafe {
        let pool: id = NSAutoreleasePool::new(nil);

        let superclass = class!(NSObject);
        let mut decl = match objc::declare::ClassDecl::new("SnoopAppObserver", superclass) {
            Some(d) => d,
            None => {
                eprintln!("⚠️ NSWorkspace 观察者类已存在，跳过注册（可能是热重载）");
                let _: () = msg_send![pool, drain];
                return;
            }
        };

        decl.add_method(
            sel!(appActivated:),
            app_activated_callback as extern "C" fn(&Object, Sel, id),
        );
        let observer_class = decl.register();
        // observer 需要长期存活，用 alloc/init 拿到 retain=1 的实例
        let observer: id = msg_send![observer_class, alloc];
        let observer: id = msg_send![observer, init];

        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let notification_center: id = msg_send![workspace, notificationCenter];

        // NSString stringWithUTF8String: 返回 autoreleased，在下面 addObserver
        // 里 name 会被 retain，pool drain 后仍然有效
        let name_ns: id = NSString::alloc(nil).init_str(
            "NSWorkspaceDidActivateApplicationNotification",
        );

        let _: () = msg_send![
            notification_center,
            addObserver: observer
            selector: sel!(appActivated:)
            name: name_ns
            object: nil
        ];

        println!("✅ NSWorkspace 前台切换通知观察者已注册");

        // 给 run loop 挂一个 Mach 端口作为输入源，否则没有任何输入源时
        // runUntilDate: 会立即返回，导致下面的 loop 空转吃满一个 CPU 核心
        let port: id = msg_send![class!(NSMachPort), port];
        let default_mode: id = NSString::alloc(nil).init_str("kCFRunLoopDefaultMode");
        let keep_alive_run_loop: id = msg_send![class!(NSRunLoop), currentRunLoop];
        let _: () = msg_send![keep_alive_run_loop, addPort: port forMode: default_mode];

        let _: () = msg_send![pool, drain];

        // 事件循环本身长跑，每次 runUntilDate 之前开新的 pool 释放中间对象
        loop {
            let iter_pool: id = NSAutoreleasePool::new(nil);
            let run_loop: id = msg_send![class!(NSRunLoop), currentRunLoop];
            let distant_future: id = msg_send![class!(NSDate), distantFuture];
            let _: () = msg_send![run_loop, runUntilDate: distant_future];
            let _: () = msg_send![iter_pool, drain];
        }
    }
}
