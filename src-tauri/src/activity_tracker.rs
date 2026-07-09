use rdev::{listen, Event, EventType};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSAutoreleasePool, NSString};
#[cfg(target_os = "macos")]
use objc::runtime::{Object, Sel};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
use std::panic::AssertUnwindSafe;

const MAX_BUCKET_MS: i64 = 5000;
const MIN_KEEP_MS: i64 = 500;
const POLL_INTERVAL_MS: u64 = 300;

#[derive(Debug, Clone, Default)]
struct Counters {
    key_presses: HashMap<String, u32>,
    left_clicks: u32,
    right_clicks: u32,
    middle_clicks: u32,
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
            || self.mouse_distance > 0.0
            || self.scroll_amount > 0.0
    }
}

#[derive(Debug, Clone, PartialEq)]
struct FrontmostApp {
    name: String,
    bundle_id: String,
}

#[cfg(target_os = "macos")]
fn get_frontmost_app() -> FrontmostApp {
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
                return FrontmostApp {
                    name: "Unknown".to_string(),
                    bundle_id: "unknown.bundle.id".to_string(),
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

        result.unwrap_or_else(|_| FrontmostApp {
            name: "Unknown".to_string(),
            bundle_id: "unknown.bundle.id".to_string(),
        })
    }
}

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
fn get_frontmost_app() -> FrontmostApp {
    FrontmostApp {
        name: "Unknown".to_string(),
        bundle_id: "unknown.bundle.id".to_string(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

static SWITCH_SENDER: OnceLock<Mutex<Option<Sender<FrontmostApp>>>> = OnceLock::new();

fn send_switch(app: FrontmostApp) {
    if let Some(m) = SWITCH_SENDER.get() {
        if let Some(sender) = m.lock().unwrap().as_ref() {
            let _ = sender.send(app);
        }
    }
}

pub fn start_activity_tracking(db_path: std::path::PathBuf) {
    let counters = Arc::new(Mutex::new(Counters::default()));
    let (tx, rx) = channel::<FrontmostApp>();

    // 全局 sender：供 NSWorkspace 回调 & 轮询线程使用
    let _ = SWITCH_SENDER.set(Mutex::new(Some(tx)));

    // ============ Settler：定时 5s 或 App 切换任一触发结算 ============
    let counters_settler = Arc::clone(&counters);
    let db_path_settler = db_path.clone();
    thread::spawn(move || {
        let mut bucket_start = now_ms();
        let mut bucket_app = get_frontmost_app();
        println!(
            "✅ 起始桶: {} ({}) @ {}",
            bucket_app.name, bucket_app.bundle_id, bucket_start
        );

        loop {
            let elapsed = now_ms() - bucket_start;
            let remaining = (MAX_BUCKET_MS - elapsed).max(0) as u64;

            let next_app = match rx.recv_timeout(Duration::from_millis(remaining)) {
                Ok(app) => {
                    if app.bundle_id == bucket_app.bundle_id {
                        // 同一个 App 的重复通知，忽略并继续等
                        continue;
                    }
                    app
                }
                Err(RecvTimeoutError::Timeout) => get_frontmost_app(),
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

            let should_write =
                duration_ms >= MIN_KEEP_MS || snapshot.has_any_activity();

            if should_write {
                match write_bucket_to_db(
                    &db_path_settler,
                    bucket_start,
                    duration_ms,
                    &bucket_app,
                    &snapshot,
                ) {
                    Ok(_) => println!(
                        "✓ 桶 {}ms | {} | 键:{} 鼠:{}/{}/{} 移:{:.0}px 滚:{:.0}",
                        duration_ms,
                        bucket_app.name,
                        snapshot.key_total(),
                        snapshot.left_clicks,
                        snapshot.right_clicks,
                        snapshot.middle_clicks,
                        snapshot.mouse_distance,
                        snapshot.scroll_amount
                    ),
                    Err(e) => eprintln!("❌ 写入数据库失败: {:?}", e),
                }
            } else {
                println!(
                    "- 丢弃碎桶 {}ms | {} (无输入)",
                    duration_ms, bucket_app.name
                );
            }

            bucket_start = close_ms;
            bucket_app = next_app;
        }
    });

    // ============ 键鼠监听 ============
    let counters_input = Arc::clone(&counters);
    thread::spawn(move || {
        println!("🎹 rdev 监听线程启动");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            listen(move |event| {
                handle_input_event(&event, &counters_input);
            })
        }));
        match result {
            Ok(Ok(())) => eprintln!("⚠️ rdev listen 正常返回（不应该发生）"),
            Ok(Err(e)) => eprintln!("❌ rdev 监听错误: {:?}", e),
            Err(p) => eprintln!("❌ rdev 线程 panic: {:?}", p),
        }
    });

    // ============ 前台 App 切换检测：NSWorkspace 通知 ============
    #[cfg(target_os = "macos")]
    thread::spawn(|| {
        start_nsworkspace_observer();
    });

    // ============ 前台 App 切换检测：300ms 轮询兜底 ============
    thread::spawn(|| {
        let mut last_seen = get_frontmost_app();
        loop {
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            let cur = get_frontmost_app();
            if cur.bundle_id != last_seen.bundle_id {
                last_seen = cur.clone();
                send_switch(cur);
            }
        }
    });

    println!("✅ 活动追踪已启动（事件驱动结算 + NSWorkspace 通知 + 300ms 轮询兜底）");
}

fn handle_input_event(event: &Event, counters: &Arc<Mutex<Counters>>) {
    let mut data = counters.lock().unwrap();

    match event.event_type {
        EventType::KeyPress(key) => {
            let key_name = format!("{:?}", key);
            *data.key_presses.entry(key_name).or_insert(0) += 1;
        }
        EventType::ButtonPress(button) => match button {
            rdev::Button::Left => data.left_clicks += 1,
            rdev::Button::Right => data.right_clicks += 1,
            rdev::Button::Middle => data.middle_clicks += 1,
            _ => {}
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
         mouse_move_dist, scroll_dist)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            bucket_start,
            duration_ms,
            app.name,
            app.bundle_id,
            data.key_total(),
            data.left_clicks,
            data.right_clicks,
            data.middle_clicks,
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

#[cfg(target_os = "macos")]
extern "C" fn app_activated_callback(_self: &Object, _cmd: Sel, _notification: id) {
    // 回调也在专用线程分发，get_frontmost_app 内部已经自带 autoreleasepool
    let app = get_frontmost_app();
    send_switch(app);
}

#[cfg(target_os = "macos")]
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
