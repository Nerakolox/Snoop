//! 应用分类内置规则表 —— **纯数据，勿加逻辑**。
//!
//! 命中即用（`source = 'builtin'`），省调用、省等待、离线也能工作。
//! 维护约定：
//!   - 每行是 `(keyword, category_id)`，keyword 对「应用名」和「bundle_id(exe 路径)」
//!     做**大小写不敏感的子串匹配**，**先命中先赢**。
//!   - 更具体的关键词放前面（如「迅雷影音」必须排在「迅雷」之前，否则播放器会被
//!     误判成下载工具）。
//!   - 只放确定能覆盖的常见应用；拿不准的交给 AI 或「其他」，别硬塞。
//!
//! **规则住在 DB 而不是这个静态数组里。** 静态数组只是首次启动的种子：
//! 永久删除一个分类要求「清除 builtin 规则表中指向它的规则」，静态数组做不到。
//! 种子只灌一次（`app_meta` 打标记），此后用户删掉的规则不会被重新灌回来。

#![allow(dead_code)]

use std::sync::{Arc, OnceLock, RwLock};

use rusqlite::{Connection, Result};

/// 内置规则种子。顺序有意义：匹配时从上往下取第一个命中，落库时写进 `sort_order`。
pub static SEED_RULES: &[(&str, &str)] = &[
    // ── 浏览 browsing ──
    ("chrome", "browsing"),
    ("msedge", "browsing"),
    ("firefox", "browsing"),
    ("safari", "browsing"),
    ("arc browser", "browsing"),
    ("brave", "browsing"),
    // ── 开发 development ──
    ("visual studio code", "development"),
    ("code.exe", "development"),
    ("codex", "development"),
    ("warp", "development"),
    ("iterm", "development"),
    ("terminal", "development"),
    ("jetbrains", "development"),
    ("intellij", "development"),
    ("pycharm", "development"),
    ("webstorm", "development"),
    ("goland", "development"),
    ("clion", "development"),
    ("sourcetree", "development"),
    ("electerm", "development"),
    // ── 沟通 communication ──
    ("weixin", "communication"),
    ("wechat", "communication"),
    ("微信", "communication"),
    ("腾讯会议", "communication"),
    ("wemeet", "communication"),
    ("qq", "communication"),
    ("slack", "communication"),
    ("discord", "communication"),
    ("telegram", "communication"),
    ("钉钉", "communication"),
    ("飞书", "communication"),
    // ── 娱乐 entertainment ──
    ("迅雷影音", "entertainment"),
    ("steam", "entertainment"),
    ("epic", "entertainment"),
    ("minecraft", "entertainment"),
    ("apex legends", "entertainment"),
    ("cyberpunk", "entertainment"),
    ("vlc", "entertainment"),
    ("cloudmusic", "entertainment"),
    ("网易云", "entertainment"),
    ("wallpaper engine", "entertainment"),
    // ── 设计 design ──
    ("figma", "design"),
    ("photoshop", "design"),
    ("illustrator", "design"),
    ("blender", "design"),
    ("obs studio", "design"),
    ("jianying", "design"),
    ("剪映", "design"),
    ("premiere", "design"),
    ("after effects", "design"),
    ("afterfx", "design"),
    ("davinci", "design"),
    // ── 文档 document ──
    ("excel", "document"),
    ("winword", "document"),
    ("powerpoint", "document"),
    ("microsoft word", "document"),
    ("notion", "document"),
    ("obsidian", "document"),
    ("office", "document"),
    // ── 系统 system ──
    ("explorer.exe", "system"),
    ("资源管理器", "system"),
    ("finder", "system"),
    ("snoop", "system"),
    ("taskmgr", "system"),
    ("任务管理器", "system"),
    ("onedrive", "system"),
    ("dropbox", "system"),
    ("nextcloud", "system"),
    ("winrar", "system"),
    ("clash", "system"),
    ("leigod", "system"),
    ("雷神", "system"),
    // 虚拟机
    ("vmware", "system"),
    ("parallels", "system"),
    ("virtualbox", "system"),
    ("hyper-v", "system"),
    ("utm", "system"),
    // 密码管理器
    ("1password", "system"),
    ("bitwarden", "system"),
    ("keepass", "system"),
    // ── 远程控制 remote ──
    ("todesk", "remote"),
    ("anydesk", "remote"),
    ("parsec", "remote"),
    ("teamviewer", "remote"),
    ("向日葵", "remote"),
    ("mstsc", "remote"),
    // ── AI 助手 ai_assistant ──
    ("chatgpt", "ai_assistant"),
    ("claude", "ai_assistant"),
    ("gemini", "ai_assistant"),
    // ── 下载工具 download ──
    ("internet download manager", "download"),
    ("idm", "download"),
    ("迅雷", "download"),
    ("thunder", "download"),
    ("qbittorrent", "download"),
];

/// 进程内规则缓存。
///
/// `resolve` 在「列全部应用」「算分类占比」这类循环里逐应用调用，每次都查一遍
/// 规则表会把 O(app) 变成 O(app × SQL)。规则只在永久删除分类时才变，所以缓存
/// 一份、变更时 [`invalidate`] 掉即可。
static CACHE: OnceLock<RwLock<Option<Arc<Vec<(String, String)>>>>> = OnceLock::new();

fn cache() -> &'static RwLock<Option<Arc<Vec<(String, String)>>>> {
    CACHE.get_or_init(|| RwLock::new(None))
}

/// 规则变更后必须调用，否则匹配还在用旧快照。
pub fn invalidate() {
    if let Ok(mut c) = cache().write() {
        *c = None;
    }
}

fn query_rules(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT keyword, category_id FROM builtin_rules ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// 取规则快照（首次调用查库，之后走缓存）。
///
/// 查库失败（例如老库还没建表、或测试用的临时库没建）一律当作**空规则表**，
/// 而不是回落到 `SEED_RULES`——回落会让用户永久删除掉的规则悄悄复活。
fn rules(conn: &Connection) -> Arc<Vec<(String, String)>> {
    if let Ok(c) = cache().read() {
        if let Some(v) = c.as_ref() {
            return v.clone();
        }
    }
    let loaded = Arc::new(query_rules(conn).unwrap_or_default());
    if let Ok(mut c) = cache().write() {
        *c = Some(loaded.clone());
    }
    loaded
}

/// 对应用名 + bundle_id 做大小写不敏感子串匹配，返回第一个命中规则的分类 id。
pub fn match_builtin(conn: &Connection, app_name: &str, bundle_id: &str) -> Option<String> {
    let hay = format!("{} {}", app_name, bundle_id).to_lowercase();
    rules(conn)
        .iter()
        .find(|(kw, _)| hay.contains(kw.as_str()))
        .map(|(_, cat)| cat.clone())
}

/// 删除全部指向某分类的规则（永久删除分类时调用）。返回删除行数。
pub fn delete_by_category(conn: &Connection, category_id: &str) -> Result<u64> {
    let n = conn.execute(
        "DELETE FROM builtin_rules WHERE category_id = ?1",
        [category_id],
    )?;
    invalidate();
    Ok(n as u64)
}

/// 统计指向某分类的规则条数（永久删除前的影响面提示用）。
pub fn count_by_category(conn: &Connection, category_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM builtin_rules WHERE category_id = ?1",
        [category_id],
        |r| r.get(0),
    )
}
