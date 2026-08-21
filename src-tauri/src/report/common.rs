//! 报告模块的公共层（批次 6 Task 0）—— 日报 / 周报 / 月报共用的桶查询、聚合与日期算术。
//!
//! 本模块是从 [`super::daily`] 原样抽出来的，抽出的动机只有一个：周报和月报要复用同一套
//! 「有输入桶判定 + 时长聚合 + 应用排行 + 分类占比」，不能各写一份，否则口径会分叉。
//!
//! # 日期算术为什么全走 SQLite
//!
//! `Cargo.toml` 没有 chrono，本批也不引。所有「加减天数 / 求周一 / 求月首末」都用 SQLite 的
//! 日期函数，和现有 `commands.rs` 的 `localtime` 惯用法同源，也天然按本地时区。
//!
//! # 两套日界（务必分清）
//!
//! - **自然日**：`date(bucket_start/1000,'unixepoch','localtime')`。报告的时长、条形、
//!   分类占比、应用排行**全部**用这一套。
//! - **作息日（4:00 日界）**：见 [`RHYTHM_DAY_START_HOUR`]，**只有周报的作息模块**用。
//!
//! 两套绝不能混用 —— 混用会导致「7 天条形加起来 ≠ 周活跃总时长」。

#![allow(dead_code)]

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::app_classify::store;

// ── 阈值常量（集中一处，方便日后调） ────────────────────────────────────────────

/// 专注段的间隙阈值：相邻活跃桶超过这个墙钟间隔即断段。
/// 定义与理由见 [`super::daily`] 的模块头注释。
pub(crate) const FOCUS_GAP_MS: i64 = 5 * 60 * 1000;

/// 作息日界：4:00。`00:00–04:00` 的活动算前一天的尾巴，不算新一天的开头。
///
/// 为什么需要它：桶归日只看 `bucket_start`（见 [`super::daily`] 的「跨午夜归属」），
/// 凌晨 1:30 的活动因此属于第二天。若作息也按自然日算，「末次活动」永远停在 23:59、
/// 「首次活动」变成 01:20 —— 晚睡在数据上直接消失，而周报最有价值的正是这句话。
///
/// **只用于周报的作息模块。** 报告其余统计一律自然日。
pub(crate) const RHYTHM_DAY_START_HOUR: i64 = 4;

/// 「熬穿日界」的判定窗口：日界前后各 30 分钟内都有活跃桶 → 判为通宵。
pub(crate) const RHYTHM_OVERNIGHT_MARGIN_MIN: i64 = 30;

/// 作息日活跃时长下限：不足 30 分钟的一天，「开工 / 入睡」没有意义，不参与作息均值
/// （但仍计入总时长统计）。与 `store::MIN_ACTIVE_MS` 数值相同、**含义不同**，故各自具名：
/// 那个管「这份报告值不值得生成」，这个管「这一天的作息可不可信」。
pub(crate) const MIN_RHYTHM_ACTIVE_MS: i64 = 30 * 60 * 1000;

/// 可用于作息均值的天数下限：不足 3 天不出作息模块（1–2 天算不出「平时」）。
pub(crate) const MIN_RHYTHM_DAYS: u32 = 3;

/// 周报生成阈值：有活跃记录的天数 < 3 → `too_little`。
pub(crate) const MIN_WEEK_DAYS: u32 = 3;

/// 月报生成阈值：有活跃记录的天数 < 10 → `too_little`。
pub(crate) const MIN_MONTH_DAYS: u32 = 10;

// ── 结构体 ──────────────────────────────────────────────────────────────────

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

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FocusSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_ms: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AppRef {
    pub name: String,
    pub bundle_id: String,
}

/// 一个自然日的汇总（周报的 7 天条形、月报的按周趋势都建在它上面）。
#[derive(Serialize, Deserialize, Clone)]
pub struct DayStat {
    pub date: String,
    pub active_ms: i64,
    pub foreground_ms: i64,
}

// ── 内部原始桶 ─────────────────────────────────────────────────────────────

