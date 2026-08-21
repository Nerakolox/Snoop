//! 月报数据算法（批次 6 Task 2）—— 纯计算，不碰 AI。
//!
//! # 月报回答的问题是「变化趋势」
//!
//! 所以主体是**走势**：按周切分看起伏、上半月 vs 下半月的分类占比变化。
//! 趋势就是趋势，**本模块只给数字，不给结论** —— 字段名、注释、文案一律中性，
//! 不出现 `busiest` / `quietest` / 「高产」/「摸鱼」这类评价词。
//!
//! # weekday × 小时热力网格不在这里
//!
//! 那张网格由前端渲染时用 `analytics/aggregate.ts` 的 `aggregateDowHourGrid` 现算
//! （吃 `get_hourly_activity` + `get_hourly_heartbeats` 两个既有命令）。
//! 在 Rust 里重写一份 intensity / 三态逻辑会变成第二个真源，得不偿失；
//! 过去月份的原始桶不会再变，现算与快照等价。
//!
//! # 日界
//!
//! 月报**全部用自然日**，不涉及作息模块，因此没有 4:00 日界的事。

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::common::{
    add_days, category_shares, day_stats, dow_of, month_end_of, month_start_of,
    query_buckets_in_range, sum_active_duration, sum_duration, top_apps, week_start_of, AppRank,
    AppRef, CategoryShare, RawBucket,
};
use super::weekly::DayCell;

/// 上下半月的切分点：1–15 号 / 16 号–月末。
///
/// 两侧天数不等（15 vs 13~16）无所谓 —— 比的是**占比**，不是总量。
const HALF_SPLIT_DAY: u32 = 15;
/// 月维度的应用排行给到 Top 10（比日报/周报多几个，月尺度上长尾才有意义）。
const TOP_APPS_N: usize = 10;
/// 「整月新增」的回看窗口：此前 90 天没出现过才算新。
const NEW_APP_LOOKBACK_DAYS: i64 = 90;
/// 新增应用最多列几条。
const MAX_NEW_APPS: usize = 8;

