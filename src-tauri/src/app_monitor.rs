#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
use objc::runtime::{Class, Object, Sel};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[derive(Debug, Clone)]
pub struct FrontmostApp {
    pub name: String,
    pub bundle_id: String,
}

#[cfg(target_os = "macos")]
fn get_frontmost_app() -> Option<FrontmostApp> {
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let frontmost_app: id = msg_send![workspace, frontmostApplication];

        if frontmost_app == nil {
            return None;
        }

        let app_name: id = msg_send![frontmost_app, localizedName];
        let bundle_id: id = msg_send![frontmost_app, bundleIdentifier];

        let name = if app_name != nil {
            let name_str: *const i8 = msg_send![app_name, UTF8String];
            std::ffi::CStr::from_ptr(name_str)
                .to_string_lossy()
                .to_string()
        } else {
            "Unknown".to_string()
        };

        let bundle = if bundle_id != nil {
            let bundle_str: *const i8 = msg_send![bundle_id, UTF8String];
            std::ffi::CStr::from_ptr(bundle_str)
                .to_string_lossy()
                .to_string()
        } else {
            "unknown.bundle.id".to_string()
        };

        Some(FrontmostApp {
            name,
            bundle_id: bundle,
        })
    }
}

#[cfg(target_os = "macos")]
extern "C" fn app_activated_callback(_self: &Object, _cmd: Sel, notification: id) {
    unsafe {
        let user_info: id = msg_send![notification, userInfo];
        if user_info == nil {
            return;
        }

        let ns_running_app_key = NSString::alloc(nil);
        let ns_running_app_key: id =
            msg_send![ns_running_app_key, initWithUTF8String: "NSWorkspaceApplicationKey\0".as_ptr()];

        let app: id = msg_send![user_info, objectForKey: ns_running_app_key];
        if app == nil {
            return;
        }

        let app_name: id = msg_send![app, localizedName];
        let bundle_id: id = msg_send![app, bundleIdentifier];

        let name = if app_name != nil {
            let name_str: *const i8 = msg_send![app_name, UTF8String];
            std::ffi::CStr::from_ptr(name_str)
                .to_string_lossy()
                .to_string()
        } else {
            "Unknown".to_string()
        };

        let bundle = if bundle_id != nil {
            let bundle_str: *const i8 = msg_send![bundle_id, UTF8String];
            std::ffi::CStr::from_ptr(bundle_str)
                .to_string_lossy()
                .to_string()
        } else {
            "unknown.bundle.id".to_string()
        };

        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔄 前台应用切换:");
        println!("  应用名称: {}", name);
        println!("  Bundle ID: {}", bundle);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

#[cfg(target_os = "macos")]
pub fn start_monitoring() {
    unsafe {
        // 先打印当前前台应用
        if let Some(app) = get_frontmost_app() {
            println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            println!("✨ 初始前台应用:");
            println!("  应用名称: {}", app.name);
            println!("  Bundle ID: {}", app.bundle_id);
            println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
            println!("📡 开始实时监听前台应用切换...\n");
        }

        // 创建 Observer 类
        let superclass = class!(NSObject);
        let mut decl = objc::declare::ClassDecl::new("AppObserver", superclass).unwrap();

        decl.add_method(
            sel!(appActivated:),
            app_activated_callback as extern "C" fn(&Object, Sel, id),
        );

        let observer_class = decl.register();
        let observer: id = msg_send![observer_class, new];

        // 获取 NSWorkspace
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let notification_center: id = msg_send![workspace, notificationCenter];

        // 注册通知监听
        let notification_name = NSString::alloc(nil);
        let notification_name: id = msg_send![
            notification_name,
            initWithUTF8String: "NSWorkspaceDidActivateApplicationNotification\0".as_ptr()
        ];

        let _: () = msg_send![
            notification_center,
            addObserver: observer
            selector: sel!(appActivated:)
            name: notification_name
            object: nil
        ];

        println!("✅ 实时监听已启动（基于 NSWorkspace 通知，无轮询）\n");

        // 保持运行
        let run_loop: id = msg_send![class!(NSRunLoop), currentRunLoop];
        loop {
            let distant_future: id = msg_send![class!(NSDate), distantFuture];
            let _: () = msg_send![run_loop, runUntilDate: distant_future];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start_monitoring() {
    println!("前台应用监听仅支持 macOS");
}
