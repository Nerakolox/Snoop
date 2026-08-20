//! AI 分类引擎（Task 2）—— 队列攒批 + 单一出口调用 + 严格校验。
//!
//! 触发时机（三者满足其一，且队列非空）：
//!   - 队列 ≥ 8 个待分类应用；
//!   - 距上次分类 > 24h（或从未分过）；
//!   - 手动「立即分类」（`force`）。
//!
//! 每次只发一批（≤ 30 个），绝不逐应用发请求。请求走
//! [`crate::ai::envelope::call_ai`] 单一出口（`featureId = ai.app-classify`），
//! 自动裁剪到 T2（只发应用名，不发窗口标题）并记审计。
//!
//! 响应契约：模型返回 `{"classifications":[{category,confidence}]}`，数组长度
//! 必须与 apps 一致、顺序一一对应。结构不符（非 JSON / 缺字段 / 长度不一致）
//! 整批丢弃；单条 category 不在固定枚举内则跳过该条、留队下次再分。

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

use crate::ai::config::AiConfigState;
use crate::ai::envelope::{self, AiCodeMap};

use super::store::{self, Source};
use super::Category;

/// 队列达到该数量即触发（即使未过 24h）。
const QUEUE_TRIGGER: usize = 8;
/// 单批最多分类的应用数。
const BATCH_MAX: usize = 30;
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

// ── 待分类队列的轻量内存缓存 ──
// 后台每 10 分钟轮询，不能每次都跑 collect_pending（全表 GROUP BY + 逐 app resolve）。
// 改为：队列变化时更新这里的计数，轮询只读计数，达标（或 24h 过期）才真正查库分类。
//
// 队列变化的两类来源：
//   - 写桶线程见到「新 app」→ note_apps_seen 把缓存标脏；
//   - 分类 / 手改 / 重置 → 调用方（poll_once / 命令）里 refresh_pending 重算。
// 轮询路径 poll_once 先消费脏标记（重算一次），再只读原子判断是否触发。

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

/// 收集**全部**待分类应用，按使用时长降序（优先分类用得最多的）。
fn collect_pending(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<AppInfo>> {
    let raw = collect_all_apps(conn)?;
    // 已分类（manual/builtin/ai）的不再进队列。
    let mut pending = Vec::new();
    for info in raw {
        if store::resolve(conn, &info.app_id, &info.name, &info.app_id)?.is_none() {
            pending.push(info);
        }
    }
    Ok(pending)
}

/// 最近一次 AI 分类时间（`app_categories` 里 source='ai' 的最大 classified_at_ms）。
fn last_classified_at(conn: &rusqlite::Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT MAX(classified_at_ms) FROM app_categories WHERE source = 'ai'",
        [],
        |r| r.get(0),
    )
}

/// 分类系统提示：固定 11 类 + 输出契约。模型不得自创新类别。
const SYSTEM_PROMPT: &str = "你是 Snoop 的应用分类器。根据应用名，把每个应用归入以下固定 11 个类别之一：\n\
development（开发：IDE、终端、版本控制、数据库）\n\
communication（沟通：微信、QQ、邮件、Slack、会议）\n\
browsing（浏览：浏览器）\n\
entertainment（娱乐：游戏、视频播放器、音乐）\n\
design（设计：Figma、Photoshop、剪辑、录屏）\n\
document（文档：Office、笔记、PDF）\n\
ai_assistant（AI 助手：ChatGPT、Claude、Gemini、Copilot 等独立桌面客户端；编辑器/IDE 里的 Copilot 插件不算，那是宿主开发工具）\n\
system（系统：资源管理器、任务管理器、系统工具、代理）\n\
remote（远程控制：ToDesk、向日葵、RDP、TeamViewer）\n\
download（下载工具：IDM、迅雷、BT）\n\
other（其他：无法归入以上任何一类）\n\
\n\
只使用上述类别，禁止自创新类别。输出一个 JSON 对象，格式为：\n\
{\"classifications\":[{\"category\":\"<类别>\",\"confidence\":0.0}]}\n\
classifications 数组长度必须与 apps 数组完全一致，顺序一一对应（第 i 个分类对应第 i 个应用）。\n\
confidence 是对分类的把握（0 到 1）。拿不准的用 other 并给低 confidence。";

/// 构造完整 T3 形状的 payload；信封层会按 tier 裁到 T2（只发应用名）。
fn build_payload(batch: &[AppInfo]) -> Value {
    json!({
        "system_prompt": SYSTEM_PROMPT,
        "categories": Category::ALL.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        "apps": batch
            .iter()
            .map(|a| json!({ "id": a.app_id, "name": a.name, "windows": [] }))
            .collect::<Vec<_>>(),
    })
}

