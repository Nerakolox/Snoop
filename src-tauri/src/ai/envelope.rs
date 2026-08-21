//! 数据层级与信封构造器（Task 2）—— 所有 AI 调用**唯一**出口。
//!
//! ## 层级定义
//! - T0：不调 AI，纯本地模板。
//! - T1：只出数字（时长/次数/强度分布/小时桶），应用以稳定代号表示（App A / App B）。
//! - T2：T1 + 真实应用名。
//! - T3：T2 + 窗口标题（独立开关，不在主层级 T0/T1/T2 选择里）。
//!
//! ## payload 裁剪约定（机械可执行的唯一依据）
//!
//! 应用相关的数据**只能**出现在 `payload.apps` 数组里，且每个元素形状固定：
//! ```json
//! { "id": "com.example.chrome", "name": "Chrome", "windows": [{ "title": "..." }] }
//! ```
//! - `id`：应用稳定标识（bundle id）。**永不外发**，仅本地用于代号映射与回映。
//! - `name`：应用显示名，T2 起才允许出现在请求里。
//! - `windows`：窗口标题数组，T3（独立开关）才允许出现在请求里。
//!
//! 其余字段必须是 tier 无关的纯数值 / 通用文本，**不得夹带应用名或窗口标题**。
//! 裁剪器只改 `apps`，按 tier 重写每个元素：T1→`{code}`、T2→`{code,name}`、T3→`{code,name,windows}`。
//! 前端永远提交完整 T3 形状，由本层单点裁剪——不依赖各功能自觉。
//!
//! 可选约定：`payload.system_prompt`（若存在）会被提升为 system 消息，它是
//! tier 无关的功能指令，不参与裁剪。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::ai::audit::{self, AuditEntry};
use crate::ai::config::AiConfigState;
use crate::ai::provider::{self, ChatMessage};

/// 通用系统提示（无 `system_prompt` 字段时的兜底）。
const DEFAULT_SYSTEM: &str = "你是 Snoop 的本地数据助手，只基于用户提供的数据给出回复，不要臆测或编造。";

// ─── 层级 ─────────────────────────────────────────────────────────────────────

/// 数据层级。声明顺序即严格递增：T0 < T1 < T2 < T3。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Tier {
    T0,
    T1,
    T2,
    T3,
}

impl Tier {
    pub fn label(self) -> &'static str {
        match self {
            Tier::T0 => "T0",
            Tier::T1 => "T1",
            Tier::T2 => "T2",
            Tier::T3 => "T3",
        }
    }
}

// ─── 功能注册表 ───────────────────────────────────────────────────────────────

/// 一个 AI 功能的声明（设置页展示用）。字段全为静态字符串，可直接放 `static`。
#[derive(Clone, Debug, Serialize)]
pub struct FeatureDecl {
    pub id: &'static str,
    pub required_tier: Tier,
    pub label: &'static str,
    pub description: &'static str,
}

/// 全部 AI 功能。本批只注册占位，不实现功能。
pub static FEATURE_REGISTRY: &[FeatureDecl] = &[
    FeatureDecl {
        id: "ai.app-classify",
        required_tier: Tier::T2,
        label: "应用分类",
        description: "根据使用数据为应用归类（工作 / 娱乐等）",
    },
    FeatureDecl {
        id: "ai.nl-query",
        required_tier: Tier::T1,
        label: "自然语言查询",
        description: "用自然语言问数据，只发数字统计",
    },
    FeatureDecl {
        id: "ai.cat-quip",
        required_tier: Tier::T1,
        label: "猫的吐槽",
        description: "基于当日数字生成一句吐槽",
    },
    FeatureDecl {
        id: "ai.daily-report",
        required_tier: Tier::T2,
        label: "日报",
        description: "生成当日使用报告，含应用名",
    },
    FeatureDecl {
        id: "ai.weekly-report",
        required_tier: Tier::T2,
        label: "周报",
        description: "生成上周对比报告，含应用名",
    },
    FeatureDecl {
        id: "ai.monthly-report",
        required_tier: Tier::T2,
        label: "月报",
        description: "生成上月趋势报告，含应用名",
    },
    FeatureDecl {
        id: "ai.insights-explain",
        required_tier: Tier::T2,
        label: "洞察解释",
        description: "解释某个数据模式，含应用名",
    },
    FeatureDecl {
        id: "ai.notice",
        required_tier: Tier::T1,
        label: "提醒",
        description: "基于数字生成提醒",
    },
];

pub fn find_feature(id: &str) -> Option<&'static FeatureDecl> {
    FEATURE_REGISTRY.iter().find(|f| f.id == id)
}

// ─── 稳定代号映射 ─────────────────────────────────────────────────────────────

