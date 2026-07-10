use super::{send_switch, FrontmostApp};

use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString};
use objc::runtime::{Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use std::panic::AssertUnwindSafe;
use std::thread;

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
