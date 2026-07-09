use rdev::{listen, Event, EventType};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct InputStats {
    pub key_presses: HashMap<String, u32>,
    pub left_clicks: u32,
    pub right_clicks: u32,
    pub middle_clicks: u32,
    pub mouse_distance: f64,
    pub scroll_amount: f64,
    pub last_mouse_x: f64,
    pub last_mouse_y: f64,
}

impl InputStats {
    fn new() -> Self {
        Self::default()
    }

    fn clear(&mut self) {
        self.key_presses.clear();
        self.left_clicks = 0;
        self.right_clicks = 0;
        self.middle_clicks = 0;
        self.mouse_distance = 0.0;
        self.scroll_amount = 0.0;
        // 保留 last_mouse_x/y 用于计算下一次移动距离
    }

    fn print_and_clear(&mut self) {
        println!("\n========== 输入统计（最近5秒）==========");

        if !self.key_presses.is_empty() {
            println!("键盘按键:");
            let mut sorted: Vec<_> = self.key_presses.iter().collect();
            sorted.sort_by(|a, b| b.1.cmp(a.1));
            for (key, count) in sorted {
                println!("  {}: {} 次", key, count);
            }
        } else {
            println!("键盘按键: 无");
        }

        println!("鼠标点击:");
        println!("  左键: {} 次", self.left_clicks);
        println!("  右键: {} 次", self.right_clicks);
        println!("  中键: {} 次", self.middle_clicks);

        println!("鼠标移动距离: {:.1} 像素", self.mouse_distance);
        println!("滚轮滚动量: {:.1}", self.scroll_amount);
        println!("=====================================\n");

        self.clear();
    }
}

pub fn start_monitoring() {
    let stats = Arc::new(Mutex::new(InputStats::new()));

    // 启动打印线程：每5秒打印并清零
    let stats_clone = Arc::clone(&stats);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(5));
            let mut stats = stats_clone.lock().unwrap();
            stats.print_and_clear();
        }
    });

    // 启动监听线程：阻塞调用 rdev::listen
    let stats_clone = Arc::clone(&stats);
    thread::spawn(move || {
        if let Err(error) = listen(move |event| {
            callback(&event, &stats_clone);
        }) {
            eprintln!("rdev 监听错误: {:?}", error);
        }
    });

    println!("✓ 输入事件监听已启动（rdev）");
}

fn callback(event: &Event, stats: &Arc<Mutex<InputStats>>) {
    let mut stats = stats.lock().unwrap();

    match event.event_type {
        EventType::KeyPress(key) => {
            let key_name = format!("{:?}", key);
            *stats.key_presses.entry(key_name).or_insert(0) += 1;
        }
        EventType::ButtonPress(button) => {
            match button {
                rdev::Button::Left => stats.left_clicks += 1,
                rdev::Button::Right => stats.right_clicks += 1,
                rdev::Button::Middle => stats.middle_clicks += 1,
                _ => {}
            }
        }
        EventType::MouseMove { x, y } => {
            // 计算移动距离（曼哈顿距离）
            if stats.last_mouse_x != 0.0 || stats.last_mouse_y != 0.0 {
                let dx = (x - stats.last_mouse_x).abs();
                let dy = (y - stats.last_mouse_y).abs();
                stats.mouse_distance += dx + dy;
            }
            stats.last_mouse_x = x;
            stats.last_mouse_y = y;
        }
        EventType::Wheel { delta_x, delta_y } => {
            stats.scroll_amount += delta_x.abs() as f64 + delta_y.abs() as f64;
        }
        _ => {}
    }
}
