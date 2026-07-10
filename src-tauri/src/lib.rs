use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

mod activity_tracker;
mod commands;
mod db;
mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_buckets,
            commands::get_key_details,
            commands::get_today_key_total,
            commands::get_app_ranking,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Windows：在任务栏隐藏主窗口，靠托盘唤起（对齐 macOS 的 Accessory 语义）
            // 关闭原生装饰，改用前端自绘 title bar；圆角/阴影交给系统组合器
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.set_decorations(false);
                }
            }

            // 配置红绿灯位置：嵌入侧边栏顶部左侧
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use cocoa::appkit::{NSView, NSWindow, NSWindowButton};
                    use cocoa::base::{id, nil, YES};
                    use cocoa::foundation::NSPoint;
                    use objc::{msg_send, sel, sel_impl};

                    unsafe {
                        let ns_window = window.ns_window().unwrap() as id;

                        // 标题栏透明，让内容延伸到标题栏区域
                        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];

                        // 微调红绿灯位置（相对于窗口左上角）
                        let close_button = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
                        if close_button != nil {
                            close_button.setFrameOrigin(NSPoint::new(16.0, 18.0));
                        }
                        let minimize_button = ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
                        if minimize_button != nil {
                            minimize_button.setFrameOrigin(NSPoint::new(36.0, 18.0));
                        }
                        let zoom_button = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);
                        if zoom_button != nil {
                            zoom_button.setFrameOrigin(NSPoint::new(56.0, 18.0));
                        }
                    }
                }
            }

            let app_data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&app_data_dir).expect("无法创建应用数据目录");

            let db_path = app_data_dir.join("snoop.db");
            println!("数据库路径: {:?}", db_path);

            let database = db::Database::new(db_path.clone()).expect("无法创建数据库连接");
            database.init_schema().expect("无法初始化数据库表结构");
            println!("✓ 数据库初始化成功");

            database.insert_test_data().expect("无法插入测试数据");
            println!("✓ 测试数据插入成功");

            database.verify_test_data().expect("无法验证测试数据");

            // 启动集成的活动追踪（5秒桶 + 实时键鼠 + 前台应用）
            activity_tracker::start_activity_tracking(db_path.clone());

            app.manage(commands::DbPath(db_path));

            // 创建托盘菜单
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).item(&quit).build()?;

            let handle = app.handle().clone();
            let menu_handle = app.handle().clone();
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-icon.png"
            ))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Snoop")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |_app, event| {
                    if event.id() == "quit" {
                        menu_handle.exit(0);
                    }
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(&handle);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // 无退出码代表系统"最后一个窗口关闭"触发的退出，拦截以让 App 常驻托盘
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}
