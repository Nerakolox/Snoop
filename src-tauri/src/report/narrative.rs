//! 日报叙事文案。
//!
//! Task 2 只落地**本地模板**（T0 兜底）；Task 3 在此接入 AI（`envelope::call_ai`）。
//! 模板要可读，不能是「今天使用了 5 个应用」这种流水账。

use crate::report::daily::DailyReport;

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
        let mut s = format!(
            "在 {} 待得最久（占 {:.0}%）",
            top.name,
            top.share_pct
        );
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
