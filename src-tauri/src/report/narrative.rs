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

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::ai::config::AiConfigState;
use crate::ai::envelope::{self, AiCodeMap};
use crate::report::common::CategoryShare;
use crate::report::daily::{AppOpenCount, DailyReport, HourCell};
use crate::report::monthly::{MonthWeek, MonthlyReport};
use crate::report::weekly::{CategoryDelta, WeeklyReport};

/// 一次生成的结果：旧字段（列表页 / 旧前端兼容）+ 结构化编辑层文案。
pub struct GeneratedCopy {
    pub headline: Option<String>,
    pub narrative: String,
    pub source: String,
    pub ai_copy: Option<Value>,
}

/// payload 与占位符使用同一份后端事实，避免两处格式化口径漂移。
struct AiPrompt {
    payload: Value,
    placeholders: BTreeMap<String, String>,
}

/// 日报 system prompt：编辑层。毒舌猫负责标题/旁批/结尾，杂志编辑负责其余栏目文案。
const SYSTEM_PROMPT: &str = "你是 Snoop 报告里的编辑室，负责一份固定版式的中文数字生活杂志。\n\
角色分层：headline、sections.*.aside、closing 由毒舌猫写——质问、阴阳、挑刺，明知对方答不上来还要追问；deck、sections.*.title、sections.*.heading、sections.03.aside_heading、chart_heads.*、pull_quote 由杂志编辑写——冷静、观察式、偶尔阴阳。整页不要都在骂人。\n\
facts 是唯一事实来源，数字已经全部算好。placeholders 是允许引用的全部事实值（key → 已格式化好的文本，例如「4 小时 12 分」「20:00」「38%」）。directions 是唯一允许的趋势判断。\n\
硬规则：\n\
1. 所有数字、时长、百分比、次数、日期、时刻、星期、分类名、应用名，都必须写成 [[fact:key]]，key 只能取 placeholders 里已有的。要强调数字写 {{n:[[fact:key]]}}，强调语气写 {{em:文字}}。正文字段里除占位符外不许出现阿拉伯数字 0-9；不许自己换算、推导、相加，不许自创 key，不许嵌套标记。\n\
2. headline、issue_right、sections.*.title、chart_heads.* 禁止 {{...}}，只能写 [[fact:key]] 或纯文字。\n\
3. 多行字段用 \\n 分隔，不要空行。标题不要句号。字段缺失就省略，不要写空字符串。\n\
4. 只输出一个 JSON 对象，不要 Markdown、代码围栏、注释、尾逗号；不要输出 version、report_type、quips。\n\
字段规格（长度按替换占位符后的可见字数）：\n\
- headline：8–36 字，1 行。今天最荒谬的一点，像杂志封面标题。\n\
- deck：20–160 字，1 段。导语，替这期报告定调。\n\
- issue_right：4–24 字，1 行。刊头右侧的短标签。\n\
- sections.01.title：2–14 字，1 行。讲节奏与形状。\n\
- sections.01.heading：8–36 字，最多 2 行。\n\
- sections.01.aside：20–100 字，1 段。毒舌猫旁批。\n\
- sections.02.title：2–14 字，1 行。讲时间去向。\n\
- sections.02.heading：8–36 字，最多 2 行。\n\
- sections.02.aside：20–100 字，1 段。毒舌猫旁批。\n\
- sections.03.title：2–14 字，1 行。讲异常与夜间。\n\
- sections.03.heading：8–36 字，最多 2 行。\n\
- sections.03.aside_heading：6–28 字，最多 2 行。\n\
- sections.03.aside：20–100 字，1 段。毒舌猫旁批。\n\
- chart_heads.hourly：4–28 字，1 行。小时曲线的小标题，必须与 directions.shape 一致：evening_heavy 说晚上重，day_heavy 说白天重，balanced 说前后接近；不许写相反判断。\n\
- pull_quote：10–48 字，最多 2 行。只写一句拉引句，不要复述第一行已有的事实。\n\
- closing：20–100 字，最多 2 行。页脚结尾注，毒舌猫收尾。\n\
内容边界：01 只讲这一天的节奏与形状（peak_hour、evening_share_pct、shape.*、focus_duration_display、switch_count）；02 只讲时间去向（top_app、top_category、new_app_*）；03 只讲异常与夜间（late_night_display、open_hog_*、active_delta_display、switch_delta_display）。不要把 01 的数据写进 03。\n\
directions.has_open_hog 为 false 时不要提「开了很多次却没用多久」；引用占位符前先确认它确实在 placeholders 里，缺失的值不要编，也不要做对比。\n\
不要复述图表已经显示的分类占比表和应用排行，只写图表给不了的东西：形状、异常、荒谬的组合。\n\
不要编造 facts 里没有的事实；不要提窗口标题；不要拿身体健康和生死开玩笑（不说「猝死」「不要命了」「要出事」这类）。\n\
JSON 形状：{\"headline\":\"…\",\"deck\":\"…\",\"issue_right\":\"…\",\"sections\":{\"01\":{\"title\":\"…\",\"heading\":\"…\",\"aside\":\"…\"},\"02\":{\"title\":\"…\",\"heading\":\"…\",\"aside\":\"…\"},\"03\":{\"title\":\"…\",\"heading\":\"…\",\"aside_heading\":\"…\",\"aside\":\"…\"}},\"chart_heads\":{\"hourly\":\"…\"},\"pull_quote\":\"…\",\"closing\":\"…\"}\n\
只输出 JSON 对象。";

/// 周报 system prompt：编辑层。周报讲「这一周和平时比如何」，不是复述某一天。
const WEEKLY_SYSTEM_PROMPT: &str = "你是 Snoop 报告里的编辑室，负责一份固定版式的中文数字生活杂志的周报。\n\
角色分层：headline、sections.01.aside、sections.03.aside、closing 由毒舌猫写——质问、阴阳、挑刺；deck、sections.*.title、sections.*.heading、sections.03.aside_heading、chart_heads.*、pull_quote 由杂志编辑写——冷静、观察式、偶尔阴阳。整页不要都在骂人。\n\
facts 是唯一事实来源，数字已经全部算好。placeholders 是允许引用的全部事实值（key → 已格式化好的文本，例如「4 小时 12 分」「20:42」「38%」）。directions 是唯一允许的趋势判断。\n\
硬规则：\n\
1. 所有数字、时长、百分比、次数、日期、时刻、星期、分类名、应用名，都必须写成 [[fact:key]]，key 只能取 placeholders 里已有的。要强调数字写 {{n:[[fact:key]]}}，强调语气写 {{em:文字}}。正文字段里除占位符外不许出现阿拉伯数字 0-9；不许自己换算、推导、相加，不许自创 key，不许嵌套标记。\n\
2. headline、issue_right、sections.*.title、chart_heads.* 禁止 {{...}}，只能写 [[fact:key]] 或纯文字。\n\
3. 多行字段用 \\n 分隔，不要空行。标题不要句号。字段缺失就省略，不要写空字符串。\n\
4. 只输出一个 JSON 对象，不要 Markdown、代码围栏、注释、尾逗号；不要输出 version、report_type、quips。\n\
字段规格（长度按替换占位符后的可见字数）：\n\
- headline：8–36 字，1 行。这一周最荒谬的规律，像杂志封面标题。\n\
- deck：20–160 字，1 段。导语，替这期周报定调。\n\
- issue_right：4–24 字，1 行。刊头右侧的短标签。\n\
- sections.01.title：2–14 字，1 行。讲这一周的节奏与作息。\n\
- sections.01.heading：8–36 字，最多 2 行。\n\
- sections.01.aside：20–100 字，1 段。毒舌猫旁批。\n\
- sections.02.title：2–14 字，1 行。讲时间去向。\n\
- sections.02.heading：8–36 字，最多 2 行。\n\
- sections.03.title：2–14 字，1 行。讲对比、消失与异常。\n\
- sections.03.heading：8–36 字，最多 2 行。\n\
- sections.03.aside_heading：6–28 字，最多 2 行。\n\
- sections.03.aside：20–100 字，1 段。毒舌猫旁批。周报没有 02 旁批，不要输出 sections.02.aside。\n\
- chart_heads.week：4–28 字，1 行。按天柱状图的小标题，必须与 directions.weekend_vs_weekday 一致：higher 说周末更重，lower 说周末更轻，equal 说两者接近，unknown 写中性句；不许写相反判断。\n\
- pull_quote：10–48 字，最多 2 行。两行都由你写，第一行给判断，第二行补一刀；不要复述旁边的倍数数字。\n\
- closing：20–100 字，最多 2 行。页脚结尾注，毒舌猫收尾。\n\
内容边界：01 只讲这一周的节奏与作息（weekday_avg_display、weekend_avg_display、rhythm_*、busy_dow、quiet_dow、max_day_date、max_day_active_display、min_day_date、min_day_active_display）；02 只讲时间去向（top_app、top_category、new_app_*）；03 只讲对比与异常（baseline_*、gone_app_*、no_data_days、weekend_*、rhythm_*_delta_display）。\n\
directions.rhythm_available 为 false 时不要谈平均开工收工；baseline_available 为 false 时不要和前几周比较；has_gone_apps 为 false 时不要提消失的应用。引用占位符前先确认它确实在 placeholders 里，缺失的值不要编，也不要做对比。\n\
不要复述图表已经显示的分类占比表和应用排行，只写图表给不了的东西：规律、异常、荒谬的组合。\n\
不要编造 facts 里没有的事实；不要提窗口标题；不要拿身体健康和生死开玩笑（不说「猝死」「不要命了」「要出事」这类）。\n\
JSON 形状：{\"headline\":\"…\",\"deck\":\"…\",\"issue_right\":\"…\",\"sections\":{\"01\":{\"title\":\"…\",\"heading\":\"…\",\"aside\":\"…\"},\"02\":{\"title\":\"…\",\"heading\":\"…\"},\"03\":{\"title\":\"…\",\"heading\":\"…\",\"aside_heading\":\"…\",\"aside\":\"…\"}},\"chart_heads\":{\"week\":\"…\"},\"pull_quote\":\"…\",\"closing\":\"…\"}\n\
只输出 JSON 对象。";

