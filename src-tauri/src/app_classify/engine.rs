//! AI 分类引擎 —— 队列攒批 + 单一出口调用 + 严格校验 + 批次可撤销。
//!
//! 触发时机（三者满足其一，且队列非空）：
//!   - 队列 ≥ 8 个待分类应用；
//!   - 距上次分类 > 24h（或从未分过）；
//!   - 手动「立即分类」（`force`）。
//!
//! 每次只发一批（≤ 30 个），绝不逐应用发请求；手动触发时按 30 个一组连发多批。
//! 请求走 [`crate::ai::envelope::call_ai`] 单一出口（`featureId = ai.app-classify`），
//! 自动裁剪到 T2（只发应用名，不发窗口标题）并记审计。这条约束不因分类数据化而改变。
//!
//! 分类清单**运行时从 `categories` 表拼装**，没有任何硬编码类别：新建的自定义分类
//! 会立刻出现在 prompt 里，归档的立刻消失。
//!
//! 响应契约：模型返回 `{"classifications":[{category,confidence}]}`，数组长度
//! 必须与 apps 一致、顺序一一对应。结构不符（非 JSON / 缺字段 / 长度不一致）
//! 整批丢弃；单条 category 不是合法分类 id 则跳过该条、留队下次再分。

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai::config::AiConfigState;
use crate::ai::envelope::{self, AiCodeMap};

use super::store::{self, Source};
use super::{catalog, ID_UNCATEGORIZED};

/// 队列达到该数量即触发（即使未过 24h）。
const QUEUE_TRIGGER: usize = 8;
/// 单批最多分类的应用数。
const BATCH_MAX: usize = 30;
/// 手动触发时最多连发几批（防止一次点击打出无上限的调用量）。
const MAX_CHUNKS: usize = 10;
/// 距上次分类超过该毫秒数且队列非空时触发。
const STALE_MS: i64 = 24 * 60 * 60 * 1000;

/// 并发防抖：同一时刻只允许一个分类流程在跑（后台轮询 + 手动按钮可能撞车）。
static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn acquire() -> Option<RunningGuard> {
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        Some(RunningGuard)
    } else {
        None
    }
}

/// 批量分类的范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// 仅未分类的应用（默认，也是后台轮询唯一使用的范围）。
    Unclassified,
    /// 全部应用，但跳过存在手动覆盖的。
    AllSkipManual,
    /// 全部应用，包含覆盖手动记录。破坏性，前端须二次确认。
    AllOverride,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Unclassified => "unclassified",
            Scope::AllSkipManual => "all_skip_manual",
            Scope::AllOverride => "all_override",
        }
    }

    pub fn from_str(s: &str) -> Option<Scope> {
        Some(match s {
            "unclassified" => Scope::Unclassified,
            "all_skip_manual" => Scope::AllSkipManual,
            "all_override" => Scope::AllOverride,
            _ => return None,
        })
    }
}

// ── 待分类队列的轻量内存缓存 ──
// 后台每 10 分钟轮询，不能每次都跑 collect_pending（全表 GROUP BY + 逐 app resolve）。
// 改为：队列变化时更新这里的计数，轮询只读计数，达标（或 24h 过期）才真正查库分类。

/// 待分类应用数量（refresh_pending 后有效；启动时填一次初值）。
static PENDING_QUEUE: AtomicUsize = AtomicUsize::new(0);
/// 最近一次 AI 分类时间（ms）；0 = 从未分类。
static LAST_CLASSIFIED_AT_MS: AtomicI64 = AtomicI64::new(0);
/// 有新 app 出现、缓存计数待重算时为 true。
static PENDING_DIRTY: AtomicBool = AtomicBool::new(false);

fn seen_apps() -> &'static Mutex<HashSet<String>> {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 一个待分类应用（`app_id` 即 activity_buckets.app_bundle_id）。
struct AppInfo {
    app_id: String,
    name: String,
}

