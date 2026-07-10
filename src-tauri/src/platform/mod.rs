use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq)]
pub struct FrontmostApp {
    pub name: String,
    pub bundle_id: String,
}

impl FrontmostApp {
    pub fn unknown() -> Self {
        FrontmostApp {
            name: "Unknown".to_string(),
            bundle_id: "unknown.bundle.id".to_string(),
        }
    }
}

static SWITCH_SENDER: OnceLock<Mutex<Option<Sender<FrontmostApp>>>> = OnceLock::new();

pub fn set_switch_sender(sender: Sender<FrontmostApp>) {
    let _ = SWITCH_SENDER.set(Mutex::new(Some(sender)));
}

pub(crate) fn send_switch(app: FrontmostApp) {
    if let Some(m) = SWITCH_SENDER.get() {
        if let Some(sender) = m.lock().unwrap().as_ref() {
            let _ = sender.send(app);
        }
    }
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{get_frontmost_app, spawn_switch_observer};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{get_frontmost_app, spawn_switch_observer};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod fallback;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::{get_frontmost_app, spawn_switch_observer};
