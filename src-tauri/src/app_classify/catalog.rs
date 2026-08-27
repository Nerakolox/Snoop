//! 分类目录 —— `categories` 表的增删改查、归档、永久删除、排序。
//!
//! 两条贯穿全篇的约定：
//!
//! 1. **归档是软删除，数据层一行不动。** 归档只让分类退出「AI prompt / 下拉选项 /
//!    展示层聚合」三个地方；`app_categories` 里指向它的归类与手动覆盖原样保留。
//!    所以恢复一个分类后，原先属于它的应用自动回来，不需要重新归类。
//! 2. **永久删除才动数据**，且只允许在已归档的分类上执行：清掉指向它的全部归类行
//!    （其下应用因此落回「未分类」）与全部 builtin 规则。不可撤销。
//!
//! 系统分类（「未分类」「其他」）既不可归档也不可删除——它们是聚合逻辑的结构依赖：
//! 归档要往「其他」折叠，永久删除要往「未分类」落。

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock};

use rusqlite::{params, Connection, Result};
use serde::Serialize;

use super::store::{self, now_ms};
use super::{builtin, ID_OTHER, ID_UNCATEGORIZED, MAX_ACTIVE_CATEGORIES};

// ── 分类 id → 显示名的进程内缓存 ──────────────────────────────────────────────
//
// 报告叙事（`report::narrative`）要把分类 id 翻成中文名，但它的格式化路径
// （`build_payload` / `template_*_narrative`）拿的是纯 report 结构体，手边没有
// 数据库连接。为一个显示名把 conn 串进六个函数签名不值得，所以在这里存一份
// 全局名称快照：有 conn 的地方 [`prime`]，没 conn 的地方 [`name_of`] 直接读。
//
// 快照过期不会给出错误数据，只会退回显示原始 id，所以对正确性无风险。

static NAME_CACHE: OnceLock<RwLock<Arc<HashMap<String, String>>>> = OnceLock::new();

fn name_cache() -> &'static RwLock<Arc<HashMap<String, String>>> {
    NAME_CACHE.get_or_init(|| RwLock::new(Arc::new(HashMap::new())))
}

/// 用当前分类表刷新名称快照。启动时、每次分类表变更后、生成报告前调用。
pub fn prime(conn: &Connection) {
    let mut map = HashMap::new();
    if let Ok(cats) = list(conn) {
        for c in cats {
            map.insert(c.id, c.name);
        }
    }
    if let Ok(mut w) = name_cache().write() {
        *w = Arc::new(map);
    }
}

/// 分类 id → 显示名。快照里没有（分类已被永久删除、或快照还没建立）时退回 id 本身。
pub fn name_of(id: &str) -> String {
    name_cache()
        .read()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .unwrap_or_else(|| id.to_string())
}

/// 一个分类。`id` 创建后永不变更，是所有引用的锚点。
#[derive(Clone, Debug, Serialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    /// 分类说明。**AI 判断归属的唯一依据**，会逐条进分类 prompt。
    pub description: String,
    /// OKLCH 色相角 [0,360)。只存色相，L/C 由主题层给，所以切主题自动适配。
    pub hue: f64,
    /// 用户手动指定的完整色值。非空时优先于 `hue`，且不再参与主题适配。
    pub custom_color: Option<String>,
    pub is_system: bool,
    pub is_archived: bool,
    pub sort_order: i64,
}

fn row_to_category(r: &rusqlite::Row<'_>) -> rusqlite::Result<Category> {
    Ok(Category {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        hue: r.get(3)?,
        custom_color: r.get(4)?,
        is_system: r.get::<_, i64>(5)? != 0,
        is_archived: r.get::<_, i64>(6)? != 0,
        sort_order: r.get(7)?,
    })
}

const SELECT_COLS: &str =
    "id, name, description, hue, custom_color, is_system, is_archived, sort_order";

