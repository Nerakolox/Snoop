//! 报告模块（批次 4a）—— 日报数据算法 + 存储 + AI 叙事 + 命令。
//!
//! 核心原则：**算术全在本机，LLM 只负责措辞。** 所有数字、排名、时长、对比都由
//! [`daily`] 算好，AI 只把已经确定的事实组织成一段自然的话（见 [`narrative`]）。
//! 图表完全不依赖 AI，T0 下也能正常显示。

pub mod commands;
pub mod common;
pub mod daily;
pub mod narrative;
pub mod store;
pub mod weekly;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::ai::config::AiConfigState;
use crate::ai::envelope::AiCodeMap;
use crate::report::daily::DailyReport;

use store::MIN_ACTIVE_MS;

/// 给前端的报告视图（数据 + 叙事）。
#[derive(Serialize)]
pub struct ReportView {
    pub data: DailyReport,
    pub narrative: Option<String>,
    pub narrative_source: Option<String>,
}

/// 计算某日期日报、生成叙事、落库。
///
/// - `Ok(None)`：无记录（当天 0 桶），不落行。
/// - `Ok(Some)`：`status='ok'` 或 `status='too_little'`（记录太少，无叙事）。
/// - `Err`：计算 / 落库失败。
pub async fn generate_for_date(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    date: &str,
) -> Result<Option<ReportView>, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let _ = conn.execute("PRAGMA journal_mode=WAL", []);

    let report = daily::compute_daily_report(&conn, date).map_err(|e| e.to_string())?;

    // 无记录（当天 0 桶）：不落任何行。
    if report.foreground_ms == 0 {
        return Ok(None);
    }

    let (status, narrative, narrative_source) = if report.active_ms < MIN_ACTIVE_MS {
        ("too_little", None, None)
    } else {
        let (text, source) = narrative::generate_narrative(config, code_map, db_path, &report).await;
        ("ok", Some(text), Some(source))
    };

    let row = store::ReportRow {
        report_date: date.to_string(),
        report_type: "day".to_string(),
        status: status.to_string(),
        generated_at_ms: store::now_ms(),
        active_ms: report.active_ms,
        foreground_ms: report.foreground_ms,
        data_json: serde_json::to_string(&report).unwrap_or_default(),
        narrative: narrative.clone(),
        narrative_source: narrative_source.clone(),
    };
    store::upsert(&conn, &row).map_err(|e| e.to_string())?;

    Ok(Some(ReportView {
        data: report,
        narrative,
        narrative_source,
    }))
}

/// 每天首次启动时后台生成「昨天」的日报。
///
/// 流程：已生成则跳过 → 计算 → 三档分流（无记录不落行 / 记录太少落 `too_little` /
/// 正常落 `ok` 并配 AI 叙事，AI 失败回落模板）。
pub async fn maybe_generate_yesterday(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    let (yday, exists) = {
        let Ok(conn) = rusqlite::Connection::open(db_path) else {
            eprintln!("❌ [Report] 打开数据库失败，跳过昨日日报生成");
            return;
        };
        let Ok(yday) =
            conn.query_row("SELECT date('now','localtime','-1 day')", [], |r| r.get::<_, String>(0))
        else {
            eprintln!("❌ [Report] 取昨日日期失败");
            return;
        };
        let exists = store::exists(&conn, &yday, "day");
        (yday, exists)
    };

    if exists {
        return; // 同一天只生成一次。
    }

    match generate_for_date(config, code_map, db_path, &yday).await {
        Ok(_) => {}
        Err(e) => eprintln!("❌ [Report] 生成昨日日报失败: {e}"),
    }
}
