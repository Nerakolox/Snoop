//! 周报数据算法（批次 6 Task 1）—— 纯计算，不碰 AI。
//!
//! # 周报回答的问题不是「这周发生了什么」，是「这周和平时比如何」
//!
//! 所以主体是**对比**：与前 4 周基线的偏差、一周内部的起伏、作息的变化。
//! 用前 4 周而不是前 1 周做基线 —— 单周波动太大，4 周均值才算得上「平时」。
//!
//! # 两套日界（本模块内并存，务必分清）
//!
//! - **自然日**：总时长、7 天条形、分类占比、应用排行**全部**用它。
//! - **作息日（4:00 日界，见 [`common::RHYTHM_DAY_START_HOUR`]）**：只有作息模块用。
//!   凌晨 1:30 的活动算前一天的尾巴，否则「晚睡」在数据上根本不存在
//!   （桶归日只看 `bucket_start`，见 [`super::daily`] 的「跨午夜归属」）。
//!
//! 两者互不混用。单测 [`tests::week_bars_sum_equals_total`] 就是钉这一点的：
//! 7 天条形之和必须严格等于周活跃总时长。
//!
//! # 分钟数编码（作息模块唯一的编码约定）
//!
//! `start_min` / `end_min` / `overnight_end_min` 一律是**距该作息日所属自然日 00:00 的分钟数**：
//! 09:12 → 552；次日 01:20 → 1520（= 1440 + 80）。取值范围 `[240, 1680)`，即 04:00 到次日 03:59。
//! 前端据此渲染「次日 HH:MM」，不显示 24:41 这种。

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::common::{
    self, add_days, category_shares, day_stats, query_buckets_in_range, sum_active_duration,
    sum_duration, top_apps, week_start_of, AppRank, AppRef, CategoryShare, RawBucket,
    ACTIVE_PREDICATE, FOCUS_GAP_MS, MIN_RHYTHM_ACTIVE_MS, MIN_RHYTHM_DAYS,
    RHYTHM_OVERNIGHT_MARGIN_MIN,
};

/// 基线跨度：前 4 周 = 28 天。
const BASELINE_DAYS: i64 = 28;
const BASELINE_WEEKS: usize = 4;

/// 「消失的应用」的常用门槛：前 4 周累计活跃 ≥ 60 分钟。
///
/// 单设门槛是为了挡掉「装一次、试了半小时就再没打开」这种一次性应用 ——
/// 它本来就不是习惯的一部分，本周没出现不构成信号。
const GONE_APP_MIN_BASELINE_MS: i64 = 60 * 60 * 1000;
/// 「消失的应用」的常用门槛：前 4 周里至少出现在 2 个不同的周。
const GONE_APP_MIN_WEEKS: u32 = 2;
/// 应用清单（新增 / 消失）最多列几条。
const MAX_APP_LIST: usize = 5;