/// 月报 system prompt：编辑层。月报讲「这个月的变化趋势」，不是复述某一天。
const MONTHLY_SYSTEM_PROMPT: &str = "你是 Snoop 报告里的编辑室，负责一份固定版式的中文数字生活杂志的月报。\n\
角色分层：headline、sections.01.aside、sections.03.aside、closing 由毒舌猫写——质问、阴阳、挑刺；deck、sections.*.title、sections.*.heading、sections.03.aside_heading、chart_heads.*、pull_quote 由杂志编辑写——冷静、观察式、偶尔阴阳。整页不要都在骂人。\n\
facts 是唯一事实来源，数字已经全部算好。placeholders 是允许引用的全部事实值（key → 已格式化好的文本，例如「128 小时 30 分」「4 小时 12 分」「38%」）。directions 是唯一允许的趋势判断。\n\
硬规则：\n\
1. 所有数字、时长、百分比、次数、日期、时刻、星期、分类名、应用名，都必须写成 [[fact:key]]，key 只能取 placeholders 里已有的。要强调数字写 {{n:[[fact:key]]}}，强调语气写 {{em:文字}}。正文字段里除占位符外不许出现阿拉伯数字 0-9；不许自己换算、推导、相加，不许自创 key，不许嵌套标记。\n\
2. headline、issue_right、sections.*.title、chart_heads.* 禁止 {{...}}，只能写 [[fact:key]] 或纯文字。\n\
3. 多行字段用 \\n 分隔，不要空行。标题不要句号。字段缺失就省略，不要写空字符串。\n\
4. 只输出一个 JSON 对象，不要 Markdown、代码围栏、注释、尾逗号；不要输出 version、report_type、quips。\n\
字段规格（长度按替换占位符后的可见字数）：\n\
- headline：8–36 字，1 行。这个月最荒谬的趋势，像杂志封面标题。\n\
- deck：20–160 字，1 段。导语，替这期月报定调。\n\
- issue_right：4–24 字，1 行。刊头右侧的短标签。\n\
- sections.01.title：2–14 字，1 行。讲按周的走势。\n\
- sections.01.heading：8–36 字，最多 2 行。\n\
- sections.01.aside：20–100 字，1 段。毒舌猫旁批。\n\
- sections.02.title：2–14 字，1 行。讲时间去向。\n\
- sections.02.heading：8–36 字，最多 2 行。\n\
- sections.03.title：2–14 字，1 行。讲变化与异常。\n\
- sections.03.heading：8–36 字，最多 2 行。\n\
- sections.03.aside_heading：6–28 字，最多 2 行。\n\
- sections.03.aside：20–100 字，1 段。毒舌猫旁批。月报没有 02 旁批，不要输出 sections.02.aside。\n\
- chart_heads.calendar：4–28 字，1 行。日历热力图的小标题，必须与 directions.day_spread 一致：even 说每天起伏不大，uneven 说有高有低，patchy 说记录不全；不许写相反判断。\n\
- chart_heads.trend：4–28 字，最多 2 行。按周折线的小标题，必须与 directions.trend 一致：up 说走高，down 说走低，flat 说基本持平，unknown 写中性句；不许写相反判断。\n\
- pull_quote：10–48 字，最多 2 行。只写一句拉引句，不要复述第一行已有的事实。\n\
- closing：20–100 字，最多 2 行。页脚结尾注，毒舌猫收尾。\n\
内容边界：01 只讲按周的走势（full_week_count、first_full_week_*、last_full_week_*、max_week_*、min_week_*、trend_*）；02 只讲时间去向（top_app、top_category、new_app_*）；03 只讲变化与异常（prev_month_avg_display、month_delta_display、half_shift 的 shift_*、max_day_date、max_day_active_display、min_day_date、min_day_active_display、missing_days、day_spread_ratio）。\n\
directions.trend_available 为 false 时不要谈月末走势；shift_available 为 false 时不要谈上下半月变化；has_new_apps 为 false 时不要提新应用。引用占位符前先确认它确实在 placeholders 里，缺失的值不要编，也不要做对比。标了 partial 的半截周不许当成完整周比较。\n\
不要复述图表已经显示的分类占比表和应用排行，只写图表给不了的东西：趋势的转折、异常的组合。\n\
不要编造 facts 里没有的事实；不要提窗口标题；不要拿身体健康和生死开玩笑（不说「猝死」「不要命了」「要出事」这类）。\n\
JSON 形状：{\"headline\":\"…\",\"deck\":\"…\",\"issue_right\":\"…\",\"sections\":{\"01\":{\"title\":\"…\",\"heading\":\"…\",\"aside\":\"…\"},\"02\":{\"title\":\"…\",\"heading\":\"…\"},\"03\":{\"title\":\"…\",\"heading\":\"…\",\"aside_heading\":\"…\",\"aside\":\"…\"}},\"chart_heads\":{\"calendar\":\"…\",\"trend\":\"…\"},\"pull_quote\":\"…\",\"closing\":\"…\"}\n\
只输出 JSON 对象。";

/// 生成日报编辑层文案：优先 AI，失败回落到本地模板。
pub async fn generate_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &DailyReport,
) -> GeneratedCopy {
    let prompt = build_payload(code_map, report);
    let directions = prompt
        .payload
        .get("directions")
        .cloned()
        .unwrap_or(Value::Null);
    let result = envelope::call_ai(
        config,
        code_map,
        db_path,
        "ai.daily-report",
        prompt.payload,
        true,
    )
    .await;
    let template = template_narrative(report);
    if result.ok {
        if let Some(content) = result.content {
            if let Some(doc) = parse_copy(&content, "day", &prompt.placeholders, &directions) {
                return finalize_copy(Some(doc), template);
            }
        }
    }
    finalize_copy(None, template)
}

