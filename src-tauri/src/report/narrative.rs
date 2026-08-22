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
use crate::report::daily::{DailyReport, HourCell};
use crate::report::monthly::MonthlyReport;
use crate::report::weekly::WeeklyReport;

/// 日报 system prompt：毒舌猫。数字全部由 facts 提供，模型只挑刺、不许算、不许评。
const SYSTEM_PROMPT: &str = "你是 Snoop 里的毒舌猫，负责给用户复盘这一天。你不是来夸人的，是来找茬的。\n\
facts 是已经算好的确定事实，数字全部正确。带 `_display` 后缀的字段已经是「4 小时 12 分」这种人读格式，引用时长一律用它，不要自己把分钟换算成时分，更不要写「252 分钟」这种原始数字。\n\
你的任务：挑出这一天里最离谱、最经不起追问的地方，写成 1–3 句中文吐槽，放进 JSON 的 quips 数组。\n\
写法：\n\
- 质问式，不是陈述式。发现荒谬处就追问，明知道对方答不上来还非要问。\n\
- 可以连用问号感叹号，可以急，可以阴阳怪气；可以说教、怼人、人身攻击（互联网语境，不是恶意）。\n\
- 拿最离谱的点开刀：挂机时长、切换频率、凌晨活跃、某个类别占比高得可疑、\n\
  某个应用「只用了很短时间却开了很多次」（看 facts.open_hog 与 top_apps[].open_count）。\n\
- 只说图表给不了的东西：这一天的形状、异常点、荒谬的组合；不要复述分类占比表或应用排行的百分比和排名。\n\
- 说「几个新应用」就要说清是几个、是什么，要么说清要么不说。\n\
引用某个应用时用 apps 里对应的 code（如 App A），后台会自动换成真名。\n\
facts.open_hog 是「打开最频繁、但用时最短」的应用（每活跃分钟打开次数最多）：app 是代号，active_display 是它的活跃时长，open_count 是打开次数；top_apps[].open_count 是各 Top 应用被打开的次数。若某应用用时短却开得勤，这就是最荒谬的组合，拿它开刀。\n\
禁止：编造 facts 里没有的事实；自己计算或改写数字；提到窗口标题；拿身体健康和生死开玩笑（不说「猝死」「不要命了」「要出事」这类）。\n\
标记只有两种：{{n:数字/时长}}、{{em:语气重点}}，不要第三种。\n\
只输出 JSON 对象：{\"quips\":[\"...\",\"...\"]}，不要 JSON 以外的任何文字。";

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
    let result = envelope::call_ai(config, code_map, db_path, "ai.daily-report", payload, true).await;
    if result.ok {
        if let Some(content) = result.content {
            if let Some(narrative) = parse_narrative(&content) {
                return (narrative, "ai".to_string());
            }
        }
    }
    (template_narrative(report), "template".to_string())
}

