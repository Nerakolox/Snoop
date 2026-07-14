#[cfg(not(target_os = "windows"))]
use rdev::listen;
use rdev::{Event, EventType};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use crate::platform::{self, FrontmostApp};

#[derive(Clone, serde::Serialize)]
struct InputEventPayload {
    event_type: String, // "KeyPress" | "KeyRelease" | "ButtonPress" | "ButtonRelease"
    code: String,
}

const MAX_BUCKET_MS: i64 = 5000;
const MIN_KEEP_MS: i64 = 1000;
const MIN_KEEP_EXPLORER_MS: i64 = 2000;
const APP_SWITCH_STABILITY_MS: i64 = 1000;
const POLL_INTERVAL_MS: u64 = 300;

#[derive(Debug, Clone, Default)]
struct Counters {
    key_presses: HashMap<String, u32>,
    left_clicks: u32,
    right_clicks: u32,
    middle_clicks: u32,
    mouse_back: u32,
    mouse_forward: u32,
    mouse_distance: f64,
    scroll_amount: f64,
    last_mouse_x: f64,
    last_mouse_y: f64,
}

impl Counters {
    fn reset_activity(&mut self) {
        self.key_presses.clear();
        self.left_clicks = 0;
        self.right_clicks = 0;
        self.middle_clicks = 0;
        self.mouse_back = 0;
        self.mouse_forward = 0;
        self.mouse_distance = 0.0;
        self.scroll_amount = 0.0;
        // 保留 last_mouse_x/y 用于下一个桶的距离计算
    }

    fn key_total(&self) -> u32 {
        self.key_presses.values().sum()
    }