/// 把校验通过的 `ai_copy` 与旧字段组装起来。
///
/// `narrative` 继续写派生 quips（+ 结尾注），旧前端 / 列表页无需改动；
/// `source` 只描述 `narrative` 这一列的来源。
fn finalize_copy(ai_copy: Option<Value>, template: String) -> GeneratedCopy {
    let Some(doc) = ai_copy else {
        return GeneratedCopy {
            headline: None,
            narrative: template,
            source: "template".to_string(),
            ai_copy: None,
        };
    };

    let headline = doc
        .get("headline")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let quips: Vec<String> = doc
        .get("quips")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if quips.is_empty() {
        GeneratedCopy {
            headline,
            narrative: template,
            source: "template".to_string(),
            ai_copy: Some(doc),
        }
    } else {
        GeneratedCopy {
            headline,
            narrative: quips.join("\n"),
            source: "ai".to_string(),
            ai_copy: Some(doc),
        }
    }
}

/// 构造 T3 形状 payload。应用引用用**稳定代号**（信封层回映成真名），
/// 数字全部是已算好的事实；分类名是固定 11 类 taxonom、非应用名，可放 facts。
fn build_payload(code_map: &Mutex<AiCodeMap>, report: &DailyReport) -> AiPrompt {
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
    let open_hog = find_open_hog(report);

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
            "active_delta_display": delta_label(report.vs_7d.active_delta_pct),
            "switch_delta_display": delta_label(report.vs_7d.switch_delta_pct),
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

    let placeholders = placeholders_day(report);
    let directions = directions_day(report);
    let payload = json!({
        "system_prompt": SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
        "placeholders": placeholders,
        "directions": directions,
    });
    AiPrompt {
        payload,
        placeholders,
    }
}

