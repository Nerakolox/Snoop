use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};

const REPO_URL: &str = "https://github.com/Nerakolox/Snoop";

mod activity_tracker;
mod commands;
mod db;
mod platform;
mod settings;
mod icon_cache;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_buckets,
            commands::get_key_details,
            commands::get_today_key_total,
            commands::get_app_ranking,
            commands::get_buckets_in_range,
            commands::get_key_details_in_range,
            commands::get_app_ranking_in_range,
            commands::get_hourly_activity,
            commands::get_settings,
            commands::save_settings,
            commands::get_db_info,
            commands::clear_data,
            commands::export_data,
            commands::get_recent_apps,
            commands::get_app_icon,
            commands::clear_icon_cache,
            commands::list_all_bundle_ids,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // Windows：关闭原生装饰，改用前端自绘 title bar；圆角/阴影交给系统组合器
            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                use windows::Win32::Foundation::HWND;
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_BORDER_COLOR,
                    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
                    DWM_WINDOW_CORNER_PREFERENCE,
                };

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);

                    // Acrylic：实时对桌面做模糊，与窗口 focus 状态解耦，切走切回不会掉色。
                    // 传 None 让系统按主题决定色调；Win10 也吃这一套。
                    let _ = apply_acrylic(&window, None);

                    // vibrancy 之后再关阴影
                    let _ = window.set_shadow(false);

                    if let Ok(hwnd) = window.hwnd() {
                        let hwnd = HWND(hwnd.0 as *mut _);
                        unsafe {
                            // 消掉 1~2px 的深色 hint 边
                            let border_color: u32 = 0xFFFFFFFE; // DWMWA_COLOR_NONE
                            let _ = DwmSetWindowAttribute(
                                hwnd,
                                DWMWA_BORDER_COLOR,
                                &border_color as *const _ as *const _,
                                std::mem::size_of::<u32>() as u32,
                            );

                            // 关系统圆角，避免圆角走 non-client 合成把 halo 也带回来
                            let pref: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND;
                            let _ = DwmSetWindowAttribute(
                                hwnd,
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &pref as *const _ as *const _,
                                std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                            );
                        }
                    }
                }
            }

            // 配置红绿灯位置：嵌入侧边栏顶部左侧
            // 注意：仅在 setup 时摆一次不够——系统在全屏进出、resize、becomeMain、appearance
            // 切换等 layout pass 后会把按钮拨回默认位置。install_traffic_light_pinner
            // 会注册 NSWindow 通知观察者，每次状态变化自动重放坐标。
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use cocoa::base::{id, YES};
                    use objc::{msg_send, sel, sel_impl};
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

                    // Sidebar 材质：系统 App 侧栏专用，比 HudWindow 淡、比 Menu 厚
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        None,
                        None,
                    );

                    unsafe {
                        let ns_window = window.ns_window().unwrap() as id;

                        // 标题栏透明，让内容延伸到标题栏区域
                        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];

                        // 摆红绿灯 + 装观察者钉死位置
                        platform::install_traffic_light_pinner(ns_window);
                    }
                }
            }

            let app_data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&app_data_dir).expect("无法创建应用数据目录");

            let db_path = app_data_dir.join("snoop.db");
            let config_path = app_data_dir.join("settings.json");
            let icon_cache_dir = app_data_dir.join("icon_cache");
            println!("数据库路径: {:?}", db_path);

            let settings = settings::SettingsState::load(config_path);
            let paused = settings.paused.clone();
            let ignore_list = settings.ignore_list.clone();

            let database = db::Database::new(db_path.clone()).expect("无法创建数据库连接");
            database.init_schema().expect("无法初始化数据库表结构");
            println!("✓ 数据库初始化成功");

            // 启动集成的活动追踪（5秒桶 + 实时键鼠 + 前台应用）
            activity_tracker::start_activity_tracking(db_path.clone(), app.handle().clone(), paused, ignore_list);

            let icon_cache = icon_cache::IconCache::new(icon_cache_dir);

            app.manage(commands::DbPath(db_path));
            app.manage(settings);
            app.manage(icon_cache);

            // macOS 应用菜单：仅 App / 窗口 / 帮助 三块，去掉 File/Edit/View
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, SubmenuBuilder};

                // 关于面板用打包进 app 的 Snoop 猫图标；dev 环境系统里没有
                // .app bundle，从系统提取会退化成 macOS 空白文件图标。
                let about_icon = tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/128x128@2x.png"
                ))
                .ok();

                let about_meta = AboutMetadataBuilder::new()
                    .name(Some("Snoop"))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .website(Some(REPO_URL))
                    .website_label(Some("GitHub"))
                    .icon(about_icon)
                    .build();

                let settings_item = MenuItemBuilder::with_id("menu:open-settings", "设置…")
                    .accelerator("Cmd+,")
                    .build(app)?;
                let check_update_item =
                    MenuItemBuilder::with_id("menu:check-update", "检查更新…").build(app)?;

                let app_submenu = SubmenuBuilder::new(app, "Snoop")
                    .about(Some(about_meta))
                    .separator()
                    .item(&settings_item)
                    .item(&check_update_item)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let window_submenu = SubmenuBuilder::new(app, "窗口")
                    .minimize()
                    .maximize()
                    .separator()
                    .close_window()
                    .build()?;

                let github_item = MenuItemBuilder::with_id("menu:open-repo", "Snoop 开源仓库")
                    .build(app)?;
                let help_submenu = SubmenuBuilder::new(app, "帮助").item(&github_item).build()?;

                let app_menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&window_submenu)
                    .item(&help_submenu)
                    .build()?;

                app.set_menu(app_menu)?;

                let menu_app_handle = app.handle().clone();
                app.on_menu_event(move |_app, event| match event.id().as_ref() {
                    "menu:open-settings" => {
                        if let Some(window) = menu_app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = menu_app_handle.emit("menu-navigate", "settings");
                    }
                    "menu:check-update" => {
                        if let Some(window) = menu_app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = menu_app_handle.emit("menu-navigate", "settings");
                    }
                    "menu:open-repo" => {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = menu_app_handle.opener().open_url(REPO_URL, None::<&str>);
                    }
                    _ => {}
                });
            }

            // 创建托盘菜单
            let show = MenuItemBuilder::with_id("show", "打开 Snoop").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).item(&show).item(&quit).build()?;

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
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            menu_handle.exit(0);
                        }
                        _ => {}
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
                    let close_to_tray = window
                        .app_handle()
                        .try_state::<settings::SettingsState>()
                        .map(|s| s.close_to_tray.load(std::sync::atomic::Ordering::Relaxed))
                        .unwrap_or(true);
                    if close_to_tray {
                        #[cfg(target_os = "windows")]
                        let _ = window.set_skip_taskbar(true);
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            _ => {}
        });
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_skip_taskbar(true);
                }
                let _ = window.hide();
            }
            _ => {
                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_skip_taskbar(false);
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}