/// 参与计算的桶字段（不读 key_details / mouse_move_dist）。
#[derive(Clone)]
pub(crate) struct RawBucket {
    pub(crate) bucket_start: i64,
    pub(crate) duration_ms: i64,
    pub(crate) app_name: String,
    pub(crate) app_bundle_id: String,
    pub(crate) key_total: i64,
    pub(crate) mouse_left: i64,
    pub(crate) mouse_right: i64,
    pub(crate) mouse_middle: i64,
    pub(crate) mouse_back: i64,
    pub(crate) mouse_forward: i64,
    pub(crate) scroll_dist: i64,
}

impl RawBucket {
    /// 有输入桶判定（活跃口径的判定式）。
    ///
    /// **`mouse_move_dist` 故意不计**：纯鼠标位移是连续信号，若计入，看网页时随手晃鼠标
    /// 都会被当成「活跃」，挂机判定就失效了。代价是「只移动鼠标不点击」被判成无输入——
    /// 数据上是对的，但若占比很高，活跃时长会低于直觉。若日后用户反馈「活跃时长偏低」，
    /// 从这个判定式开始排查。
    pub(crate) fn is_active(&self) -> bool {
        self.key_total > 0
            || self.mouse_left > 0
            || self.mouse_right > 0
            || self.mouse_middle > 0
            || self.mouse_back > 0
            || self.mouse_forward > 0
            || self.scroll_dist > 0
    }
}

pub(crate) const BUCKET_COLS: &str = "bucket_start, duration_ms, app_name, app_bundle_id, \
    key_total, mouse_left, mouse_right, mouse_middle, mouse_back, mouse_forward, scroll_dist";

/// [`RawBucket::is_active`] 的 SQL 等价式。放在这里是为了让「有输入」只有一个定义，
/// Rust 侧改了 SQL 侧不会忘。
pub(crate) const ACTIVE_PREDICATE: &str = "(key_total > 0 OR mouse_left > 0 OR mouse_right > 0 \
    OR mouse_middle > 0 OR mouse_back > 0 OR mouse_forward > 0 OR scroll_dist > 0)";

/// 本地日表达式：桶归哪一天只看 `bucket_start`（见 [`super::daily`] 的「跨午夜归属」）。
pub(crate) const LOCAL_DAY: &str = "date(bucket_start/1000,'unixepoch','localtime')";