/// 打开最频繁、用时最短的应用（每活跃分钟打开次数最多）。
fn find_open_hog(report: &DailyReport) -> Option<&AppOpenCount> {
    report
        .open_counts
        .iter()
        .filter(|a| a.active_ms >= 60_000 && a.open_count >= 10)
        .max_by(|a, b| {
            let ra = a.open_count as f64 / a.active_ms as f64;
            let rb = b.open_count as f64 / b.active_ms as f64;
            ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// 分类 id → 中文显示名。走 `catalog` 的全局名称快照（本函数所在的格式化路径
/// 拿不到数据库连接）；快照未命中时退回 id 本身，不会给出错误的名字。
fn category_label(cat: &str) -> String {
    crate::app_classify::catalog::name_of(cat)
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

/// 生成周报编辑层文案：优先 AI，失败回落模板。
pub async fn generate_weekly_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &WeeklyReport,
) -> GeneratedCopy {
    let prompt = build_weekly_payload(code_map, report);
    let directions = prompt
        .payload
        .get("directions")
        .cloned()
        .unwrap_or(Value::Null);
    let result = envelope::call_ai(
        config,
        code_map,
        db_path,
        "ai.weekly-report",
        prompt.payload,
        true,
    )
    .await;
    let template = template_weekly_narrative(report);
    if result.ok {
        if let Some(content) = result.content {
            if let Some(doc) = parse_copy(&content, "week", &prompt.placeholders, &directions) {
                return finalize_copy(Some(doc), template);
            }
        }
    }
    finalize_copy(None, template)
}

fn build_weekly_payload(code_map: &Mutex<AiCodeMap>, report: &WeeklyReport) -> AiPrompt {
    // 叙事里要引用的应用 = 新出现 + 消失（Top 5 排行与分类占比表不复述，不进 payload）。
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in report.new_apps.iter() {
        if seen.insert(a.bundle_id.clone()) {
            pairs.push((a.bundle_id.clone(), a.name.clone()));
        }
    }
    for a in report.gone_apps.iter() {
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

    // 某天的活跃时长（`max_day`/`min_day` 只存日期，时长从这里补）。
    let day_ms = |date: &str| -> i64 {
        report
            .days
            .iter()
            .find(|d| d.date.as_str() == date)
            .map(|d| d.active_ms)
            .unwrap_or(0)
    };

    let no_data_days: Vec<String> = report
        .days
        .iter()
        .filter(|d| d.active_ms == 0)
        .map(|d| weekday_label(d.dow))
        .collect();

    let mut facts = json!({
        "week_label": week_label(&report.week_start, &report.week_end),
        "active_display": fmt_duration(report.active_ms),
        "avg_daily_display": fmt_duration(report.avg_daily_active_ms),
        "days_with_data": report.days_with_data,
        "no_data_days": no_data_days,
        "days": report.days.iter().filter(|d| d.active_ms > 0).map(|d| json!({
            "dow": weekday_label(d.dow),
            "active_display": fmt_duration(d.active_ms),
        })).collect::<Vec<_>>(),
        "max_day": report.max_day.as_ref().map(|s| json!({
            "date": date_label(s),
            "active_display": fmt_duration(day_ms(s)),
        })),
        "min_day": report.min_day.as_ref().map(|s| json!({
            "date": date_label(s),
            "active_display": fmt_duration(day_ms(s)),
        })),
        "weekday_vs_weekend": json!({
            "weekday_avg_display": fmt_duration(report.weekday_weekend.weekday_avg_active_ms),
            "weekend_avg_display": fmt_duration(report.weekday_weekend.weekend_avg_active_ms),
            "weekday_days": report.weekday_weekend.weekday_days,
            "weekend_days": report.weekday_weekend.weekend_days,
        }),
        "vs_baseline": json!({
            "baseline_sufficient": report.baseline.baseline_sufficient,
            "daily_delta_display": delta_display(
                report.baseline.daily_delta_pct,
                report.baseline.baseline_sufficient,
            ),
            "weeks_counted": report.baseline.weeks_counted,
        }),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
        "gone_apps": report.gone_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "baseline_active_display": fmt_duration(a.baseline_active_ms),
            "baseline_weeks": a.baseline_weeks,
        })).collect::<Vec<_>>(),
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

    let placeholders = placeholders_week(report);
    let directions = directions_week(report);
    let payload = json!({
        "system_prompt": WEEKLY_SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
        "placeholders": placeholders,
        "directions": directions,
    });
    AiPrompt {
        payload,
        placeholders,
    }
}

/// 本地模板：毒舌猫语气，专挑「这一周的规律」——作息漂移、分布极端、消失的应用、工作日/周末反差。
/// 数字全部来自已算好的 `WeeklyReport`，这里只拼句；时长一律用格式化好的 `fmt_duration` 结果。
pub fn template_weekly_narrative(r: &WeeklyReport) -> String {
    let mut quips: Vec<String> = Vec::new();

    // 作息漂移：平均开工/收工。
    if let (Some(s), Some(e)) = (r.rhythm_summary.avg_start_min, r.rhythm_summary.avg_end_min) {
        quips.push(format!(
            "平均 {{n:{}}} 开工、{{n:{}}} 停下，这作息是飘到哪个时区去了?",
            fmt_min_of_day(s),
            fmt_min_of_day(e),
        ));
    }

    // 分布极端：忙的天 vs 完全空的天 / 最闲的天。
    let data_days: Vec<_> = r.days.iter().filter(|d| d.active_ms > 0).collect();
    let no_data: Vec<String> = r
        .days
        .iter()
        .filter(|d| d.active_ms == 0)
        .map(|d| weekday_label(d.dow))
        .collect();
    if let (Some(max), Some(min)) = (
        data_days.iter().max_by_key(|d| d.active_ms),
        data_days.iter().min_by_key(|d| d.active_ms),
    ) {
        if !no_data.is_empty() && max.active_ms >= min.active_ms * 2 {
            quips.push(format!(
                "{}烧了 {{n:{}}}，{}却一秒都没有。{{em:人呢?}}",
                weekday_label(max.dow),
                fmt_duration(max.active_ms),
                no_data.join("、"),
            ));
        } else if max.active_ms >= min.active_ms * 3 {
            quips.push(format!(
                "{}烧了 {{n:{}}}，{}才 {{n:{}}}。这落差你自己信吗?",
                weekday_label(max.dow),
                fmt_duration(max.active_ms),
                weekday_label(min.dow),
                fmt_duration(min.active_ms),
            ));
        }
    }

    // 消失的应用：前 4 周常用、这周一次没开。
    if let Some(g) = r.gone_apps.first() {
        quips.push(format!(
            "前 4 周你在 {} 上耗了 {{n:{}}}，这周一次没开。{{em:绝交了?}}",
            g.name,
            fmt_duration(g.baseline_active_ms),
        ));
    }

    // 工作日 / 周末反差：两侧都有记录且差一倍以上才说。
    let ww = &r.weekday_weekend;
    if ww.weekday_days > 0 && ww.weekend_days > 0 {
        let (busy_label, busy_ms, idle_label, idle_ms) =
            if ww.weekday_avg_active_ms >= ww.weekend_avg_active_ms {
                ("工作日", ww.weekday_avg_active_ms, "周末", ww.weekend_avg_active_ms)
            } else {
                ("周末", ww.weekend_avg_active_ms, "工作日", ww.weekday_avg_active_ms)
            };
        if busy_ms >= idle_ms * 2 {
            quips.push(format!(
                "{busy_label}日均 {{n:{}}}，{idle_label}日均 {{n:{}}}。{{em:这周是怎么安排的?}}",
                fmt_duration(busy_ms),
                fmt_duration(idle_ms),
            ));
        }
    }

    if quips.is_empty() {
        quips.push("这一周居然挑不出毛病。{{em:你确定开机了?}}".to_string());
    }

    quips.truncate(3);
    quips.join("\n")
}

// ── 月报 ────────────────────────────────────────────────────────────────────

/// 生成月报编辑层文案：优先 AI，失败回落模板。
pub async fn generate_monthly_narrative(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    report: &MonthlyReport,
) -> GeneratedCopy {
    let prompt = build_monthly_payload(code_map, report);
    let directions = prompt
        .payload
        .get("directions")
        .cloned()
        .unwrap_or(Value::Null);
    let result = envelope::call_ai(
        config,
        code_map,
        db_path,
        "ai.monthly-report",
        prompt.payload,
        true,
    )
    .await;
    let template = template_monthly_narrative(report);
    if result.ok {
        if let Some(content) = result.content {
            if let Some(doc) = parse_copy(&content, "month", &prompt.placeholders, &directions) {
                return finalize_copy(Some(doc), template);
            }
        }
    }
    finalize_copy(None, template)
}

fn build_monthly_payload(code_map: &Mutex<AiCodeMap>, report: &MonthlyReport) -> AiPrompt {
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
        "active_display": fmt_duration(report.active_ms),
        "avg_daily_display": fmt_duration(report.avg_daily_active_ms),
        "days_with_data": report.days_with_data,
        "vs_prev_month": json!({
            "avg_daily_active_display": fmt_duration(report.prev_month.avg_daily_active_ms),
            "daily_delta_display": delta_display(
                report.prev_month.daily_delta_pct,
                report.prev_month.avg_daily_active_ms > 0,
            ),
        }),
        "weeks": report.weeks.iter().map(|w| json!({
            "label": week_label(&w.clip_from, &w.clip_to),
            "active_display": fmt_duration(w.active_ms),
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
            "date": date_label(&d.date),
            "active_display": fmt_duration(d.active_ms),
        })),
        "min_day": report.min_day.as_ref().map(|d| json!({
            "date": date_label(&d.date),
            "active_display": fmt_duration(d.active_ms),
        })),
        "categories": report.categories.iter().map(|c| json!({
            "category": category_label(&c.category),
            "share_pct": round1(c.share_pct),
        })).collect::<Vec<_>>(),
        "top_apps": report.top_apps.iter().map(|a| json!({
            "app": code_by_id.get(&a.bundle_id).cloned().unwrap_or_default(),
            "active_display": fmt_duration(a.active_ms),
            "share_pct": round1(a.share_pct),
        })).collect::<Vec<_>>(),
        "new_apps": report.new_apps.iter()
            .map(|a| code_by_id.get(&a.bundle_id).cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    });

    let placeholders = placeholders_month(report);
    let directions = directions_month(report);
    let payload = json!({
        "system_prompt": MONTHLY_SYSTEM_PROMPT,
        "facts": facts,
        "apps": apps,
        "placeholders": placeholders,
        "directions": directions,
    });
    AiPrompt {
        payload,
        placeholders,
    }
}

/// 本地模板：毒舌猫语气，专挑「这个月的趋势」——按周起伏、上下半月占比变化、整月新增。
/// 数字全部来自已算好的 `MonthlyReport`，这里只拼句；时长一律用格式化好的 `fmt_duration` 结果。
pub fn template_monthly_narrative(r: &MonthlyReport) -> String {
    let mut quips: Vec<String> = Vec::new();

    // 按周起伏最悬殊：只在「完整周」里比，避开月初/月末的半截周。
    let full_weeks: Vec<_> = r.weeks.iter().filter(|w| !w.partial).collect();
    if let (Some(max), Some(min)) = (
        full_weeks.iter().max_by_key(|w| w.active_ms),
        full_weeks.iter().min_by_key(|w| w.active_ms),
    ) {
        if max.active_ms >= min.active_ms * 2 {
            quips.push(format!(
                "{}那一周烧了 {{n:{}}}，{}才 {{n:{}}}。{{em:这个月是坐过山车吗?}}",
                week_label(&max.clip_from, &max.clip_to),
                fmt_duration(max.active_ms),
                week_label(&min.clip_from, &min.clip_to),
                fmt_duration(min.active_ms),
            ));
        }
    }

    // 上下半月占比变化最大的类别。
    if let Some(shift) = r.half_shift.first() {
        if shift.delta_pp.abs() >= 0.5 {
            quips.push(format!(
                "{}占比从上半月的 {:.0}% {}到下半月的 {:.0}%。{{em:这心思变得挺快?}}",
                category_label(&shift.category),
                shift.first_half_share_pct,
                if shift.delta_pp >= 0.0 { "涨" } else { "落" },
                shift.second_half_share_pct,
            ));
        }
    }

    // 整月新冒出来的应用。
    if !r.new_apps.is_empty() {
        let names: Vec<String> = r.new_apps.iter().map(|a| a.name.clone()).collect();
        quips.push(format!(
            "这个月新冒出来 {} 个应用：{}。{{em:又下载了什么好东西?}}",
            names.len(),
            names.join("、"),
        ));
    }

    if quips.is_empty() {
        quips.push("这个月居然挑不出毛病。{{em:你确定开机了?}}".to_string());
    }

    quips.truncate(3);
    quips.join("\n")
}

// ── 占位符 / 方向事实 / 结构化文案解析 ──────────────────────────────────────

fn pct(x: f64) -> String {
    format!("{}%", x.round() as i64)
}

fn pct_i(x: f64) -> String {
    format!("{}%", x.round() as i64)
}

fn delta_minutes_label(min: i32) -> String {
    if min == 0 {
        "基本一致".to_string()
    } else if min > 0 {
        format!("晚 {} 分钟", min)
    } else {
        format!("早 {} 分钟", -min)
    }
}

fn names_join<'a>(names: impl Iterator<Item = &'a str>) -> String {
    names.collect::<Vec<_>>().join("、")
}

fn top_category_share<'a>(cats: &'a [CategoryShare]) -> Option<&'a CategoryShare> {
    cats.iter()
        .max_by(|a, b| a.share_pct.partial_cmp(&b.share_pct).unwrap_or(std::cmp::Ordering::Equal))
}

fn top_category_delta<'a>(cats: &'a [CategoryDelta]) -> Option<&'a CategoryDelta> {
    cats.iter()
        .max_by(|a, b| a.share_pct.partial_cmp(&b.share_pct).unwrap_or(std::cmp::Ordering::Equal))
}

