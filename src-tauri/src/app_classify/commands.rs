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