/// 全部分类（含已归档），按 sort_order 升序。
pub fn list(conn: &Connection) -> Result<Vec<Category>> {
    let sql = format!("SELECT {SELECT_COLS} FROM categories ORDER BY sort_order ASC, id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_category)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Category>> {
    let sql = format!("SELECT {SELECT_COLS} FROM categories WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([id], row_to_category)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 未归档分类数（不含已归档）。新建上限判定用。
pub fn count_active(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM categories WHERE is_archived = 0",
        [],
        |r| r.get(0),
    )
}

/// 已归档分类的 id 集合。展示层聚合时用它把归档分类折叠进「其他」。
pub fn archived_ids(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM categories WHERE is_archived = 1")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// 展示层折叠器：把「已归档 / 已不存在」的分类 id 折成「其他」。
///
/// 聚合口径的单一实现——概览分类占比、报告分类占比都必须过这一层，
/// 否则归档一个分类后两处会给出不同的行数。
pub struct Folder {
    live: HashSet<String>,
}

impl Folder {
    pub fn load(conn: &Connection) -> Result<Folder> {
        let mut stmt = conn.prepare("SELECT id FROM categories WHERE is_archived = 0")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(Folder {
            live: rows.collect::<Result<HashSet<String>>>()?,
        })
    }

    /// 归类指向 → 展示用分类 id。归档的、表里已经没有的，一律并入「其他」。
    pub fn fold(&self, category_id: &str) -> String {
        if self.live.contains(category_id) {
            category_id.to_string()
        } else {
            ID_OTHER.to_string()
        }
    }
}

/// 生成一个不会与现有分类撞车的 id。
///
/// 不用名称派生（名称可改、可以是中文、可以重名），用时间戳 + 递增后缀，
/// 保证「创建后永不变更」这条约定不依赖名称。
fn new_id(conn: &Connection) -> Result<String> {
    let base = now_ms();
    for n in 0..1000 {
        let id = if n == 0 {
            format!("c{base}")
        } else {
            format!("c{base}_{n}")
        };
        let taken: bool = conn
            .prepare("SELECT 1 FROM categories WHERE id = ?1")?
            .exists([id.as_str()])?;
        if !taken {
            return Ok(id);
        }
    }
    Ok(format!("c{base}_{}", now_ms()))
}

/// 新建分类。`hue` 由前端按取色算法算好传入（禁区判定要读 CSS token，后端读不到）。
pub fn create(
    conn: &Connection,
    name: &str,
    description: &str,
    hue: f64,
    custom_color: Option<String>,
) -> Result<Category, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分类名不能为空".into());
    }
    let active = count_active(conn).map_err(|e| e.to_string())?;
    if active >= MAX_ACTIVE_CATEGORIES as i64 {
        return Err(format!("分类数量已达上限 {MAX_ACTIVE_CATEGORIES} 个"));
    }
    let id = new_id(conn).map_err(|e| e.to_string())?;
    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO categories
            (id, name, description, hue, custom_color, is_system, is_archived, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)",
        params![id, name, description.trim(), hue, custom_color, next_order],
    )
    .map_err(|e| e.to_string())?;
    prime(conn);
    get(conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "新建分类后读回失败".to_string())
}

/// 改名 / 改说明 / 改色。传入的是完整值：`custom_color = None` 即「清空自定义色，
/// 回到跟随主题的 hue」。
pub fn update(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    hue: f64,
    custom_color: Option<String>,
) -> Result<Category, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分类名不能为空".into());
    }
    let n = conn
        .execute(
            "UPDATE categories SET name = ?2, description = ?3, hue = ?4, custom_color = ?5
             WHERE id = ?1",
            params![id, name, description.trim(), hue, custom_color],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("分类不存在：{id}"));
    }
    prime(conn);
    get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "更新分类后读回失败".to_string())
}

/// 归档 / 恢复。系统分类拒绝归档。
///
/// 只翻 `is_archived` 这一个位，**不碰 `app_categories` 一行**——这正是
/// 「恢复后应用自动回来、无需重新归类」成立的原因。
pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> Result<Category, String> {
    let cat = get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("分类不存在：{id}"))?;
    if cat.is_system && archived {
        return Err(format!("「{}」是系统分类，不可归档", cat.name));
    }
    if !archived {
        // 恢复要占一个未归档名额，超上限就不让恢复，否则会绕过 24 的限制。
        let active = count_active(conn).map_err(|e| e.to_string())?;
        if cat.is_archived && active >= MAX_ACTIVE_CATEGORIES as i64 {
            return Err(format!(
                "未归档分类已达上限 {MAX_ACTIVE_CATEGORIES} 个，先归档或删除一个再恢复"
            ));
        }
    }
    conn.execute(
        "UPDATE categories SET is_archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )
    .map_err(|e| e.to_string())?;
    prime(conn);
    get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "归档分类后读回失败".to_string())
}

