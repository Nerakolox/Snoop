//! 三种报告的叙事文案（日报 / 周报 / 月报）。
//!
//! **核心原则**：算术全在本机，LLM 只负责措辞。所有数字由 [`daily`] / [`weekly`] /
//! [`monthly`] 算好，这里把已经确定的事实组织成 payload，走 [`envelope::call_ai`]
//! 单一出口（日报 `ai.daily-report`、周报 `ai.weekly-report`、月报 `ai.monthly-report`）；
//! 失败 / tier 不足 / 功能关闭时落到本地模板（T0 兜底）。
//!
//! 三份报问的问题不同，prompt 的侧重点也不同：日报讲**叙事**，周报讲**对比**，
//! 月报讲**趋势**。周报 / 月报多一条硬禁令：不对趋势 / 作息做价值判断 ——
//! 说「开发占比上升」，不说「你越来越专注了」；「通宵」只是中性事实，不是「熬夜」。

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::ai::config::AiConfigState;
use crate::ai::envelope::{self, AiCodeMap};
use crate::report::daily::DailyReport;
use crate::report::monthly::MonthlyReport;
use crate::report::weekly::WeeklyReport;

/// 叙事 system prompt。数字全部由 facts 提供，模型只措辞、不许算、不许评。
const SYSTEM_PROMPT: &str = "你是 Snoop 里的猫，陪用户回顾一天。facts 是已经算好的确定事实，数字全部正确。你的唯一任务是把它组织成 100–150 字的中文叙事，语气是陪伴、观察，不是监工、不是绩效报告。\n\
禁止：自己计算、推断或改写任何数字；编造 facts 里没有的事实；评判用户（不说「效率低」「浪费时间」「摸鱼」「发呆」「浪费」）；把「前台无输入的时间」说成负面（它可能是开会、阅读、看视频、思考）；提到窗口标题。\n\
输出一段纯文本，不要标题、列表、emoji。";

/// 周报 system prompt：**重点是「这周和平时比如何」，不是复述这周发生了什么。**
const WEEKLY_SYSTEM_PROMPT: &str = "你是 Snoop 里的猫，陪用户回顾这一周。facts 是已经算好的确定事实，数字全部正确。你的唯一任务是把它组织成 120–180 字的中文叙事。\n\
这是周报，重点是「这周和平时比如何」，不是复述这周发生了什么。优先讲差异：和前几周的偏差、一周内部的起伏、作息的变化；没有差异可讲时才讲绝对值。\n\
禁止：自己计算、推断或改写任何数字；编造 facts 里没有的事实；评判用户（不说「效率低」「浪费时间」「摸鱼」「发呆」「自律」「进步」）；把「前台无输入的时间」说成负面（它可能是开会、阅读、看视频、思考）；提到窗口标题；对作息下价值判断（「通宵」只能作为中性事实陈述，不许写成「熬夜」「作息紊乱」「要注意身体」）。\n\
输出一段纯文本，不要标题、列表、emoji。";

/// 月报 system prompt：**重点是「变化趋势」。**
const MONTHLY_SYSTEM_PROMPT: &str = "你是 Snoop 里的猫，陪用户回顾这个月。facts 是已经算好的确定事实，数字全部正确。你的唯一任务是把它组织成 120–180 字的中文叙事。\n\
这是月报，重点是「变化趋势」。优先讲走势：按周的起伏、上半月与下半月的占比变化。趋势就是趋势，不许对趋势做价值判断 —— 说「开发占比上升」，不许说「你越来越专注了」或「社交时间被挤压了」，好坏由用户自己判断。\n\
标了 partial 的周是被月初/月末截断的半截周，讲走势时要么跳过、要么说明它不完整，不许把它当成「这周活跃度暴跌」。\n\
禁止：自己计算、推断或改写任何数字；编造 facts 里没有的事实；评判用户（不说「效率低」「浪费时间」「摸鱼」「发呆」「自律」「进步」）；把「前台无输入的时间」说成负面；提到窗口标题；对作息下价值判断。\n\
输出一段纯文本，不要标题、列表、emoji。";

/// 生成叙事：优先 AI，失败回落到本地模板。返回 `(文案, "ai" | "template")`。
pub async fn generate_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &DailyReport,
) -> (String, String) {
    let payload = build_payload(code_map, report);
    let result = envelope::call_ai(config, code_map, db_path, "ai.daily-report", payload, false).await;
    if result.ok {
        if let Some(content) = result.content {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return (trimmed.to_string(), "ai".to_string());
            }
        }
    }
    (template_narrative(report), "template".to_string())
}

