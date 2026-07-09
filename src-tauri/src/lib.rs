use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

mod db;
mod activity_tracker;
mod commands;

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

            let handle = app.handle().clone();
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-icon.png"
            ))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Snoop")
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