/// 永久删除的影响面（确认弹窗要如实显示这三个数）。
#[derive(Serialize, Clone)]
pub struct DeleteImpact {
    /// 该分类下的应用数（会落到「未分类」）。
    pub app_count: i64,
    /// 指向该分类的手动覆盖条数（会被清除）。
    pub manual_count: i64,
    /// 指向该分类的内置规则条数（会被清除）。
    pub rule_count: i64,
}

pub fn delete_impact(conn: &Connection, id: &str) -> Result<DeleteImpact> {
    let counts = app_counts(conn)?;
    Ok(DeleteImpact {
        app_count: counts.get(id).copied().unwrap_or(0),
        manual_count: store::count_manual_by_category(conn, id)?,
        rule_count: builtin::count_by_category(conn, id)?,
    })
}

/// 永久删除。只允许对**已归档的非系统分类**执行。
///
/// 三处一起清，缺一处都会留下指向不存在分类的悬空引用：
///   1. `app_categories` 里指向它的行（其下应用因此落回「未分类」，手动覆盖一并清除）；
///   2. `builtin_rules` 里指向它的规则；
///   3. `categories` 自身。
pub fn delete_permanent(conn: &Connection, id: &str) -> Result<DeleteImpact, String> {
    let cat = get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("分类不存在：{id}"))?;
    if cat.is_system {
        return Err(format!("「{}」是系统分类，不可删除", cat.name));
    }
    if !cat.is_archived {
        return Err("只能删除已归档的分类".into());
    }
    let impact = delete_impact(conn, id).map_err(|e| e.to_string())?;
    store::delete_by_category(conn, id).map_err(|e| e.to_string())?;
    builtin::delete_by_category(conn, id).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM categories WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    prime(conn);
    Ok(impact)
}

/// 按给定 id 顺序重排。列表里没提到的分类保持在后面。
pub fn reorder(conn: &Connection, ids: &[String]) -> Result<(), String> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 测试夹具用：建分类相关的表并灌入内置分类种子。
///
/// 报告模块的单测各自手搓 schema（只建 `activity_buckets` + `app_categories`），
/// 而分类占比要读 `categories` 表做归档折叠——缺表会让整个 `category_shares` 失败。
#[cfg(test)]
pub(crate) fn create_tables_for_tests(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS categories (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            hue          REAL NOT NULL,
            custom_color TEXT,
            is_system    INTEGER NOT NULL DEFAULT 0,
            is_archived  INTEGER NOT NULL DEFAULT 0,
            sort_order   INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS builtin_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword     TEXT NOT NULL,
            category_id TEXT NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
         );",
    )
    .unwrap();
    for (i, c) in super::SEED_CATEGORIES.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO categories
                (id, name, description, hue, is_system, is_archived, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
            params![c.id, c.name, c.description, c.hue, c.is_system as i64, i as i64],
        )
        .unwrap();
    }
}

/// 每个分类下的应用数量（按 `resolve` 的生效分类统计，未分类计入 `uncategorized`）。
///
/// 统计的是**数据层的归类指向**，不折叠归档——分类列表要显示「归档它会有多少个
/// 应用并入其他」，折叠了就数不出来了。
pub fn app_counts(conn: &Connection) -> Result<HashMap<String, i64>> {
    let mut apps: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT app_bundle_id, MAX(app_name) FROM activity_buckets GROUP BY app_bundle_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows {
            apps.push(r?);
        }
    }
    let mut out: HashMap<String, i64> = HashMap::new();
    for (id, name) in apps {
        let cat = store::resolve(conn, &id, &name, &id)?
            .map(|c| c.category)
            .unwrap_or_else(|| ID_UNCATEGORIZED.to_string());
        *out.entry(cat).or_insert(0) += 1;
    }
    Ok(out)
}
