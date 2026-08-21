//! 报告命令（Task 4）—— 暴露给前端的 Tauri 命令。
//!
//! 与顶层 `commands.rs` / `ai::commands.rs` 一致：命令按需打开自己的 SQLite 连接
//! （短生命周期），命名 snake_case，前端 `invoke` 同名调用。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::ai::AiState;
use crate::commands::DbPath;
use crate::report::{store, ReportView};

fn open_db(state: &State<'_, DbPath>) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(&state.0).map_err(|e| e.to_string())
}

/// 报告列表的一行元数据（不 parse data_json，反规范化列直接读）。
#[derive(Serialize)]
pub struct ReportMeta {
    pub report_date: String,
    pub report_type: String,
    /// `ok` | `too_little`。
    pub status: String,
    pub generated_at_ms: i64,
    pub active_ms: i64,
    pub foreground_ms: i64,
    pub narrative_source: Option<String>,
}

/// 全部已生成报告（含 `too_little`），按日期降序。
#[tauri::command]
pub fn get_report_list(state: State<'_, DbPath>) -> Result<Vec<ReportMeta>, String> {
    let conn = open_db(&state)?;
    let rows = store::list(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| ReportMeta {
            report_date: r.report_date,
            report_type: r.report_type,
            status: r.status,
            generated_at_ms: r.generated_at_ms,
            active_ms: r.active_ms,
            foreground_ms: r.foreground_ms,
            narrative_source: r.narrative_source,
        })
        .collect())
}

/// 取某个报告的完整内容（含叙事）。无行返回 `None`。
///
/// `data` 原样透传 `data_json`（三种报形状不同，前端靠 `report_type` 收窄）。
#[tauri::command]
pub fn get_report(
    state: State<'_, DbPath>,
    report_date: String,
    report_type: Option<String>,
) -> Result<Option<ReportView>, String> {
    let conn = open_db(&state)?;
    let rtype = report_type.unwrap_or_else(|| "day".to_string());
    let row = store::get(&conn, &report_date, &rtype).map_err(|e| e.to_string())?;
    match row {
        None => Ok(None),
        Some(r) => {
            let data: serde_json::Value =
                serde_json::from_str(&r.data_json).map_err(|e| e.to_string())?;
            Ok(Some(ReportView {
                report_type: r.report_type,
                data,
                narrative: r.narrative,
                narrative_source: r.narrative_source,
            }))
        }
    }
}

/// 手动重新生成某个报告（重算 + 重调 AI + 覆盖落库）。
#[tauri::command]
pub async fn regenerate_report(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
    report_date: String,
    report_type: Option<String>,
) -> Result<ReportView, String> {
    let ai = state.inner().clone();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    let rtype = report_type.unwrap_or_else(|| "day".to_string());
    match crate::report::generate_report(&ai.config, &ai.code_map, &db_path, &report_date, &rtype)
        .await
    {
        Ok(Some(view)) => Ok(view),
        Ok(None) => Err("这个周期没有采集记录".to_string()),
        Err(e) => Err(e),
    }
}