    fn has_any_activity(&self) -> bool {
        !self.key_presses.is_empty()
            || self.left_clicks > 0
            || self.right_clicks > 0
            || self.middle_clicks > 0
            || self.mouse_back > 0
            || self.mouse_forward > 0
            || self.mouse_distance > 0.0
            || self.scroll_amount > 0.0
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn start_activity_tracking(
    db_path: std::path::PathBuf,
    app_handle: tauri::AppHandle,
    paused: Arc<AtomicBool>,
    ignore_list: Arc<Mutex<Vec<String>>>,
) {
    let counters = Arc::new(Mutex::new(Counters::default()));
    let (tx, rx) = channel::<FrontmostApp>();

    // 全局 sender：供平台切换回调 & 轮询线程使用
    platform::set_switch_sender(tx);
    // ============ Settler：定时 5s 或 App 切换任一触发结算 ============
    let counters_settler = Arc::clone(&counters);
    let db_path_settler = db_path.clone();
    let paused_settler = paused.clone();
    let ignore_settler = ignore_list.clone();
    thread::spawn(move || {
        let mut bucket_start = now_ms();
        let mut bucket_app = platform::get_frontmost_app();
        println!(
            "✅ 起始桶: {} ({}) @ {}",
            bucket_app.name, bucket_app.bundle_id, bucket_start
        );

        loop {
            let elapsed = now_ms() - bucket_start;
            let remaining = (MAX_BUCKET_MS - elapsed).max(0) as u64;

            let candidate_app = match rx.recv_timeout(Duration::from_millis(remaining)) {
                Ok(app) => {
                    if app.bundle_id == bucket_app.bundle_id {
                        // 同一个 App 的重复通知，忽略并继续等
                        continue;
                    }
                    app
                }
                Err(RecvTimeoutError::Timeout) => platform::get_frontmost_app(),
                Err(RecvTimeoutError::Disconnected) => return,
            };

            // 稳定性窗口：等待 APP_SWITCH_STABILITY_MS，看新 App 是否稳定
            let stability_check = rx.recv_timeout(Duration::from_millis(APP_SWITCH_STABILITY_MS as u64));
            let next_app = match stability_check {
                Ok(newer_app) => {
                    // 稳定期内又切换了，说明 candidate_app 是瞬时中间态（如 Alt+Tab）
                    if newer_app.bundle_id == bucket_app.bundle_id {
                        // 切回原 App，candidate_app 是瞬时抖动，忽略并继续当前桶
                        println!(
                            "⚡ 忽略瞬时切换: {} (未稳定 {}ms 即切回)",
                            candidate_app.name, APP_SWITCH_STABILITY_MS
                        );
                        continue;
                    } else if newer_app.bundle_id != candidate_app.bundle_id {
                        // 又切到第三个 App，candidate_app 是瞬态中转站（如 Alt+Tab explorer）
                        println!(
                            "⚡ 跳过瞬态中转: {} ({}ms 内又切到 {})",
                            candidate_app.name, APP_SWITCH_STABILITY_MS, newer_app.name
                        );
                        // 丢弃 candidate_app，用 newer_app 关桶（newer_app 也要走稳定性检查，下一轮自然处理）
                        newer_app
                    } else {
                        // 同一个 App 的重复通知（异常路径）
                        candidate_app
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 稳定期过了，candidate_app 确认稳定，接受切换
                    candidate_app
                }
                Err(RecvTimeoutError::Disconnected) => return,
            };

            let close_ms = now_ms();
            let duration_ms = (close_ms - bucket_start).max(0);

            // 快照并重置
            let snapshot = {
                let mut c = counters_settler.lock().unwrap();
                let snap = c.clone();
                c.reset_activity();
                snap
            };

            // explorer.exe 需要更长停留时间才记录（区分 Alt+Tab 浮层和真正使用文件管理器）
            let min_threshold = if bucket_app.bundle_id.to_lowercase().contains("explorer.exe") {
                MIN_KEEP_EXPLORER_MS
            } else {
                MIN_KEEP_MS
            };

            let is_paused = paused_settler.load(Ordering::Relaxed);
            let is_ignored = ignore_settler.lock().unwrap().iter().any(|id| {
                id == &bucket_app.bundle_id || id == &bucket_app.name
            });
            let should_write = !is_paused
                && !is_ignored
                && (duration_ms >= min_threshold || snapshot.has_any_activity());

            if should_write {
                match write_bucket_to_db(
                    &db_path_settler,
                    bucket_start,
                    duration_ms,
                    &bucket_app,
                    &snapshot,
                ) {
                    Ok(_) => println!(
                        "✓ 桶 {}ms | {} | 键:{} 鼠:L{}/R{}/M{}/B{}/F{} 移:{:.0}px 滚:{:.0}",
                        duration_ms,
                        bucket_app.name,
                        snapshot.key_total(),
                        snapshot.left_clicks,
                        snapshot.right_clicks,
                        snapshot.middle_clicks,
                        snapshot.mouse_back,
                        snapshot.mouse_forward,
                        snapshot.mouse_distance,
                        snapshot.scroll_amount
                    ),
                    Err(e) => eprintln!("❌ 写入数据库失败: {:?}", e),
                }
            } else {
                println!(
                    "- 丢弃碎桶 {}ms | {} ({})",
                    duration_ms, bucket_app.name,
                    if duration_ms < min_threshold { "停留过短" } else { "无输入" }
                );
            }

            bucket_start = close_ms;
            bucket_app = next_app;
        }
    });

    // ============ 键鼠监听 ============
    // Windows 走 Raw Input(WM_INPUT):不受 low-level hook 拦截影响,
    // EAC / 小蓝熊 / 反宏工具都挡不住。其它平台继续用 rdev。
    let counters_input = Arc::clone(&counters);
    let app_handle_input = app_handle.clone();
    thread::spawn(move || {
        println!("🎹 输入监听线程启动");
        let callback = move |event: Event| {
            // emit 实时事件供前端调试页使用
            let payload = match &event.event_type {
                EventType::KeyPress(key) => Some(InputEventPayload {
                    event_type: "KeyPress".into(),
                    code: format!("{:?}", key),
                }),
                EventType::KeyRelease(key) => Some(InputEventPayload {
                    event_type: "KeyRelease".into(),
                    code: format!("{:?}", key),
                }),
                EventType::ButtonPress(btn) => Some(InputEventPayload {
                    event_type: "ButtonPress".into(),
                    code: format!("{:?}", btn),
                }),
                EventType::ButtonRelease(btn) => Some(InputEventPayload {
                    event_type: "ButtonRelease".into(),
                    code: format!("{:?}", btn),
                }),
                _ => None,
            };
            if let Some(p) = payload {
                let _ = app_handle_input.emit("input-event", p);
            }
            handle_input_event(&event, &counters_input);
        };

        #[cfg(target_os = "windows")]
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::raw_input_windows::listen(callback).map_err(|e| format!("{e:?}"))
        }));

        #[cfg(not(target_os = "windows"))]
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            listen(callback).map_err(|e| format!("{:?}", e))
        }));

        match result {
            Ok(Ok(())) => eprintln!("⚠️ 输入监听正常返回（不应该发生）"),
            Ok(Err(e)) => eprintln!("❌ 输入监听错误: {}", e),
            Err(p) => eprintln!("❌ 输入监听线程 panic: {:?}", p),
        }
    });

    // ============ 前台 App 切换检测：平台原生事件 ============
    platform::spawn_switch_observer();

    // ============ 前台 App 切换检测：300ms 轮询兜底 ============
    thread::spawn(|| {
        let mut last_seen = platform::get_frontmost_app();
        loop {
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            let cur = platform::get_frontmost_app();
            if cur.bundle_id != last_seen.bundle_id {
                last_seen = cur.clone();
                platform::send_switch(cur);
            }
        }
    });

    println!("✅ 活动追踪已启动（事件驱动结算 + 平台原生通知 + 300ms 轮询兜底）");
}