/// 全部出现过（activity_buckets 里有记录）的应用，按使用时长降序。
fn collect_all_apps(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<AppInfo>> {
    let mut raw: Vec<AppInfo> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT app_bundle_id, MAX(app_name) AS name
         FROM activity_buckets
         GROUP BY app_bundle_id
         ORDER BY SUM(duration_ms) DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(AppInfo {
            app_id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    for r in rows {
        raw.push(r?);
    }
    Ok(raw)
}

/// 按范围收集本次要分类的应用，按使用时长降序（优先分类用得最多的）。
fn collect_targets(conn: &rusqlite::Connection, scope: Scope) -> rusqlite::Result<Vec<AppInfo>> {
    let raw = collect_all_apps(conn)?;
    let mut out = Vec::new();
    for info in raw {
        let resolved = store::resolve(conn, &info.app_id, &info.name, &info.app_id)?;
        let keep = match scope {
            Scope::Unclassified => resolved.is_none(),
            Scope::AllSkipManual => resolved.as_ref().map_or(true, |c| c.source != "manual"),
            Scope::AllOverride => true,
        };
        if keep {
            out.push(info);
        }
    }
    Ok(out)
}

/// 收集**全部**待分类应用（范围 = 仅未分类）。队列计数与后台轮询用。
fn collect_pending(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<AppInfo>> {
    collect_targets(conn, Scope::Unclassified)
}

/// 最近一次 AI 分类时间（`app_categories` 里 source='ai' 的最大 classified_at_ms）。
fn last_classified_at(conn: &rusqlite::Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT MAX(classified_at_ms) FROM app_categories WHERE source = 'ai'",
        [],
        |r| r.get(0),
    )
}

/// 运行时拼装分类系统提示：逐条列出各**未归档**分类的 id / 名称 / 说明。
///
/// 「未分类」不进 prompt——它是「AI 还没判断过」的状态，不是一个可供选择的归属。
/// 模型只能从列出的 id 里选，不得自创。
fn build_system_prompt(cats: &[catalog::Category]) -> String {
    let mut s = String::from(
        "你是 Snoop 的应用分类器。根据应用名，把每个应用归入以下固定类别之一：\n",
    );
    for c in cats {
        s.push_str(&format!("{}（{}：{}）\n", c.id, c.name, c.description));
    }
    s.push_str(
        "\n只使用上述类别 id，禁止自创新类别。输出一个 JSON 对象，格式为：\n\
         {\"classifications\":[{\"category\":\"<类别 id>\",\"confidence\":0.0}]}\n\
         classifications 数组长度必须与 apps 数组完全一致，顺序一一对应（第 i 个分类对应第 i 个应用）。\n\
         confidence 是对分类的把握（0 到 1）。",
    );
    s
}

/// 可供 AI 分配的分类：未归档，且排除「未分类」。
fn assignable(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<catalog::Category>> {
    Ok(catalog::list(conn)?
        .into_iter()
        .filter(|c| !c.is_archived && c.id != ID_UNCATEGORIZED)
        .collect())
}

/// 构造完整 T3 形状的 payload；信封层会按 tier 裁到 T2（只发应用名）。
fn build_payload(batch: &[AppInfo], cats: &[catalog::Category]) -> Value {
    json!({
        "system_prompt": build_system_prompt(cats),
        "categories": cats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        "apps": batch
            .iter()
            .map(|a| json!({ "id": a.app_id, "name": a.name, "windows": [] }))
            .collect::<Vec<_>>(),
    })
}

/// 严格校验模型响应，返回与 `apps` 等长的 `Option<(分类 id, 置信度)>` 数组。
/// 单条 category 非法 → 该位置为 None（跳过、留队）；结构非法 → 整批报错。
fn validate(
    content: &str,
    n: usize,
    valid: &HashSet<String>,
) -> Result<Vec<Option<(String, Option<f64>)>>, String> {
    let v: Value = serde_json::from_str(content).map_err(|e| format!("响应不是合法 JSON：{e}"))?;
    let arr = v
        .get("classifications")
        .and_then(|x| x.as_array())
        .ok_or("响应缺少 classifications 数组")?;
    if arr.len() != n {
        return Err(format!("分类数量不符：期望 {n}，实际 {}", arr.len()));
    }

    let mut out = Vec::with_capacity(n);
    for item in arr {
        let cat = item
            .get("category")
            .and_then(|c| c.as_str())
            .filter(|c| valid.contains(*c))
            .map(|c| c.to_string());
        let conf = item
            .get("confidence")
            .and_then(|x| x.as_f64())
            .map(|x| x.clamp(0.0, 1.0));
        out.push(cat.map(|c| (c, conf)));
    }
    Ok(out)
}

// ── 批次快照与撤销 ──────────────────────────────────────────────────────────

/// 一个应用在批次执行**前**的原始状态。`category = None` 表示当时表里没有行
/// （即未分类，或分类由 builtin 计算得出）。
#[derive(Serialize, Deserialize, Clone)]
struct SnapshotEntry {
    app_id: String,
    category: Option<String>,
    source: Option<String>,
    confidence: Option<f64>,
    classified_at_ms: Option<i64>,
}

fn snapshot_of(conn: &rusqlite::Connection, app_ids: &[String]) -> Vec<SnapshotEntry> {
    app_ids
        .iter()
        .map(|id| {
            let row = conn
                .query_row(
                    "SELECT category, source, confidence, classified_at_ms
                     FROM app_categories WHERE app_id = ?1",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<f64>>(2)?,
                            r.get::<_, i64>(3)?,
                        ))
                    },
                )
                .ok();
            match row {
                Some((c, s, conf, at)) => SnapshotEntry {
                    app_id: id.clone(),
                    category: Some(c),
                    source: Some(s),
                    confidence: conf,
                    classified_at_ms: Some(at),
                },
                None => SnapshotEntry {
                    app_id: id.clone(),
                    category: None,
                    source: None,
                    confidence: None,
                    classified_at_ms: None,
                },
            }
        })
        .collect()
}

/// 落一个批次记录，并清掉更早的批次（只保留最近一个可撤销）。
fn save_batch(
    conn: &rusqlite::Connection,
    scope: Scope,
    affected: usize,
    snap: &[SnapshotEntry],
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(snap).unwrap_or_else(|_| "[]".into());
    conn.execute("DELETE FROM classify_batches", [])?;
    conn.execute(
        "INSERT INTO classify_batches (created_at_ms, scope, affected, snapshot_json)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![store::now_ms(), scope.as_str(), affected as i64, json],
    )?;
    Ok(())
}

/// 作废撤销入口。用户手动改了任一应用的归类后调用——旧批次的「原始状态」
/// 已经不再是用户眼下看到的状态，再还原就会把手改也一起吞掉。
pub fn invalidate_batch(conn: &rusqlite::Connection) {
    let _ = conn.execute("DELETE FROM classify_batches", []);
}

/// 最近一个可撤销批次的摘要。
#[derive(Serialize, Clone)]
pub struct BatchInfo {
    pub created_at_ms: i64,
    pub scope: String,
    pub affected: i64,
}

pub fn latest_batch(conn: &rusqlite::Connection) -> Option<BatchInfo> {
    conn.query_row(
        "SELECT created_at_ms, scope, affected FROM classify_batches
         ORDER BY id DESC LIMIT 1",
        [],
        |r| {
            Ok(BatchInfo {
                created_at_ms: r.get(0)?,
                scope: r.get(1)?,
                affected: r.get(2)?,
            })
        },
    )
    .ok()
}

/// 撤销最近一个批次：把所有受影响应用恢复到批次执行前的状态，
/// **包括被覆盖掉的手动覆盖记录**。返回还原的应用数。
pub fn undo_latest_batch(conn: &rusqlite::Connection) -> Result<usize, String> {
    let json: String = conn
        .query_row(
            "SELECT snapshot_json FROM classify_batches ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "没有可撤销的分类批次".to_string())?;
    let snap: Vec<SnapshotEntry> =
        serde_json::from_str(&json).map_err(|e| format!("批次快照损坏：{e}"))?;

    for e in &snap {
        match (&e.category, &e.source) {
            // 批次执行前表里有行 → 原样写回（绕过优先级判定，这是还原不是新决策）
            (Some(cat), Some(src)) => {
                store::restore_row(
                    conn,
                    &e.app_id,
                    cat,
                    src,
                    e.confidence,
                    e.classified_at_ms.unwrap_or(0),
                )
                .map_err(|err| err.to_string())?;
            }
            // 批次执行前没有行 → 删掉本次写进去的那行，回到未分类 / builtin
            _ => {
                store::delete(conn, &e.app_id).map_err(|err| err.to_string())?;
            }
        }
    }
    conn.execute("DELETE FROM classify_batches", [])
        .map_err(|e| e.to_string())?;
    Ok(snap.len())
}

// ── 分类主流程 ──────────────────────────────────────────────────────────────

/// 一次分类流程的结果（回给前端展示 / 日志）。
#[derive(Serialize, Clone)]
pub struct ClassifyOutcome {
    /// busy | empty | skipped | classified | degraded | invalid_response
    pub status: String,
    /// 本次范围内待处理的应用数（触发前）。
    pub queue_len: usize,
    /// 本次成功落库的分类条数。
    pub classified: usize,
    /// 人类可读的一句话结果 / 跳过原因。
    pub message: String,
    /// 本次批次是否可撤销（有落库改动才有意义）。
    pub can_undo: bool,
}

impl ClassifyOutcome {
    fn new(status: &str, queue_len: usize, classified: usize, message: impl Into<String>) -> Self {
        ClassifyOutcome {
            status: status.to_string(),
            queue_len,
            classified,
            message: message.into(),
            can_undo: false,
        }
    }
}

/// 分类流程主入口。`force=true` 对应「立即分类」按钮，跳过攒批阈值直接跑。
pub async fn classify_if_due(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    force: bool,
    scope: Scope,
) -> ClassifyOutcome {
    let _guard = match acquire() {
        Some(g) => g,
        None => return ClassifyOutcome::new("busy", 0, 0, "已有分类流程在运行"),
    };

    // ── 阶段 1：攒批（同步，短生命周期连接） ──
    let (targets, queue_len, cats) = {
        let conn = match rusqlite::Connection::open(db_path) {
            Ok(c) => c,
            Err(e) => {
                return ClassifyOutcome::new("invalid_response", 0, 0, format!("打开数据库失败：{e}"))
            }
        };
        let cats = match assignable(&conn) {
            Ok(c) => c,
            Err(e) => {
                return ClassifyOutcome::new(
                    "invalid_response",
                    0,
                    0,
                    format!("读取分类表失败：{e}"),
                )
            }
        };
        if cats.is_empty() {
            return ClassifyOutcome::new("empty", 0, 0, "没有可用的分类，先在分类页建一个");
        }
        let targets = match collect_targets(&conn, scope) {
            Ok(p) => p,
            Err(e) => {
                return ClassifyOutcome::new(
                    "invalid_response",
                    0,
                    0,
                    format!("读取待分类列表失败：{e}"),
                )
            }
        };
        let queue_len = targets.len();
        if queue_len == 0 {
            return ClassifyOutcome::new("empty", 0, 0, "没有待分类的应用");
        }
        if !force {
            let last = last_classified_at(&conn).ok().flatten();
            let stale = last.map_or(true, |t| store::now_ms() - t > STALE_MS);
            if queue_len < QUEUE_TRIGGER && !stale {
                return ClassifyOutcome::new(
                    "skipped",
                    queue_len,
                    0,
                    format!("队列 {queue_len} 个（<{QUEUE_TRIGGER}），未到触发条件"),
                );
            }
        }
        (targets, queue_len, cats)
    };

    // 手动触发按 30 个一组连发多批；后台轮询只发一批。
    let chunk_limit = if force { MAX_CHUNKS } else { 1 };
    let chunks: Vec<&[AppInfo]> = targets.chunks(BATCH_MAX).take(chunk_limit).collect();
    let covered: usize = chunks.iter().map(|c| c.len()).sum();
    let truncated = queue_len.saturating_sub(covered);
    let valid: HashSet<String> = cats.iter().map(|c| c.id.clone()).collect();

    // 先把整轮会碰到的应用的原始状态拍下来，再开始写——撤销要能还原到动手之前。
    let all_ids: Vec<String> = chunks
        .iter()
        .flat_map(|c| c.iter().map(|a| a.app_id.clone()))
        .collect();
    let snapshot = match rusqlite::Connection::open(db_path) {
        Ok(conn) => snapshot_of(&conn, &all_ids),
        Err(e) => {
            return ClassifyOutcome::new("invalid_response", queue_len, 0, format!("打开数据库失败：{e}"))
        }
    };

    let mut classified = 0usize;
    let mut last_error: Option<(String, String)> = None;

    for batch in &chunks {
        // ── 阶段 2：请求分类（异步，走单一出口） ──
        let payload = build_payload(batch, &cats);
        let result =
            envelope::call_ai(config, code_map, db_path, "ai.app-classify", payload, true).await;
        if !result.ok {
            last_error = Some((
                "degraded".into(),
                result.reason.unwrap_or_else(|| "AI 不可用".into()),
            ));
            break;
        }
        let content = result.content.unwrap_or_default();
        let parsed = match validate(&content, batch.len(), &valid) {
            Ok(p) => p,
            Err(e) => {
                last_error = Some(("invalid_response".into(), e));
                break;
            }
        };

        // ── 阶段 3：落库（同步，新连接；store 层再兜一道优先级硬规则） ──
        let conn = match rusqlite::Connection::open(db_path) {
            Ok(c) => c,
            Err(e) => {
                last_error = Some(("invalid_response".into(), format!("打开数据库失败：{e}")));
                break;
            }
        };
        for (i, entry) in parsed.iter().enumerate() {
            let Some((cat, conf)) = entry else { continue };
            let info = &batch[i];
            let written = if scope == Scope::AllOverride {
                // 「包含覆盖手动记录」是用户显式选择的破坏性操作，绕过优先级硬规则；
                // 代价由撤销兜底——快照里存了每条手动覆盖的原样。
                store::force_set(&conn, &info.app_id, cat, Source::Ai, *conf).map(|_| true)
            } else {
                store::set_category(
                    &conn,
                    &info.app_id,
                    &info.name,
                    &info.app_id,
                    cat,
                    Source::Ai,
                    *conf,
                )
            };
            match written {
                Ok(true) => classified += 1,
                Ok(false) => { /* 被 manual/builtin 优先级挡下，跳过 */ }
                Err(_) => { /* 单条写失败不影响其余 */ }
            }
        }
    }

    // 一条都没写成 → 不留批次（没什么可撤销的），直接把失败原因报上去。
    if classified == 0 {
        if let Some((status, msg)) = last_error {
            return ClassifyOutcome::new(&status, queue_len, 0, msg);
        }
        return ClassifyOutcome::new("classified", queue_len, 0, "没有可落库的分类结果");
    }

    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = save_batch(&conn, scope, classified, &snapshot);
    }

    let mut message = format!("已分类 {classified}/{queue_len} 个应用");
    if truncated > 0 {
        message.push_str(&format!("；本次只处理了前 {covered} 个，还剩 {truncated} 个未处理"));
    }
    if let Some((_, e)) = last_error {
        message.push_str(&format!("；中途中断：{e}"));
    }
    let mut outcome = ClassifyOutcome::new("classified", queue_len, classified, message);
    outcome.can_undo = true;
    outcome
}

/// 分类状态快照（供前端展示队列与上次时间）。
#[derive(Serialize)]
pub struct ClassifyStatus {
    pub queue_len: usize,
    pub last_classified_at_ms: Option<i64>,
    pub running: bool,
    /// 有记录的应用总数（「全部 App」范围的规模）。
    pub total_apps: usize,
    /// 存在手动覆盖的应用数（「包含覆盖手动记录」二次确认要显示这个数）。
    pub manual_count: i64,
    /// 最近一个可撤销批次；没有则为 null。
    pub undo: Option<BatchInfo>,
}

pub fn classify_status(db_path: &Path) -> ClassifyStatus {
    let conn = rusqlite::Connection::open(db_path).ok();
    let (queue_len, last, total, manual, undo) = conn
        .as_ref()
        .map(|conn| {
            let q = collect_pending(conn).map(|p| p.len()).unwrap_or(0);
            let last = last_classified_at(conn).ok().flatten();
            let total = collect_all_apps(conn).map(|a| a.len()).unwrap_or(0);
            let manual: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM app_categories WHERE source = 'manual'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            (q, last, total, manual, latest_batch(conn))
        })
        .unwrap_or((0, None, 0, 0, None));
    ClassifyStatus {
        queue_len,
        last_classified_at_ms: last,
        running: RUNNING.load(Ordering::SeqCst),
        total_apps: total,
        manual_count: manual,
        undo,
    }
}

// ── 队列缓存维护 + 后台轮询入口 ──────────────────────────────────────────────

/// 用已打开的连接重算待分类计数与最近分类时间，写入内存缓存。
/// 只在队列**可能变化**时调用（启动 / 分类后 / 手改后），不进轮询热路径。
pub(crate) fn refresh_pending_conn(conn: &rusqlite::Connection) {
    let mut seen = HashSet::new();
    let mut pending = 0usize;
    if let Ok(all) = collect_all_apps(conn) {
        for info in &all {
            seen.insert(info.app_id.clone());
            let resolved = store::resolve(conn, &info.app_id, &info.name, &info.app_id)
                .ok()
                .flatten();
            if resolved.is_none() {
                pending += 1;
            }
        }
    }
    PENDING_QUEUE.store(pending, Ordering::SeqCst);
    LAST_CLASSIFIED_AT_MS.store(
        last_classified_at(conn).ok().flatten().unwrap_or(0),
        Ordering::SeqCst,
    );
    *seen_apps().lock().unwrap() = seen;
    PENDING_DIRTY.store(false, Ordering::SeqCst);
}

/// 同上，但自行打开连接（供 lib.rs 启动时与轮询路径使用）。
pub fn refresh_pending(db_path: &Path) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        refresh_pending_conn(&conn);
    }
}

