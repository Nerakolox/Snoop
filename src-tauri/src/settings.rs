use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub collection_paused: bool,
    pub ignore_list: Vec<String>,
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            collection_paused: false,
            ignore_list: default_ignore_list(),
            close_to_tray: true,
        }
    }
}

/// 平台锁屏 App 默认进忽略名单：锁屏期间前台会被系统切到这些进程，
/// 不忽略的话会把「锁屏挂机」记成在用 LogonUI / loginwindow。
/// 匹配走 bundle_id（macOS = bundleIdentifier，Windows = exe 完整路径）。
fn default_ignore_list() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec!["com.apple.loginwindow".to_string()]
    }
    #[cfg(target_os = "windows")]
    {
        vec!["C:\\Windows\\System32\\LogonUI.exe".to_string()]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        vec![]
    }
}

pub struct SettingsState {
    pub paused: Arc<AtomicBool>,
    pub ignore_list: Arc<Mutex<Vec<String>>>,
    pub close_to_tray: Arc<AtomicBool>,
    config_path: PathBuf,
}

impl SettingsState {
    pub fn load(config_path: PathBuf) -> Self {
        let file_exists = config_path.exists();
        let mut s: Settings = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();

        // 把平台默认忽略条目合并进已有配置（仅追加未出现的条目）。
        // 只要用户没手动删过，就自动补上；删了就永久删了，不会再加回。
        // 已有文件说明是老用户，合并后回写一次让改动持久化。
        let mut changed = !file_exists; // 新文件本就要写
        for entry in default_ignore_list() {
            if !s.ignore_list.contains(&entry) {
                s.ignore_list.push(entry);
                changed = true;
            }
        }
        if changed {
            if let Ok(json) = serde_json::to_string_pretty(&s) {
                let _ = std::fs::write(&config_path, json);
            }
        }

        SettingsState {
            paused: Arc::new(AtomicBool::new(s.collection_paused)),
            ignore_list: Arc::new(Mutex::new(s.ignore_list)),
            close_to_tray: Arc::new(AtomicBool::new(s.close_to_tray)),
            config_path,
        }
    }

    pub fn get(&self) -> Settings {
        Settings {
            collection_paused: self.paused.load(Ordering::Relaxed),
            ignore_list: self.ignore_list.lock().unwrap().clone(),
            close_to_tray: self.close_to_tray.load(Ordering::Relaxed),
        }
    }

    pub fn apply(&self, s: &Settings) {
        self.paused.store(s.collection_paused, Ordering::Relaxed);
        self.close_to_tray.store(s.close_to_tray, Ordering::Relaxed);
        *self.ignore_list.lock().unwrap() = s.ignore_list.clone();
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(&self.config_path, json);
        }
    }
}
