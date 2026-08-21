//! 日报数据算法（批次 4a Task 1）—— 纯计算，不碰 AI。
//!
//! 桶查询、活跃判定、时长聚合、应用排行、分类占比等**周月报也要用的原语**已抽到
//! [`super::common`]，本模块只保留「一天」特有的部分。
//!
//! # 时长口径（执行单已锁定）
//!
//! - **活跃时长** = 有输入桶的时长，是报告主体口径。
//! - **前台时长** = 前台墙钟（所有桶），只在总览副行并排展示。
//! - 有输入桶判定见 [`super::common::RawBucket::is_active`]。
//!
//! # 连续专注段（定义 + 理由）
//!
//! 专注段 = 在「活跃桶」序列上，把相邻活跃桶之间时间间隙 ≤ [`super::common::FOCUS_GAP_MS`] 的连成一段；
//! **跨应用算同一段**。
//!
//! - 间隙取 5 分钟：桶是 5 秒级，读文档/思考的输入停顿通常 < 5 分钟；起身离开
//!   （喝水/走动/锁屏）通常 ≥ 5 分钟。5 分钟是「离开」的常用启发式阈值，也天然
//!   避开系统挂起边界。
//! - 跨应用算同一段：专注衡量「人是否持续投入」，不是「是否盯着同一窗口」。VS Code ↔
//!   终端 ↔ 浏览器之间的快速切换正是深度工作的表现；打断专注的是「人离开」，不是换应用。
//! - 基于活跃桶：挂机桶（如 IDM 前台无输入）不会延长专注段，和活跃口径同一个根子。
//!
//! # 跨午夜归属（有意为之）
//!
//! 桶归哪一天**只看 `bucket_start`**（`date(bucket_start/1000,'unixepoch','localtime')`），
//! 不看 `bucket_start + duration_ms`。一个 23:59:50 开始、持续 30s 跨到次日的桶，
//! 归入起点那天、只计一次。这与现有 `commands::get_hourly_activity` 的按起点分桶一致。
//!
//! 作息模块（周报）另有 4:00 日界，见 [`super::common::RHYTHM_DAY_START_HOUR`]；
//! **两套日界互不混用** —— 混用会让「7 天条形加起来 ≠ 周活跃总时长」。

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::common::{
    add_days, category_shares, longest_focus, query_buckets_in_range, query_day_buckets,
    sum_active_duration, sum_duration, switch_count, top_apps, RawBucket, ACTIVE_PREDICATE,
    LOCAL_DAY,
};

// 这四个结构体现在住在 common（周月报同样要用），从这里 re-export 保持
// `report::daily::AppRank` 这类既有路径可用。
pub use super::common::{AppRank, AppRef, CategoryShare, FocusSegment};

// ── 结构体 ──────────────────────────────────────────────────────────────────