/// 写桶线程在每个桶落库后调用：把出现的 app_id 记进内存「已见」集合。
/// 只有**新** app 才会把缓存标脏（触发一次重算），老 app 的桶写入是零开销的。
pub(crate) fn note_apps_seen(ids: &[String]) {
    let mut seen = seen_apps().lock().unwrap();
    let mut dirty = false;
    for id in ids {
        if seen.insert(id.clone()) {
            dirty = true;
        }
    }
    if dirty {
        PENDING_DIRTY.store(true, Ordering::SeqCst);
    }
}

/// 后台轮询单次入口：只读内存计数，达标才查库分类。返回是否真正触发了分类流程。
pub async fn poll_once(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
) -> bool {
    // 0) 总开关关闭：后台轮询直接短路。分类走 call_ai 时信封层还会再拦一道，
    //    这里提前返回是为了避免每 10 分钟对已禁用状态反复尝试、往审计日志灌 ai_disabled。
    if !config.get().enabled {
        return false;
    }
    // 1) 有新 app → 先重算一次缓存（消费脏标记，清掉后再读才准确）。
    if PENDING_DIRTY.swap(false, Ordering::SeqCst) {
        refresh_pending(db_path);
    }
    // 2) 只读内存计数与上次分类时间，不碰库。
    let pending = PENDING_QUEUE.load(Ordering::SeqCst);
    if pending == 0 {
        return false;
    }
    let last = LAST_CLASSIFIED_AT_MS.load(Ordering::SeqCst);
    let stale = last == 0 || store::now_ms() - last > STALE_MS;
    if pending < QUEUE_TRIGGER && !stale {
        return false;
    }
    // 3) 达标才碰库：走原有完整分类流程（内部会再精确核一次门）。
    classify_if_due(config, code_map, db_path, false, Scope::Unclassified).await;
    // 4) 分类后队列变了（或精确门判定为 skip，缓存可能虚高），刷新缓存对齐真实值。
    refresh_pending(db_path);
    true
}
