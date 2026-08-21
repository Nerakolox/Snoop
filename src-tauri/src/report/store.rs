//! 报告存储（Task 2）—— `daily_reports` 表的读写。
//!
//! # 三档语义（见执行单 Task 2）
//!
//! - `foreground_ms == 0`（当天 0 桶，等于没采集）→ 「无记录」，**完全不落行**、列表不显示。
//! - `0 < active_ms <` [`MIN_ACTIVE_MS`] → 「记录太少」，落 `status='too_little'` 行
//!   （不调 AI、`narrative` 为 NULL，列表显示灰色条目）。
//! - `active_ms >=` [`MIN_ACTIVE_MS`] → 正常报告，落 `status='ok'` 行。

use rusqlite::{params, Connection, Result};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// 「记录太少」阈值：当天活跃时长不足 30 分钟不生成完整报告、也不调 AI。
pub const MIN_ACTIVE_MS: i64 = 30 * 60 * 1000;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `daily_reports` 的一行。
#[derive(Clone, Serialize)]
pub struct ReportRow {
    pub report_date: String,
    pub report_type: String,
    /// `ok` | `too_little`。
    pub status: String,
    pub generated_at_ms: i64,
    /// 反规范化列：列表直接读，不 parse JSON。
    pub active_ms: i64,
    pub foreground_ms: i64,
    /// `DailyReport` 全量序列化。
    pub data_json: String,
    /// AI 或模板文案（`too_little` 为 None）。
    pub narrative: Option<String>,
    /// `ai` | `template`（`too_little` 为 None）。
    pub narrative_source: Option<String>,
}

fn row_to_report(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReportRow> {
    Ok(ReportRow {
        report_date: row.get(0)?,
        report_type: row.get(1)?,
        status: row.get(2)?,
        generated_at_ms: row.get(3)?,
        active_ms: row.get(4)?,
        foreground_ms: row.get(5)?,
        data_json: row.get(6)?,
        narrative: row.get(7)?,
        narrative_source: row.get(8)?,
    })
}

const COLS: &str = "report_date, report_type, status, generated_at_ms, \
    active_ms, foreground_ms, data_json, narrative, narrative_source";

/// 插入或覆盖（同 (report_date, report_type) 只保留一条）。
pub fn upsert(conn: &Connection, r: &ReportRow) -> Result<()> {
    conn.execute(
        "INSERT INTO daily_reports
         (report_date, report_type, status, generated_at_ms, active_ms, foreground_ms,
          data_json, narrative, narrative_source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(report_date, report_type) DO UPDATE SET
             status = excluded.status,
             generated_at_ms = excluded.generated_at_ms,
             active_ms = excluded.active_ms,
             foreground_ms = excluded.foreground_ms,
             data_json = excluded.data_json,
             narrative = excluded.narrative,
             narrative_source = excluded.narrative_source",
        params![
            r.report_date,
            r.report_type,
            r.status,
            r.generated_at_ms,
            r.active_ms,
            r.foreground_ms,
            r.data_json,
            r.narrative,
            r.narrative_source,
        ],
    )?;
    Ok(())
}

pub fn exists(conn: &Connection, date: &str, rtype: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM daily_reports WHERE report_date = ?1 AND report_type = ?2)",
        params![date, rtype],
        |r| r.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

pub fn get(conn: &Connection, date: &str, rtype: &str) -> Result<Option<ReportRow>> {
    let sql = format!("SELECT {COLS} FROM daily_reports WHERE report_date = ?1 AND report_type = ?2");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![date, rtype], row_to_report)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn list(conn: &Connection) -> Result<Vec<ReportRow>> {
    let sql = format!("SELECT {COLS} FROM daily_reports ORDER BY report_date DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_report)?;
    rows.collect()
}
