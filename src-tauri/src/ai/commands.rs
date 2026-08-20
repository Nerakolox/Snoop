//! AI 子系统暴露给前端的 Tauri 命令。
//!
//! 与顶层 `commands.rs` 一致：命令按需打开自己的 SQLite 连接（短生命周期）。
//! 命名沿用 snake_case，前端 `invoke` 直接以同名调用。

use tauri::State;

use crate::ai::audit::{self, AuditRecord};
use crate::commands::DbPath;

fn open_db(state: &State<'_, DbPath>) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(&state.0).map_err(|e| e.to_string())
}

// ─── 审计日志 ────────────────────────────────────────────────────────────────

/// 取最近 `limit` 条审计记录（默认 100，倒序）。
#[tauri::command]
pub fn query_ai_audit(state: State<'_, DbPath>, limit: Option<i64>) -> Result<Vec<AuditRecord>, String> {
    let conn = open_db(&state)?;
    audit::query(&conn, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

/// 导出全部审计记录（正序 JSON）。
#[tauri::command]
pub fn export_ai_audit(state: State<'_, DbPath>) -> Result<Vec<AuditRecord>, String> {
    let conn = open_db(&state)?;
    audit::export_all(&conn).map_err(|e| e.to_string())
}

/// 清空全部审计记录。
#[tauri::command]
pub fn clear_ai_audit(state: State<'_, DbPath>) -> Result<u64, String> {
    let conn = open_db(&state)?;
    audit::clear(&conn).map_err(|e| e.to_string())
}