/// 构造 T3 形状 payload。应用引用用**稳定代号**（信封层回映成真名），
/// 数字全部是已算好的事实；分类名是固定 11 类 taxonom、非应用名，可放 facts。
fn build_payload(code_map: &Mutex<AiCodeMap>, report: &DailyReport) -> Value {
    // 叙事里要引用的应用 = Top 应用 + 新应用，去重，统一分配代号。
    let mut apps_list: Vec<(String, String)> = Vec::new(); // (bundle_id, name)
    let mut seen = std::collections::HashSet::new();
    for a in &report.top_apps {
        if seen.insert(a.bundle_id.clone()) {
            apps_list.push((a.bundle_id.clone(), a.name.clone()));
        }
    }
    for a in &report.new_apps {
        if seen.insert(a.bundle_id.clone()) {
            apps_list.push((a.bundle_id.clone(), a.name.clone()));
        }
    }

    let code_by_id: std::collections::HashMap<String, String> = {
        let mut map = code_map.lock().unwrap();
        apps_list
            .iter()
            .map(|(id, _)| (id.clone(), map.ensure_code(id)))
            .collect()
    };

    let apps: Vec<Value> = apps_list
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "windows": [] }))
        .collect();

    let facts = json!({
        "date": date_label(&report.date),
        "active_minutes": report.active_ms / 60_000,
        "switch_count": report.switch_count,
        "top_apps": report.top_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "minutes": a.active_ms / 60_000,
            "share_pct": round1(a.share_pct),
        })).collect::<Vec<_>>(),
        "categories": report.categories.iter().map(|c| json!({
            "category": category_label(&c.category),
            "share_pct": round1(c.share_pct),
        })).collect::<Vec<_>>(),
        "peak_hour": report.peak_hour,
        "longest_focus_minutes": report.longest_focus.duration_ms / 60_000,
        "vs_7d": json!({
            "active_delta_pct": round1(report.vs_7d.active_delta_pct),
            "switch_delta_pct": round1(report.vs_7d.switch_delta_pct),
        }),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    });

    json!({
        "system_prompt": SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
    })
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn category_label(cat: &str) -> String {
    crate::app_classify::Category::from_str(cat)
        .map(|c| c.label().to_string())
        .unwrap_or_else(|| cat.to_string())
}

/// 时长 → 「X 小时 Y 分」/「Y 分钟」。
fn fmt_duration(ms: i64) -> String {
    let total_min = ms / 60_000;
    let h = total_min / 60;
    let m = total_min % 60;
    if h > 0 {
        format!("{h} 小时 {m} 分")
    } else {
        format!("{m} 分钟")
    }
}

/// 'YYYY-MM-DD' → 「M月D日」。仅用于叙事文案，不做时区运算。
fn date_label(date: &str) -> String {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() == 3 {
        let m: i64 = parts[1].parse().unwrap_or(0);
        let d: i64 = parts[2].parse().unwrap_or(0);
        if m > 0 && d > 0 {
            return format!("{m}月{d}日");
        }
    }
    date.to_string()
}

/// 本地模板兜底叙事。数字全部来自已算好的 `DailyReport`，这里只拼句。
pub fn template_narrative(r: &DailyReport) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!(
        "{}你活跃了 {}，切换了 {} 次应用。",
        date_label(&r.date),
        fmt_duration(r.active_ms),
        r.switch_count
    ));

    if let Some(top) = r.top_apps.first() {
        let mut s = format!("在 {} 待得最久（占 {:.0}%）", top.name, top.share_pct);
        if let Some(second) = r.top_apps.get(1) {
            s.push_str(&format!("，之后是 {}", second.name));
        }
        s.push('。');
        parts.push(s);
    }

    if r.active_ms > 0 {
        parts.push(format!("{}:00 前后最有干劲。", r.peak_hour));
    }

    if r.longest_focus.duration_ms > 0 {
        parts.push(format!(
            "最长一口气专注了 {}。",
            fmt_duration(r.longest_focus.duration_ms)
        ));
    }

    if r.vs_7d.avg_active_ms > 0 {
        let d = r.vs_7d.active_delta_pct;
        let cmp = if d >= 0.0 {
            format!("多 {:.0}%", d)
        } else {
            format!("少 {:.0}%", -d)
        };
        parts.push(format!("比最近一周平均{cmp}。"));
    }

    if parts.is_empty() {
        "这一天还没有足够的数据。".to_string()
    } else {
        parts.join("")
    }
}