fn shape_key(hourly: &[HourCell]) -> &'static str {
    let total: i64 = hourly.iter().map(|h| h.active_ms).sum();
    let evening = hourly_sum(hourly, 18, 24);
    let share = if total > 0 {
        evening as f64 / total as f64
    } else {
        0.0
    };
    if share >= 0.5 {
        "evening_heavy"
    } else if share <= 0.35 {
        "day_heavy"
    } else {
        "balanced"
    }
}

fn shape_phrase(hourly: &[HourCell]) -> &'static str {
    match shape_key(hourly) {
        "evening_heavy" => "晚上更重",
        "day_heavy" => "白天更重",
        _ => "前后差不多",
    }
}

fn month_trend_pct(report: &MonthlyReport) -> Option<f64> {
    let full: Vec<&MonthWeek> = report.weeks.iter().filter(|w| !w.partial).collect();
    if full.len() < 2 {
        return None;
    }
    let first = full.first()?;
    let last = full.last()?;
    if first.avg_daily_active_ms <= 0 {
        return None;
    }
    Some(
        (last.avg_daily_active_ms - first.avg_daily_active_ms) as f64
            / first.avg_daily_active_ms as f64
            * 100.0,
    )
}

fn trend_phrase(delta: f64) -> &'static str {
    if delta.abs() < 10.0 {
        "基本持平"
    } else if delta > 0.0 {
        "整体走高"
    } else {
        "整体走低"
    }
}

fn day_spread_key(report: &MonthlyReport) -> &'static str {
    let missing = report.days.len().saturating_sub(report.days_with_data as usize);
    if missing > 7 {
        return "patchy";
    }
    match (report.max_day.as_ref(), report.min_day.as_ref()) {
        (Some(max), Some(min)) if max.active_ms > 0 && min.active_ms > 0 => {
            let ratio = max.active_ms as f64 / min.active_ms as f64;
            if ratio >= 2.5 {
                "uneven"
            } else if ratio <= 1.6 {
                "even"
            } else {
                "moderate"
            }
        }
        _ => "unknown",
    }
}

fn day_spread_phrase(report: &MonthlyReport) -> &'static str {
    match day_spread_key(report) {
        "uneven" => "起伏明显",
        "even" => "比较平均",
        "patchy" => "缺失较多",
        "moderate" => "有高有低",
        _ => "起伏不大",
    }
}

fn placeholders_day(report: &DailyReport) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("date_label".into(), date_label(&report.date));
    p.insert("active_display".into(), fmt_duration(report.active_ms));
    p.insert(
        "foreground_display".into(),
        fmt_duration(report.foreground_ms),
    );
    let idle_ms = (report.foreground_ms - report.active_ms).max(0);
    p.insert("idle_display".into(), fmt_duration(idle_ms));
    p.insert("days_with_data".into(), "1".into());
    p.insert("switch_count".into(), report.switch_count.to_string());

    if let Some(a) = report.top_apps.first() {
        p.insert("top_app".into(), a.name.clone());
        p.insert("top_app_display".into(), fmt_duration(a.active_ms));
        p.insert("top_app_share_pct".into(), pct(a.share_pct));
    }
    if let Some(c) = top_category_share(&report.categories) {
        p.insert("top_category".into(), category_label(&c.category));
        p.insert("top_category_share_pct".into(), pct(c.share_pct));
    }
    if !report.new_apps.is_empty() {
        p.insert("new_app_count".into(), report.new_apps.len().to_string());
        p.insert(
            "new_app_names".into(),
            names_join(report.new_apps.iter().map(|a| a.name.as_str())),
        );
    }

    p.insert(
        "peak_hour_display".into(),
        format!("{:02}:00", report.peak_hour),
    );
    p.insert(
        "peak_hour_end_display".into(),
        format!("{:02}:00", (report.peak_hour + 1) % 24),
    );
    let peak_ms = report
        .hourly
        .iter()
        .find(|h| h.hour == report.peak_hour)
        .map(|h| h.active_ms)
        .unwrap_or(0);
    p.insert(
        "peak_hour_active_display".into(),
        fmt_duration(peak_ms),
    );

    let total: i64 = report.hourly.iter().map(|h| h.active_ms).sum();
    let evening = hourly_sum(&report.hourly, 18, 24);
    p.insert(
        "evening_share_pct".into(),
        if total > 0 {
            pct(evening as f64 / total as f64 * 100.0)
        } else {
            "0%".into()
        },
    );
    p.insert("evening_display".into(), fmt_duration(evening));
    p.insert(
        "morning_display".into(),
        fmt_duration(hourly_sum(&report.hourly, 6, 12)),
    );
    p.insert(
        "afternoon_display".into(),
        fmt_duration(hourly_sum(&report.hourly, 12, 18)),
    );
    p.insert(
        "late_night_display".into(),
        fmt_duration(hourly_sum(&report.hourly, 0, 6)),
    );
    p.insert(
        "focus_duration_display".into(),
        fmt_duration(report.longest_focus.duration_ms),
    );
    p.insert(
        "span_display".into(),
        fmt_duration((report.span_end_ms - report.span_start_ms).max(0)),
    );
    p.insert(
        "active_delta_display".into(),
        delta_label(report.vs_7d.active_delta_pct),
    );
    p.insert(
        "switch_delta_display".into(),
        delta_label(report.vs_7d.switch_delta_pct),
    );
    if let Some(hog) = find_open_hog(report) {
        p.insert("open_hog_app".into(), hog.name.clone());
        p.insert(
            "open_hog_active_display".into(),
            fmt_duration(hog.active_ms),
        );
        p.insert("open_hog_open_count".into(), hog.open_count.to_string());
    }
    p.insert(
        "shape_direction_phrase".into(),
        shape_phrase(&report.hourly).into(),
    );
    p
}

