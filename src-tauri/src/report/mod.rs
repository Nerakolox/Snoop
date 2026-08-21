//! 报告模块（批次 4a 日报 / 批次 6 周月报）—— 数据算法 + 存储 + AI 叙事 + 命令。
//!
//! 核心原则：**算术全在本机，LLM 只负责措辞。** 所有数字、排名、时长、对比都由
//! [`daily`] / [`weekly`] / [`monthly`] 算好，AI 只把已经确定的事实组织成一段自然的话
//! （见 [`narrative`]）。图表完全不依赖 AI，T0 下也能正常显示。
//!
//! 三种报回答三个不同的问题：日报讲「今天怎么过的」（叙事），周报讲「这周和平时比如何」
//! （对比），月报讲「变化趋势」（走势）。共用一张 `daily_reports` 表，靠 `report_type` 分流。

pub mod commands;
pub mod common;
pub mod daily;
pub mod monthly;
pub mod narrative;
pub mod store;
pub mod weekly;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::ai::config::AiConfigState;
use crate::ai::envelope::AiCodeMap;

use common::{MIN_MONTH_DAYS, MIN_WEEK_DAYS};
use store::MIN_ACTIVE_MS;

/// 给前端的报告视图（数据 + 叙事）。
///
/// `data` 用 [`Value`] 而不是 tagged enum：三种报的 `data` 形状不同，而 `get_report`
/// 从 `data_json` 取出来本来就只有字符串，转 `Value` 是零成本的；换成 tagged enum
/// 会改变 JSON 外形，前端要跟着改两处。前端靠 `report_type` 收窄联合类型。
#[derive(Serialize)]
pub struct ReportView {
    /// `day` | `week` | `month`。
    pub report_type: String,
    pub data: Value,
    pub narrative: Option<String>,
    pub narrative_source: Option<String>,
}

/// 三种报计算结果的统一外壳，让落库路径只写一遍。
enum Computed {
    Day(daily::DailyReport),
    Week(weekly::WeeklyReport),
    Month(monthly::MonthlyReport),
}

impl Computed {
    fn active_ms(&self) -> i64 {
        match self {
            Computed::Day(r) => r.active_ms,
            Computed::Week(r) => r.active_ms,
            Computed::Month(r) => r.active_ms,
        }
    }

    fn foreground_ms(&self) -> i64 {
        match self {
            Computed::Day(r) => r.foreground_ms,
            Computed::Week(r) => r.foreground_ms,
            Computed::Month(r) => r.foreground_ms,
        }
    }

    /// 各周期**规范化后**的报告日期：日报是当天，周报是周一，月报是月首日。
    ///
    /// 存的必须是规范化后的日期 —— 否则「按周三存了一行周报」会绕过
    /// `UNIQUE(report_date, report_type)`，同一周落出两行。
    fn report_date(&self) -> String {
        match self {
            Computed::Day(r) => r.date.clone(),
            Computed::Week(r) => r.week_start.clone(),
            Computed::Month(r) => r.month_start.clone(),
        }
    }

    fn report_type(&self) -> &'static str {
        match self {
            Computed::Day(_) => "day",
            Computed::Week(_) => "week",
            Computed::Month(_) => "month",
        }
    }

    /// 「记录太少」判定。**周月的阈值与日报不是一回事**：
    /// 日报看活跃时长（< 30 分钟），周月看有活跃记录的天数（< 3 天 / < 10 天）。
    /// 周月尺度上「时长少」很正常（一周只用了两小时也可能是真实的一周），
    /// 「天数少」才说明这个周期根本没被记录到，算不出对比与趋势。
    fn too_little(&self) -> bool {
        match self {
            Computed::Day(r) => r.active_ms < MIN_ACTIVE_MS,
            Computed::Week(r) => r.days_with_data < MIN_WEEK_DAYS,
            Computed::Month(r) => r.days_with_data < MIN_MONTH_DAYS,
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Computed::Day(r) => serde_json::to_value(r),
            Computed::Week(r) => serde_json::to_value(r),
            Computed::Month(r) => serde_json::to_value(r),
        }
        .unwrap_or(Value::Null)
    }
}

fn compute(conn: &rusqlite::Connection, date: &str, rtype: &str) -> Result<Computed, String> {
    match rtype {
        "day" => daily::compute_daily_report(conn, date)
            .map(Computed::Day)
            .map_err(|e| e.to_string()),
        "week" => weekly::compute_weekly_report(conn, date)
            .map(Computed::Week)
            .map_err(|e| e.to_string()),
        "month" => monthly::compute_monthly_report(conn, date)
            .map(Computed::Month)
            .map_err(|e| e.to_string()),
        other => Err(format!("未知的报告类型：{other}")),
    }
}

