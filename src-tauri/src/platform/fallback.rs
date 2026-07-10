use super::FrontmostApp;

pub fn get_frontmost_app() -> FrontmostApp {
    FrontmostApp::unknown()
}

pub fn spawn_switch_observer() {
    // 未支持的平台没有事件通知；只靠 activity_tracker 的 300ms 轮询兜底
}