fn placeholders_week(report: &WeeklyReport) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert(
        "week_label".into(),
        week_label(&report.week_start, &report.week_end),
    );
    p.insert("active_display".into(), fmt_duration(report.active_ms));
    p.insert(
        "avg_daily_display".into(),
        fmt_duration(report.avg_daily_active_ms),
    );
    p.insert(
        "days_with_data".into(),
        report.days_with_data.to_string(),
    );

    if let Some(a) = report.top_apps.first() {
        p.insert("top_app".into(), a.name.clone());
        p.insert("top_app_display".into(), fmt_duration(a.active_ms));
        p.insert("top_app_share_pct".into(), pct(a.share_pct));
    }
    if let Some(c) = top_category_delta(&report.categories) {
        p.insert("top_category".into(), category_label(&c.category));
        p.insert("top_category_share_pct".into(), pct(c.share_pct));
    }
    if !report.new_apps.is_empty() {
        p.insert("new_app_count".into(), report.new_apps.len().to_string());
        p.insert(
            "new_app_names".into(),
            names_join(report.new_apps.iter().map(|a| a.name.as_str())),
        );
    }

    let ww = &report.weekday_weekend;
    if ww.weekday_days > 0 {
        p.insert(
            "weekday_avg_display".into(),
            fmt_duration(ww.weekday_avg_active_ms),
        );
    }
    if ww.weekend_days > 0 {
        p.insert(
            "weekend_avg_display".into(),
            fmt_duration(ww.weekend_avg_active_ms),
        );
    }
    let weekend_ms: i64 = report
        .days
        .iter()
        .filter(|d| d.dow >= 5)
        .map(|d| d.active_ms)
        .sum();
    let weekend_share = if report.active_ms > 0 {
        weekend_ms as f64 / report.active_ms as f64 * 100.0
    } else {
        0.0
    };
    p.insert("weekend_share_pct".into(), pct(weekend_share));
    if ww.weekday_days > 0 && ww.weekend_days > 0 && ww.weekday_avg_active_ms > 0 {
        let mult = ww.weekend_avg_active_ms as f64 / ww.weekday_avg_active_ms as f64;
        p.insert("weekend_multiplier".into(), format!("{mult:.1}"));
        p.insert(
            "weekend_vs_weekday_phrase".into(),
            if mult >= 1.1 {
                "周末高于工作日"
            } else if mult <= 0.9 {
                "周末低于工作日"
            } else {
                "两者接近"
            }
            .into(),
        );
    }

    let data_days: Vec<_> = report.days.iter().filter(|d| d.active_ms > 0).collect();
    if let Some(max) = data_days.iter().max_by_key(|d| d.active_ms) {
        p.insert("busy_dow".into(), weekday_label(max.dow));
        p.insert(
            "busy_day_active_display".into(),
            fmt_duration(max.active_ms),
        );
    }
    if let Some(min) = data_days.iter().min_by_key(|d| d.active_ms) {
        p.insert("quiet_dow".into(), weekday_label(min.dow));
        p.insert(
            "quiet_day_active_display".into(),
            fmt_duration(min.active_ms),
        );
    }
    let day_ms = |date: &str| -> i64 {
        report
            .days
            .iter()
            .find(|d| d.date == date)
            .map(|d| d.active_ms)
            .unwrap_or(0)
    };
    if let Some(s) = &report.max_day {
        p.insert("max_day_date".into(), date_label(s));
        p.insert(
            "max_day_active_display".into(),
            fmt_duration(day_ms(s)),
        );
    }
    if let Some(s) = &report.min_day {
        p.insert("min_day_date".into(), date_label(s));
        p.insert(
            "min_day_active_display".into(),
            fmt_duration(day_ms(s)),
        );
    }
    let no_data: Vec<String> = report
        .days
        .iter()
        .filter(|d| d.active_ms == 0)
        .map(|d| weekday_label(d.dow))
        .collect();
    if !no_data.is_empty() {
        p.insert("no_data_days".into(), no_data.join("、"));
    }

    if report.rhythm_summary.days_counted >= crate::report::common::MIN_RHYTHM_DAYS {
        if let Some(v) = report.rhythm_summary.avg_start_min {
            p.insert("rhythm_start".into(), fmt_min_of_day(v));
        }
        if let Some(v) = report.rhythm_summary.avg_end_min {
            p.insert("rhythm_end".into(), fmt_min_of_day(v));
        }
        if let Some(v) = report.rhythm_summary.start_delta_min {
            p.insert("rhythm_start_delta_display".into(), delta_minutes_label(v));
        }
        if let Some(v) = report.rhythm_summary.end_delta_min {
            p.insert("rhythm_end_delta_display".into(), delta_minutes_label(v));
        }
        p.insert(
            "overnight_days".into(),
            report.rhythm_summary.overnight_days.to_string(),
        );
    }

    if report.baseline.baseline_sufficient {
        p.insert(
            "baseline_delta_display".into(),
            delta_label(report.baseline.daily_delta_pct),
        );
        p.insert(
            "baseline_weeks_counted".into(),
            report.baseline.weeks_counted.to_string(),
        );
    }

    if let Some(g) = report.gone_apps.first() {
        p.insert("gone_app".into(), g.name.clone());
        p.insert(
            "gone_app_baseline_display".into(),
            fmt_duration(g.baseline_active_ms),
        );
        p.insert(
            "gone_app_baseline_weeks".into(),
            g.baseline_weeks.to_string(),
        );
    }
    p
}

fn placeholders_month(report: &MonthlyReport) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("month_label".into(), month_label(&report.month_start));
    p.insert("active_display".into(), fmt_duration(report.active_ms));
    p.insert(
        "avg_daily_display".into(),
        fmt_duration(report.avg_daily_active_ms),
    );
    p.insert(
        "days_with_data".into(),
        report.days_with_data.to_string(),
    );

    if report.prev_month.avg_daily_active_ms > 0 {
        p.insert(
            "prev_month_avg_display".into(),
            fmt_duration(report.prev_month.avg_daily_active_ms),
        );
        p.insert(
            "month_delta_display".into(),
            delta_label(report.prev_month.daily_delta_pct),
        );
    }

    if let Some(a) = report.top_apps.first() {
        p.insert("top_app".into(), a.name.clone());
        p.insert("top_app_display".into(), fmt_duration(a.active_ms));
        p.insert("top_app_share_pct".into(), pct(a.share_pct));
    }
    if let Some(c) = top_category_share(&report.categories) {
        p.insert("top_category".into(), category_label(&c.category));
        p.insert("top_category_share_pct".into(), pct(c.share_pct));
    }
    if !report.new_apps.is_empty() {
        p.insert("new_app_count".into(), report.new_apps.len().to_string());
        p.insert(
            "new_app_names".into(),
            names_join(report.new_apps.iter().map(|a| a.name.as_str())),
        );
    }

    if let Some(d) = &report.max_day {
        p.insert("max_day_date".into(), date_label(&d.date));
        p.insert(
            "max_day_active_display".into(),
            fmt_duration(d.active_ms),
        );
    }
    if let Some(d) = &report.min_day {
        p.insert("min_day_date".into(), date_label(&d.date));
        p.insert(
            "min_day_active_display".into(),
            fmt_duration(d.active_ms),
        );
    }

    let full: Vec<&MonthWeek> = report.weeks.iter().filter(|w| !w.partial).collect();
    p.insert("full_week_count".into(), full.len().to_string());
    if let Some(w) = full.first() {
        p.insert(
            "first_full_week_label".into(),
            week_label(&w.clip_from, &w.clip_to),
        );
        p.insert(
            "first_full_week_active_display".into(),
            fmt_duration(w.active_ms),
        );
    }
    if let Some(w) = full.last() {
        p.insert(
            "last_full_week_label".into(),
            week_label(&w.clip_from, &w.clip_to),
        );
        p.insert(
            "last_full_week_active_display".into(),
            fmt_duration(w.active_ms),
        );
    }
    if let Some(w) = full.iter().max_by_key(|w| w.active_ms) {
        p.insert(
            "max_week_label".into(),
            week_label(&w.clip_from, &w.clip_to),
        );
        p.insert(
            "max_week_active_display".into(),
            fmt_duration(w.active_ms),
        );
    }
    if let Some(w) = full.iter().min_by_key(|w| w.active_ms) {
        p.insert(
            "min_week_label".into(),
            week_label(&w.clip_from, &w.clip_to),
        );
        p.insert(
            "min_week_active_display".into(),
            fmt_duration(w.active_ms),
        );
    }

    if let Some(delta) = month_trend_pct(report) {
        p.insert("trend_delta_display".into(), delta_label(delta));
        p.insert("trend_direction_phrase".into(), trend_phrase(delta).into());
    }

    if let Some(s) = report
        .half_shift
        .iter()
        .max_by(|a, b| a.delta_pp.abs().partial_cmp(&b.delta_pp.abs()).unwrap_or(std::cmp::Ordering::Equal))
    {
        p.insert("shift_category".into(), category_label(&s.category));
        p.insert("shift_first_pct".into(), pct_i(s.first_half_share_pct));
        p.insert("shift_second_pct".into(), pct_i(s.second_half_share_pct));
        p.insert("shift_delta_pp".into(), format!("{:.1}", s.delta_pp.abs()));
        p.insert(
            "shift_direction_phrase".into(),
            if s.delta_pp >= 0.0 { "上升" } else { "下降" }.into(),
        );
    }

    let missing = report
        .days
        .len()
        .saturating_sub(report.days_with_data as usize);
    p.insert("missing_days".into(), missing.to_string());
    if let (Some(max), Some(min)) = (report.max_day.as_ref(), report.min_day.as_ref()) {
        if max.active_ms > 0 && min.active_ms > 0 {
            p.insert(
                "day_spread_ratio".into(),
                format!("{:.1}", max.active_ms as f64 / min.active_ms as f64),
            );
            p.insert(
                "day_spread_direction_phrase".into(),
                day_spread_phrase(report).into(),
            );
        }
    }
    p
}

