use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, RunEvent, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use std::time::Duration;

#[cfg(target_os = "macos")]
const REPO_URL: &str = "https://github.com/Nerakolox/Snoop";

mod activity_tracker;
mod ai;
mod app_classify;
mod commands;
mod db;
mod platform;
mod settings;
mod icon_cache;
mod updater;
#[cfg(target_os = "windows")]
mod raw_input_windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动前先看有没有 pending 更新需要静默装。装上后 installer 会替换本进程,
    // try_install_pending_on_startup 内部已 spawn 好新进程；这里直接 return
    // 让当前旧版进程尽快退出,把可执行文件释放给 installer 覆盖。
    #[cfg(target_os = "windows")]
    if updater::try_install_pending_on_startup() {
        std::process::exit(0);
    }

    // 判断本次是否走开机自启：autostart 插件注册项里带的 --autostart 参数
    // 会跟随可执行文件命令行传进来。用它决定是否静默启动到托盘。
    let launched_via_autostart = std::env::args().any(|a| a == "--autostart");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 当第二个实例尝试启动时，聚焦已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));

    builder
        .invoke_handler(tauri::generate_handler![
            commands::get_buckets,
            commands::get_key_details,
            commands::get_today_key_total,
            commands::get_app_ranking,
            commands::get_buckets_in_range,
            commands::get_key_details_in_range,
            commands::get_key_hourly_distribution,
            commands::get_key_app_distribution,
            commands::get_app_ranking_in_range,
            commands::get_hourly_activity,
            commands::get_hourly_heartbeats,
            commands::has_heartbeat_in_range,
            commands::get_settings,
            commands::save_settings,
            commands::get_db_info,
            commands::clear_data,
            commands::export_data,
            commands::get_recent_apps,
            commands::get_app_icon,
            commands::clear_icon_cache,
            commands::list_all_bundle_ids,
            commands::check_update,
            commands::get_update_state,
            commands::install_pending_update,
            commands::get_app_version,
            ai::commands::query_ai_audit,
            ai::commands::export_ai_audit,
            ai::commands::clear_ai_audit,
            ai::commands::get_ai_config,
            ai::commands::save_ai_config,
            ai::commands::set_ai_api_key,
            ai::commands::get_ai_features,
            ai::commands::test_ai_connection,
            ai::commands::call_ai,
            app_classify::commands::classify_apps,
            app_classify::commands::get_classify_status,
            app_classify::commands::list_classified_apps,
            app_classify::commands::set_app_category,
            app_classify::commands::reset_app_category,
            app_classify::commands::get_category_breakdown,
        ])
        .setup(move |app| {
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

            // titlebar 保持系统默认高度（~28pt）并透明化，红绿灯回到系统标准位置，
            // 跨 Mac / 跨 macOS 版本一致，不再手动 setFrameOrigin。
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

                        // 去掉 titlebar 分隔线，红绿灯位置由系统决定
                        platform::configure_titlebar(ns_window);
                    }
                }
            }

            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Snoop (Dev)");
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

            let classify_db_path = db_path.clone();
            app.manage(commands::DbPath(db_path));
            app.manage(settings);
            app.manage(icon_cache);
            app.manage(updater::UpdaterState::new());

            // AI 子系统状态：配置 / Key / 代号映射。以 Arc 托管，供异步命令跨 await 持有。
            let ai_state = ai::AiState::load(
                app_data_dir.join("ai_config.json"),
                app_data_dir.join("ai_key.dat"),
                app_data_dir.join("ai_code_map.json"),
            );
            let ai_state = std::sync::Arc::new(ai_state);
            app.manage(ai_state.clone());

            // 后台轮询触发 AI 应用分类（攒批 / 24h 过期；手动「立即分类」走前端命令）。
            {
                let bg_ai = ai_state.clone();
                let bg_db = classify_db_path.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(10 * 60)).await;
                        let _ = app_classify::engine::classify_if_due(
                            &bg_ai.config,
                            &bg_ai.code_map,
                            &bg_db,
                            false,
                        )
                        .await;
                    }
                });
            }

            // Windows release 自启自愈:若注册表里已有自启项,用当前 exe 路径覆盖一次。
            // 用途是修 dev 期开过自启、后来装了正式版的老用户 —— 注册表里那条 Run 项
            // 可能还指向 target\debug\snoop.exe,开机时会拉起一个带控制台的旧 debug 进程
            // (加载 devUrl 显示「未连接」),黑窗一闪就没了。debug 不做,免得开发时反向覆盖。
            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                if let Ok(true) = autostart.is_enabled() {
                    if let Err(e) = autostart.enable() {
                        eprintln!("[autostart] 自愈失败: {e}");
                    }
                }
            }

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

            // 创建托盘菜单（初始无更新项，收到 updater://ready 事件后动态重建）
            let show = MenuItemBuilder::with_id("show", "打开 Snoop").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).item(&show).item(&quit).build()?;

            let handle = app.handle().clone();
            let menu_handle = app.handle().clone();

            #[cfg(debug_assertions)]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-dev.png"
            ))?;
            #[cfg(all(not(debug_assertions), target_os = "windows"))]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-icon-windows.png"
            ))?;
            #[cfg(all(not(debug_assertions), not(target_os = "windows")))]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-icon.png"
            ))?;

            #[cfg(debug_assertions)]
            let tray_tooltip = "Snoop (Dev)";
            #[cfg(not(debug_assertions))]
            let tray_tooltip = "Snoop";

            let tray_builder = TrayIconBuilder::with_id("main-tray").icon(tray_icon);
            #[cfg(not(target_os = "windows"))]
            let tray_builder = tray_builder.icon_as_template(true);
            tray_builder
                .tooltip(tray_tooltip)
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
                        "install-update" => {
                            // Windows: 静默重启装 pending;macOS: 走 openUrl 打开雨云 dmg 页面
                            #[cfg(target_os = "windows")]
                            if let Err(e) = updater::run_pending_installer(app) {
                                eprintln!("[updater] 手动触发安装失败: {e}");
                            }
                            #[cfg(target_os = "macos")]
                            if let Err(e) = updater::open_manual_download(app) {
                                eprintln!("[updater] 打开下载页失败: {e}");
                            }
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

            // 监听「已就绪」事件：重建托盘菜单,插入更新入口置顶项
            // Windows 文案「点击重启安装」;macOS 文案「点击打开下载页」
            let ready_handle = app.handle().clone();
            app.listen("updater://ready", move |_ev| {
                let Some(tray) = ready_handle.tray_by_id("main-tray") else { return };
                #[cfg(target_os = "windows")]
                let update_label = "有新版本待安装 · 点击重启安装";
                #[cfg(target_os = "macos")]
                let update_label = "有新版本可下载 · 点击打开下载页";
                #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                let update_label = "有新版本可下载";
                let install = match MenuItemBuilder::with_id("install-update", update_label).build(&ready_handle) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                let show = match MenuItemBuilder::with_id("show", "打开 Snoop").build(&ready_handle) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                let quit = match MenuItemBuilder::with_id("quit", "退出").build(&ready_handle) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                let Ok(menu) = MenuBuilder::new(&ready_handle)
                    .item(&install)
                    .separator()
                    .item(&show)
                    .item(&quit)
                    .build()
                else { return };
                let _ = tray.set_menu(Some(menu));
            });

            // 应用启动 3 秒后触发后台静默检查更新,失败静默吞掉。
            // 3 秒延迟让主界面先渲染完,再走网络请求不抢资源。
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                updater::check_and_download(update_handle).await;
            });

            // 主窗口显示策略：
            // - 正常启动 → 显式 show（配置里 visible:false 是为了避免白屏，这里补一次真正的 show）
            // - 开机自启（命令行带 --autostart）→ 保持隐藏，只在托盘常驻，静默采集
            if let Some(window) = app.get_webview_window("main") {
                if launched_via_autostart {
                    #[cfg(target_os = "windows")]
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

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
        .run(|_app_handle, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    if let Some(window) = _app_handle.get_webview_window("main") {
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
