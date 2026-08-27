//! 应用分类暴露给前端的 Tauri 命令。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::ai::AiState;
use crate::app_classify::catalog::{self, Category, DeleteImpact};
use crate::app_classify::engine::{self, ClassifyOutcome, ClassifyStatus, Scope};
use crate::app_classify::store::{self, ClassifiedApp, Source};
use crate::app_classify::ID_UNCATEGORIZED;
use crate::commands::DbPath;
use crate::db::ACTIVE_PREDICATE;

/// 「待确认」阈值：AI 置信度低于此值（或缺省）需要用户复核。
const CONFIRM_THRESHOLD: f64 = 0.6;

fn open_db(db: &DbPath) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(&db.0).map_err(|e| e.to_string())
}

// ─── 分类目录：增删改查 / 归档 / 排序 ─────────────────────────────────────────

/// 分类列表的一行：分类本体 + 该分类下的应用数量。
#[derive(Serialize, Clone)]
pub struct CategoryRow {
    #[serde(flatten)]
    pub category: Category,
    pub app_count: i64,
}

/// 列出全部分类（**含已归档**）。前端要靠归档项还原「原 XX，已归档」的显示。
#[tauri::command]
pub fn list_categories(db: State<'_, DbPath>) -> Result<Vec<CategoryRow>, String> {
    let conn = open_db(&db)?;
    let cats = catalog::list(&conn).map_err(|e| e.to_string())?;
    let counts = catalog::app_counts(&conn).map_err(|e| e.to_string())?;
    Ok(cats
        .into_iter()
        .map(|c| {
            let app_count = counts.get(&c.id).copied().unwrap_or(0);
            CategoryRow {
                category: c,
                app_count,
            }
        })
        .collect())
}

#[tauri::command]
pub fn create_category(
    db: State<'_, DbPath>,
    name: String,
    description: String,
    hue: f64,
    custom_color: Option<String>,
) -> Result<Category, String> {
    let conn = open_db(&db)?;
    catalog::create(&conn, &name, &description, hue, custom_color)
}

#[tauri::command]
pub fn update_category(
    db: State<'_, DbPath>,
    id: String,
    name: String,
    description: String,
    hue: f64,
    custom_color: Option<String>,
) -> Result<Category, String> {
    let conn = open_db(&db)?;
    catalog::update(&conn, &id, &name, &description, hue, custom_color)
}

/// 归档 / 恢复。归档不动任何归类数据，恢复后其下应用自动回来。
#[tauri::command]
pub fn set_category_archived(
    db: State<'_, DbPath>,
    id: String,
    archived: bool,
) -> Result<Category, String> {
    let conn = open_db(&db)?;
    catalog::set_archived(&conn, &id, archived)
}

/// 永久删除前的影响面：多少个应用会落到未分类、清多少条手动覆盖、清多少条规则。
#[tauri::command]
pub fn get_category_delete_impact(
    db: State<'_, DbPath>,
    id: String,
) -> Result<DeleteImpact, String> {
    let conn = open_db(&db)?;
    catalog::delete_impact(&conn, &id).map_err(|e| e.to_string())
}

/// 永久删除（只允许对已归档的非系统分类执行）。不可撤销。
#[tauri::command]
pub fn delete_category(db: State<'_, DbPath>, id: String) -> Result<DeleteImpact, String> {
    let conn = open_db(&db)?;
    let impact = catalog::delete_permanent(&conn, &id)?;
    // 批次快照里可能存着指向这个分类的旧归类值，撤销会把它们写回去，
    // 变成指向一个已经不存在的分类。删除即作废撤销入口。
    engine::invalidate_batch(&conn);
    engine::refresh_pending_conn(&conn);
    Ok(impact)
}

#[tauri::command]
pub fn reorder_categories(db: State<'_, DbPath>, ids: Vec<String>) -> Result<(), String> {
    let conn = open_db(&db)?;
    catalog::reorder(&conn, &ids)
}

// ─── 触发与状态 ───────────────────────────────────────────────────────────────

/// 触发一次分类。`force=true` 对应「立即分类」，跳过攒批阈值。
/// `scope` 见 [`Scope`]，缺省为「仅未分类」。
#[tauri::command]
pub async fn classify_apps(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
    force: Option<bool>,
    scope: Option<String>,
) -> Result<ClassifyOutcome, String> {
    let ai = state.inner().clone();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    let scope = match scope.as_deref() {
        None => Scope::Unclassified,
        Some(s) => Scope::from_str(s).ok_or_else(|| format!("未知的分类范围：{s}"))?,
    };

    let outcome =
        engine::classify_if_due(&ai.config, &ai.code_map, &db_path, force.unwrap_or(false), scope)
            .await;
    engine::refresh_pending(&db_path);
    Ok(outcome)
}