fn directions_day(report: &DailyReport) -> Value {
    let switch_vs = if report.vs_7d.avg_active_ms <= 0 {
        "unknown"
    } else if report.vs_7d.switch_delta_pct >= 10.0 {
        "up"
    } else if report.vs_7d.switch_delta_pct <= -10.0 {
        "down"
    } else {
        "flat"
    };
    json!({
        "shape": shape_key(&report.hourly),
        "peak_after_18": report.peak_hour >= 18,
        "switch_vs_baseline": switch_vs,
        "has_open_hog": find_open_hog(report).is_some(),
    })
}

fn directions_week(report: &WeeklyReport) -> Value {
    let ww = &report.weekday_weekend;
    let weekend_vs = if ww.weekday_days == 0 || ww.weekend_days == 0 || ww.weekday_avg_active_ms <= 0 {
        "unknown"
    } else {
        let ratio = ww.weekend_avg_active_ms as f64 / ww.weekday_avg_active_ms as f64;
        if ratio >= 1.1 {
            "higher"
        } else if ratio <= 0.9 {
            "lower"
        } else {
            "equal"
        }
    };
    json!({
        "weekend_vs_weekday": weekend_vs,
        "rhythm_available": report.rhythm_summary.days_counted >= crate::report::common::MIN_RHYTHM_DAYS,
        "baseline_available": report.baseline.baseline_sufficient,
        "has_gone_apps": !report.gone_apps.is_empty(),
    })
}

fn directions_month(report: &MonthlyReport) -> Value {
    let trend = match month_trend_pct(report) {
        Some(p) if p.abs() < 10.0 => "flat",
        Some(p) if p > 0.0 => "up",
        Some(_) => "down",
        None => "unknown",
    };
    json!({
        "trend": trend,
        "trend_available": month_trend_pct(report).is_some(),
        "shift_available": !report.half_shift.is_empty(),
        "has_new_apps": !report.new_apps.is_empty(),
        "day_spread": day_spread_key(report),
    })
}

#[derive(Clone, Copy)]
struct FieldSpec {
    min: usize,
    max: usize,
    max_lines: usize,
    markup: bool,
}

const HEADLINE_SPEC: FieldSpec = FieldSpec { min: 8, max: 36, max_lines: 1, markup: false };
const DECK_SPEC: FieldSpec = FieldSpec { min: 20, max: 160, max_lines: 1, markup: true };
const ISSUE_RIGHT_SPEC: FieldSpec = FieldSpec { min: 4, max: 24, max_lines: 1, markup: false };
const SECTION_TITLE_SPEC: FieldSpec = FieldSpec { min: 2, max: 14, max_lines: 1, markup: false };
const SECTION_HEADING_SPEC: FieldSpec = FieldSpec { min: 8, max: 36, max_lines: 2, markup: true };
const ASIDE_HEADING_SPEC: FieldSpec = FieldSpec { min: 6, max: 28, max_lines: 2, markup: true };
const ASIDE_SPEC: FieldSpec = FieldSpec { min: 20, max: 100, max_lines: 1, markup: true };
const CHART_HEAD_SPEC: FieldSpec = FieldSpec { min: 4, max: 28, max_lines: 1, markup: false };
const CHART_HEAD_2_SPEC: FieldSpec = FieldSpec { min: 4, max: 28, max_lines: 2, markup: false };
const PULL_QUOTE_SPEC: FieldSpec = FieldSpec { min: 10, max: 48, max_lines: 2, markup: true };
const CLOSING_SPEC: FieldSpec = FieldSpec { min: 20, max: 100, max_lines: 2, markup: true };

fn parse_copy(
    content: &str,
    report_type: &str,
    placeholders: &BTreeMap<String, String>,
    directions: &Value,
) -> Option<Value> {
    let root: Value = serde_json::from_str(strip_code_fence(content)).ok()?;
    let obj = root.as_object()?;
    let mut out = serde_json::Map::new();

    if let Some(v) = take_field(obj, "headline", HEADLINE_SPEC, placeholders, None) {
        out.insert("headline".into(), json!(v));
    }
    if let Some(v) = take_field(obj, "deck", DECK_SPEC, placeholders, None) {
        out.insert("deck".into(), json!(v));
    }
    if let Some(v) = take_field(obj, "issue_right", ISSUE_RIGHT_SPEC, placeholders, None) {
        out.insert("issue_right".into(), json!(v));
    }

    if let Some(secs) = obj.get("sections").and_then(|v| v.as_object()) {
        let mut out_secs = serde_json::Map::new();
        for id in ["01", "02", "03"] {
            let Some(sec) = secs.get(id).and_then(|v| v.as_object()) else {
                continue;
            };
            let mut out_sec = serde_json::Map::new();
            if let Some(v) = take_field(sec, "title", SECTION_TITLE_SPEC, placeholders, None) {
                out_sec.insert("title".into(), json!(v));
            }
            if let Some(v) =
                take_field(sec, "heading", SECTION_HEADING_SPEC, placeholders, None)
            {
                out_sec.insert("heading".into(), json!(v));
            }
            if id == "03" {
                if let Some(v) =
                    take_field(sec, "aside_heading", ASIDE_HEADING_SPEC, placeholders, None)
                {
                    out_sec.insert("aside_heading".into(), json!(v));
                }
            }
            if id != "02" || report_type == "day" {
                if let Some(v) = take_field(sec, "aside", ASIDE_SPEC, placeholders, None) {
                    out_sec.insert("aside".into(), json!(v));
                }
            }
            if !out_sec.is_empty() {
                out_secs.insert(id.to_string(), Value::Object(out_sec));
            }
        }
        if !out_secs.is_empty() {
            out.insert("sections".into(), Value::Object(out_secs));
        }
    }

    if let Some(heads) = obj.get("chart_heads").and_then(|v| v.as_object()) {
        let mut out_heads = serde_json::Map::new();
        let allowed: &[(&str, FieldSpec)] = match report_type {
            "day" => &[("hourly", CHART_HEAD_SPEC)],
            "week" => &[("week", CHART_HEAD_SPEC)],
            _ => &[("calendar", CHART_HEAD_SPEC), ("trend", CHART_HEAD_2_SPEC)],
        };
        for (key, spec) in allowed {
            let direction = chart_direction(report_type, key, directions);
            if let Some(v) = take_field(heads, key, *spec, placeholders, direction) {
                out_heads.insert((*key).to_string(), json!(v));
            }
        }
        if !out_heads.is_empty() {
            out.insert("chart_heads".into(), Value::Object(out_heads));
        }
    }

    if let Some(v) = take_field(obj, "pull_quote", PULL_QUOTE_SPEC, placeholders, None) {
        out.insert("pull_quote".into(), json!(v));
    }
    if let Some(v) = take_field(obj, "closing", CLOSING_SPEC, placeholders, None) {
        out.insert("closing".into(), json!(v));
    }

    if out.is_empty() {
        return None;
    }

    let quips = derive_quips(report_type, &Value::Object(out.clone()));
    out.insert("version".into(), json!(2));
    out.insert("report_type".into(), json!(report_type));
    out.insert("quips".into(), json!(quips));
    Some(Value::Object(out))
}

fn chart_direction<'a>(
    report_type: &str,
    key: &str,
    directions: &'a Value,
) -> Option<&'a str> {
    match (report_type, key) {
        ("day", "hourly") => directions.get("shape").and_then(|v| v.as_str()),
        ("week", "week") => match directions
            .get("weekend_vs_weekday")
            .and_then(|v| v.as_str())
        {
            Some("higher") => Some("weekend_higher"),
            Some("lower") => Some("weekend_lower"),
            Some("equal") => Some("weekend_equal"),
            _ => Some("unknown"),
        },
        ("month", "calendar") => {
            if directions.get("day_spread").and_then(|v| v.as_str()) == Some("even") {
                Some("even")
            } else {
                None
            }
        }
        ("month", "trend") => directions.get("trend").and_then(|v| v.as_str()),
        _ => None,
    }
}

