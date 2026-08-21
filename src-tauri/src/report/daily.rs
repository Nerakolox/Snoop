//! 日报数据算法（Task 1）—— 纯计算，不碰 AI。
//!
//! # 时长口径（执行单已锁定）
//!
//! - **活跃时长** = 有输入桶的时长，是报告主体口径。
//! - **前台时长** = 前台墙钟（所有桶），只在总览副行并排展示。
//! - 有输入桶判定见 [`RawBucket::is_active`]。
//!
//! # 连续专注段（定义 + 理由）
//!
//! 专注段 = 在「活跃桶」序列上，把相邻活跃桶之间时间间隙 ≤ [`FOCUS_GAP_MS`] 的连成一段；
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

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::app_classify::store;

/// 专注段的间隙阈值：相邻活跃桶超过这个墙钟间隔即断段。做成常量，日后可调。
const FOCUS_GAP_MS: i64 = 5 * 60 * 1000;

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
pub struct AppRank {
    pub name: String,
    pub bundle_id: String,
    pub active_ms: i64,
    pub share_pct: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CategoryShare {
    pub category: String,
    pub active_ms: i64,
    pub share_pct: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HourCell {
    pub hour: u8,
    pub active_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FocusSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Compare7d {
    pub avg_active_ms: i64,
    pub avg_switch_count: f64,
    pub active_delta_pct: f64,
    pub switch_delta_pct: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AppRef {
    pub name: String,
    pub bundle_id: String,
}

// ── 内部原始桶 ─────────────────────────────────────────────────────────────

/// 参与计算的桶字段（不读 key_details / mouse_move_dist）。
#[derive(Clone)]
struct RawBucket {
    bucket_start: i64,
    duration_ms: i64,
    app_name: String,
    app_bundle_id: String,
    key_total: i64,
    mouse_left: i64,
    mouse_right: i64,
    mouse_middle: i64,
    mouse_back: i64,
    mouse_forward: i64,
    scroll_dist: i64,
}

impl RawBucket {
    /// 有输入桶判定（活跃口径的判定式）。
    ///
    /// **`mouse_move_dist` 故意不计**：纯鼠标位移是连续信号，若计入，看网页时随手晃鼠标
    /// 都会被当成「活跃」，挂机判定就失效了。代价是「只移动鼠标不点击」被判成无输入——
    /// 数据上是对的，但若占比很高，活跃时长会低于直觉。若日后用户反馈「活跃时长偏低」，
    /// 从这个判定式开始排查。
    fn is_active(&self) -> bool {
        self.key_total > 0
            || self.mouse_left > 0
            || self.mouse_right > 0
            || self.mouse_middle > 0
            || self.mouse_back > 0
            || self.mouse_forward > 0
            || self.scroll_dist > 0
    }
}

const BUCKET_COLS: &str = "bucket_start, duration_ms, app_name, app_bundle_id, \
    key_total, mouse_left, mouse_right, mouse_middle, mouse_back, mouse_forward, scroll_dist";

fn row_to_bucket_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<RawBucket> {
    Ok(RawBucket {
        bucket_start: row.get(offset)?,
        duration_ms: row.get(offset + 1)?,
        app_name: row.get(offset + 2)?,
        app_bundle_id: row.get(offset + 3)?,
        key_total: row.get(offset + 4)?,
        mouse_left: row.get(offset + 5)?,
        mouse_right: row.get(offset + 6)?,
        mouse_middle: row.get(offset + 7)?,
        mouse_back: row.get(offset + 8)?,
        mouse_forward: row.get(offset + 9)?,
        scroll_dist: row.get(offset + 10)?,
    })
}

/// 某本地日的全部桶，按 `bucket_start` 升序。
fn query_day_buckets(conn: &Connection, date: &str) -> rusqlite::Result<Vec<RawBucket>> {
    let sql = format!(
        "SELECT {BUCKET_COLS} FROM activity_buckets
         WHERE date(bucket_start/1000,'unixepoch','localtime') = ?1
         ORDER BY bucket_start ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([date], |row| row_to_bucket_at(row, 0))?;
    rows.collect()
}

/// 近 7 天（不含当天）的桶，返回 `(本地日, 桶)`，按 `bucket_start` 升序。
fn query_prev_7d_buckets(
    conn: &Connection,
    date: &str,
) -> rusqlite::Result<Vec<(String, RawBucket)>> {
    let sql = format!(
        "SELECT date(bucket_start/1000,'unixepoch','localtime') AS day, {BUCKET_COLS}
         FROM activity_buckets
         WHERE date(bucket_start/1000,'unixepoch','localtime') >= date(?1, '-7 days')
           AND date(bucket_start/1000,'unixepoch','localtime') < ?1
         ORDER BY bucket_start ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([date], |row| {
        let day: String = row.get(0)?;
        let b = row_to_bucket_at(row, 1)?;
        Ok((day, b))
    })?;
    rows.collect()
}

/// 前 30 天（不含当天）出现过的 `app_bundle_id`。
fn query_prior_30d_apps(conn: &Connection, date: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT app_bundle_id FROM activity_buckets
         WHERE date(bucket_start/1000,'unixepoch','localtime') < ?1
           AND date(bucket_start/1000,'unixepoch','localtime') >= date(?1, '-30 days')",
    )?;
    let rows = stmt.query_map([date], |row| row.get::<_, String>(0))?;
    rows.collect()
}

// ── 纯计算 helper（入参均须已按 bucket_start 升序） ─────────────────────────

fn sum_duration(buckets: &[RawBucket]) -> i64 {
    buckets.iter().map(|b| b.duration_ms).sum()
}

/// 切换次数 = 相邻桶 `bundle_id` 变化的次数。同 App 的连续 5s 桶不计数。
fn switch_count(buckets: &[RawBucket]) -> u32 {
    let mut count = 0u32;
    for w in buckets.windows(2) {
        if w[0].app_bundle_id != w[1].app_bundle_id {
            count += 1;
        }
    }
    count
}

/// 最长连续专注段。间隙 = 当前段末到下一个活跃桶起点的墙钟间隔（见模块头注释）。
fn longest_focus(buckets: &[RawBucket]) -> FocusSegment {
    let active: Vec<&RawBucket> = buckets.iter().filter(|b| b.is_active()).collect();
    let Some(first) = active.first() else {
        return FocusSegment::default();
    };

    let mut best = FocusSegment {
        start_ms: first.bucket_start,
        end_ms: first.bucket_start + first.duration_ms,
        duration_ms: first.duration_ms,
    };
    let mut cur_start = first.bucket_start;
    let mut cur_end = first.bucket_start + first.duration_ms;

    for b in &active[1..] {
        let b_end = b.bucket_start + b.duration_ms;
        if b.bucket_start - cur_end <= FOCUS_GAP_MS {
            cur_end = cur_end.max(b_end);
            let dur = cur_end - cur_start;
            if dur > best.duration_ms {
                best = FocusSegment {
                    start_ms: cur_start,
                    end_ms: cur_end,
                    duration_ms: dur,
                };
            }
        } else {
            cur_start = b.bucket_start;
            cur_end = b_end;
        }
    }
    best
}

/// 应用活跃时长 Top 5。
fn top_apps(buckets: &[RawBucket]) -> Vec<AppRank> {
    let mut acc: HashMap<String, (String, i64)> = HashMap::new();
    for b in buckets.iter().filter(|b| b.is_active()) {
        let e = acc
            .entry(b.app_bundle_id.clone())
            .or_insert((b.app_name.clone(), 0));
        e.0 = b.app_name.clone();
        e.1 += b.duration_ms;
    }
    let total: i64 = acc.values().map(|(_, ms)| *ms).sum();
    let mut v: Vec<AppRank> = acc
        .into_iter()
        .map(|(id, (name, ms))| AppRank {
            name,
            bundle_id: id,
            active_ms: ms,
            share_pct: if total > 0 {
                ms as f64 / total as f64 * 100.0
            } else {
                0.0
            },
        })
        .collect();
    v.sort_by(|a, b| {
        b.active_ms
            .cmp(&a.active_ms)
            .then_with(|| a.bundle_id.cmp(&b.bundle_id))
    });
    v.truncate(5);
    v
}

/// 分类占比（复用批次 2 的 `store::resolve` + 11 类，未分类计 `other`）。
fn category_shares(conn: &Connection, buckets: &[RawBucket]) -> rusqlite::Result<Vec<CategoryShare>> {
    let mut by_app: HashMap<String, (String, i64)> = HashMap::new();
    for b in buckets.iter().filter(|b| b.is_active()) {
        let e = by_app
            .entry(b.app_bundle_id.clone())
            .or_insert((b.app_name.clone(), 0));
        e.0 = b.app_name.clone();
        e.1 += b.duration_ms;
    }

    let mut totals: HashMap<String, i64> = HashMap::new();
    for (id, (name, ms)) in by_app {
        let cat = store::resolve(conn, &id, &name, &id)?
            .map(|c| c.category)
            .unwrap_or_else(|| "other".to_string());
        *totals.entry(cat).or_insert(0) += ms;
    }

    let total: i64 = totals.values().sum();
    let mut v: Vec<CategoryShare> = totals
        .into_iter()
        .filter(|(_, ms)| *ms > 0)
        .map(|(category, active_ms)| CategoryShare {
            category,
            active_ms,
            share_pct: if total > 0 {
                active_ms as f64 / total as f64 * 100.0
            } else {
                0.0
            },
        })
        .collect();
    v.sort_by(|a, b| b.active_ms.cmp(&a.active_ms));
    Ok(v)
}

/// 24 小时活跃分布（有输入口径）+ 峰值时段。小时分桶直接走 SQLite 本地时区。
fn build_hourly(conn: &Connection, date: &str) -> rusqlite::Result<(Vec<HourCell>, u8)> {
    let mut ms_by_hour = [0i64; 24];
    let mut stmt = conn.prepare(
        "SELECT CAST(strftime('%H', datetime(bucket_start/1000,'unixepoch','localtime')) AS INTEGER) AS h,
                COALESCE(SUM(duration_ms), 0)
         FROM activity_buckets
         WHERE date(bucket_start/1000,'unixepoch','localtime') = ?1
           AND (key_total > 0 OR mouse_left > 0 OR mouse_right > 0 OR mouse_middle > 0
                OR mouse_back > 0 OR mouse_forward > 0 OR scroll_dist > 0)
         GROUP BY h",
    )?;
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
    let buckets = query_prev_7d_buckets(conn, date)?;

    // 按本地日分组（查询已升序，分组内保持升序，switch_count 依赖这一点）。
    let mut per_day: HashMap<String, Vec<RawBucket>> = HashMap::new();
    for (day, b) in buckets {
        per_day.entry(day).or_default().push(b);
    }
    let day_count = per_day.len();

    let mut total_active = 0i64;
    let mut total_switches = 0u32;
    for bs in per_day.values() {
        total_active += bs
            .iter()
            .filter(|b| b.is_active())
            .map(|b| b.duration_ms)
            .sum::<i64>();
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

    let active_ms = buckets
        .iter()
        .filter(|b| b.is_active())
        .map(|b| b.duration_ms)
        .sum::<i64>();
    let foreground_ms = sum_duration(&buckets);
    let switch_count = switch_count(&buckets);
    let span_start_ms = buckets.iter().map(|b| b.bucket_start).min().unwrap_or(0);
    let span_end_ms = buckets
        .iter()
        .map(|b| b.bucket_start + b.duration_ms)
        .max()
        .unwrap_or(0);

    let top_apps = top_apps(&buckets);
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
