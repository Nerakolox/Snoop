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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

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

/// 一个待分类应用（`app_id` 即 activity_buckets.app_bundle_id）。
struct AppInfo {
    app_id: String,
    name: String,
}

/// 收集**全部**待分类应用，按使用时长降序（优先分类用得最多的）。
fn collect_pending(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<AppInfo>> {
    let mut raw: Vec<AppInfo> = Vec::new();
    {
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
    }
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

/// 分类系统提示：固定 10 类 + 输出契约。模型不得自创新类别。
const SYSTEM_PROMPT: &str = "你是 Snoop 的应用分类器。根据应用名，把每个应用归入以下固定类别之一：\n\
development（开发：IDE、终端、版本控制、数据库）\n\
communication（沟通：微信、QQ、邮件、Slack、会议）\n\
browsing（浏览：浏览器）\n\
entertainment（娱乐：游戏、视频播放器、音乐）\n\
design（设计：Figma、Photoshop、剪辑、录屏）\n\
document（文档：Office、笔记、PDF）\n\
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
