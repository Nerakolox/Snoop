use super::{send_switch, FrontmostApp};

use cocoa::appkit::{NSView, NSWindow, NSWindowButton};
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSString};
use objc::runtime::{Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

/// 红绿灯目标坐标（AppKit 坐标：以 titlebar superview 为参考，y 越大越靠上）。
/// close@x=16、min@x=36、zoom@x=56，三颗共用同一 y。
const TRAFFIC_LIGHT_X: [f64; 3] = [16.0, 36.0, 56.0];
const TRAFFIC_LIGHT_Y: f64 = 5.0;

/// 保存主窗口指针（usize 化以便放进 static；只在主线程使用）。
/// 系统在 fullscreen/resize/main 等状态切换后会把红绿灯位置重置为默认，
/// 观察者回调里读它拿到 window，再调一次 reposition。
static PINNED_WINDOW: AtomicUsize = AtomicUsize::new(0);

pub unsafe fn reposition_traffic_lights(ns_window: id) {
    if ns_window == nil {
        return;
    }
    let buttons = [
        NSWindowButton::NSWindowCloseButton,
        NSWindowButton::NSWindowMiniaturizeButton,
        NSWindowButton::NSWindowZoomButton,
    ];
    for (i, btn) in buttons.iter().enumerate() {
        let b = ns_window.standardWindowButton_(*btn);
        if b != nil {
            b.setFrameOrigin(NSPoint::new(TRAFFIC_LIGHT_X[i], TRAFFIC_LIGHT_Y));
        }
    }
}

extern "C" fn traffic_light_repin_callback(_this: &Object, _cmd: Sel, _notification: id) {
    let w = PINNED_WINDOW.load(Ordering::SeqCst);
    if w == 0 {
        return;
    }
    unsafe {
        // 通知在 layout 之前触发的场景下，先立刻放一次；再在下一轮 runloop 兜底一次，
        // 覆盖系统自己在通知后又做一次 layout 把按钮拨回默认位置的情况。
        reposition_traffic_lights(w as id);

        // performSelector:withObject:afterDelay: 让系统当前 layout pass 结束后再跑一次
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

/// 把红绿灯位置钉死：立刻摆一次，并注册 NSWindow 通知观察者，之后每次
/// 主态切换/尺寸变化/全屏进出/最小化恢复，都自动重放坐标。
///
/// 必须在主线程调用（Tauri setup 是主线程）。
pub unsafe fn install_traffic_light_pinner(ns_window: id) {
    if ns_window == nil {
        return;
    }

    PINNED_WINDOW.store(ns_window as usize, Ordering::SeqCst);
    reposition_traffic_lights(ns_window);

    // 观察者类：只注册一次，热重载/重复调用时直接复用已有类
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
            None => {
                // 已存在——沿用现有类，避免重复注册崩溃
                class!(SnoopTrafficLightPinner)
            }
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

    // NSApplication 级别的 appearance 变化也可能触发系统重排 titlebar
    let app_notif: id = NSString::alloc(nil)
        .init_str("NSApplicationDidChangeScreenParametersNotification");
    let _: () = msg_send![
        notification_center,
        addObserver: observer
        selector: sel!(windowStateChanged:)
        name: app_notif
        object: nil
    ];

    println!("✅ 红绿灯位置观察者已注册（y={})", TRAFFIC_LIGHT_Y);
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
                // 前台就是自己：dev 环境从终端启动没 .app bundle，
                // bundleIdentifier 会返回 nil，localizedName 也可能是 "snoop"。
                // 直接固定成正式包名 + 大写显示名，图标匹配与展示都一致。
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