/// `app_id → "App A"` 的稳定映射，**永不外发**。
///
/// 稳定性策略：代号按**首次出现顺序**分配并持久化，**只增不删**。新应用出现时
/// 追加到末尾，已有应用的代号不会变化。这样模型跨多次调用看到的「App A」始终
/// 指向同一个应用。
fn code_for_index(index: usize) -> String {
    // 0→A, 1→B, …, 25→Z, 26→AA, 27→AB, …（双射 base-26，避免第 27 个应用重名）
    let mut n = index + 1;
    let mut chars = Vec::new();
    while n > 0 {
        let r = (n - 1) % 26;
        chars.push((b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    chars.reverse();
    format!("App {}", chars.into_iter().collect::<String>())
}

pub struct AiCodeMap {
    /// 按首次出现顺序持久化的 app_id 列表；下标即代号序号。
    ids: Vec<String>,
    code_by_id: HashMap<String, String>,
    id_by_code: HashMap<String, String>,
    path: PathBuf,
}

impl AiCodeMap {
    pub fn load(path: PathBuf) -> Self {
        let ids: Vec<String> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut m = Self {
            ids,
            code_by_id: HashMap::new(),
            id_by_code: HashMap::new(),
            path,
        };
        m.rebuild();
        m
    }

    fn rebuild(&mut self) {
        self.code_by_id.clear();
        self.id_by_code.clear();
        for (i, id) in self.ids.iter().enumerate() {
            let code = code_for_index(i);
            self.code_by_id.insert(id.clone(), code.clone());
            self.id_by_code.insert(code, id.clone());
        }
    }

    /// 取（或首次分配）某应用的代号。首次出现时追加并持久化，已有代号不变。
    pub fn ensure_code(&mut self, id: &str) -> String {
        if let Some(c) = self.code_by_id.get(id) {
            return c.clone();
        }
        let code = code_for_index(self.ids.len());
        self.ids.push(id.to_string());
        self.code_by_id.insert(id.to_string(), code.clone());
        self.id_by_code.insert(code.clone(), id.to_string());
        self.persist();
        code
    }

    /// 只读查代号（不分配）。
    pub fn code_of(&self, id: &str) -> Option<String> {
        self.code_by_id.get(id).cloned()
    }

    fn persist(&self) {
        if let Ok(json) = serde_json::to_string(&self.ids) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

// ─── 裁剪 ─────────────────────────────────────────────────────────────────────

/// 计算生效 tier：功能所需 tier 与用户天花板取更严者；不足则 None（不发请求）。
/// T3 是叠加在 T2 之上的独立开关，单独判断。
fn effective_tier(required: Tier, ceiling: Tier, t3_enabled: bool) -> Option<Tier> {
    match required {
        Tier::T3 => {
            if ceiling >= Tier::T2 && t3_enabled {
                Some(Tier::T3)
            } else {
                None
            }
        }
        _ => {
            let e = required.min(ceiling);
            if e < required {
                None
            } else {
                Some(e)
            }
        }
    }
}

/// 按 tier 裁剪 payload 的 `apps` 数组（机械执行，见模块头注释）。
fn trim_payload(payload: &Value, tier: Tier, map: &mut AiCodeMap) -> Value {
    let Some(apps) = payload.get("apps").and_then(|v| v.as_array()).cloned() else {
        return payload.clone(); // 无 apps 字段：无应用数据，无需裁剪
    };

    let trimmed: Vec<Value> = apps
        .iter()
        .map(|app| {
            let id = app.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = app.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let windows = app.get("windows").cloned();
            let code = if id.is_empty() {
                "App ?".to_string()
            } else {
                map.ensure_code(id)
            };
            match tier {
                Tier::T1 => json!({ "code": code }),
                Tier::T2 => json!({ "code": code, "name": name }),
                _ => {
                    let mut o = json!({ "code": code, "name": name });
                    if let Some(w) = windows {
                        o["windows"] = w;
                    }
                    o
                }
            }
        })
        .collect();

    let mut out = payload.clone();
    out["apps"] = Value::Array(trimmed);
    out
}

/// 从原始 payload 收集 (code → 真实名) 回映对，用于把响应里的代号换回应用名。
fn collect_code_name_pairs(payload: &Value, map: &AiCodeMap) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    if let Some(apps) = payload.get("apps").and_then(|v| v.as_array()) {
        for app in apps {
            let id = app.get("id").and_then(|v| v.as_str());
            let name = app.get("name").and_then(|v| v.as_str());
            if let (Some(id), Some(name)) = (id, name) {
                if let Some(code) = map.code_of(id) {
                    pairs.push((code, name.to_string()));
                }
            }
        }
    }
    pairs
}

fn resolve_codes(content: &str, pairs: &[(String, String)]) -> String {
    let mut out = content.to_string();
    for (code, name) in pairs {
        out = out.replace(code, name);
    }
    out
}

// ─── 调用结果与单一出口 ───────────────────────────────────────────────────────

/// `call_ai` 返回给前端的结果。`ok=false` 表示未取得 AI 结果，前端应静默降级 T0。
#[derive(Serialize)]
pub struct AiCallResult {
    pub ok: bool,
    pub tier: String,
    pub content: Option<String>,
    /// 降级/失败原因（供日志与小标记，不是错误弹窗）。
    pub reason: Option<String>,
}

fn degraded(reason: impl Into<String>) -> AiCallResult {
    AiCallResult {
        ok: false,
        tier: "T0".into(),
        content: None,
        reason: Some(reason.into()),
    }
}

/// 尽力写一条审计（失败不影响 AI 调用本身）。
fn write_audit(db_path: &Path, entry: AuditEntry) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = audit::insert(&conn, &entry);
    }
}

/// 记一条「未发送」审计（tier 不足 / 未配置 / 功能关闭）。
fn audit_not_sent(db_path: &Path, feature_id: &str, error_kind: &str) {
    write_audit(
        db_path,
        AuditEntry {
            created_at_ms: audit::now_ms(),
            feature_id: feature_id.to_string(),
            tier: "T0".into(),
            sent: false,
            request_json: None,
            response_len: None,
            success: false,
            error_kind: Some(error_kind.to_string()),
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            duration_ms: None,
        },
    );
}

/// 所有 AI 调用的唯一出口。流程：查声明 → 功能开关 → 生效 tier → 裁剪 → 审计 → 发请求。
pub async fn call_ai(
    config: &AiConfigState,
    code_map: &Mutex<AiCodeMap>,
    db_path: &Path,
    feature_id: &str,
    payload: Value,
    json_mode: bool,
) -> AiCallResult {
    let feature_id = feature_id.to_string();

    // 1) 查功能声明
    let Some(decl) = find_feature(&feature_id) else {
        return degraded(format!("未知的 AI 功能：{feature_id}"));
    };

    // 2) 总开关：关闭时一切 AI 调用立即停止，退回 T0（不区分功能）。
    let cfg = config.get();
    if !cfg.enabled {
        audit_not_sent(db_path, &feature_id, "ai_disabled");
        return degraded("AI 功能总开关已关闭");
    }

    // 3) 功能开关
    if !cfg.feature_enabled(&feature_id) {
        audit_not_sent(db_path, &feature_id, "feature_disabled");
        return degraded("该功能已被用户关闭");
    }

    // 4) 生效 tier：取更严者，不足则不发请求
    let Some(effective) = effective_tier(decl.required_tier, cfg.tier, cfg.window_titles_enabled) else {
        let reason = format!("需要 {}，但当前天花板为 {}", decl.required_tier.label(), cfg.tier.label());
        audit_not_sent(db_path, &feature_id, "tier_insufficient");
        return degraded(reason);
    };

    // 5) 未配置 API → 不发请求
    let svc = config.service_config();
    if !svc.is_configured() {
        audit_not_sent(db_path, &feature_id, "not_configured");
        return degraded("尚未配置 API（缺少 Key 或模型）");
    }

    // 6) 裁剪 + 准备回映对（锁仅覆盖同步裁剪，不跨 await）
    let (trimmed, pairs) = {
        let mut map = code_map.lock().unwrap();
        let trimmed = trim_payload(&payload, effective, &mut map);
        let pairs = collect_code_name_pairs(&payload, &map);
        (trimmed, pairs)
    };

    // 7) 组装消息
    let system_prompt = trimmed
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_SYSTEM)
        .to_string();
    let mut user_payload = trimmed.clone();
    if let Value::Object(ref mut m) = user_payload {
        m.remove("system_prompt");
    }
    let user_content = serde_json::to_string(&user_payload).unwrap_or_else(|_| "{}".to_string());
    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: user_content },
    ];

    // 审计用的请求原文（与 provider 实际发出的体一致）
    let request_json = serde_json::to_string(&json!({
        "model": svc.model,
        "messages": messages,
        "response_format": if json_mode { Some(json!({"type": "json_object"})) } else { None },
    }))
    .ok();

    // 8) 发请求
    let start = audit::now_ms();
    let result = provider::chat_completion(&svc, &messages, json_mode).await;
    let duration = audit::now_ms() - start;

    // 9) 记审计 + 回映代号 → 返回
    match result {
        Ok(resp) => {
            let content = resolve_codes(&resp.content, &pairs);
            write_audit(
                db_path,
                AuditEntry {
                    created_at_ms: audit::now_ms(),
                    feature_id,
                    tier: effective.label().into(),
                    sent: true,
                    request_json,
                    response_len: Some(content.chars().count() as i64),
                    success: true,
                    error_kind: None,
                    prompt_tokens: resp.prompt_tokens.map(|v| v as i64),
                    completion_tokens: resp.completion_tokens.map(|v| v as i64),
                    total_tokens: resp.total_tokens.map(|v| v as i64),
                    duration_ms: Some(duration),
                },
            );
            AiCallResult {
                ok: true,
                tier: effective.label().into(),
                content: Some(content),
                reason: None,
            }
        }
        Err(f) => {
            write_audit(
                db_path,
                AuditEntry {
                    created_at_ms: audit::now_ms(),
                    feature_id,
                    tier: effective.label().into(),
                    sent: true,
                    request_json,
                    response_len: None,
                    success: false,
                    error_kind: Some(f.kind.as_str().to_string()),
                    prompt_tokens: None,
                    completion_tokens: None,
                    total_tokens: None,
                    duration_ms: Some(duration),
                },
            );
            degraded(f.message)
        }
    }
}
