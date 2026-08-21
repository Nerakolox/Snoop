//! 报告模块（批次 4a）—— 日报数据算法 + 存储 + AI 叙事 + 命令。
//!
//! 核心原则：**算术全在本机，LLM 只负责措辞。** 所有数字、排名、时长、对比都由
//! [`daily`] 算好，AI 只把已经确定的事实组织成一段自然的话（见 [`narrative`]）。
//! 图表完全不依赖 AI，T0 下也能正常显示。

// 报告 API 由 Task 2（生成时机）/ Task 4（命令）分批接入消费方，落库前先放行未用告警。
#![allow(dead_code)]

pub mod daily;
pub mod narrative;
pub mod store;

use std::path::Path;
use std::sync::Mutex;

use crate::ai::config::AiConfigState;
use crate::ai::envelope::AiCodeMap;

use store::MIN_ACTIVE_MS;

/// 每天首次启动时后台生成「昨天」的日报（执行单 Task 2 / Task 3）。
///
/// 流程：已生成则跳过 → 计算 → 三档分流：
/// - 无记录（当天 0 桶）→ 不落行；
/// - 记录太少（活跃 < 30 分钟）→ 落 `too_little` 行，不调 AI；
/// - 正常 → 落 `ok` 行，叙事走 AI（`ai.daily-report`），失败回落模板。
pub async fn maybe_generate_yesterday(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("❌ [Report] 打开数据库失败，跳过昨日日报生成: {e}");
            return;
        }
    };
    let _ = conn.execute("PRAGMA journal_mode=WAL", []);

    // 昨天的本地日。
    let yday: String = match conn.query_row("SELECT date('now','localtime','-1 day')", [], |r| r.get(0)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("❌ [Report] 取昨日日期失败: {e}");
            return;
        }
    };

    if store::exists(&conn, &yday, "day") {
        return; // 同一天只生成一次。
    }

    let report = match daily::compute_daily_report(&conn, &yday) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("❌ [Report] 计算 {yday} 日报失败: {e}");
            return;
        }
    };

    // 无记录（当天 0 桶）：不落任何行。
    if report.foreground_ms == 0 {
        return;
    }

    // 记录太少：落 too_little 行，不调 AI。
    let (status, narrative, narrative_source) = if report.active_ms < MIN_ACTIVE_MS {
        ("too_little", None, None)
    } else {
        let (text, source) = narrative::generate_narrative(config, code_map, db_path, &report).await;
        ("ok", Some(text), Some(source))
    };

    let row = store::ReportRow {
        report_date: yday,
        report_type: "day".to_string(),
        status: status.to_string(),
        generated_at_ms: store::now_ms(),
        active_ms: report.active_ms,
        foreground_ms: report.foreground_ms,
        data_json: serde_json::to_string(&report).unwrap_or_default(),
        narrative,
        narrative_source,
    };
    if let Err(e) = store::upsert(&conn, &row) {
        eprintln!("❌ [Report] 落库 {status} 日报失败: {e}");
    }
}