// ── 周报 ────────────────────────────────────────────────────────────────────

/// 生成周报叙事：优先 AI，失败回落模板。返回 `(文案, "ai" | "template")`。
pub async fn generate_weekly_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &WeeklyReport,
) -> (String, String) {
    let payload = build_weekly_payload(code_map, report);
    let result =
        envelope::call_ai(config, code_map, db_path, "ai.weekly-report", payload, false).await;
    if result.ok {
        if let Some(content) = result.content {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return (trimmed.to_string(), "ai".to_string());
            }
        }
    }
    (template_weekly_narrative(report), "template".to_string())
}

fn build_weekly_payload(code_map: &Mutex<AiCodeMap>, report: &WeeklyReport) -> Value {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for a in &report.top_apps {
        pairs.push((a.bundle_id.clone(), a.name.clone()));
    }
    for a in &report.new_apps {
        pairs.push((a.bundle_id.clone(), a.name.clone()));
    }
    for a in &report.gone_apps {
        pairs.push((a.bundle_id.clone(), a.name.clone()));
    }

    let code_by_id: std::collections::HashMap<String, String> = {
        let mut map = code_map.lock().unwrap();
        pairs
            .iter()
            .map(|(id, _)| (id.clone(), map.ensure_code(id)))
            .collect()
    };
    let apps: Vec<Value> = pairs
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "windows": [] }))
        .collect();

    let mut facts = json!({
        "week_label": week_label(&report.week_start, &report.week_end),
        "active_minutes": report.active_ms / 60_000,
        "avg_daily_minutes": report.avg_daily_active_ms / 60_000,
        "days_with_data": report.days_with_data,
        "vs_baseline": json!({
            "daily_delta_pct": round1(report.baseline.daily_delta_pct),
            "weeks_counted": report.baseline.weeks_counted,
        }),
        "days": report.days.iter().map(|d| json!({
            "dow": weekday_label(d.dow),
            "minutes": d.active_ms / 60_000,
        })).collect::<Vec<_>>(),
        "max_day": report.max_day.as_ref().map(|s| date_label(s)),
        "min_day": report.min_day.as_ref().map(|s| date_label(s)),
        "categories": report.categories.iter().map(|c| json!({
            "category": category_label(&c.category),
            "share_pct": round1(c.share_pct),
            "delta_pp": round1(c.share_delta_pp),
        })).collect::<Vec<_>>(),
        "weekday_vs_weekend": json!({
            "weekday_avg_minutes": report.weekday_weekend.weekday_avg_active_ms / 60_000,
            "weekend_avg_minutes": report.weekday_weekend.weekend_avg_active_ms / 60_000,
        }),
        "top_apps": report.top_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "minutes": a.active_ms / 60_000,
            "share_pct": round1(a.share_pct),
        })).collect::<Vec<_>>(),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
        "gone_apps": report.gone_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    });

    // 作息天数够（≥ 3）才把作息块放进 facts —— 不给模型没有的数据，它就不会编。
    if report.rhythm_summary.days_counted >= crate::report::common::MIN_RHYTHM_DAYS {
        facts["rhythm"] = json!({
            "days_counted": report.rhythm_summary.days_counted,
            "avg_start": report.rhythm_summary.avg_start_min.map(fmt_min_of_day),
            "avg_end": report.rhythm_summary.avg_end_min.map(fmt_min_of_day),
            "start_delta_min": report.rhythm_summary.start_delta_min,
            "end_delta_min": report.rhythm_summary.end_delta_min,
            "overnight_days": report.rhythm_summary.overnight_days,
        });
    }

    json!({
        "system_prompt": WEEKLY_SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
    })
}

