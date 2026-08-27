//! 报告快照 —— 把「生成那一刻的分类长什么样」冻进报告行。
//!
//! # 为什么报告要冻结而概览不冻结
//!
//! **报告是快照，视图是实时。** 一份报告是特定时刻生成、会被导出成图发给别人的成品，
//! 内容必须凝固：三个月后重新打开 8 月的周报，看到的应当还是八月那天的分类名与配色，
//! 而不是被今天的分类设置改写过的样子。概览页与规律页恰恰相反，它们回答「我现在
//! 什么样」，必须跟着最新的分类设置走。所以本模块只服务 `daily_reports`，
//! 数据页的实时聚合一行不碰。
//!
//! # 冻的是什么，不冻的是什么
//!
//! `data_json` 里的聚合结果（分类 id、活跃时长、占比、应用排行）**本来就已经是快照**
//! ——它在生成时算好落库，此后不再重算。真正会漂移的是两样东西：分类的**显示名**和
//! **颜色**，它们原先由前端拿着分类 id 去分类表实时查（`labelOf` / `fillHexOf`），
//! 于是改名改色就改写了历史报告。本模块把这两样连同它们对应的数字一起存下来，
//! 前端此后只读快照、不再查分类表。
//!
//! 另外补上一件 `data_json` 里根本没有的事实：**每个 App 当时属于哪个分类**。
//! 应用排行原先只有名字和时长，分类归属得现查——同样会漂移。
//!
//! # 颜色为什么存解析后的色值而不是 hue
//!
//! 存 hue 等于把解析这一步留到读取时做，而解析要查分类表拿 `custom_color`、
//! 判归档——一查就又漏回实时状态了。所以这里直接产出一个**可以原样塞进 CSS 的
//! 颜色字符串**，前端 `style={{ background: c.color }}` 就完事。
//!
//! 产出的形式有两种，与前端 `categories/color.ts` 的 `categoryFill` 语义逐条对齐：
//!   - 用户手选过颜色 → 原样用那个色值；
//!   - 否则 → `oklch(<L> <C> <hue>)`，L/C 取**浅色主题**的常量（见下方 `CAT_L`）；
//!   - 系统分类（「其他」「未分类」）与查不到的 id → 中性色 hex，不发身份色。
//!
//! 写成 `oklch(0.62 0.15 99.9)` 而不是 hex，是为了不在 Rust 里再实现一遍
//! OKLCH→sRGB：那套色度学已经在 `color.ts` 里有一份，两份实现迟早对不上，
//! 而海报要的只是「一个不含 var() 的具体色值」，字面量 oklch() 就满足。

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_classify::{catalog, store, ID_OTHER, ID_UNCATEGORIZED};

// ── 主题常量（镜像 src/styles/tokens.css 的浅色一档）─────────────────────────
//
// 取浅色而不是「当前主题」：海报是一张固定浅色版式（report-card.css 的 --rc-* 全是
// 写死的浅色），同一份数据不该因为用户当时开着深色模式而导出成另一种配色。
//
// 这几个值是 tokens.css `[data-theme="light"]` 那一段的副本。前端 color.ts 的
// SYSTEM_FILL 里也有同样两个中性 hex 的副本，是同一个理由：读不到 CSS 的地方
// 只能拿字面值。改 tokens.css 的这几项时，这里和 color.ts 要一起改
// （已生成的报告不受影响——它们存的就是当时的色值，这正是快照的本意）。

/// `--cat-l`（浅色）。分类色的感知亮度。
const CAT_L: f64 = 0.62;
/// `--cat-c`（浅色）。分类色的彩度。
const CAT_C: f64 = 0.15;
/// `--neutral-3`（浅色）：「其他」的填充色。
const FILL_OTHER: &str = "#9B96A4";
/// `--neutral-5`（浅色）：「未分类」的填充色，比「其他」淡一阶以便同时出现时可区分。
const FILL_UNCATEGORIZED: &str = "#CFCBD8";

// ── 快照结构 ────────────────────────────────────────────────────────────────

/// 快照里的一个分类。`id` 之外的一切都是**生成那一刻**的值。
#[derive(Serialize, Deserialize, Clone)]
pub struct CategorySnap {
    pub id: String,
    /// 生成时的显示名。分类被改名或永久删除后，这里仍是当时那个名字。
    pub name: String,
    /// 生成时解析后的最终色值，可直接作为 CSS 颜色使用。
    pub color: String,
    pub active_ms: i64,
    pub share_pct: f64,
}