/// 分类队列状态：待分类数量 / 上次分类时间 / 是否正在运行 / 可撤销批次。
#[tauri::command]
pub fn get_classify_status(db: State<'_, DbPath>) -> Result<ClassifyStatus, String> {
    Ok(engine::classify_status(&db.0))
}

/// 撤销最近一次批量分类，完整还原到执行前（包括被覆盖掉的手动覆盖）。
#[tauri::command]
pub fn undo_classify_batch(db: State<'_, DbPath>) -> Result<usize, String> {
    let conn = open_db(&db)?;
    let n = engine::undo_latest_batch(&conn)?;
    engine::refresh_pending_conn(&conn);
    Ok(n)
}

// ─── 查看与手动修改 ───────────────────────────────────────────────────────────

/// 应用归类列表的一行：每个应用 + 其生效分类（含来源 / 置信度 / 待确认标记）。
///
/// `category` 是**数据层的原始分类 id**，不做归档折叠——前端要靠它显示
/// 「其他（原 XX，已归档）」，折叠了就还原不出原分类是谁。
#[derive(Serialize, Clone)]
pub struct AppCategoryRow {
    pub app_id: String,
    pub app_name: String,
    /// 生效分类 id；未分类为 null。
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
            classified_at_ms: if c.classified_at_ms == 0 {
                None
            } else {
                Some(c.classified_at_ms)
            },
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
///
/// 手改会**作废撤销入口**：旧批次记的「原始状态」已经不是用户眼下看到的状态，
/// 再还原就会把这次手改一起吞掉。
#[tauri::command]
pub fn set_app_category(
    db: State<'_, DbPath>,
    app_id: String,
    app_name: String,
    category: String,
) -> Result<AppCategoryRow, String> {
    let conn = open_db(&db)?;
    let cat = catalog::get(&conn, &category)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("未知分类：{category}"))?;
    if cat.is_archived {
        return Err(format!("「{}」已归档，不能作为归类目标", cat.name));
    }
    if cat.id == ID_UNCATEGORIZED {
        return Err("「未分类」不是可指定的归类目标，请用「重置为自动」".into());
    }
    store::set_category(
        &conn,
        &app_id,
        &app_name,
        &app_id,
        &cat.id,
        Source::Manual,
        None,
    )
    .map_err(|e| e.to_string())?;
    engine::invalidate_batch(&conn);
    engine::refresh_pending_conn(&conn);
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
    engine::invalidate_batch(&conn);
    engine::refresh_pending_conn(&conn);
    let resolved = store::resolve(&conn, &app_id, &app_name, &app_id).map_err(|e| e.to_string())?;
    Ok(to_row(&app_id, &app_name, resolved))
}

// ─── 消费方（概览分类占比） ────────────────────────────────────────────────────

/// 分类占比的一格：某分类在给定范围内的活跃时长（有输入）。
#[derive(Serialize, Clone)]
pub struct CategoryShare {
    pub category: String,
    pub duration_ms: i64,
}

/// 聚合给定时间范围内各分类的活跃时长（有输入口径），按时长降序返回。
///
/// 归档的分类并入「其他」（走 [`catalog::Folder`] 这一个折叠口径）；
/// 未分类的应用也计入「其他」，与改造前一致。
///
/// 与报告页分类占比同一口径：复用 [`crate::db::ACTIVE_PREDICATE`]，挂机时段不计入。
#[tauri::command]
pub fn get_category_breakdown(
    db: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<CategoryShare>, String> {
    use std::collections::HashMap;

    let conn = open_db(&db)?;
    let folder = catalog::Folder::load(&conn).map_err(|e| e.to_string())?;

    // 每个 app 聚一次：代表名 + 该范围总活跃时长（有输入）。
    let mut agg: Vec<(String, String, i64)> = Vec::new();
    {
        let sql = format!(
            "SELECT app_bundle_id, MAX(app_name) AS name,
                    SUM(CASE WHEN {ACTIVE_PREDICATE} THEN duration_ms ELSE 0 END) AS dur
             FROM activity_buckets
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             GROUP BY app_bundle_id"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
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
            .map(|c| folder.fold(&c.category))
            .unwrap_or_else(|| crate::app_classify::ID_OTHER.to_string());
        *totals.entry(cat).or_insert(0) += dur;
    }

    let mut out: Vec<CategoryShare> = totals
        .into_iter()
        .filter(|(_, d)| *d > 0)
        .map(|(category, duration_ms)| CategoryShare {
            category,
            duration_ms,
        })
        .collect();
    out.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
    Ok(out)
}
