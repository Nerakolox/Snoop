//! AI 调用审计日志（Task 3）。
//!
//! 每次 AI 调用——**无论成功、失败、还是「因 tier 不足根本没发出」**——
//! 都落一行。这份日志是「什么数据离开了本机」的唯一可审计证据，
//! 也是隐私承诺比任何文案都有说服力的兑现方式。
//!
//! 表结构在 `db.rs::init_schema` 里创建（`ai_audit_log`），本模块只放读写逻辑。
//! 保留 30 天，超期在每次插入时顺带清理。

use rusqlite::{Connection, Result, params};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// 保留天数。
const RETENTION_DAYS: i64 = 30;
/// 保留时长（毫秒）。
const RETENTION_MS: i64 = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 一次调用要写入的完整记录（`call_ai` 组装好交进来）。
pub struct AuditEntry {
    pub created_at_ms: i64,
    pub feature_id: String,
    pub tier: String,
    /// 是否真的发出了 HTTP 请求。tier 不足 / 未配置时 false。
    pub sent: bool,
    /// 发出去的完整请求体 JSON（未发送时为 None）。
    pub request_json: Option<String>,
    /// 响应正文长度（字符）。
    pub response_len: Option<i64>,
    /// 是否成功拿到响应。
    pub success: bool,
    /// 失败分类（含 `not_sent_tier` / `not_configured` 等）。
    pub error_kind: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// 查询 / 导出返回的记录（含自增 id）。
#[derive(Debug, Serialize)]
pub struct AuditRecord {
    pub id: i64,
    pub created_at_ms: i64,
    pub feature_id: String,
    pub tier: String,
    pub sent: bool,
    pub request_json: Option<String>,
    pub response_len: Option<i64>,
    pub success: bool,
    pub error_kind: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditRecord> {
    Ok(AuditRecord {
        id: row.get(0)?,
        created_at_ms: row.get(1)?,
        feature_id: row.get(2)?,
        tier: row.get(3)?,
        sent: row.get::<_, i64>(4)? != 0,
        request_json: row.get(5)?,
        response_len: row.get(6)?,
        success: row.get::<_, i64>(7)? != 0,
        error_kind: row.get(8)?,
        prompt_tokens: row.get(9)?,
        completion_tokens: row.get(10)?,
        total_tokens: row.get(11)?,
        duration_ms: row.get(12)?,
    })
}

const COLS: &str = "id, created_at_ms, feature_id, tier, sent, request_json, response_len, \
                    success, error_kind, prompt_tokens, completion_tokens, total_tokens, duration_ms";

/// 写入一条审计记录，并顺带清理过期（>30 天）记录。
pub fn insert(conn: &Connection, e: &AuditEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO ai_audit_log
            (created_at_ms, feature_id, tier, sent, request_json, response_len, success,
             error_kind, prompt_tokens, completion_tokens, total_tokens, duration_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            e.created_at_ms, e.feature_id, e.tier, e.sent as i64, e.request_json,
            e.response_len, e.success as i64, e.error_kind, e.prompt_tokens,
            e.completion_tokens, e.total_tokens, e.duration_ms,
        ],
    )?;
    cleanup(conn, now_ms(), RETENTION_MS)?;
    Ok(())
}

/// 删除 `created_at_ms < cutoff` 的过期记录，返回删除行数。
pub fn cleanup(conn: &Connection, now_ms: i64, retention_ms: i64) -> Result<u64> {
    let cutoff = now_ms - retention_ms;
    conn.execute(
        "DELETE FROM ai_audit_log WHERE created_at_ms < ?1",
        [cutoff],
    )
    .map(|n| n as u64)
}

/// 按时间倒序取最近 `limit` 条。
pub fn query(conn: &Connection, limit: i64) -> Result<Vec<AuditRecord>> {
    let sql = format!("SELECT {COLS} FROM ai_audit_log ORDER BY created_at_ms DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit], row_to_record)?;
    rows.collect()
}

/// 导出全部（按时间正序，便于阅读/归档）。
pub fn export_all(conn: &Connection) -> Result<Vec<AuditRecord>> {
    let sql = format!("SELECT {COLS} FROM ai_audit_log ORDER BY created_at_ms ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_record)?;
    rows.collect()
}

/// 清空全部审计记录，返回删除行数。
pub fn clear(conn: &Connection) -> Result<u64> {
    conn.execute("DELETE FROM ai_audit_log", []).map(|n| n as u64)
}