/// 计算某周期的报告、生成叙事、落库。三种报共用这一条路径。
///
/// - `Ok(None)`：无记录（整个周期 0 桶），**不落任何行**，列表天然不显示。
/// - `Ok(Some)`：`status='ok'` 或 `status='too_little'`（记录太少，无叙事、不调 AI）。
/// - `Err`：计算 / 落库失败。
pub async fn generate_report(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report_date: &str,
    report_type: &str,
) -> Result<Option<ReportView>, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let _ = conn.execute("PRAGMA journal_mode=WAL", []);

    let report = compute(&conn, report_date, report_type)?;

    // 无记录（整个周期 0 桶，等于没采集）：不落任何行。
    if report.foreground_ms() == 0 {
        return Ok(None);
    }

    let (status, narrative, narrative_source) = if report.too_little() {
        ("too_little", None, None)
    } else {
        match &report {
            Computed::Day(r) => {
                let (text, source) =
                    narrative::generate_narrative(config, code_map, db_path, r).await;
                ("ok", Some(text), Some(source))
            }
            Computed::Week(r) => {
                let (text, source) =
                    narrative::generate_weekly_narrative(config, code_map, db_path, r).await;
                ("ok", Some(text), Some(source))
            }
            Computed::Month(r) => {
                let (text, source) =
                    narrative::generate_monthly_narrative(config, code_map, db_path, r).await;
                ("ok", Some(text), Some(source))
            }
        }
    };

    let row = store::ReportRow {
        report_date: report.report_date(),
        report_type: report.report_type().to_string(),
        status: status.to_string(),
        generated_at_ms: store::now_ms(),
        active_ms: report.active_ms(),
        foreground_ms: report.foreground_ms(),
        data_json: serde_json::to_string(&report.to_json()).unwrap_or_default(),
        narrative: narrative.clone(),
        narrative_source: narrative_source.clone(),
    };
    store::upsert(&conn, &row).map_err(|e| e.to_string())?;

    Ok(Some(ReportView {
        report_type: row.report_type.clone(),
        data: report.to_json(),
        narrative,
        narrative_source,
    }))
}

// ── 启动时的生成时机 ─────────────────────────────────────────────────────────

/// 取一个 SQLite 算出来的本地日期（`SELECT` 一行一列）。
fn local_date(db_path: &Path, sql: &str) -> Option<String> {
    let conn = rusqlite::Connection::open(db_path).ok()?;
    conn.query_row(sql, [], |r| r.get::<_, String>(0)).ok()
}

/// 某个周期是否已经生成过。
fn already_generated(db_path: &Path, date: &str, rtype: &str) -> bool {
    match rusqlite::Connection::open(db_path) {
        Ok(conn) => store::exists(&conn, date, rtype),
        // 打不开库就当作已生成：启动路径上不该反复重试，报告也不是关键路径。
        Err(_) => true,
    }
}

async fn maybe_generate(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    date: Option<String>,
    rtype: &str,
    label: &str,
) {
    let Some(date) = date else {
        eprintln!("❌ [Report] 取{label}日期失败");
        return;
    };
    if already_generated(db_path, &date, rtype) {
        return; // 同一周期只生成一次。
    }
    if let Err(e) = generate_report(config, code_map, db_path, &date, rtype).await {
        eprintln!("❌ [Report] 生成{label}失败: {e}");
    }
}

/// 每天首次启动时后台生成「昨天」的日报。
pub async fn maybe_generate_yesterday(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    let date = local_date(db_path, "SELECT date('now','localtime','-1 day')");
    maybe_generate(config, code_map, db_path, date, "day", "昨日日报").await;
}

/// 每周首次启动时后台生成「上一周」的周报。
///
/// `'-6 days','weekday 1'` = 含今天那一周的周一，再 `-7 days` 就是上一周的周一
/// （周一起，与前端 `ranges.ts` / `context.tsx` / `date.ts` / `aggregate.ts` 一致）。
pub async fn maybe_generate_last_week(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    let date = local_date(
        db_path,
        "SELECT date('now','localtime','-6 days','weekday 1','-7 days')",
    );
    maybe_generate(config, code_map, db_path, date, "week", "上周周报").await;
}

/// 每月首次启动时后台生成「上一个月」的月报。
pub async fn maybe_generate_last_month(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    let date = local_date(db_path, "SELECT date('now','localtime','start of month','-1 month')");
    maybe_generate(config, code_map, db_path, date, "month", "上月月报").await;
}

/// 启动时补齐最近一个完整周期的三种报。
///
/// **必须顺序执行，不要 `join!`**：首次升级启动时三份报都缺，并发会同时打三个 AI 请求。
///
/// 「行不存在就生成」这一条同时实现了两件事：日常运行时「每天 / 每周 / 每月首次打开
/// 生成一次」，以及升级后首次启动就补上最近一个完整周期（那行本来就不存在）。
/// 更早的历史不回填 —— 与批次 4a 的日报策略一致，等用户反馈缺口再议。
pub async fn maybe_generate_on_startup(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) {
    maybe_generate_yesterday(config, code_map, db_path).await;
    maybe_generate_last_week(config, code_map, db_path).await;
    maybe_generate_last_month(config, code_map, db_path).await;
}