// ── 结构体 ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct WeeklyReport {
    /// 周一 'YYYY-MM-DD'。
    pub week_start: String,
    /// 周日 'YYYY-MM-DD'（闭区间）。
    pub week_end: String,
    // ── 总览（自然日口径） ──
    pub active_ms: i64,
    pub foreground_ms: i64,
    /// 本周「有活跃记录」的天数（`active_ms > 0`）。日均的分母。
    pub days_with_data: u32,
    pub avg_daily_active_ms: i64,
    pub baseline: Baseline4w,
    // ── 分布 ──
    /// 恒 7 条，周一→周日，无数据的日子补零。
    pub days: Vec<DayCell>,
    pub max_day: Option<String>,
    pub min_day: Option<String>,
    pub categories: Vec<CategoryDelta>,
    // ── 作息（4:00 日界口径） ──
    /// 恒 7 条，与 `days` 一一对应。
    pub rhythm: Vec<RhythmDay>,
    pub rhythm_summary: RhythmSummary,
    pub weekday_weekend: WeekdayWeekend,
    // ── 应用（自然日口径） ──
    pub top_apps: Vec<AppRank>,
    pub new_apps: Vec<AppRef>,
    pub gone_apps: Vec<GoneApp>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DayCell {
    pub date: String,
    /// 0=周一 … 6=周日（与前端 `aggregate.ts` 的 `mondayIndex` 同约定）。
    pub dow: u8,
    pub active_ms: i64,
    pub foreground_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Baseline4w {
    pub from_date: String,
    pub to_date: String,
    /// 前 4 周里有活跃记录的周数（0..4）。
    pub weeks_counted: u32,
    /// 前 4 周里有活跃记录的天数。
    pub days_with_data: u32,
    pub avg_daily_active_ms: i64,
    pub avg_weekly_active_ms: i64,
    /// 本周日均 vs 基线日均。分母为 0 → 0.0。
    ///
    /// 用**日均**而不是周总量做头条对比：本周只有 3 天数据、基线周有 7 天时，
    /// 比总量会得出「暴跌 60%」这种假结论。
    pub daily_delta_pct: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CategoryDelta {
    pub category: String,
    pub active_ms: i64,
    pub share_pct: f64,
    pub baseline_share_pct: f64,
    /// 百分点差（`share_pct - baseline_share_pct`），**不是百分比**。
    pub share_delta_pp: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RhythmDay {
    /// 作息日，用自然日日期标识，覆盖 `[该日 04:00, 次日 04:00)`。
    pub date: String,
    /// 开工：作息日内第一个**活跃桶**的起点。被通宵吞掉时为 None。
    pub start_min: Option<i32>,
    /// 入睡：最后一个**活跃桶**的结束点。活动越过下一个 4:00 时为 None。
    pub end_min: Option<i32>,
    /// 作息日口径的活跃时长（只用于 30 分钟下限判定，**不进任何总时长统计**）。
    pub active_ms: i64,
    /// 跨越 4:00 日界（本日开头或结尾被越过）。
    pub overnight: bool,
    /// 通宵时：越过日界之后那一段活跃最终结束的时刻（本日坐标系，必然 > 1680）。
    pub overnight_end_min: Option<i32>,
    /// 是否进入均值。
    pub counted: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RhythmSummary {
    /// 本周进入均值的天数。前端 `< MIN_RHYTHM_DAYS` 时整块不渲染。
    pub days_counted: u32,
    pub avg_start_min: Option<i32>,
    pub avg_end_min: Option<i32>,
    pub baseline_days_counted: u32,
    pub baseline_avg_start_min: Option<i32>,
    pub baseline_avg_end_min: Option<i32>,
    /// 本周 - 基线。正数 = 比平时晚。
    pub start_delta_min: Option<i32>,
    pub end_delta_min: Option<i32>,
    /// 本周被判为通宵的天数（如实展示，中性描述）。
    pub overnight_days: u32,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct WeekdayWeekend {
    pub weekday_days: u32,
    pub weekend_days: u32,
    pub weekday_avg_active_ms: i64,
    pub weekend_avg_active_ms: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GoneApp {
    pub name: String,
    pub bundle_id: String,
    pub baseline_active_ms: i64,
    pub baseline_weeks: u32,
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/// 计算某一周的周报。`week_start` 应是周一；**函数内部会再规范化一次**，
/// 传成周三也不会算出跨周的怪结果。
pub fn compute_weekly_report(conn: &Connection, week_start: &str) -> rusqlite::Result<WeeklyReport> {
    let week_start = week_start_of(conn, week_start)?;
    let week_end = add_days(conn, &week_start, 6)?;

    // ── 本周（自然日口径） ──
    let week_pairs = query_buckets_in_range(conn, &week_start, &week_end)?;
    let week_buckets: Vec<RawBucket> = week_pairs.iter().map(|(_, b)| b.clone()).collect();
    let active_ms = sum_active_duration(&week_buckets);
    let foreground_ms = sum_duration(&week_buckets);

    let days = build_days(conn, &week_start, &week_end)?;
    let days_with_data = days.iter().filter(|d| d.active_ms > 0).count() as u32;
    let avg_daily_active_ms = div_or_zero(active_ms, days_with_data as i64);

    let max_day = days
        .iter()
        .filter(|d| d.active_ms > 0)
        .max_by_key(|d| d.active_ms)
        .map(|d| d.date.clone());
    // 只在「有活跃记录」的日子里选最小 —— 否则没开机那天永远夺冠，数字没有信息量。
    let min_day = days
        .iter()
        .filter(|d| d.active_ms > 0)
        .min_by_key(|d| d.active_ms)
        .map(|d| d.date.clone());

    // ── 基线：前 4 周 ──
    let base_from = add_days(conn, &week_start, -BASELINE_DAYS)?;
    let base_to = add_days(conn, &week_start, -1)?;
    let base_pairs = query_buckets_in_range(conn, &base_from, &base_to)?;
    let base_buckets: Vec<RawBucket> = base_pairs.iter().map(|(_, b)| b.clone()).collect();
    let baseline = build_baseline(
        conn,
        &week_start,
        &base_from,
        &base_to,
        avg_daily_active_ms,
    )?;

    // ── 分类占比 + 与基线的偏差 ──
    let categories = build_category_deltas(conn, &week_buckets, &base_buckets)?;

    // ── 作息（4:00 日界） ──
    let rhythm = compute_rhythm_days(conn, &week_start, &week_end)?;
    let baseline_rhythm = compute_rhythm_days(conn, &base_from, &base_to)?;
    let rhythm_summary = build_rhythm_summary(&rhythm, &baseline_rhythm);

    let weekday_weekend = build_weekday_weekend(&days);

    // ── 应用 ──
    let ranked = top_apps(&week_buckets, usize::MAX);
    let top = ranked.iter().take(5).cloned().collect();
    let new_apps = build_new_apps(&ranked, &base_pairs);
    let gone_apps = build_gone_apps(conn, &week_start, &ranked, &base_pairs)?;

    Ok(WeeklyReport {
        week_start,
        week_end,
        active_ms,
        foreground_ms,
        days_with_data,
        avg_daily_active_ms,
        baseline,
        days,
        max_day,
        min_day,
        categories,
        rhythm,
        rhythm_summary,
        weekday_weekend,
        top_apps: top,
        new_apps,
        gone_apps,
    })
}

fn div_or_zero(total: i64, n: i64) -> i64 {
    if n > 0 {
        total / n
    } else {
        0
    }
}

fn delta_pct(current: i64, baseline: i64) -> f64 {
    if baseline > 0 {
        (current - baseline) as f64 / baseline as f64 * 100.0
    } else {
        0.0
    }
}

// ── 分布 ────────────────────────────────────────────────────────────────────

/// 7 条 `DayCell`，周一→周日。没有桶的日子补零（不是省略），前端条形图直接照着画。
fn build_days(conn: &Connection, week_start: &str, week_end: &str) -> rusqlite::Result<Vec<DayCell>> {
    let stats = day_stats(conn, week_start, week_end)?;
    let by_date: HashMap<String, (i64, i64)> = stats
        .into_iter()
        .map(|s| (s.date, (s.active_ms, s.foreground_ms)))
        .collect();

    let mut out = Vec::with_capacity(7);
    for i in 0..7i64 {
        let date = add_days(conn, week_start, i)?;
        let (active_ms, foreground_ms) = by_date.get(&date).copied().unwrap_or((0, 0));
        out.push(DayCell {
            // week_start 已规范化成周一，所以偏移量 i 就是 dow（0=周一），
            // 不需要再问 SQLite 要星期几。
            dow: i as u8,
            date,
            active_ms,
            foreground_ms,
        });
    }
    Ok(out)
}

fn build_weekday_weekend(days: &[DayCell]) -> WeekdayWeekend {
    let mut weekday_days = 0u32;
    let mut weekend_days = 0u32;
    let mut weekday_ms = 0i64;
    let mut weekend_ms = 0i64;
    for d in days.iter().filter(|d| d.active_ms > 0) {
        if d.dow <= 4 {
            weekday_days += 1;
            weekday_ms += d.active_ms;
        } else {
            weekend_days += 1;
            weekend_ms += d.active_ms;
        }
    }
    WeekdayWeekend {
        weekday_avg_active_ms: div_or_zero(weekday_ms, weekday_days as i64),
        weekend_avg_active_ms: div_or_zero(weekend_ms, weekend_days as i64),
        weekday_days,
        weekend_days,
    }
}

// ── 基线 ────────────────────────────────────────────────────────────────────

fn build_baseline(
    conn: &Connection,
    week_start: &str,
    from: &str,
    to: &str,
    this_week_avg_daily: i64,
) -> rusqlite::Result<Baseline4w> {
    let stats = day_stats(conn, from, to)?;
    let by_date: HashMap<String, i64> = stats.into_iter().map(|s| (s.date, s.active_ms)).collect();

    let mut total_active = 0i64;
    let mut days_with_data = 0u32;
    let mut weeks_counted = 0u32;

    for w in 1..=BASELINE_WEEKS as i64 {
        let ws = add_days(conn, week_start, -7 * w)?;
        let mut week_active = 0i64;
        for i in 0..7i64 {
            let date = add_days(conn, &ws, i)?;
            let active = by_date.get(&date).copied().unwrap_or(0);
            if active > 0 {
                days_with_data += 1;
                week_active += active;
            }
        }
        if week_active > 0 {
            weeks_counted += 1;
            total_active += week_active;
        }
    }

    let avg_daily_active_ms = div_or_zero(total_active, days_with_data as i64);
    Ok(Baseline4w {
        from_date: from.to_string(),
        to_date: to.to_string(),
        weeks_counted,
        days_with_data,
        avg_daily_active_ms,
        avg_weekly_active_ms: div_or_zero(total_active, weeks_counted as i64),
        daily_delta_pct: delta_pct(this_week_avg_daily, avg_daily_active_ms),
    })
}

fn build_category_deltas(
    conn: &Connection,
    week_buckets: &[RawBucket],
    base_buckets: &[RawBucket],
) -> rusqlite::Result<Vec<CategoryDelta>> {
    let this_week = category_shares(conn, week_buckets)?;
    let baseline: HashMap<String, f64> = category_shares(conn, base_buckets)?
        .into_iter()
        .map(|c: CategoryShare| (c.category, c.share_pct))
        .collect();

    Ok(this_week
        .into_iter()
        .map(|c| {
            let base = baseline.get(&c.category).copied().unwrap_or(0.0);
            CategoryDelta {
                category: c.category,
                active_ms: c.active_ms,
                share_pct: c.share_pct,
                baseline_share_pct: base,
                share_delta_pp: c.share_pct - base,
            }
        })
        .collect())
}

// ── 应用 ────────────────────────────────────────────────────────────────────

/// 本周有活跃、前 4 周**完全未出现**（连挂机桶都没有）的应用，按本周活跃降序。
fn build_new_apps(ranked: &[AppRank], base_pairs: &[(String, RawBucket)]) -> Vec<AppRef> {
    let seen: HashSet<&str> = base_pairs
        .iter()
        .map(|(_, b)| b.app_bundle_id.as_str())
        .collect();
    ranked
        .iter()
        .filter(|a| !seen.contains(a.bundle_id.as_str()))
        .take(MAX_APP_LIST)
        .map(|a| AppRef {
            name: a.name.clone(),
            bundle_id: a.bundle_id.clone(),
        })
        .collect()
}

/// 前 4 周「常用」（≥ 60 分钟且出现在 ≥ 2 个周）、本周活跃为 0 的应用，按基线活跃降序。
fn build_gone_apps(
    conn: &Connection,
    week_start: &str,
    ranked: &[AppRank],
    base_pairs: &[(String, RawBucket)],
) -> rusqlite::Result<Vec<GoneApp>> {
    // 把基线 28 天映射到「第几周」，用于「出现在 ≥ 2 个周」的判定。
    let mut week_of_day: HashMap<String, usize> = HashMap::new();
    for w in 0..BASELINE_WEEKS {
        let ws = add_days(conn, week_start, -(BASELINE_DAYS - 7 * w as i64))?;
        for i in 0..7i64 {
            week_of_day.insert(add_days(conn, &ws, i)?, w);
        }
    }

    struct Acc {
        name: String,
        active_ms: i64,
        weeks: HashSet<usize>,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    for (day, b) in base_pairs.iter().filter(|(_, b)| b.is_active()) {
        let e = acc.entry(b.app_bundle_id.clone()).or_insert_with(|| Acc {
            name: b.app_name.clone(),
            active_ms: 0,
            weeks: HashSet::new(),
        });
        e.name = b.app_name.clone();
        e.active_ms += b.duration_ms;
        if let Some(w) = week_of_day.get(day) {
            e.weeks.insert(*w);
        }
    }

    let this_week: HashSet<&str> = ranked.iter().map(|a| a.bundle_id.as_str()).collect();
    let mut out: Vec<GoneApp> = acc
        .into_iter()
        .filter(|(id, a)| {
            a.active_ms >= GONE_APP_MIN_BASELINE_MS
                && a.weeks.len() as u32 >= GONE_APP_MIN_WEEKS
                && !this_week.contains(id.as_str())
        })
        .map(|(id, a)| GoneApp {
            name: a.name,
            bundle_id: id,
            baseline_active_ms: a.active_ms,
            baseline_weeks: a.weeks.len() as u32,
        })
        .collect();
    out.sort_by(|a, b| {
        b.baseline_active_ms
            .cmp(&a.baseline_active_ms)
            .then_with(|| a.bundle_id.cmp(&b.bundle_id))
    });
    out.truncate(MAX_APP_LIST);
    Ok(out)
}

// ── 作息（4:00 日界） ────────────────────────────────────────────────────────

/// 作息日界对应的分钟数（本日坐标）：04:00 → 240。
const BOUNDARY_MIN: i32 = (common::RHYTHM_DAY_START_HOUR * 60) as i32;
/// 下一个作息日界在**本日坐标**下的分钟数：次日 04:00 → 1680。
const NEXT_BOUNDARY_MIN: i32 = 1440 + BOUNDARY_MIN;

/// 一个活跃桶在作息坐标系里的样子。
struct RhythmBucket {
    /// 所属作息日在 `sleep_days` 里的下标。
    day_idx: usize,
    /// 距所属作息日**自然日 00:00** 的分钟数（见模块头注释）。
    start_min: i32,
    bucket_start: i64,
    duration_ms: i64,
}

/// 计算 `[from_day, to_day]` 每个作息日的开工 / 入睡 / 通宵判定。
///
/// 内部实际查询 `[from_day - 1, to_day + 1]`：判定 `from_day` 开头那个 4:00 日界要看前一天，
/// 判定 `to_day` 结尾那个日界要看后一天。返回的只有 `[from_day, to_day]`。
fn compute_rhythm_days(
    conn: &Connection,
    from_day: &str,
    to_day: &str,
) -> rusqlite::Result<Vec<RhythmDay>> {
    let query_from = add_days(conn, from_day, -1)?;
    let query_to = add_days(conn, to_day, 1)?;

    // 作息日 ↔ 下标。日期连续，下标差 = 天数差，用来把任意桶换算到某一天的坐标系。
    let mut sleep_days: Vec<String> = Vec::new();
    let mut idx_of: HashMap<String, usize> = HashMap::new();
    let mut cur = query_from.clone();
    loop {
        idx_of.insert(cur.clone(), sleep_days.len());
        sleep_days.push(cur.clone());
        if cur == query_to {
            break;
        }
        cur = add_days(conn, &cur, 1)?;
    }

    let buckets = query_rhythm_buckets(conn, &query_from, &query_to, &idx_of)?;

    // 每个作息日的活跃桶（查询已按 bucket_start 升序，分组内保持升序）。
    let mut by_day: Vec<Vec<usize>> = vec![Vec::new(); sleep_days.len()];
    let mut active_ms: Vec<i64> = vec![0; sleep_days.len()];
    for (i, b) in buckets.iter().enumerate() {
        by_day[b.day_idx].push(i);
        active_ms[b.day_idx] += b.duration_ms;
    }

    // 连续活跃段（沿用专注段的 5 分钟断段规则）—— 通宵时「未中断到几点」要靠它。
    let runs = build_runs(&buckets);

    // 日界 i（作息日 i 的开头，即 sleep_days[i] 当天的 04:00）是否被熬穿：
    // 前一天有桶落在 [03:30, 04:00) 且本天有桶落在 [04:00, 04:30)。
    let margin = RHYTHM_OVERNIGHT_MARGIN_MIN as i32;
    let mut crossed = vec![false; sleep_days.len()];
    for i in 1..sleep_days.len() {
        let before = by_day[i - 1]
            .iter()
            .any(|&bi| buckets[bi].start_min >= NEXT_BOUNDARY_MIN - margin);
        let after = by_day[i]
            .iter()
            .any(|&bi| buckets[bi].start_min < BOUNDARY_MIN + margin);
        crossed[i] = before && after;
    }

    let from_idx = idx_of[from_day];
    let to_idx = idx_of[to_day];
    let mut out = Vec::with_capacity(to_idx - from_idx + 1);
    for i in from_idx..=to_idx {
        // 本日开头被越过 → 开工被通宵吞掉；本日结尾被越过 → 入睡未知。
        let head_crossed = crossed[i];
        let tail_crossed = i + 1 < sleep_days.len() && crossed[i + 1];
        let overnight = head_crossed || tail_crossed;

        let first = by_day[i].first().copied();
        let last = by_day[i].last().copied();

        let start_min = if head_crossed {
            None
        } else {
            first.map(|bi| buckets[bi].start_min)
        };
        let end_min = if tail_crossed {
            None
        } else {
            last.map(|bi| end_min_of(&buckets[bi], i))
        };
        let overnight_end_min = if tail_crossed {
            // 越过日界之后那一段活跃最终结束在几点（本日坐标，必然 > 1680）。
            //
            // 取的是**日界之后**那一段的结尾，不是日界之前那一段：通宵判定用的是
            // 日界前后各 30 分钟的窗口，两侧之间允许有间隙（去接杯水、发会儿呆），
            // 而连续段用的是 5 分钟断段。若取日界之前那段，一个 15 分钟的间隙就会让
            // 结果停在 03:55 —— 比日界还早，「至次日 03:55」是句废话。
            by_day
                .get(i + 1)
                .and_then(|d| d.first().copied())
                .and_then(|bi| runs.get(&bi).copied())
                .map(|end_bi| end_min_of(&buckets[end_bi], i))
        } else {
            None
        };

        let counted = !overnight
            && active_ms[i] >= MIN_RHYTHM_ACTIVE_MS
            && start_min.is_some()
            && end_min.is_some();

        out.push(RhythmDay {
            date: sleep_days[i].clone(),
            start_min,
            end_min,
            active_ms: active_ms[i],
            overnight,
            overnight_end_min,
            counted,
        });
    }
    Ok(out)
}

/// 桶的结束时刻，换算到作息日 `day_idx` 的坐标系。
///
/// 跨日的换算就是加 1440 × 天数差：作息日 D+k 的坐标原点比 D 晚 k 个自然日。
fn end_min_of(b: &RhythmBucket, day_idx: usize) -> i32 {
    let offset = (b.day_idx as i64 - day_idx as i64) * 1440;
    b.start_min + offset as i32 + (b.duration_ms / 60_000) as i32
}

/// 每个桶 → 它所在连续活跃段的**最后一个桶**的下标。断段规则复用 [`FOCUS_GAP_MS`]。
fn build_runs(buckets: &[RhythmBucket]) -> HashMap<usize, usize> {
    let mut out = HashMap::new();
    let mut i = 0usize;
    while i < buckets.len() {
        let mut end = i;
        let mut cur_end = buckets[i].bucket_start + buckets[i].duration_ms;
        while end + 1 < buckets.len() && buckets[end + 1].bucket_start - cur_end <= FOCUS_GAP_MS {
            end += 1;
            cur_end = cur_end.max(buckets[end].bucket_start + buckets[end].duration_ms);
        }
        for k in i..=end {
            out.insert(k, end);
        }
        i = end + 1;
    }
    out
}

/// 查作息坐标系下的**活跃桶**（挂机桶一律不参与作息 —— 否则挂机会把「入睡时间」无限后延）。
fn query_rhythm_buckets(
    conn: &Connection,
    from_day: &str,
    to_day: &str,
    idx_of: &HashMap<String, usize>,
) -> rusqlite::Result<Vec<RhythmBucket>> {
    let shift = common::RHYTHM_DAY_START_HOUR;
    // local = 桶起点的本地墙钟；sleep_day = 往前推 4 小时后的日期。
    let local = "datetime(bucket_start/1000,'unixepoch','localtime')";
    let sleep_day = format!("date(datetime(bucket_start/1000,'unixepoch','localtime','-{shift} hours'))");
    let sql = format!(
        "SELECT {sleep_day} AS sleep_day,
                CAST(strftime('%H', {local}) AS INTEGER) * 60
                  + CAST(strftime('%M', {local}) AS INTEGER)
                  + (CASE WHEN date({local}) > {sleep_day} THEN 1440 ELSE 0 END) AS start_min,
                bucket_start, duration_ms
         FROM activity_buckets
         WHERE {ACTIVE_PREDICATE}
           AND {sleep_day} >= ?1 AND {sleep_day} <= ?2
         ORDER BY bucket_start ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([from_day, to_day], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;

    let mut out = Vec::new();
    for r in rows {
        let (day, start_min, bucket_start, duration_ms) = r?;
        let Some(&day_idx) = idx_of.get(&day) else {
            continue; // 理论上不会发生：SQL 已按同一表达式过滤过范围。
        };
        out.push(RhythmBucket {
            day_idx,
            start_min: start_min as i32,
            bucket_start,
            duration_ms,
        });
    }
    Ok(out)
}

fn avg_min(days: &[RhythmDay], pick: impl Fn(&RhythmDay) -> Option<i32>) -> Option<i32> {
    let vals: Vec<i32> = days.iter().filter(|d| d.counted).filter_map(pick).collect();
    if (vals.len() as u32) < MIN_RHYTHM_DAYS {
        return None;
    }
    Some((vals.iter().map(|v| *v as i64).sum::<i64>() / vals.len() as i64) as i32)
}

fn build_rhythm_summary(week: &[RhythmDay], baseline: &[RhythmDay]) -> RhythmSummary {
    let days_counted = week.iter().filter(|d| d.counted).count() as u32;
    let baseline_days_counted = baseline.iter().filter(|d| d.counted).count() as u32;

    let avg_start_min = avg_min(week, |d| d.start_min);
    let avg_end_min = avg_min(week, |d| d.end_min);
    let baseline_avg_start_min = avg_min(baseline, |d| d.start_min);
    let baseline_avg_end_min = avg_min(baseline, |d| d.end_min);

    RhythmSummary {
        days_counted,
        avg_start_min,
        avg_end_min,
        baseline_days_counted,
        baseline_avg_start_min,
        baseline_avg_end_min,
        start_delta_min: match (avg_start_min, baseline_avg_start_min) {
            (Some(a), Some(b)) => Some(a - b),
            _ => None,
        },
        end_delta_min: match (avg_end_min, baseline_avg_end_min) {
            (Some(a), Some(b)) => Some(a - b),
            _ => None,
        },
        overnight_days: week.iter().filter(|d| d.overnight).count() as u32,
    }
}

// ── 单测 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-08-17 是周一（已用 sqlite3 核对）。
    const MON: &str = "2026-08-17";

    fn init_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_buckets (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_start    INTEGER NOT NULL,
                duration_ms     INTEGER NOT NULL,
                app_name        TEXT NOT NULL,
                app_bundle_id   TEXT NOT NULL,
                key_total       INTEGER NOT NULL,
                mouse_left      INTEGER NOT NULL,
                mouse_right     INTEGER NOT NULL,
                mouse_middle    INTEGER NOT NULL,
                mouse_back      INTEGER NOT NULL DEFAULT 0,
                mouse_forward   INTEGER NOT NULL DEFAULT 0,
                mouse_move_dist INTEGER NOT NULL,
                scroll_dist     INTEGER NOT NULL
            );
            CREATE TABLE app_categories (
                app_id           TEXT PRIMARY KEY,
                category         TEXT NOT NULL,
                source           TEXT NOT NULL,
                confidence       REAL,
                classified_at_ms INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    /// 本地墙钟 'YYYY-MM-DD' + 'HH:MM:SS' → UTC ms。
    /// 走 SQLite 的 'utc' 修饰符，测试因此不依赖机器时区（与 daily.rs 的做法一致）。
    fn ts(conn: &Connection, date: &str, hms: &str) -> i64 {
        conn.query_row(
            "SELECT CAST(strftime('%s', ?1 || ' ' || ?2, 'utc') AS INTEGER) * 1000",
            [date, hms],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn day_of(conn: &Connection, date: &str, n: i64) -> String {
        add_days(conn, date, n).unwrap()
    }

    /// 插一个**活跃**桶（key_total=10）。
    fn put(conn: &Connection, at_ms: i64, dur_ms: i64, app: &str) {
        conn.execute(
            "INSERT INTO activity_buckets
             (bucket_start, duration_ms, app_name, app_bundle_id, key_total,
              mouse_left, mouse_right, mouse_middle, mouse_back, mouse_forward,
              mouse_move_dist, scroll_dist)
             VALUES (?1,?2,?3,?4,10,0,0,0,0,0,0,0)",
            rusqlite::params![at_ms, dur_ms, app, app],
        )
        .unwrap();
    }

    /// 插一个**挂机**桶（无任何输入）。
    fn put_idle(conn: &Connection, at_ms: i64, dur_ms: i64, app: &str) {
        conn.execute(
            "INSERT INTO activity_buckets
             (bucket_start, duration_ms, app_name, app_bundle_id, key_total,
              mouse_left, mouse_right, mouse_middle, mouse_back, mouse_forward,
              mouse_move_dist, scroll_dist)
             VALUES (?1,?2,?3,?4,0,0,0,0,0,0,9999,0)",
            rusqlite::params![at_ms, dur_ms, app, app],
        )
        .unwrap();
    }

    const HOUR: i64 = 3_600_000;
    const MIN: i64 = 60_000;

    /// 在 `date` 的 `start_hms` 开始放一段活跃（一个桶，够长即可）。
    fn workday(conn: &Connection, date: &str, start_hms: &str, dur_ms: i64) {
        let at = ts(conn, date, start_hms);
        put(conn, at, dur_ms, "VS Code");
    }

    // 1) 两套日界不串味：7 天条形之和 == 周活跃总时长。
    #[test]
    fn week_bars_sum_equals_total() {
        let conn = init_db();
        workday(&conn, MON, "09:00:00", 2 * HOUR);
        workday(&conn, &day_of(&conn, MON, 2), "10:00:00", 3 * HOUR);
        // 一段跨午夜的深夜活动：自然日归周三，作息日归周二 —— 总量不受作息日界影响。
        put(&conn, ts(&conn, &day_of(&conn, MON, 2), "23:40:00"), 40 * MIN, "VS Code");
        put(&conn, ts(&conn, &day_of(&conn, MON, 3), "01:00:00"), 30 * MIN, "VS Code");
        // 挂机桶只进前台，不进活跃。
        put_idle(&conn, ts(&conn, &day_of(&conn, MON, 4), "14:00:00"), HOUR, "IDM");

        let r = compute_weekly_report(&conn, MON).unwrap();
        let bars: i64 = r.days.iter().map(|d| d.active_ms).sum();
        assert_eq!(bars, r.active_ms, "7 天条形之和必须等于周活跃总时长");
        assert_eq!(r.days.len(), 7);
        assert_eq!(r.active_ms, 2 * HOUR + 3 * HOUR + 40 * MIN + 30 * MIN);
        assert_eq!(r.foreground_ms, r.active_ms + HOUR);
    }

    // 2) 熬穿 4:00 → 相邻两个作息日都判通宵、都不进均值。
    #[test]
    fn overnight_marks_both_adjacent_days() {
        let conn = init_db();
        let tue = day_of(&conn, MON, 1);
        // 周一开工，一路干到周二 05:20：日界前后各 30 分钟内都有活跃桶。
        workday(&conn, MON, "09:00:00", 2 * HOUR);
        put(&conn, ts(&conn, &tue, "03:40:00"), 15 * MIN, "VS Code");
        put(&conn, ts(&conn, &tue, "04:10:00"), 70 * MIN, "VS Code");

        let r = compute_weekly_report(&conn, MON).unwrap();
        let mon_rhythm = &r.rhythm[0];
        let tue_rhythm = &r.rhythm[1];

        assert!(mon_rhythm.overnight, "周一结尾越过 4:00");
        assert!(tue_rhythm.overnight, "周二开头被通宵吞掉");
        assert!(!mon_rhythm.counted && !tue_rhythm.counted, "两天都不进均值");
        assert_eq!(mon_rhythm.start_min, Some(9 * 60), "周一开工照常记录");
        assert_eq!(mon_rhythm.end_min, None, "周一入睡未知");
        assert_eq!(tue_rhythm.start_min, None, "周二开工被通宵吞掉");
        // 未中断到周二 05:20 → 周一坐标系下 1440 + 320 = 1760。
        assert_eq!(mon_rhythm.overnight_end_min, Some(1440 + 5 * 60 + 20));
        assert_eq!(r.rhythm_summary.overnight_days, 2);
    }

    // 3) 通宵日不污染均值：5 个正常日 + 1 组通宵 → 分母是 5。
    #[test]
    fn overnight_excluded_from_average() {
        let conn = init_db();
        // 周一~周五：09:00 开工，干 2 小时。
        for i in 0..5i64 {
            workday(&conn, &day_of(&conn, MON, i), "09:00:00", 2 * HOUR);
        }
        // 周六→周日通宵。
        let sat = day_of(&conn, MON, 5);
        let sun = day_of(&conn, MON, 6);
        workday(&conn, &sat, "20:00:00", 2 * HOUR);
        put(&conn, ts(&conn, &sun, "03:45:00"), 10 * MIN, "VS Code");
        put(&conn, ts(&conn, &sun, "04:05:00"), 60 * MIN, "VS Code");

        let r = compute_weekly_report(&conn, MON).unwrap();
        assert_eq!(r.rhythm_summary.days_counted, 5);
        assert_eq!(r.rhythm_summary.avg_start_min, Some(9 * 60));
        assert_eq!(r.rhythm_summary.avg_end_min, Some(11 * 60));
        assert_eq!(r.rhythm_summary.overnight_days, 2);
    }

    // 4) 活跃不足 30 分钟的一天：不进作息均值，但仍计入总时长。
    #[test]
    fn short_day_not_counted_but_still_in_totals() {
        let conn = init_db();
        for i in 0..3i64 {
            workday(&conn, &day_of(&conn, MON, i), "09:00:00", 2 * HOUR);
        }
        let thu = day_of(&conn, MON, 3);
        workday(&conn, &thu, "23:00:00", 5 * MIN); // 只有 5 分钟

        let r = compute_weekly_report(&conn, MON).unwrap();
        let thu_rhythm = &r.rhythm[3];
        assert!(!thu_rhythm.counted, "不足 30 分钟不进作息均值");
        assert!(!thu_rhythm.overnight);
        assert_eq!(thu_rhythm.start_min, Some(23 * 60), "开工时间仍如实记录");
        assert_eq!(r.rhythm_summary.days_counted, 3);
        // 但总时长统计一分不少。
        assert_eq!(r.days[3].active_ms, 5 * MIN);
        assert_eq!(r.active_ms, 6 * HOUR + 5 * MIN);
        assert_eq!(r.days_with_data, 4);
    }

    // 5) 可用天数 < 3 → 均值为 None（前端据此整块隐藏）。
    #[test]
    fn rhythm_hidden_when_fewer_than_three_days() {
        let conn = init_db();
        workday(&conn, MON, "09:00:00", 2 * HOUR);
        workday(&conn, &day_of(&conn, MON, 1), "10:00:00", 2 * HOUR);

        let r = compute_weekly_report(&conn, MON).unwrap();
        assert_eq!(r.rhythm_summary.days_counted, 2);
        assert_eq!(r.rhythm_summary.avg_start_min, None);
        assert_eq!(r.rhythm_summary.avg_end_min, None);
        assert_eq!(r.rhythm_summary.start_delta_min, None);
    }

    // 6) 消失的应用：要同时满足「≥60 分钟」和「≥2 个周」。
    #[test]
    fn gone_apps_require_an_hour_and_two_weeks() {
        let conn = init_db();
        // 基线里：Slack 在前 1 周和前 3 周各用 40 分钟（合计 80 分钟、2 个周）→ 算常用。
        put(&conn, ts(&conn, &day_of(&conn, MON, -3), "10:00:00"), 40 * MIN, "Slack");
        put(&conn, ts(&conn, &day_of(&conn, MON, -17), "10:00:00"), 40 * MIN, "Slack");
        // Figma 只在前 2 周用过一次，但用了 3 小时 → 只有 1 个周，不算常用。
        put(&conn, ts(&conn, &day_of(&conn, MON, -10), "10:00:00"), 3 * HOUR, "Figma");
        // 本周只用 VS Code。
        workday(&conn, MON, "09:00:00", 2 * HOUR);

        let r = compute_weekly_report(&conn, MON).unwrap();
        let gone: Vec<&str> = r.gone_apps.iter().map(|a| a.bundle_id.as_str()).collect();
        assert_eq!(gone, vec!["Slack"]);
        assert_eq!(r.gone_apps[0].baseline_weeks, 2);
        assert_eq!(r.gone_apps[0].baseline_active_ms, 80 * MIN);
        // VS Code 在基线里没出现过 → 本周算新应用。
        assert_eq!(r.new_apps.len(), 1);
        assert_eq!(r.new_apps[0].bundle_id, "VS Code");
    }

    // 7) 基线全空：不 panic、不除零。
    #[test]
    fn empty_baseline_does_not_divide_by_zero() {
        let conn = init_db();
        workday(&conn, MON, "09:00:00", 2 * HOUR);

        let r = compute_weekly_report(&conn, MON).unwrap();
        assert_eq!(r.baseline.weeks_counted, 0);
        assert_eq!(r.baseline.days_with_data, 0);
        assert_eq!(r.baseline.avg_daily_active_ms, 0);
        assert_eq!(r.baseline.avg_weekly_active_ms, 0);
        assert_eq!(r.baseline.daily_delta_pct, 0.0);
        assert_eq!(r.rhythm_summary.baseline_avg_start_min, None);
    }

    // 8) 传周三进来，week_start 仍规范化成那周的周一。
    #[test]
    fn week_start_is_normalized_to_monday() {
        let conn = init_db();
        let wed = day_of(&conn, MON, 2);
        workday(&conn, &wed, "09:00:00", HOUR);

        let r = compute_weekly_report(&conn, &wed).unwrap();
        assert_eq!(r.week_start, MON);
        assert_eq!(r.week_end, day_of(&conn, MON, 6));
        assert_eq!(r.days[2].date, wed);
        assert_eq!(r.days[2].dow, 2);
    }
}