fn handle_input_event(event: &Event, counters: &Arc<Mutex<Counters>>) {
    let mut data = counters.lock().unwrap();

    match event.event_type {
        EventType::KeyPress(key) => {
            let key_name = format!("{:?}", key);
            // 调试日志：打印每个按键的原始键码格式（首次出现时）
            if !data.key_presses.contains_key(&key_name) {
                println!("🔑 新键码: {}", key_name);
            }
            *data.key_presses.entry(key_name).or_insert(0) += 1;
        }
        EventType::ButtonPress(button) => match button {
            rdev::Button::Left => data.left_clicks += 1,
            rdev::Button::Right => data.right_clicks += 1,
            rdev::Button::Middle => data.middle_clicks += 1,
            rdev::Button::Unknown(code) => {
                // Windows: 侧键通常是 Unknown(1) = 后退, Unknown(2) = 前进
                // macOS/Linux 可能有不同编号，这里统一处理 1/2
                match code {
                    1 => {
                        data.mouse_back += 1;
                        println!("🖱️ 鼠标后退键 (Unknown(1))");
                    }
                    2 => {
                        data.mouse_forward += 1;
                        println!("🖱️ 鼠标前进键 (Unknown(2))");
                    }
                    _ => {
                        // 其他未知按键也记录一下，方便调试
                        println!("🖱️ 未知鼠标按键: Unknown({})", code);
                    }
                }
            }
        },
        EventType::MouseMove { x, y } => {
            if data.last_mouse_x != 0.0 || data.last_mouse_y != 0.0 {
                let dx = (x - data.last_mouse_x).abs();
                let dy = (y - data.last_mouse_y).abs();
                data.mouse_distance += dx + dy;
            }
            data.last_mouse_x = x;
            data.last_mouse_y = y;
        }
        EventType::Wheel { delta_x, delta_y } => {
            data.scroll_amount += delta_x.abs() as f64 + delta_y.abs() as f64;
        }
        _ => {}
    }
}

fn write_bucket_to_db(
    db_path: &std::path::Path,
    bucket_start: i64,
    duration_ms: i64,
    app: &FrontmostApp,
    data: &Counters,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::open(db_path)?;
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "INSERT INTO activity_buckets
        (bucket_start, duration_ms, app_name, app_bundle_id,
         key_total, mouse_left, mouse_right, mouse_middle,
         mouse_back, mouse_forward,
         mouse_move_dist, scroll_dist)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            bucket_start,
            duration_ms,
            app.name,
            app.bundle_id,
            data.key_total(),
            data.left_clicks,
            data.right_clicks,
            data.middle_clicks,
            data.mouse_back,
            data.mouse_forward,
            data.mouse_distance as i64,
            data.scroll_amount as i64,
        ],
    )?;

    let bucket_id = tx.last_insert_rowid();

    if !data.key_presses.is_empty() {
        let mut stmt = tx.prepare(
            "INSERT INTO key_details (bucket_id, key_code, count) VALUES (?1, ?2, ?3)",
        )?;
        for (key_code, count) in &data.key_presses {
            stmt.execute(rusqlite::params![bucket_id, key_code, count])?;
        }
    }

    tx.commit()?;
    Ok(())
}