// ── 结构体 ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct MonthlyReport {
    /// 'YYYY-MM-01'。
    pub month_start: String,
    /// 该月最后一天。
    pub month_end: String,
    // ── 总览 ──
    pub active_ms: i64,
    pub foreground_ms: i64,
    /// 本月「有活跃记录」的天数（`active_ms > 0`）。日均的分母。
    pub days_with_data: u32,
    pub avg_daily_active_ms: i64,
    pub prev_month: PrevMonth,
    // ── 趋势（月报的核心） ──
    pub weeks: Vec<MonthWeek>,
    pub half_shift: Vec<CategoryHalfShift>,
    /// 活跃时长最长的一天。**只给日期和数字**。
    pub max_day: Option<DayCell>,
    /// 有活跃记录的日子里活跃时长最短的一天。**只给日期和数字**。
    pub min_day: Option<DayCell>,
    // ── 分布 ──
    pub categories: Vec<CategoryShare>,
    // ── 应用 ──
    pub top_apps: Vec<AppRank>,
    pub new_apps: Vec<AppRef>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PrevMonth {
    pub month_start: String,
    pub active_ms: i64,
    pub days_with_data: u32,
    pub avg_daily_active_ms: i64,
    /// 本月日均 vs 上月日均。分母为 0 → 0.0。
    pub daily_delta_pct: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MonthWeek {
    /// 该周周一（**可能早于 `month_start`**）。
    pub week_start: String,
    /// 实际统计区间起 = `max(week_start, month_start)`。
    pub clip_from: String,
    /// 实际统计区间止 = `min(week_end, month_end)`。
    pub clip_to: String,
    /// 该周落在本月内的天数（1..7）。
    pub days_in_month: u32,
    pub days_with_data: u32,
    /// `days_in_month < 7`，即被月初/月末截断的半截周。
    pub partial: bool,
    pub active_ms: i64,
    pub avg_daily_active_ms: i64,
    /// 该周的分类占比，用来看走势。
    pub categories: Vec<CategoryShare>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CategoryHalfShift {
    pub category: String,
    pub first_half_share_pct: f64,
    pub second_half_share_pct: f64,
    /// 百分点差（后半 - 前半），**不是百分比**。
    pub delta_pp: f64,
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/// 计算某个自然月的月报。`month_start` 应是月首日；**函数内部会再规范化一次**。
pub fn compute_monthly_report(
    conn: &Connection,
    month_start: &str,
) -> rusqlite::Result<MonthlyReport> {
    let month_start = month_start_of(conn, month_start)?;
    let month_end = month_end_of(conn, &month_start)?;

    let pairs = query_buckets_in_range(conn, &month_start, &month_end)?;
    let buckets: Vec<RawBucket> = pairs.iter().map(|(_, b)| b.clone()).collect();
    let active_ms = sum_active_duration(&buckets);
    let foreground_ms = sum_duration(&buckets);

    let stats = day_stats(conn, &month_start, &month_end)?;
    let by_date: HashMap<String, (i64, i64)> = stats
        .iter()
        .map(|s| (s.date.clone(), (s.active_ms, s.foreground_ms)))
        .collect();
    let days_with_data = stats.iter().filter(|s| s.active_ms > 0).count() as u32;
    let avg_daily_active_ms = div_or_zero(active_ms, days_with_data as i64);

    let (max_day, min_day) = pick_extreme_days(conn, &stats)?;
    let prev_month = build_prev_month(conn, &month_start, avg_daily_active_ms)?;
    let weeks = build_weeks(conn, &month_start, &month_end, &by_date, &pairs)?;
    let half_shift = build_half_shift(conn, &pairs)?;
    let categories = category_shares(conn, &buckets)?;

    let ranked = top_apps(&buckets, usize::MAX);
    let top = ranked.iter().take(TOP_APPS_N).cloned().collect();
    let new_apps = build_new_apps(conn, &month_start, &ranked)?;

    Ok(MonthlyReport {
        month_start,
        month_end,
        active_ms,
        foreground_ms,
        days_with_data,
        avg_daily_active_ms,
        prev_month,
        weeks,
        half_shift,
        max_day,
        min_day,
        categories,
        top_apps: top,
        new_apps,
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

/// 日期字符串的「日」部分（'2026-08-09' → 9）。ISO 日期定长，直接切。
fn day_of_month(date: &str) -> u32 {
    date.get(8..10).and_then(|s| s.parse().ok()).unwrap_or(0)
}

// ── 总览 ────────────────────────────────────────────────────────────────────

/// 最长 / 最短的一天。**最短只在有活跃记录的日子里选** ——
/// 否则「没开机那天」永远夺冠，这个数字就没有信息量。
fn pick_extreme_days(
    conn: &Connection,
    stats: &[super::common::DayStat],
) -> rusqlite::Result<(Option<DayCell>, Option<DayCell>)> {
    let with_data: Vec<&super::common::DayStat> =
        stats.iter().filter(|s| s.active_ms > 0).collect();
    let max = with_data.iter().max_by_key(|s| s.active_ms).copied();
    let min = with_data.iter().min_by_key(|s| s.active_ms).copied();

    let to_cell = |s: Option<&super::common::DayStat>| -> rusqlite::Result<Option<DayCell>> {
        match s {
            None => Ok(None),
            Some(s) => Ok(Some(DayCell {
                dow: dow_of(conn, &s.date)?,
                date: s.date.clone(),
                active_ms: s.active_ms,
                foreground_ms: s.foreground_ms,
            })),
        }
    };
    Ok((to_cell(max)?, to_cell(min)?))
}

fn build_prev_month(
    conn: &Connection,
    month_start: &str,
    this_avg_daily: i64,
) -> rusqlite::Result<PrevMonth> {
    let prev_start: String = conn.query_row(
        "SELECT date(?1, '-1 month')",
        [month_start],
        |r| r.get(0),
    )?;
    let prev_end = month_end_of(conn, &prev_start)?;
    let stats = day_stats(conn, &prev_start, &prev_end)?;

    let active_ms: i64 = stats.iter().map(|s| s.active_ms).sum();
    let days_with_data = stats.iter().filter(|s| s.active_ms > 0).count() as u32;
    let avg_daily_active_ms = div_or_zero(active_ms, days_with_data as i64);

    Ok(PrevMonth {
        month_start: prev_start,
        active_ms,
        days_with_data,
        avg_daily_active_ms,
        daily_delta_pct: delta_pct(this_avg_daily, avg_daily_active_ms),
    })
}

// ── 趋势 ────────────────────────────────────────────────────────────────────

/// 按周切分，**首尾周裁剪到本月内**并打上 `partial` 标记。
///
/// 不裁剪会把上月/下月的时长算进本月总量；裁剪但不标记，趋势图上月初那根 2 天的
/// 半截周看起来像「这周崩了」。所以两件事都要做，把判断权交给前端去如实标注。
fn build_weeks(
    conn: &Connection,
    month_start: &str,
    month_end: &str,
    by_date: &HashMap<String, (i64, i64)>,
    pairs: &[(String, RawBucket)],
) -> rusqlite::Result<Vec<MonthWeek>> {
    let mut out = Vec::new();
    let mut ws = week_start_of(conn, month_start)?;

    while ws.as_str() <= month_end {
        let we = add_days(conn, &ws, 6)?;
        let clip_from = if ws.as_str() < month_start {
            month_start.to_string()
        } else {
            ws.clone()
        };
        let clip_to = if we.as_str() > month_end {
            month_end.to_string()
        } else {
            we.clone()
        };

        let mut days_in_month = 0u32;
        let mut days_with_data = 0u32;
        let mut active_ms = 0i64;
        let mut d = clip_from.clone();
        while d.as_str() <= clip_to.as_str() {
            days_in_month += 1;
            let active = by_date.get(&d).map(|(a, _)| *a).unwrap_or(0);
            if active > 0 {
                days_with_data += 1;
                active_ms += active;
            }
            d = add_days(conn, &d, 1)?;
        }

        let week_buckets: Vec<RawBucket> = pairs
            .iter()
            .filter(|(day, _)| day.as_str() >= clip_from.as_str() && day.as_str() <= clip_to.as_str())
            .map(|(_, b)| b.clone())
            .collect();

        out.push(MonthWeek {
            week_start: ws.clone(),
            clip_from,
            clip_to,
            days_in_month,
            days_with_data,
            partial: days_in_month < 7,
            active_ms,
            avg_daily_active_ms: div_or_zero(active_ms, days_with_data as i64),
            categories: category_shares(conn, &week_buckets)?,
        });

        ws = add_days(conn, &ws, 7)?;
    }
    Ok(out)
}

/// 上半月（1–15）vs 下半月（16–月末）的分类占比变化。
///
/// 任一半没有活跃 → 返回空（前端整块不渲染）。只有一半数据时谈「变化」是无稽之谈。
fn build_half_shift(
    conn: &Connection,
    pairs: &[(String, RawBucket)],
) -> rusqlite::Result<Vec<CategoryHalfShift>> {
    let mut first: Vec<RawBucket> = Vec::new();
    let mut second: Vec<RawBucket> = Vec::new();
    for (day, b) in pairs {
        if day_of_month(day) <= HALF_SPLIT_DAY {
            first.push(b.clone());
        } else {
            second.push(b.clone());
        }
    }

    if sum_active_duration(&first) == 0 || sum_active_duration(&second) == 0 {
        return Ok(Vec::new());
    }

    let first_shares: HashMap<String, f64> = category_shares(conn, &first)?
        .into_iter()
        .map(|c| (c.category, c.share_pct))
        .collect();
    let second_shares: HashMap<String, f64> = category_shares(conn, &second)?
        .into_iter()
        .map(|c| (c.category, c.share_pct))
        .collect();

    let mut cats: Vec<String> = first_shares
        .keys()
        .chain(second_shares.keys())
        .cloned()
        .collect::<HashSet<String>>()
        .into_iter()
        .collect();
    cats.sort();

    let mut out: Vec<CategoryHalfShift> = cats
        .into_iter()
        .map(|category| {
            let a = first_shares.get(&category).copied().unwrap_or(0.0);
            let b = second_shares.get(&category).copied().unwrap_or(0.0);
            CategoryHalfShift {
                category,
                first_half_share_pct: a,
                second_half_share_pct: b,
                delta_pp: b - a,
            }
        })
        .collect();
    // 变化大的排前面 —— 这块的信息量全在「谁变了」。
    out.sort_by(|x, y| {
        y.delta_pp
            .abs()
            .partial_cmp(&x.delta_pp.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| x.category.cmp(&y.category))
    });
    Ok(out)
}

// ── 应用 ────────────────────────────────────────────────────────────────────

/// 本月有活跃、此前 90 天完全未出现的应用，按本月活跃降序。
fn build_new_apps(
    conn: &Connection,
    month_start: &str,
    ranked: &[AppRank],
) -> rusqlite::Result<Vec<AppRef>> {
    let from = add_days(conn, month_start, -NEW_APP_LOOKBACK_DAYS)?;
    let to = add_days(conn, month_start, -1)?;
    let prior: HashSet<String> = query_buckets_in_range(conn, &from, &to)?
        .into_iter()
        .map(|(_, b)| b.app_bundle_id)
        .collect();

    Ok(ranked
        .iter()
        .filter(|a| !prior.contains(&a.bundle_id))
        .take(MAX_NEW_APPS)
        .map(|a| AppRef {
            name: a.name.clone(),
            bundle_id: a.bundle_id.clone(),
        })
        .collect())
}

// ── 单测 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-07-01 是周三 —— 首周只有 5 天（周三…周日）落在本月内。
    const JUL: &str = "2026-07-01";

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

    fn ts(conn: &Connection, date: &str, hms: &str) -> i64 {
        conn.query_row(
            "SELECT CAST(strftime('%s', ?1 || ' ' || ?2, 'utc') AS INTEGER) * 1000",
            [date, hms],
            |r| r.get(0),
        )
        .unwrap()
    }

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

    /// 手动钉死某个应用的分类（manual 优先级最高，绕开 builtin 的名字匹配）。
    fn classify(conn: &Connection, app: &str, category: &str) {
        conn.execute(
            "INSERT INTO app_categories (app_id, category, source, confidence, classified_at_ms)
             VALUES (?1, ?2, 'manual', NULL, 0)",
            rusqlite::params![app, category],
        )
        .unwrap();
    }

    const HOUR: i64 = 3_600_000;

    fn day(n: u32) -> String {
        format!("2026-07-{n:02}")
    }

    // 1) 首尾周裁剪 + partial 标记，且各周之和 == 月总量。
    #[test]
    fn weeks_are_clipped_and_marked_partial() {
        let conn = init_db();
        put(&conn, ts(&conn, &day(1), "09:00:00"), 2 * HOUR, "VS Code");
        put(&conn, ts(&conn, &day(8), "09:00:00"), 3 * HOUR, "VS Code");
        put(&conn, ts(&conn, &day(31), "09:00:00"), HOUR, "VS Code");

        let r = compute_monthly_report(&conn, JUL).unwrap();
        assert_eq!(r.month_start, "2026-07-01");
        assert_eq!(r.month_end, "2026-07-31");

        let first = &r.weeks[0];
        assert_eq!(first.clip_from, "2026-07-01");
        assert_eq!(first.clip_to, "2026-07-05");
        assert_eq!(first.days_in_month, 5, "2026-07-01 是周三，首周只有 5 天在本月");
        assert!(first.partial);
        assert!(first.week_start < first.clip_from, "周一早于月首日");

        let last = r.weeks.last().unwrap();
        assert_eq!(last.clip_to, "2026-07-31");
        assert!(last.partial);

        let sum: i64 = r.weeks.iter().map(|w| w.active_ms).sum();
        assert_eq!(sum, r.active_ms, "各周之和必须等于月活跃总时长");
        assert_eq!(r.active_ms, 6 * HOUR);
    }

    // 2) 上下半月的分类占比变化，符号要对。
    #[test]
    fn half_shift_signs_are_correct() {
        let conn = init_db();
        classify(&conn, "Editor", "development");
        classify(&conn, "Chat", "communication");
        // 上半月全是开发，下半月全是沟通。
        put(&conn, ts(&conn, &day(10), "09:00:00"), 2 * HOUR, "Editor");
        put(&conn, ts(&conn, &day(20), "09:00:00"), 2 * HOUR, "Chat");

        let r = compute_monthly_report(&conn, JUL).unwrap();
        let dev = r
            .half_shift
            .iter()
            .find(|c| c.category == "development")
            .unwrap();
        let chat = r
            .half_shift
            .iter()
            .find(|c| c.category == "communication")
            .unwrap();

        assert_eq!(dev.first_half_share_pct, 100.0);
        assert_eq!(dev.second_half_share_pct, 0.0);
        assert_eq!(dev.delta_pp, -100.0);
        assert_eq!(chat.delta_pp, 100.0);
    }

    // 2b) 只有半个月有数据 → 不谈「变化」。
    #[test]
    fn half_shift_empty_when_one_half_is_blank() {
        let conn = init_db();
        put(&conn, ts(&conn, &day(3), "09:00:00"), 2 * HOUR, "Editor");

        let r = compute_monthly_report(&conn, JUL).unwrap();
        assert!(r.half_shift.is_empty());
    }

    // 3) 上月无数据：不 panic、不除零。
    #[test]
    fn empty_prev_month_does_not_divide_by_zero() {
        let conn = init_db();
        put(&conn, ts(&conn, &day(3), "09:00:00"), 2 * HOUR, "VS Code");

        let r = compute_monthly_report(&conn, JUL).unwrap();
        assert_eq!(r.prev_month.month_start, "2026-06-01");
        assert_eq!(r.prev_month.active_ms, 0);
        assert_eq!(r.prev_month.days_with_data, 0);
        assert_eq!(r.prev_month.daily_delta_pct, 0.0);
    }

    // 4) 最短的一天只在「有活跃记录」的日子里选，挂机日不参选。
    #[test]
    fn min_day_skips_days_without_active_records() {
        let conn = init_db();
        put(&conn, ts(&conn, &day(3), "09:00:00"), 2 * HOUR, "VS Code");
        put(&conn, ts(&conn, &day(4), "09:00:00"), HOUR, "VS Code");
        // 7 月 5 日只有挂机桶：前台有时长，活跃为 0。
        put_idle(&conn, ts(&conn, &day(5), "09:00:00"), 5 * HOUR, "IDM");

        let r = compute_monthly_report(&conn, JUL).unwrap();
        assert_eq!(r.max_day.as_ref().unwrap().date, "2026-07-03");
        assert_eq!(r.min_day.as_ref().unwrap().date, "2026-07-04");
        assert_eq!(r.days_with_data, 2, "挂机日不算「有活跃记录」");
        assert_eq!(r.foreground_ms, 8 * HOUR, "但前台时长照记");
    }

    // 5) 月末边界：闰年 2 月 / 平年 2 月 / 31 天的月份。
    #[test]
    fn month_end_handles_leap_years() {
        let conn = init_db();
        let ends = |m: &str| compute_monthly_report(&conn, m).unwrap().month_end;
        assert_eq!(ends("2028-02-01"), "2028-02-29", "2028 是闰年");
        assert_eq!(ends("2026-02-01"), "2026-02-28");
        assert_eq!(ends("2026-01-01"), "2026-01-31");
        assert_eq!(ends("2026-04-01"), "2026-04-30");
        // 传月中的日期也要规范化到月首日。
        assert_eq!(
            compute_monthly_report(&conn, "2026-07-19").unwrap().month_start,
            "2026-07-01"
        );
    }
}