/// 一天的日报（结构化事实，全部由本模块算好）。
#[derive(Serialize, Deserialize, Clone)]
pub struct DailyReport {
    /// 本地日期 'YYYY-MM-DD'。
    pub date: String,
    /// 有输入桶时长（主体口径）。
    pub active_ms: i64,
    /// 前台墙钟（所有桶，仅副行展示）。
    pub foreground_ms: i64,
    /// 应用切换次数（派生：桶按时间排序后 `bundle_id` 变化次数）。
    pub switch_count: u32,
    /// 记录覆盖跨度：首桶 `bucket_start`。
    pub span_start_ms: i64,
    /// 记录覆盖跨度：末桶 `bucket_start + duration_ms`。
    pub span_end_ms: i64,
    /// 应用活跃时长 Top 5（降序）。
    pub top_apps: Vec<AppRank>,
    /// 分类占比（降序，复用批次 2 的 11 类）。
    pub categories: Vec<CategoryShare>,
    /// 24 小时活跃分布（每小时活跃时长）。
    pub hourly: Vec<HourCell>,
    /// 峰值时段（活跃时长最大的小时）。
    pub peak_hour: u8,
    /// 最长一段连续专注。
    pub longest_focus: FocusSegment,
    /// 与最近 7 天（不含当天）均值的对比。
    pub vs_7d: Compare7d,
    /// 今天新出现（此前 30 天未见）的应用。
    pub new_apps: Vec<AppRef>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HourCell {
    pub hour: u8,
    pub active_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Compare7d {
    pub avg_active_ms: i64,
    pub avg_switch_count: f64,
    pub active_delta_pct: f64,
    pub switch_delta_pct: f64,
}

// ── 查询 ────────────────────────────────────────────────────────────────────

/// 前 30 天（不含当天）出现过的 `app_bundle_id`。
fn query_prior_30d_apps(conn: &Connection, date: &str) -> rusqlite::Result<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT app_bundle_id FROM activity_buckets
         WHERE {LOCAL_DAY} < ?1
           AND {LOCAL_DAY} >= date(?1, '-30 days')"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([date], |row| row.get::<_, String>(0))?;
    rows.collect()
}

// ── 纯计算 ──────────────────────────────────────────────────────────────────

/// 24 小时活跃分布（有输入口径）+ 峰值时段。小时分桶直接走 SQLite 本地时区。
fn build_hourly(conn: &Connection, date: &str) -> rusqlite::Result<(Vec<HourCell>, u8)> {
    let mut ms_by_hour = [0i64; 24];
    let sql = format!(
        "SELECT CAST(strftime('%H', datetime(bucket_start/1000,'unixepoch','localtime')) AS INTEGER) AS h,
                COALESCE(SUM(duration_ms), 0)
         FROM activity_buckets
         WHERE {LOCAL_DAY} = ?1
           AND {ACTIVE_PREDICATE}
         GROUP BY h"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([date], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    for r in rows {
        let (h, ms) = r?;
        if (0..24).contains(&h) {
            ms_by_hour[h as usize] += ms;
        }
    }
    // 全零时 tie 落到最小索引 0（max_by_key 平局取最后一个，会得到 23）。
    let peak = ms_by_hour
        .iter()
        .enumerate()
        .max_by(|(ia, a), (ib, b)| a.cmp(b).then_with(|| ib.cmp(ia)))
        .map(|(i, _)| i as u8)
        .unwrap_or(0);
    let hourly = ms_by_hour
        .into_iter()
        .enumerate()
        .map(|(h, ms)| HourCell {
            hour: h as u8,
            active_ms: ms,
        })
        .collect();
    Ok((hourly, peak))
}

/// 近 7 天（不含当天）的日均活跃时长 / 日均切换次数，及当天相对均值的偏差百分比。
fn compare_7d(
    conn: &Connection,
    date: &str,
    today_active_ms: i64,
    today_switch_count: u32,
) -> rusqlite::Result<Compare7d> {
    // 闭区间 [date-7, date-1] 等价于原来的 `>= date-7 AND < date`。
    let from = add_days(conn, date, -7)?;
    let to = add_days(conn, date, -1)?;
    let buckets = query_buckets_in_range(conn, &from, &to)?;

    // 按本地日分组（查询已升序，分组内保持升序，switch_count 依赖这一点）。
    let mut per_day: HashMap<String, Vec<RawBucket>> = HashMap::new();
    for (day, b) in buckets {
        per_day.entry(day).or_default().push(b);
    }
    let day_count = per_day.len();

    let mut total_active = 0i64;
    let mut total_switches = 0u32;
    for bs in per_day.values() {
        total_active += sum_active_duration(bs);
        total_switches += switch_count(bs);
    }

    let avg_active_ms = if day_count > 0 {
        total_active / day_count as i64
    } else {
        0
    };
    let avg_switch_count = if day_count > 0 {
        total_switches as f64 / day_count as f64
    } else {
        0.0
    };
    let active_delta_pct = if avg_active_ms > 0 {
        (today_active_ms - avg_active_ms) as f64 / avg_active_ms as f64 * 100.0
    } else {
        0.0
    };
    let switch_delta_pct = if avg_switch_count > 0.0 {
        (today_switch_count as f64 - avg_switch_count) / avg_switch_count * 100.0
    } else {
        0.0
    };

    Ok(Compare7d {
        avg_active_ms,
        avg_switch_count,
        active_delta_pct,
        switch_delta_pct,
    })
}

/// 今天有、此前 30 天未见的应用。
fn new_apps(conn: &Connection, date: &str, today: &[RawBucket]) -> rusqlite::Result<Vec<AppRef>> {
    let mut prior = std::collections::HashSet::new();
    for id in query_prior_30d_apps(conn, date)? {
        prior.insert(id);
    }

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for b in today {
        if seen.insert(b.app_bundle_id.clone()) && !prior.contains(&b.app_bundle_id) {
            out.push(AppRef {
                name: b.app_name.clone(),
                bundle_id: b.app_bundle_id.clone(),
            });
        }
    }
    Ok(out)
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/// 计算某本地日的日报。`date` 形如 'YYYY-MM-DD'。
pub fn compute_daily_report(conn: &Connection, date: &str) -> rusqlite::Result<DailyReport> {
    let buckets = query_day_buckets(conn, date)?;

    let active_ms = sum_active_duration(&buckets);
    let foreground_ms = sum_duration(&buckets);
    let switch_count = switch_count(&buckets);
    let span_start_ms = buckets.iter().map(|b| b.bucket_start).min().unwrap_or(0);
    let span_end_ms = buckets
        .iter()
        .map(|b| b.bucket_start + b.duration_ms)
        .max()
        .unwrap_or(0);

    let top_apps = top_apps(&buckets, 5);
    let categories = category_shares(conn, &buckets)?;
    let (hourly, peak_hour) = build_hourly(conn, date)?;
    let longest_focus = longest_focus(&buckets);
    let vs_7d = compare_7d(conn, date, active_ms, switch_count)?;
    let new_apps = new_apps(conn, date, &buckets)?;

    Ok(DailyReport {
        date: date.to_string(),
        active_ms,
        foreground_ms,
        switch_count,
        span_start_ms,
        span_end_ms,
        top_apps,
        categories,
        hourly,
        peak_hour,
        longest_focus,
        vs_7d,
        new_apps,
    })
}

// ── 单测 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 插入一个桶。`mouse_move_dist` 恒 0，键鼠由参数控制。
    #[allow(clippy::too_many_arguments)]
    fn insert_bucket(
        conn: &Connection,
        bucket_start: i64,
        duration_ms: i64,
        app: &str,
        key_total: i64,
        mouse_left: i64,
        scroll_dist: i64,
    ) {
        conn.execute(
            "INSERT INTO activity_buckets
             (bucket_start, duration_ms, app_name, app_bundle_id, key_total,
              mouse_left, mouse_right, mouse_middle, mouse_back, mouse_forward,
              mouse_move_dist, scroll_dist)
             VALUES (?1,?2,?3,?4,?5,?6,0,0,0,0,0,?7)",
            rusqlite::params![bucket_start, duration_ms, app, app, key_total, mouse_left, scroll_dist],
        )
        .unwrap();
    }

    fn bucket(start: i64, dur: i64, app: &str, key: i64) -> RawBucket {
        RawBucket {
            bucket_start: start,
            duration_ms: dur,
            app_name: app.to_string(),
            app_bundle_id: app.to_string(),
            key_total: key,
            mouse_left: 0,
            mouse_right: 0,
            mouse_middle: 0,
            mouse_back: 0,
            mouse_forward: 0,
            scroll_dist: 0,
        }
    }

    /// 用 SQLite 自己的 localtime 反查某个 UTC ms 落在哪个本地日（测试不依赖机器时区）。
    fn local_date_of(conn: &Connection, ts_ms: i64) -> String {
        conn.query_row(
            "SELECT date(?1/1000,'unixepoch','localtime')",
            [ts_ms],
            |r| r.get(0),
        )
        .unwrap()
    }

    // 1) 纯挂机桶不计入活跃。
    #[test]
    fn mouse_move_only_is_not_active() {
        let mut b = bucket(1_000_000, 5_000, "IDM", 0);
        b.mouse_left = 0;
        b.scroll_dist = 0;
        // mouse_move_dist 不参与 is_active，这里不设也不会影响结果。
        assert!(!b.is_active());

        b.key_total = 1;
        assert!(b.is_active());
    }

    // 2) 专注段跨应用合并。
    #[test]
    fn focus_crosses_apps() {
        // VS Code 与 终端 无间隙交替，各自 5s 桶 → 应合并成一段。
        let buckets = vec![
            bucket(0, 5_000, "VS Code", 1),
            bucket(5_000, 5_000, "Terminal", 1),
            bucket(10_000, 5_000, "VS Code", 1),
            bucket(15_000, 5_000, "Chrome", 1),
        ];
        let f = longest_focus(&buckets);
        assert_eq!(f.start_ms, 0);
        assert_eq!(f.end_ms, 20_000);
        assert_eq!(f.duration_ms, 20_000);
    }

    // 3) 间隙 > 5 分钟断段。
    #[test]
    fn focus_breaks_on_gap() {
        let buckets = vec![
            bucket(0, 5_000, "VS Code", 1),
            bucket(5_000, 5_000, "VS Code", 1),
            // 10 分钟无输入，中间隔着一段挂机桶（key=0）也要被活跃口径跳过去。
            bucket(60_000, 5_000, "IDM", 0),
            bucket(10 * 60_000, 5_000, "VS Code", 1),
        ];
        let f = longest_focus(&buckets);
        // 两段：0..10s 和 600s..605s，最长是前者 10s。
        assert_eq!(f.duration_ms, 10_000);
    }

    // 4) 切换次数只数 bundle_id 变化。
    #[test]
    fn switch_count_only_counts_app_changes() {
        let buckets = vec![
            bucket(0, 5_000, "A", 1),
            bucket(5_000, 5_000, "A", 1),
            bucket(10_000, 5_000, "B", 1),
            bucket(15_000, 5_000, "A", 1),
        ];
        assert_eq!(switch_count(&buckets), 2); // A→B, B→A
    }

    // 5) 空数据不 panic，返回全零结构。
    #[test]
    fn empty_day_returns_zeros() {
        let conn = init_db();
        let r = compute_daily_report(&conn, "2026-08-20").unwrap();
        assert_eq!(r.active_ms, 0);
        assert_eq!(r.foreground_ms, 0);
        assert_eq!(r.switch_count, 0);
        assert_eq!(r.top_apps.len(), 0);
        assert_eq!(r.categories.len(), 0);
        assert_eq!(r.hourly.len(), 24);
        assert_eq!(r.peak_hour, 0);
        assert_eq!(r.longest_focus.duration_ms, 0);
        assert_eq!(r.vs_7d.avg_active_ms, 0);
        assert_eq!(r.new_apps.len(), 0);
    }

    // 6) 单桶：专注段 = 那一条，vs_7d 分母为 0 不除零。
    #[test]
    fn single_bucket_day() {
        let conn = init_db();
        let now_epoch: i64 = conn
            .query_row("SELECT CAST(strftime('%s','now') AS INTEGER)", [], |r| r.get(0))
            .unwrap();
        let ts = now_epoch * 1000 - 2 * 3600 * 1000; // 2 小时前，避开午夜
        let d = local_date_of(&conn, ts);
        insert_bucket(&conn, ts, 60_000, "VS Code", 10, 0, 0);

        let r = compute_daily_report(&conn, &d).unwrap();
        assert_eq!(r.active_ms, 60_000);
        assert_eq!(r.foreground_ms, 60_000);
        assert_eq!(r.switch_count, 0);
        assert_eq!(r.top_apps.len(), 1);
        assert_eq!(r.longest_focus.duration_ms, 60_000);
        // vs_7d 无数据，分母 0 → 不除零，全 0。
        assert_eq!(r.vs_7d.avg_active_ms, 0);
        assert_eq!(r.vs_7d.active_delta_pct, 0.0);
    }

    // 7) 跨午夜：桶按起点归属当天，不被重复计入次日。
    #[test]
    fn cross_midnight_attributed_to_start_day() {
        let conn = init_db();
        // D = 两天前的本地日；D+1 = 其后一天。
        let d: String = conn
            .query_row("SELECT date('now','localtime','-2 days')", [], |r| r.get(0))
            .unwrap();
        let d1: String = conn
            .query_row("SELECT date(?1,'+1 day')", [&d], |r| r.get(0))
            .unwrap();
        // D 本地 23:59:50 的 UTC ms（'utc' 修饰符 = 把本地字符串转回 UTC epoch）。
        let ts_ms: i64 = conn
            .query_row(
                "SELECT CAST(strftime('%s', ?1 || ' 23:59:50', 'utc') AS INTEGER) * 1000",
                [&d],
                |r| r.get(0),
            )
            .unwrap();
        // 持续 30s，跨到 D+1 的 00:00:20。
        insert_bucket(&conn, ts_ms, 30_000, "VS Code", 1, 0, 0);

        let r = compute_daily_report(&conn, &d).unwrap();
        assert_eq!(r.foreground_ms, 30_000, "起点天应计入该桶");
        assert_eq!(r.span_start_ms, ts_ms);

        let r1 = compute_daily_report(&conn, &d1).unwrap();
        assert_eq!(r1.foreground_ms, 0, "次日不应重复计入该桶");
    }
}
