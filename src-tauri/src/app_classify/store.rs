//! 应用分类存储与「manual > builtin > ai」优先级硬规则。
//!
//! 模型约定：
//!   - 表 `app_categories` 只落两类需要持久化的来源：`manual`（用户手改）与
//!     `ai`（LLM 结果）。`builtin` 由内置表**计算得出**，不占表行。
//!   - 优先级在**读写两处**都强制，不依赖调用方自觉：
//!     - 读：`resolve` 返回顺序 manual（表）→ builtin（计算）→ ai（表）→ 无。
//!     - 写：`set_category` 用「新来源优先级 ≥ 当前生效优先级」才允许落库，
//!       ai(1) 永远覆盖不了 builtin(2) 或 manual(3)，manual 永远最高。
//!   - 这样「用户手动改过，后续 AI 分类不得覆盖」由本层保证。

// Task 2/3 接入前，store 的读写 API 暂无人调用。
#![allow(dead_code)]

use rusqlite::{params, Connection, Result};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{builtin, Category};

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 分类来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Manual,
    Builtin,
    Ai,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Manual => "manual",
            Source::Builtin => "builtin",
            Source::Ai => "ai",
        }
    }

    fn from_str(s: &str) -> Option<Source> {
        Some(match s {
            "manual" => Source::Manual,
            "builtin" => Source::Builtin,
            "ai" => Source::Ai,
            _ => return None,
        })
    }

    /// 优先级：manual(3) > builtin(2) > ai(1)。这是硬规则的唯一真源。
    fn priority(self) -> i64 {
        match self {
            Source::Manual => 3,
            Source::Builtin => 2,
            Source::Ai => 1,
        }
    }
}

/// 一条分类结果（读回给前端用）。
#[derive(Clone, Debug, Serialize)]
pub struct ClassifiedApp {
    pub app_id: String,
    pub category: String,
    pub source: String,
    pub confidence: Option<f64>,
    pub classified_at_ms: i64,
}

fn row_to_classified(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClassifiedApp> {
    Ok(ClassifiedApp {
        app_id: row.get(0)?,
        category: row.get(1)?,
        source: row.get(2)?,
        confidence: row.get(3)?,
        classified_at_ms: row.get(4)?,
    })
}

fn stored(conn: &Connection, app_id: &str) -> Result<Option<ClassifiedApp>> {
    let mut stmt = conn.prepare(
        "SELECT app_id, category, source, confidence, classified_at_ms
         FROM app_categories WHERE app_id = ?1",
    )?;
    let mut rows = stmt.query_map([app_id], row_to_classified)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 当前生效来源的优先级（含 builtin 计算值）。未分类为 0。
fn effective_priority(conn: &Connection, app_id: &str, app_name: &str, bundle_id: &str) -> i64 {
    let st = stored(conn, app_id).ok().flatten();
    if let Some(ref row) = st {
        if row.source == "manual" {
            return Source::Manual.priority();
        }
    }
    // builtin 优于 ai（即便表里已有 ai 行）
    if builtin::match_builtin(app_name, bundle_id).is_some() {
        return Source::Builtin.priority();
    }
    if let Some(ref row) = st {
        if let Some(src) = Source::from_str(&row.source) {
            return src.priority();
        }
    }
    0
}

/// 解析一个应用的当前分类：manual → builtin → ai → None。
pub fn resolve(
    conn: &Connection,
    app_id: &str,
    app_name: &str,
    bundle_id: &str,
) -> Result<Option<ClassifiedApp>> {
    let st = stored(conn, app_id)?;
    if let Some(row) = st {
        if row.source == "manual" {
            return Ok(Some(row));
        }
        if row.source == "ai" {
            // builtin 命中时覆盖 ai；否则退回 ai
            if builtin::match_builtin(app_name, bundle_id).is_none() {
                return Ok(Some(row));
            }
        }
    }
    if let Some(cat) = builtin::match_builtin(app_name, bundle_id) {
        return Ok(Some(ClassifiedApp {
            app_id: app_id.to_string(),
            category: cat.as_str().to_string(),
            source: Source::Builtin.as_str().to_string(),
            confidence: None,
            classified_at_ms: 0,
        }));
    }
    Ok(None)
}

/// 写入分类。`source` 只应是 `Manual` 或 `Ai`（builtin 是计算值，不落库）。
///
/// 优先级硬规则：新来源优先级 ≥ 当前生效优先级才写；否则静默忽略并返回 false。
/// `ai` 永远覆盖不了 manual（3）或 builtin（2）；`manual` 永远可写。
pub fn set_category(
    conn: &Connection,
    app_id: &str,
    app_name: &str,
    bundle_id: &str,
    category: Category,
    source: Source,
    confidence: Option<f64>,
) -> Result<bool> {
    let new_prio = source.priority();
    let cur_prio = effective_priority(conn, app_id, app_name, bundle_id);
    if new_prio < cur_prio {
        return Ok(false);
    }

    let confidence = if source == Source::Ai { confidence } else { None };
    conn.execute(
        "INSERT INTO app_categories (app_id, category, source, confidence, classified_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(app_id) DO UPDATE SET
             category = excluded.category,
             source = excluded.source,
             confidence = excluded.confidence,
             classified_at_ms = excluded.classified_at_ms",
        params![
            app_id,
            category.as_str(),
            source.as_str(),
            confidence,
            now_ms()
        ],
    )?;
    Ok(true)
}

/// 删除某应用的分类（「重置为自动」：删掉手动覆盖后，重新走 resolve 回落到
/// builtin 或重新进入 AI 队列）。返回删除行数。
pub fn delete(conn: &Connection, app_id: &str) -> Result<u64> {
    conn.execute("DELETE FROM app_categories WHERE app_id = ?1", [app_id])
        .map(|n| n as u64)
}

/// 清空全部分类（验收用：清空后重新跑，确认 builtin 命中的不发请求）。
pub fn clear(conn: &Connection) -> Result<u64> {
    conn.execute("DELETE FROM app_categories", []).map(|n| n as u64)
}

/// 列出表里所有已持久化的分类（manual + ai），供设置页展示。
pub fn list_all(conn: &Connection) -> Result<Vec<ClassifiedApp>> {
    let mut stmt = conn.prepare(
        "SELECT app_id, category, source, confidence, classified_at_ms
         FROM app_categories ORDER BY app_id ASC",
    )?;
    let rows = stmt.query_map([], row_to_classified)?;
    rows.collect()
}