/// 严格校验模型响应，返回与 `apps` 等长的 `Option<(类别, 置信度)>` 数组。
/// 单条 category 非法 → 该位置为 None（跳过、留队）；结构非法 → 整批报错。
fn validate(content: &str, n: usize) -> Result<Vec<Option<(Category, Option<f64>)>>, String> {
    let v: Value =
        serde_json::from_str(content).map_err(|e| format!("响应不是合法 JSON：{e}"))?;
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
            .and_then(Category::from_str);
        let conf = item
            .get("confidence")
            .and_then(|x| x.as_f64())
            .map(|x| x.clamp(0.0, 1.0));
        out.push(cat.map(|c| (c, conf)));
    }
    Ok(out)
}

/// 一次分类流程的结果（回给前端展示 / 日志）。
#[derive(Serialize, Clone)]
pub struct ClassifyOutcome {
    /// busy | empty | skipped | classified | degraded | invalid_response
    pub status: String,
    /// 当前待分类队列长度（触发前）。
    pub queue_len: usize,
    /// 本次成功落库的分类条数。
    pub classified: usize,
    /// 人类可读的一句话结果 / 跳过原因。
    pub message: String,
}

impl ClassifyOutcome {
    fn new(status: &str, queue_len: usize, classified: usize, message: impl Into<String>) -> Self {
        ClassifyOutcome {
            status: status.to_string(),
            queue_len,
            classified,
            message: message.into(),
        }
    }
}

/// 分类流程主入口。`force=true` 对应「立即分类」按钮，跳过攒批阈值直接跑。
pub async fn classify_if_due(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    force: bool,
) -> ClassifyOutcome {
    let _guard = match acquire() {
        Some(g) => g,
        None => return ClassifyOutcome::new("busy", 0, 0, "已有分类流程在运行"),
    };

    // ── 阶段 1：攒批（同步，短生命周期连接） ──
    let (batch, queue_len) = {
        let conn = match rusqlite::Connection::open(db_path) {
            Ok(c) => c,
            Err(e) => return ClassifyOutcome::new("invalid_response", 0, 0, format!("打开数据库失败：{e}")),
        };
        let pending = match collect_pending(&conn) {
            Ok(p) => p,
            Err(e) => return ClassifyOutcome::new("invalid_response", 0, 0, format!("读取待分类列表失败：{e}")),
        };
        let queue_len = pending.len();
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
        let batch: Vec<AppInfo> = pending.into_iter().take(BATCH_MAX).collect();
        (batch, queue_len)
    };

    // ── 阶段 2：请求分类（异步，走单一出口） ──
    let payload = build_payload(&batch);
    let result = envelope::call_ai(config, code_map, db_path, "ai.app-classify", payload, true).await;
    if !result.ok {
        return ClassifyOutcome::new(
            "degraded",
            queue_len,
            0,
            result.reason.unwrap_or_else(|| "AI 不可用".into()),
        );
    }
    let content = result.content.unwrap_or_default();
    let parsed = match validate(&content, batch.len()) {
        Ok(p) => p,
        Err(e) => return ClassifyOutcome::new("invalid_response", queue_len, 0, e),
    };

    // ── 阶段 3：落库（同步，新连接；store 层再兜一道优先级硬规则） ──
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => return ClassifyOutcome::new("invalid_response", queue_len, 0, format!("打开数据库失败：{e}")),
    };
    let mut classified = 0usize;
    for (i, entry) in parsed.iter().enumerate() {
        let Some((cat, conf)) = entry else { continue };
        let info = &batch[i];
        match store::set_category(&conn, &info.app_id, &info.name, &info.app_id, *cat, Source::Ai, *conf) {
            Ok(true) => classified += 1,
            Ok(false) => { /* 被 manual/builtin 优先级挡下，跳过 */ }
            Err(_) => { /* 单条写失败不影响其余 */ }
        }
    }

    ClassifyOutcome::new(
        "classified",
        queue_len,
        classified,
        format!("已分类 {classified}/{queue_len} 个应用"),
    )
}

/// 分类状态快照（供前端展示队列与上次时间）。
#[derive(Serialize)]
pub struct ClassifyStatus {
    pub queue_len: usize,
    pub last_classified_at_ms: Option<i64>,
    pub running: bool,
}

pub fn classify_status(db_path: &Path) -> ClassifyStatus {
    let (queue_len, last) = rusqlite::Connection::open(db_path)
        .ok()
        .map(|conn| {
            let q = collect_pending(&conn).map(|p| p.len()).unwrap_or(0);
            let last = last_classified_at(&conn).ok().flatten();
            (q, last)
        })
        .unwrap_or((0, None));
    ClassifyStatus {
        queue_len,
        last_classified_at_ms: last,
        running: RUNNING.load(Ordering::SeqCst),
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
    classify_if_due(config, code_map, db_path, false).await;
    // 4) 分类后队列变了（或精确门判定为 skip，缓存可能虚高），刷新缓存对齐真实值。
    refresh_pending(db_path);
    true
}
