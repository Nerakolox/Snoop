//! 日报叙事文案。
//!
//! **核心原则**：算术全在本机，LLM 只负责措辞。所有数字由 [`daily`] 算好，这里把
//! 已经确定的事实组织成 payload，走 [`envelope::call_ai`]（`featureId = ai.daily-report`）
//! 单一出口；失败 / tier 不足 / 功能关闭时落到本地模板（T0 兜底）。

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::ai::config::AiConfigState;
use crate::ai::envelope::{self, AiCodeMap};
use crate::report::daily::DailyReport;

/// 叙事 system prompt。数字全部由 facts 提供，模型只措辞、不许算、不许评。
const SYSTEM_PROMPT: &str = "你是 Snoop 里的猫，陪用户回顾一天。facts 是已经算好的确定事实，数字全部正确。你的唯一任务是把它组织成 100–150 字的中文叙事，语气是陪伴、观察，不是监工、不是绩效报告。\n\
禁止：自己计算、推断或改写任何数字；编造 facts 里没有的事实；评判用户（不说「效率低」「浪费时间」「摸鱼」「发呆」「浪费」）；把「前台无输入的时间」说成负面（它可能是开会、阅读、看视频、思考）；提到窗口标题。\n\
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