pub(crate) fn row_to_bucket_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<RawBucket> {
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
pub(crate) fn query_day_buckets(conn: &Connection, date: &str) -> rusqlite::Result<Vec<RawBucket>> {
    let sql = format!(
        "SELECT {BUCKET_COLS} FROM activity_buckets
         WHERE {LOCAL_DAY} = ?1
         ORDER BY bucket_start ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([date], |row| row_to_bucket_at(row, 0))?;
    rows.collect()
}

/// `[from_date, to_date]` **闭区间**（本地日）内的全部桶，带所属本地日，按 `bucket_start` 升序。
pub(crate) fn query_buckets_in_range(
    conn: &Connection,
    from_date: &str,
    to_date: &str,
) -> rusqlite::Result<Vec<(String, RawBucket)>> {
    let sql = format!(
        "SELECT {LOCAL_DAY} AS day, {BUCKET_COLS}
         FROM activity_buckets
         WHERE {LOCAL_DAY} >= ?1 AND {LOCAL_DAY} <= ?2
         ORDER BY bucket_start ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([from_date, to_date], |row| {
        let day: String = row.get(0)?;
        let b = row_to_bucket_at(row, 1)?;
        Ok((day, b))
    })?;
    rows.collect()
}

/// 闭区间内**每个有桶的自然日**的汇总（没有桶的日子不出现，由调用方补零）。
pub(crate) fn day_stats(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Vec<DayStat>> {
    let sql = format!(
        "SELECT {LOCAL_DAY} AS day,
                COALESCE(SUM(CASE WHEN {ACTIVE_PREDICATE} THEN duration_ms ELSE 0 END), 0),
                COALESCE(SUM(duration_ms), 0)
         FROM activity_buckets
         WHERE {LOCAL_DAY} >= ?1 AND {LOCAL_DAY} <= ?2
         GROUP BY day
         ORDER BY day ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([from, to], |row| {
        Ok(DayStat {
            date: row.get(0)?,
            active_ms: row.get(1)?,
            foreground_ms: row.get(2)?,
        })
    })?;
    rows.collect()
}

// ── 日期算术（全部走 SQLite，不引 chrono） ──────────────────────────────────────

/// `date` 加减天数。`n` 为负即往前。
pub(crate) fn add_days(conn: &Connection, date: &str, n: i64) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT date(?1, ?2)",
        params![date, format!("{n:+} days")],
        |r| r.get(0),
    )
}

/// 含 `date` 那一周的周一（**周一起**，与前端 `ranges.ts` / `context.tsx` / `date.ts` /
/// `aggregate.ts` 四处一致）。
///
/// `'weekday 1'` 是**向后**推进到最近的周一（已经是周一则不动），所以「先退 6 天再推进到周一」
/// 恰好是含当天那一周的周一：周一→不动，周日→退到本周一。
pub(crate) fn week_start_of(conn: &Connection, date: &str) -> rusqlite::Result<String> {
    conn.query_row("SELECT date(?1, '-6 days', 'weekday 1')", [date], |r| r.get(0))
}

/// 星期几，**0=周一 … 6=周日**（与前端 `aggregate.ts` 的 `mondayIndex` 同约定）。
///
/// SQLite 的 `%w` 是 0=周日，`+6 % 7` 换算成周一起。
pub(crate) fn dow_of(conn: &Connection, date: &str) -> rusqlite::Result<u8> {
    let w: i64 = conn.query_row(
        "SELECT (CAST(strftime('%w', ?1) AS INTEGER) + 6) % 7",
        [date],
        |r| r.get(0),
    )?;
    Ok(w as u8)
}

/// 含 `date` 那个月的 1 号。
pub(crate) fn month_start_of(conn: &Connection, date: &str) -> rusqlite::Result<String> {
    conn.query_row("SELECT strftime('%Y-%m-01', ?1)", [date], |r| r.get(0))
}

/// 该月最后一天（28/29/30/31 交给 SQLite 判）。
pub(crate) fn month_end_of(conn: &Connection, month_start: &str) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT date(?1, '+1 month', '-1 day')",
        [month_start],
        |r| r.get(0),
    )
}

// ── 纯计算 helper（入参均须已按 bucket_start 升序） ─────────────────────────

pub(crate) fn sum_duration(buckets: &[RawBucket]) -> i64 {
    buckets.iter().map(|b| b.duration_ms).sum()
}

pub(crate) fn sum_active_duration(buckets: &[RawBucket]) -> i64 {
    buckets
        .iter()
        .filter(|b| b.is_active())
        .map(|b| b.duration_ms)
        .sum()
}

/// 切换次数 = 相邻桶 `bundle_id` 变化的次数。同 App 的连续 5s 桶不计数。
pub(crate) fn switch_count(buckets: &[RawBucket]) -> u32 {
    let mut count = 0u32;
    for w in buckets.windows(2) {
        if w[0].app_bundle_id != w[1].app_bundle_id {
            count += 1;
        }
    }
    count
}

/// 最长连续专注段。间隙 = 当前段末到下一个活跃桶起点的墙钟间隔（见 [`super::daily`] 模块头注释）。
pub(crate) fn longest_focus(buckets: &[RawBucket]) -> FocusSegment {
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

/// 应用活跃时长 Top `n`（降序，平局按 bundle_id 稳定排序）。
pub(crate) fn top_apps(buckets: &[RawBucket], n: usize) -> Vec<AppRank> {
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
    v.truncate(n);
    v
}

/// 分类占比（复用批次 2 的 `store::resolve` + 11 类，未分类计 `other`）。
pub(crate) fn category_shares(
    conn: &Connection,
    buckets: &[RawBucket],
) -> rusqlite::Result<Vec<CategoryShare>> {
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
