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
            ignore_list: vec![],
            close_to_tray: true,
        }
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
        let s: Settings = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
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