/// 本地模板：周报讲对比。数字全部来自已算好的 `WeeklyReport`，这里只拼句。
pub fn template_weekly_narrative(r: &WeeklyReport) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!(
        "这周你活跃了 {}，日均 {}{}。",
        fmt_duration(r.active_ms),
        fmt_duration(r.avg_daily_active_ms),
        daily_delta_clause(r.baseline.avg_daily_active_ms, r.avg_daily_active_ms)
    ));

    if let Some(d) = &r.max_day {
        parts.push(format!("{}待得最久。", date_label(d)));
    }

    if let Some(dev) = r
        .categories
        .iter()
        .max_by(|a, b| a.share_delta_pp.abs().partial_cmp(&b.share_delta_pp.abs()).unwrap_or(std::cmp::Ordering::Equal))
    {
        if dev.share_delta_pp.abs() >= 0.5 {
            let dir = if dev.share_delta_pp >= 0.0 { "高" } else { "低" };
            parts.push(format!(
                "{}占比 {:.0}%，比前 4 周{dir} {:.0}pp。",
                category_label(&dev.category),
                dev.share_pct,
                dev.share_delta_pp.abs()
            ));
        }
    }

    if r.rhythm_summary.days_counted >= crate::report::common::MIN_RHYTHM_DAYS {
        if let (Some(s), Some(e)) = (r.rhythm_summary.avg_start_min, r.rhythm_summary.avg_end_min)
        {
            let mut s = format!(
                "平均 {} 开工、{} 停下（基于 {} 天）",
                fmt_min_of_day(s),
                fmt_min_of_day(e),
                r.rhythm_summary.days_counted
            );
            if let Some(d) = r.rhythm_summary.end_delta_min {
                s.push_str(&format!("，比平时{}", signed_min_label(d)));
            }
            s.push('。');
            parts.push(s);
        }
        if r.rhythm_summary.overnight_days > 0 {
            parts.push(format!(
                "另有 {} 天通宵，未计入均值。",
                r.rhythm_summary.overnight_days
            ));
        }
    }

    if let Some(top) = r.top_apps.first() {
        parts.push(format!("在 {} 待得最久。", top.name));
    }

    if parts.is_empty() {
        "这一周还没有足够的数据。".to_string()
    } else {
        parts.join("")
    }
}

// ── 月报 ────────────────────────────────────────────────────────────────────

/// 生成月报叙事：优先 AI，失败回落模板。返回 `(文案, "ai" | "template")`。
pub async fn generate_monthly_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &MonthlyReport,
) -> (String, String) {
    let payload = build_monthly_payload(code_map, report);
    let result =
        envelope::call_ai(config, code_map, db_path, "ai.monthly-report", payload, false).await;
    if result.ok {
        if let Some(content) = result.content {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return (trimmed.to_string(), "ai".to_string());
            }
        }
    }
    (template_monthly_narrative(report), "template".to_string())
}

fn build_monthly_payload(code_map: &Mutex<AiCodeMap>, report: &MonthlyReport) -> Value {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in &report.top_apps {
        if seen.insert(a.bundle_id.clone()) {
            pairs.push((a.bundle_id.clone(), a.name.clone()));
        }
    }
    for a in &report.new_apps {
        if seen.insert(a.bundle_id.clone()) {
            pairs.push((a.bundle_id.clone(), a.name.clone()));
        }
    }

    let code_by_id: std::collections::HashMap<String, String> = {
        let mut map = code_map.lock().unwrap();
        pairs
            .iter()
            .map(|(id, _)| (id.clone(), map.ensure_code(id)))
            .collect()
    };
    let apps: Vec<Value> = pairs
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "windows": [] }))
        .collect();

    let facts = json!({
        "month_label": month_label(&report.month_start),
        "active_minutes": report.active_ms / 60_000,
        "avg_daily_minutes": report.avg_daily_active_ms / 60_000,
        "days_with_data": report.days_with_data,
        "vs_prev_month": json!({ "daily_delta_pct": round1(report.prev_month.daily_delta_pct) }),
        "weeks": report.weeks.iter().map(|w| json!({
            "label": week_label(&w.clip_from, &w.clip_to),
            "minutes": w.active_ms / 60_000,
            "partial": w.partial,
            "days_in_month": w.days_in_month,
        })).collect::<Vec<_>>(),
        "half_shift": report.half_shift.iter().map(|c| json!({
            "category": category_label(&c.category),
            "first_half_share_pct": round1(c.first_half_share_pct),
            "second_half_share_pct": round1(c.second_half_share_pct),
            "delta_pp": round1(c.delta_pp),
        })).collect::<Vec<_>>(),
        "max_day": report.max_day.as_ref().map(|d| json!({
            "date": date_label(&d.date), "minutes": d.active_ms / 60_000,
        })),
        "min_day": report.min_day.as_ref().map(|d| json!({
            "date": date_label(&d.date), "minutes": d.active_ms / 60_000,
        })),
        "categories": report.categories.iter().map(|c| json!({
            "category": category_label(&c.category),
            "share_pct": round1(c.share_pct),
        })).collect::<Vec<_>>(),
        "top_apps": report.top_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "minutes": a.active_ms / 60_000,
            "share_pct": round1(a.share_pct),
        })).collect::<Vec<_>>(),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    });

    json!({
        "system_prompt": MONTHLY_SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
    })
}