/// 解析 AI 返回的 JSON 外壳 `{"quips": [...]}`，校验后拼成换行分隔的叙事串。
/// quips 取 1–3 条（超出截断），空句 / 超 80 字丢弃，0 条返回 None（触发模板兜底）。
fn parse_narrative(content: &str) -> Option<String> {
    let v: Value = serde_json::from_str(content.trim()).ok()?;
    let quips = v.get("quips")?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for q in quips {
        let s = q.as_str()?.trim().to_string();
        if s.is_empty() || s.chars().count() > 80 {
            continue;
        }
        out.push(s);
        if out.len() == 3 {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("\n"))
    }
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

    // 每应用打开次数（连续前台段计数），供「只用了很短时间却开了很多次」这类吐槽。
    let open_by_id: std::collections::HashMap<String, u32> = report
        .open_counts
        .iter()
        .map(|a| (a.bundle_id.clone(), a.open_count))
        .collect();

    // 打开最频繁但用时最短的应用：每活跃分钟打开次数最多（open_count / active_ms）。
    // 下限（打开 ≥ 10 次、活跃 ≥ 1 分钟）排除「只开一两次」的噪声。
    let open_hog = report
        .open_counts
        .iter()
        .filter(|a| a.active_ms >= 60_000 && a.open_count >= 10)
        .max_by(|a, b| {
            let ra = a.open_count as f64 / a.active_ms as f64;
            let rb = b.open_count as f64 / b.active_ms as f64;
            ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
        });

    // 它也要进 apps 拿到稳定代号，否则信封层回映不回真名。
    if let Some(hog) = open_hog {
        if seen.insert(hog.bundle_id.clone()) {
            apps_list.push((hog.bundle_id.clone(), hog.name.clone()));
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

    let idle_ms = (report.foreground_ms - report.active_ms).max(0);

    let mut facts = json!({
        "date": date_label(&report.date),
        "active_minutes": report.active_ms / 60_000,
        "active_display": fmt_duration(report.active_ms),
        "foreground_display": fmt_duration(report.foreground_ms),
        "idle_minutes": idle_ms / 60_000,
        "idle_display": fmt_duration(idle_ms),
        "switch_count": report.switch_count,
        "peak_hour": report.peak_hour,
        "longest_focus_display": fmt_duration(report.longest_focus.duration_ms),
        "shape": json!({
            "late_night_display": fmt_duration(hourly_sum(&report.hourly, 0, 6)),
            "morning_display": fmt_duration(hourly_sum(&report.hourly, 6, 12)),
            "afternoon_display": fmt_duration(hourly_sum(&report.hourly, 12, 18)),
            "evening_display": fmt_duration(hourly_sum(&report.hourly, 18, 24)),
        }),
        "top_apps": report.top_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "minutes": a.active_ms / 60_000,
            "share_pct": round1(a.share_pct),
            "open_count": open_by_id.get(&a.bundle_id).copied().unwrap_or(0),
        })).collect::<Vec<_>>(),
        "categories": report.categories.iter().map(|c| json!({
            "category": category_label(&c.category),
            "share_pct": round1(c.share_pct),
        })).collect::<Vec<_>>(),
        "vs_7d": json!({
            "active_delta_pct": round1(report.vs_7d.active_delta_pct),
            "switch_delta_pct": round1(report.vs_7d.switch_delta_pct),
        }),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    });
    if report.switch_count > 0 {
        facts["switch_interval_seconds"] = json!(avg_switch_seconds(report.active_ms, report.switch_count));
    }
    if let Some(hog) = open_hog {
        facts["open_hog"] = json!({
            "app": code_by_id.get(&hog.bundle_id).cloned().unwrap_or_default(),
            "active_display": fmt_duration(hog.active_ms),
            "open_count": hog.open_count,
        });
    }

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

/// 小时区间 `[from, to)` 的活跃时长合计。用于把一天切成「凌晨/上午/下午/晚上」四段。
fn hourly_sum(hourly: &[HourCell], from: u8, to: u8) -> i64 {
    hourly
        .iter()
        .filter(|c| c.hour >= from && c.hour < to)
        .map(|c| c.active_ms)
        .sum()
}

/// 平均每次切换间隔（秒）。switch_count 为 0 时返回 0（调用方不写入 facts）。
fn avg_switch_seconds(active_ms: i64, switch_count: u32) -> i64 {
    if switch_count == 0 {
        0
    } else {
        (active_ms / 1000) / switch_count as i64
    }
}

/// 本地模板兜底叙事：毒舌猫语气，按数据特征选句（挂机 gap / 切换异常 / 深夜活跃 / 一切正常）。
/// 每条都带标记，与 AI 输出同一套渲染。
pub fn template_narrative(r: &DailyReport) -> String {
    let idle_ms = (r.foreground_ms - r.active_ms).max(0);
    let late_night = hourly_sum(&r.hourly, 0, 6);
    let mut quips: Vec<String> = Vec::new();

    if idle_ms >= 30 * 60_000 {
        quips.push(format!(
            "前台挂了 {{n:{}}}，真正动手 {{n:{}}}。另外 {{n:{}}} 你在干嘛???{{em:回答本喵}}!!!",
            fmt_duration(r.foreground_ms),
            fmt_duration(r.active_ms),
            fmt_duration(idle_ms),
        ));
    }

    if r.switch_count >= 150 {
        quips.push(format!(
            "切换了 {{n:{}}} 次应用。你是在找钥匙吗?",
            r.switch_count
        ));
    }

    if late_night >= 45 * 60_000 {
        quips.push(format!(
            "凌晨还烧了 {{n:{}}}。这个点不睡觉，是有什么大事吗?",
            fmt_duration(late_night)
        ));
    }

    if quips.is_empty() {
        quips.push("今天居然没什么好说的，反常。{{em:你确定开机了?}}".to_string());
    }

    quips.truncate(3);
    quips.join("\n")
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