/// 快照里的一个 App。分类归属一并冻结。
#[derive(Serialize, Deserialize, Clone)]
pub struct AppSnap {
    pub bundle_id: String,
    pub name: String,
    pub active_ms: i64,
    pub share_pct: f64,
    /// 生成时该 App 所属的分类 id（已按展示口径折叠：归档的并入「其他」）。
    pub category_id: String,
    /// 生成时该分类的显示名。
    pub category_name: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ReportSnapshot {
    pub categories: Vec<CategorySnap>,
    pub apps: Vec<AppSnap>,
}

// ── 从 data_json 里取出要冻结的两块 ──────────────────────────────────────────
//
// 反序列化用宽松结构而不是 daily/weekly/monthly 的具体类型：三种报的分类项字段各不
// 相同（周报的 CategoryDelta 多两个基线字段），但都含 category / active_ms /
// share_pct 这三样，serde 默认忽略多余字段，一个结构就能吃下三种报。
//
// 这样 `build` 只依赖 JSON 而不依赖 Computed 枚举，「生成时写」与「历史报告首次
// 打开时补写」（那时手边只有 data_json）就能共用同一份实现，不会各写一份而分叉。

#[derive(Deserialize)]
struct RawCategory {
    category: String,
    active_ms: i64,
    share_pct: f64,
}

#[derive(Deserialize)]
struct RawApp {
    name: String,
    bundle_id: String,
    active_ms: i64,
    share_pct: f64,
}

fn parse_list<T: serde::de::DeserializeOwned>(data: &Value, key: &str) -> Vec<T> {
    data.get(key)
        .cloned()
        .and_then(|v| serde_json::from_value::<Vec<T>>(v).ok())
        .unwrap_or_default()
}

// ── 取名与取色 ──────────────────────────────────────────────────────────────

/// 分类 id → 显示名。查不到（已被永久删除）退回 id 本身，与前端 `labelOf` 同口径。
fn name_of(id: &str, cats: &HashMap<String, catalog::Category>) -> String {
    cats.get(id).map(|c| c.name.clone()).unwrap_or_else(|| id.to_string())
}

/// 分类 id → 可直接用作 CSS 颜色的色值。逐条对齐前端 `color.ts` 的 `categoryFill`。
fn color_of(id: &str, cats: &HashMap<String, catalog::Category>) -> String {
    // 系统分类没有身份色：「其他」是长尾与归档分类的收纳处，「未分类」是一个状态，
    // 给它们发彩色等于承认「不是任何一类」也是一类。
    if id == ID_OTHER {
        return FILL_OTHER.to_string();
    }
    if id == ID_UNCATEGORIZED {
        return FILL_UNCATEGORIZED.to_string();
    }
    match cats.get(id) {
        // 查不到 / 已归档：一律退到「其他」的中性色，不要退回随便一个彩色。
        // 正常路径上归档分类进不来（folder 已把它折进「其他」），这里是兜底。
        None => FILL_OTHER.to_string(),
        Some(c) if c.is_archived => FILL_OTHER.to_string(),
        Some(c) => c
            .custom_color
            .clone()
            .unwrap_or_else(|| format!("oklch({CAT_L} {CAT_C} {})", c.hue)),
    }
}

// ── 构造 ────────────────────────────────────────────────────────────────────

/// 按**当前**分类表，为一份报告的 `data_json` 构造快照。
///
/// 调用点只有两处，且都只在「快照尚不存在」时发生：报告生成时，以及加列之前的
/// 历史报告首次被打开时。已有快照的报告永远不会再走到这里——那正是「已生成的
/// 报告不受后续分类变更影响」成立的原因。
pub fn build(conn: &Connection, data: &Value) -> rusqlite::Result<ReportSnapshot> {
    let cats: HashMap<String, catalog::Category> = catalog::list(conn)?
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    let categories = parse_list::<RawCategory>(data, "categories")
        .into_iter()
        .map(|c| CategorySnap {
            name: name_of(&c.category, &cats),
            color: color_of(&c.category, &cats),
            id: c.category,
            active_ms: c.active_ms,
            share_pct: c.share_pct,
        })
        .collect();

    // App 的分类归属：与 common::category_shares 同一条解析链（resolve → fold），
    // 否则会出现「App 排行说某个 App 属于 A，分类占比里 A 却没有它的时长」。
    let folder = catalog::Folder::load(conn)?;
    let mut apps = Vec::new();
    for a in parse_list::<RawApp>(data, "top_apps") {
        let category_id = store::resolve(conn, &a.bundle_id, &a.name, &a.bundle_id)?
            .map(|c| folder.fold(&c.category))
            .unwrap_or_else(|| ID_OTHER.to_string());
        apps.push(AppSnap {
            category_name: name_of(&category_id, &cats),
            category_id,
            bundle_id: a.bundle_id,
            name: a.name,
            active_ms: a.active_ms,
            share_pct: a.share_pct,
        });
    }

    Ok(ReportSnapshot { categories, apps })
}

/// 快照 JSON 文本 → 结构。解析失败给一个空快照而不是报错：前端拿到的形状因此恒定，
/// 报告仍能显示叙述与各种图表，只是分类块显示「无数据」——比整份报告打不开好。
pub fn parse(json: &str) -> ReportSnapshot {
    serde_json::from_str(json).unwrap_or_default()
}