fn take_field(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    spec: FieldSpec,
    placeholders: &BTreeMap<String, String>,
    direction: Option<&str>,
) -> Option<String> {
    let raw = obj.get(key)?.as_str()?.trim();
    validate_field(raw, spec, placeholders, direction)
}

fn validate_field(
    raw: &str,
    spec: FieldSpec,
    placeholders: &BTreeMap<String, String>,
    direction: Option<&str>,
) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    if raw.chars().count() > spec.max + 96 {
        return None;
    }
    if raw.matches('\n').count() + 1 > spec.max_lines {
        return None;
    }

    let substituted = substitute_placeholders(raw, placeholders)?;
    if substituted.contains("[[fact:") || substituted.contains("]]") {
        return None;
    }

    if spec.markup {
        validate_markup(&substituted)?;
    } else if substituted.contains('{') || substituted.contains('}') {
        return None;
    }

    // 非占位符里的阿拉伯数字一律拒绝：数字必须由后端注入。
    let stripped = strip_placeholder_spans(raw)?;
    if stripped.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }

    if let Some(group) = direction {
        if has_opposite_direction(&substituted, group) {
            return None;
        }
    }

    let visible = visible_len(&substituted);
    if visible < spec.min || visible > spec.max {
        return None;
    }
    Some(substituted)
}

fn strip_code_fence(s: &str) -> &str {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("```json") {
        return rest.strip_suffix("```").unwrap_or(rest).trim();
    }
    if let Some(rest) = s.strip_prefix("```") {
        return rest.strip_suffix("```").unwrap_or(rest).trim();
    }
    s
}

fn valid_placeholder_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

/// 找出所有 `[[fact:name]]` 片段；语法错误返回 None。
fn placeholder_spans(s: &str) -> Option<Vec<(usize, usize, String)>> {
    const OPEN: &str = "[[fact:";
    let mut spans = Vec::new();
    let mut idx = 0;
    while let Some(rel) = s[idx..].find(OPEN) {
        let start = idx + rel;
        let name_start = start + OPEN.len();
        let end_rel = s[name_start..].find("]]")?;
        let end = name_start + end_rel;
        let name = &s[name_start..end];
        if !valid_placeholder_name(name) {
            return None;
        }
        spans.push((start, end + 2, name.to_string()));
        idx = end + 2;
    }
    Some(spans)
}

fn substitute_placeholders(
    s: &str,
    map: &BTreeMap<String, String>,
) -> Option<String> {
    let spans = placeholder_spans(s)?;
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    for (start, end, name) in spans {
        out.push_str(&s[cursor..start]);
        let value = map.get(&name)?;
        out.push_str(&sanitize_fact_value(value));
        cursor = end;
    }
    out.push_str(&s[cursor..]);
    if out.contains("[[fact:") || out.contains("]]") {
        return None;
    }
    Some(out)
}

fn strip_placeholder_spans(s: &str) -> Option<String> {
    let spans = placeholder_spans(s)?;
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    for (start, end, _) in spans {
        out.push_str(&s[cursor..start]);
        cursor = end;
    }
    out.push_str(&s[cursor..]);
    Some(out)
}

fn sanitize_fact_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        let c = if matches!(c, '{' | '}' | '[' | ']' | '\r' | '\n') {
            ' '
        } else {
            c
        };
        if c.is_control() {
            continue;
        }
        if c.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().chars().take(200).collect()
}

fn validate_markup(s: &str) -> Option<()> {
    let mut idx = 0;
    while idx < s.len() {
        if s[idx..].starts_with("{{") {
            let rest = &s[idx + 2..];
            let end = rest.find("}}")?;
            let inner = &rest[..end];
            if inner.contains('{') || inner.contains('}') {
                return None;
            }
            let (kind, body) = inner.split_once(':')?;
            if !matches!(kind, "em" | "n") || body.is_empty() {
                return None;
            }
            idx = idx + 2 + end + 2;
        } else {
            let c = s[idx..].chars().next()?;
            if c == '{' || c == '}' {
                return None;
            }
            idx += c.len_utf8();
        }
    }
    Some(())
}

fn visible_len(s: &str) -> usize {
    let mut count = 0;
    let mut idx = 0;
    while idx < s.len() {
        if s[idx..].starts_with("{{") {
            if let Some(rel) = s[idx + 2..].find("}}") {
                let inner = &s[idx + 2..idx + 2 + rel];
                let body = inner.split_once(':').map(|(_, b)| b).unwrap_or(inner);
                count += body.chars().count();
                idx = idx + 2 + rel + 2;
                continue;
            }
        }
        if let Some(c) = s[idx..].chars().next() {
            count += 1;
            idx += c.len_utf8();
        }
    }
    count
}

fn has_opposite_direction(text: &str, group: &str) -> bool {
    let bad: &[&str] = match group {
        "down" => &["涨", "升", "多", "高", "放开", "更忙"],
        "up" => &["收", "降", "落", "少", "冷", "退", "低"],
        "flat" | "unknown" => &[
            "涨", "升", "高", "收", "降", "落", "低", "放开", "更忙", "起伏", "浓淡",
        ],
        "weekend_lower" => &["放开", "更忙", "更多", "主场"],
        "weekend_higher" => &["收", "降", "更少", "安静"],
        "weekend_equal" => &["放开", "更忙", "更多", "主场", "收", "降", "更少"],
        "evening_heavy" => &["白天更", "白天是主场", "白天占", "收得早"],
        "day_heavy" => &["晚上才", "晚上连成片", "夜里更", "越夜越"],
        "balanced" => &["晚上才", "连成片", "白天是主场"],
        "even" => &["有的轻有的满", "起伏", "浓淡"],
        _ => &[],
    };
    bad.iter().any(|w| text.contains(w))
}

fn derive_quips(report_type: &str, doc: &Value) -> Vec<String> {
    let get_aside = |id: &str| -> Option<String> {
        doc.get("sections")?
            .get(id)?
            .get("aside")?
            .as_str()
            .map(str::to_string)
    };
    let mut out = Vec::new();
    if let Some(v) = get_aside("01") {
        out.push(v);
    }
    if report_type == "day" {
        if let Some(v) = get_aside("02") {
            out.push(v);
        }
    }
    if let Some(v) = get_aside("03") {
        out.push(v);
    }
    if let Some(v) = doc.get("closing").and_then(|v| v.as_str()) {
        out.push(v.to_string());
    }
    out
}

// ── 文案小工具 ──────────────────────────────────────────────────────────────

/// 零数据报告的专用叙事（手动生成且整个周期 0 桶时用，不调 AI）。三种报各一句毒舌。
pub fn zero_data_narrative(report_type: &str) -> String {
    match report_type {
        "week" => "这一周你一次都没打开过电脑?{{em:人呢}}?",
        "month" => "这一个月你一次都没打开过电脑?{{em:人呢}}?",
        _ => "这一天你一次都没打开过电脑?{{em:人呢}}?",
    }
    .to_string()
}

/// 对比百分比的展示上限：超过视为「多得离谱」，不显示具体数字。
const DELTA_CAP_PCT: f64 = 300.0;

/// 涨幅/跌幅百分比 → 展示文案。正数超上限 → 「远超平时」；否则「↑ N%」/「↓ N%」。
fn delta_label(pct: f64) -> String {
    if pct > DELTA_CAP_PCT {
        "远超平时".to_string()
    } else if pct >= 0.0 {
        format!("↑ {:.0}%", pct)
    } else {
        format!("↓ {:.0}%", -pct)
    }
}

/// 对比百分比 → 可直接引用的文案。基线不足时返回 `None`，模型不该引用这个数。
fn delta_display(pct: f64, sufficient: bool) -> Option<String> {
    if !sufficient {
        return None;
    }
    Some(delta_label(pct))
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
