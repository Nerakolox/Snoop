//! 应用分类内置规则表 —— **纯数据，勿加逻辑**。
//!
//! 命中即用（`source = 'builtin'`），省调用、省等待、离线也能工作。
//! 维护约定：
//!   - 每行是 `(keyword, Category)`，keyword 对「应用名」和「bundle_id(exe 路径)」
//!     做**大小写不敏感的子串匹配**，**先命中先赢**。
//!   - 更具体的关键词放前面（如「迅雷影音」必须排在「迅雷」之前，否则播放器会被
//!     误判成下载工具）。
//!   - 只放确定能覆盖的常见应用；拿不准的交给 AI 或 `Other`，别硬塞。

// Task 2/3 接入前，builtin 规则表暂无人调用。
#![allow(dead_code)]

use super::Category;

/// 内置规则表。顺序有意义：`match_builtin` 从上往下取第一个命中。
pub static BUILTIN_RULES: &[(&str, Category)] = &[
    // ── 浏览 browsing ──
    ("chrome", Category::Browsing),
    ("msedge", Category::Browsing),
    ("firefox", Category::Browsing),
    ("safari", Category::Browsing),
    ("arc browser", Category::Browsing),
    ("brave", Category::Browsing),
    // ── 开发 development ──
    ("visual studio code", Category::Development),
    ("code.exe", Category::Development),
    ("codex", Category::Development),
    ("warp", Category::Development),
    ("iterm", Category::Development),
    ("terminal", Category::Development),
    ("jetbrains", Category::Development),
    ("intellij", Category::Development),
    ("pycharm", Category::Development),
    ("webstorm", Category::Development),
    ("goland", Category::Development),
    ("clion", Category::Development),
    ("sourcetree", Category::Development),
    ("electerm", Category::Development),
    // ── 沟通 communication ──
    ("weixin", Category::Communication),
    ("wechat", Category::Communication),
    ("微信", Category::Communication),
    ("腾讯会议", Category::Communication),
    ("wemeet", Category::Communication),
    ("qq", Category::Communication),
    ("slack", Category::Communication),
    ("discord", Category::Communication),
    ("telegram", Category::Communication),
    ("钉钉", Category::Communication),
    ("飞书", Category::Communication),
    // ── 娱乐 entertainment ──
    ("迅雷影音", Category::Entertainment),
    ("steam", Category::Entertainment),
    ("epic", Category::Entertainment),
    ("minecraft", Category::Entertainment),
    ("apex legends", Category::Entertainment),
    ("cyberpunk", Category::Entertainment),
    ("vlc", Category::Entertainment),
    ("cloudmusic", Category::Entertainment),
    ("网易云", Category::Entertainment),
    ("wallpaper engine", Category::Entertainment),
    // ── 设计 design ──
    ("figma", Category::Design),
    ("photoshop", Category::Design),
    ("illustrator", Category::Design),
    ("blender", Category::Design),
    ("obs studio", Category::Design),
    ("jianying", Category::Design),
    ("剪映", Category::Design),
    ("premiere", Category::Design),
    ("after effects", Category::Design),
    ("afterfx", Category::Design),
    ("davinci", Category::Design),
    // ── 文档 document ──
    ("excel", Category::Document),
    ("winword", Category::Document),
    ("powerpoint", Category::Document),
    ("microsoft word", Category::Document),
    ("notion", Category::Document),
    ("obsidian", Category::Document),
    ("office", Category::Document),
    // ── 系统 system ──
    ("explorer.exe", Category::System),
    ("资源管理器", Category::System),
    ("finder", Category::System),
    ("snoop", Category::System),
    ("taskmgr", Category::System),
    ("任务管理器", Category::System),
    ("onedrive", Category::System),
    ("dropbox", Category::System),
    ("nextcloud", Category::System),
    ("winrar", Category::System),
    ("clash", Category::System),
    ("leigod", Category::System),
    ("雷神", Category::System),
    // 虚拟机
    ("vmware", Category::System),
    ("parallels", Category::System),
    ("virtualbox", Category::System),
    ("hyper-v", Category::System),
    ("utm", Category::System),
    // 密码管理器
    ("1password", Category::System),
    ("bitwarden", Category::System),
    ("keepass", Category::System),
    // ── 远程控制 remote ──
    ("todesk", Category::Remote),
    ("anydesk", Category::Remote),
    ("parsec", Category::Remote),
    ("teamviewer", Category::Remote),
    ("向日葵", Category::Remote),
    ("mstsc", Category::Remote),
    // ── AI 助手 ai_assistant ──
    ("chatgpt", Category::AiAssistant),
    ("claude", Category::AiAssistant),
    ("gemini", Category::AiAssistant),
    // ── 下载工具 download ──
    ("internet download manager", Category::Download),
    ("idm", Category::Download),
    ("迅雷", Category::Download),
    ("thunder", Category::Download),
    ("qbittorrent", Category::Download),
];

/// 对应用名 + bundle_id 做大小写不敏感子串匹配，返回第一个命中的类别。
pub fn match_builtin(app_name: &str, bundle_id: &str) -> Option<Category> {
    let hay = format!("{} {}", app_name, bundle_id).to_lowercase();
    BUILTIN_RULES
        .iter()
        .find(|(kw, _)| hay.contains(*kw))
        .map(|(_, c)| *c)
}
