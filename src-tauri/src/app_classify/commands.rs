//! 应用分类暴露给前端的 Tauri 命令。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::ai::AiState;
use crate::app_classify::engine::{self, ClassifyOutcome, ClassifyStatus};
use crate::app_classify::store::{self, ClassifiedApp, Source};
use crate::app_classify::Category;
use crate::commands::DbPath;

/// 「待确认」阈值：AI 置信度低于此值（或缺省）需要用户复核。
const CONFIRM_THRESHOLD: f64 = 0.6;

fn open_db(db: &DbPath) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(&db.0).map_err(|e| e.to_string())
}

// ─── Task 2：触发与状态 ────────────────────────────────────────────────────────

/// 触发一次分类（`force=true` 对应「立即分类」，跳过攒批阈值）。
#[tauri::command]
pub async fn classify_apps(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
    force: Option<bool>,
) -> Result<ClassifyOutcome, String> {
    let ai = state.inner().clone();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    Ok(engine::classify_if_due(&ai.config, &ai.code_map, &db_path, force.unwrap_or(false)).await)
}

/// 分类队列状态：待分类数量 / 上次分类时间 / 是否正在运行。
#[tauri::command]
pub fn get_classify_status(db: State<'_, DbPath>) -> Result<ClassifyStatus, String> {
    Ok(engine::classify_status(&db.0))
}

// ─── Task 3：查看与手动修改 ───────────────────────────────────────────────────

/// 设置页分类列表的一行：每个应用 + 其生效分类（含来源 / 置信度 / 待确认标记）。
#[derive(Serialize, Clone)]
pub struct AppCategoryRow {
    pub app_id: String,
    pub app_name: String,
    /// 生效分类（snake_case）；未分类为 null。
    pub category: Option<String>,
    /// manual | builtin | ai；未分类为 null。
    pub source: Option<String>,
    pub confidence: Option<f64>,
    /// manual/ai 的落库时间；builtin 无持久化时间，未分类为 null。
    pub classified_at_ms: Option<i64>,
    /// AI 低置信度（或缺置信度）需要用户复核。
    pub needs_confirmation: bool,
}

fn to_row(app_id: &str, name: &str, resolved: Option<ClassifiedApp>) -> AppCategoryRow {
    match resolved {
        Some(c) => AppCategoryRow {
            app_id: app_id.to_string(),
            app_name: name.to_string(),
            category: Some(c.category),
            source: Some(c.source.clone()),
            confidence: c.confidence,
            classified_at_ms: if c.classified_at_ms == 0 { None } else { Some(c.classified_at_ms) },
            needs_confirmation: c.source == "ai"
                && c.confidence.map_or(true, |v| v < CONFIRM_THRESHOLD),
        },
        None => AppCategoryRow {
            app_id: app_id.to_string(),
            app_name: name.to_string(),
            category: None,
            source: None,
            confidence: None,
            classified_at_ms: None,
            needs_confirmation: false,
        },
    }
}

/// 列出全部应用及其生效分类（含 builtin 计算值），按应用名排序。
#[tauri::command]
pub fn list_classified_apps(db: State<'_, DbPath>) -> Result<Vec<AppCategoryRow>, String> {
    let conn = open_db(&db)?;
    let mut apps: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT app_bundle_id, MAX(app_name) AS name
                 FROM activity_buckets
                 GROUP BY app_bundle_id
                 ORDER BY name COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows {
            apps.push(r.map_err(|e| e.to_string())?);
        }
    }
    let mut out = Vec::with_capacity(apps.len());
    for (id, name) in apps {
        let resolved = store::resolve(&conn, &id, &name, &id).map_err(|e| e.to_string())?;
        out.push(to_row(&id, &name, resolved));
    }
    Ok(out)
}

/// 手动指定某应用分类（source='manual'，永久；后续任何自动分类不得覆盖）。
#[tauri::command]
pub fn set_app_category(
    db: State<'_, DbPath>,
    app_id: String,
    app_name: String,
    category: String,
) -> Result<AppCategoryRow, String> {
    let conn = open_db(&db)?;
    let cat = Category::from_str(&category).ok_or_else(|| format!("未知类别：{category}"))?;
    store::set_category(&conn, &app_id, &app_name, &app_id, cat, Source::Manual, None)
        .map_err(|e| e.to_string())?;
    let resolved = store::resolve(&conn, &app_id, &app_name, &app_id).map_err(|e| e.to_string())?;
    Ok(to_row(&app_id, &app_name, resolved))
}

/// 「重置为自动」：删掉手动覆盖，回落到 builtin（立即）或重新进入 AI 队列。
#[tauri::command]
pub fn reset_app_category(
    db: State<'_, DbPath>,
    app_id: String,
    app_name: String,
) -> Result<AppCategoryRow, String> {
    let conn = open_db(&db)?;
    store::delete(&conn, &app_id).map_err(|e| e.to_string())?;
    let resolved = store::resolve(&conn, &app_id, &app_name, &app_id).map_err(|e| e.to_string())?;
    Ok(to_row(&app_id, &app_name, resolved))
}

// ─── Task 4：消费方（概览分类占比） ────────────────────────────────────────────

/// 分类占比的一格：某类别在给定范围内的前台时长。
#[derive(Serialize, Clone)]
pub struct CategoryShare {
    pub category: String,
    pub duration_ms: i64,
}

/// 聚合给定时间范围内各分类的前台时长（未分类计入 `other`），按时长降序返回。
#[tauri::command]
pub fn get_category_breakdown(
    db: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<CategoryShare>, String> {
    use std::collections::HashMap;

    let conn = open_db(&db)?;

    // 每个 app 聚一次：代表名 + 该范围总前台时长。
    let mut agg: Vec<(String, String, i64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT app_bundle_id, MAX(app_name) AS name, SUM(duration_ms) AS dur
                 FROM activity_buckets
                 WHERE bucket_start >= ?1 AND bucket_start < ?2
                 GROUP BY app_bundle_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![start_ms, end_ms], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            agg.push(r.map_err(|e| e.to_string())?);
        }
    }

    let mut totals: HashMap<String, i64> = HashMap::new();
    for (id, name, dur) in agg {
        let cat = store::resolve(&conn, &id, &name, &id)
            .map_err(|e| e.to_string())?
            .map(|c| c.category)
            .unwrap_or_else(|| "other".to_string());
        *totals.entry(cat).or_insert(0) += dur;
    }

    let mut out: Vec<CategoryShare> = totals
        .into_iter()
        .filter(|(_, d)| *d > 0)
        .map(|(category, duration_ms)| CategoryShare { category, duration_ms })
        .collect();
    out.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
    Ok(out)
}