/// 本地模板：月报讲趋势。数字全部来自已算好的 `MonthlyReport`，这里只拼句。
pub fn template_monthly_narrative(r: &MonthlyReport) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!(
        "{}你活跃了 {}，日均 {}{}，有记录 {} 天。",
        month_label(&r.month_start),
        fmt_duration(r.active_ms),
        fmt_duration(r.avg_daily_active_ms),
        daily_delta_clause(r.prev_month.avg_daily_active_ms, r.avg_daily_active_ms),
        r.days_with_data
    ));

    if let Some(shift) = r.half_shift.first() {
        if shift.delta_pp.abs() >= 0.5 {
            parts.push(format!(
                "{}占比从上半月的 {:.0}% {}到下半月的 {:.0}%。",
                category_label(&shift.category),
                shift.first_half_share_pct,
                if shift.delta_pp >= 0.0 { "涨" } else { "落" },
                shift.second_half_share_pct
            ));
        }
    }

    if let (Some(max), Some(min)) = (&r.max_day, &r.min_day) {
        parts.push(format!(
            "最活跃是 {}（{}），最安静是 {}（{}）。",
            date_label(&max.date),
            fmt_duration(max.active_ms),
            date_label(&min.date),
            fmt_duration(min.active_ms)
        ));
    }

    if let Some(top) = r.top_apps.first() {
        parts.push(format!("在 {} 待得最久。", top.name));
    }

    if parts.is_empty() {
        "这个月还没有足够的数据。".to_string()
    } else {
        parts.join("")
    }
}

// ── 文案小工具 ──────────────────────────────────────────────────────────────

/// 日均对比句的尾巴：「，比前 4 周日均多 12%」/「，比上月日均少 8%」。基线为 0 时为空。
fn daily_delta_clause(baseline_avg: i64, current_avg: i64) -> String {
    if baseline_avg <= 0 {
        return String::new();
    }
    let d = delta_pct(current_avg, baseline_avg);
    format!("，比平时{}", signed_pct_label(d))
}

fn delta_pct(current: i64, baseline: i64) -> f64 {
    (current - baseline) as f64 / baseline as f64 * 100.0
}

fn signed_pct_label(d: f64) -> String {
    if d >= 0.0 {
        format!("多 {:.0}%", d)
    } else {
        format!("少 {:.0}%", -d)
    }
}

/// 带方向的分钟差：正 = 晚，负 = 早。作息语境下的「晚/早」，不用「多/少」。
fn signed_min_label(delta: i32) -> String {
    if delta >= 0 {
        format!("晚 {} 分", delta)
    } else {
        format!("早 {} 分", -delta)
    }
}

/// 距自然日 00:00 的分钟数 → 可读时刻。≥ 1440 显示「次日 HH:MM」，不显示 24:41。
fn fmt_min_of_day(min: i32) -> String {
    let day = min.div_euclid(1440);
    let rem = min.rem_euclid(1440);
    let hh = rem / 60;
    let mm = rem % 60;
    if day > 0 {
        format!("次日 {:02}:{:02}", hh, mm)
    } else {
        format!("{:02}:{:02}", hh, mm)
    }
}

/// 周一起的下标（0=周一）→ 「周一」…「周日」。
fn weekday_label(dow: u8) -> String {
    const LABELS: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    LABELS.get(dow as usize).copied().unwrap_or("周一").to_string()
}

/// `'2026-08-17'..='2026-08-23'` → 「8月17日–8月23日」。
fn week_label(start: &str, end: &str) -> String {
    format!("{}–{}", date_label(start), date_label(end))
}

/// `'2026-08-01'` → 「2026年8月」。
fn month_label(month_start: &str) -> String {
    let parts: Vec<&str> = month_start.split('-').collect();
    if parts.len() >= 2 {
        if let (Ok(y), Ok(m)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
            return format!("{y}年{m}月");
        }
    }
    month_start.to_string()
}
