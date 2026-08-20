//! OpenAI v1 兼容的 chat completions 客户端（Task 1）。
//!
//! 只用 `/chat/completions` 一个端点，协议保持最简，不引入任何 AI SDK。
//! 只依赖项目已有的 `reqwest`(rustls) + `serde_json`。
//!
//! 错误分类是这一层最重要的产物：上层（信封层 / 设置页）需要据此决定
//! 是「静默降级到本地模板」还是「明确提示用户哪里配错了」。分类粒度与
//! 规范一一对应：未配置 / 网络失败 / 认证失败 / 限流 / 余额不足 / 模型不存在 / 其他。

use serde::Serialize;
use std::time::Duration;

/// 默认服务地址（OpenAI v1）。用户可换成自建/DeepSeek 等兼容端点。
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// 请求超时（秒）。网络失败（含超时）会触发一次重试。
pub const TIMEOUT_SECS: u64 = 30;
/// 单次重试的固定退避（毫秒）。只对网络错误和 5xx 重试，4xx 一律不重试。
const RETRY_BACKOFF_MS: u64 = 800;

/// 发起一次调用所需的运行期配置（不含 tier，那是信封层的概念）。
#[derive(Clone, Debug)]
pub struct AiServiceConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl AiServiceConfig {
    /// 「已配置」= 有 key 且有 model。base_url 缺省走默认值。
    pub fn is_configured(&self) -> bool {
        !self.api_key.trim().is_empty() && !self.model.trim().is_empty()
    }

    fn endpoint(&self) -> String {
        let base = if self.base_url.trim().is_empty() {
            DEFAULT_BASE_URL
        } else {
            self.base_url.trim()
        };
        format!("{}/chat/completions", base.trim_end_matches('/'))
    }
}

/// 一条 chat 消息。信封层负责把裁剪后的 payload 装进 messages。
#[derive(Clone, Debug, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 成功响应里上层关心的部分：正文 + token 用量（审计日志要用）。
#[derive(Clone, Debug)]
pub struct ChatResponse {
    pub content: String,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

/// 错误分类。`kind` 用 snake_case 序列化，前端据此分支（降级 or 提示）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorKind {
    NotConfigured,
    Network,
    Auth,
    RateLimit,
    InsufficientBalance,
    ModelNotFound,
    Other,
}

/// 对外返回的错误：分类 + 面向用户的详情文案。
#[derive(Clone, Debug, Serialize)]
pub struct AiFailure {
    pub kind: AiErrorKind,
    pub message: String,
}

impl AiFailure {
    fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        AiFailure { kind, message: message.into() }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(self.kind, AiErrorKind::Network)
    }
}

impl AiErrorKind {
    /// snake_case 稳定标识，审计日志 / 前端分支共用。
    pub fn as_str(self) -> &'static str {
        match self {
            AiErrorKind::NotConfigured => "not_configured",
            AiErrorKind::Network => "network",
            AiErrorKind::Auth => "auth",
            AiErrorKind::RateLimit => "rate_limit",
            AiErrorKind::InsufficientBalance => "insufficient_balance",
            AiErrorKind::ModelNotFound => "model_not_found",
            AiErrorKind::Other => "other",
        }
    }
}

pub type AiResult<T> = Result<T, AiFailure>;

/// 把 HTTP 状态码 + 响应体文本归到某一类错误。
///
/// 判定顺序很重要：先看状态码做粗分类，再扫 body 里供应商特有的措辞做细分类。
/// 不同供应商的余额/模型错误码五花八门（402 / 404 / 400 + 特定文案），
/// 所以 body 关键词兜底是必须的，不能只靠状态码。
fn classify_http(status: u16, body: &str) -> AiFailure {
    let b = body.to_lowercase();
    match status {
        401 | 403 => AiFailure::new(AiErrorKind::Auth, format!("认证失败（HTTP {status}）：请检查 API Key 是否正确")),
        404 => AiFailure::new(
            AiErrorKind::ModelNotFound,
            format!("模型不存在（HTTP {status}）：请检查 model 名称，或服务地址是否为 OpenAI 兼容端点"),
        ),
        429 => {
            if b.contains("insufficient") || b.contains("quota") || b.contains("balance") {
                AiFailure::new(AiErrorKind::InsufficientBalance, "额度/余额不足：请到服务商处充值或更换 Key")
            } else {
                AiFailure::new(AiErrorKind::RateLimit, "触发限流（HTTP 429）：请求过于频繁，请稍后再试")
            }
        }
        // 有些供应商用 402 Payment Required 或 400 + 文案表达余额不足
        402 => AiFailure::new(AiErrorKind::InsufficientBalance, "余额不足：请到服务商处充值"),
        // 400 也可能是「模型不存在」，扫文案兜底
        400 if b.contains("model") && (b.contains("not found") || b.contains("not exist") || b.contains("does not exist")) => {
            AiFailure::new(AiErrorKind::ModelNotFound, "模型不存在：请检查 model 名称")
        }
        400 if b.contains("insufficient") || b.contains("quota") || b.contains("balance") || b.contains("billing") => {
            AiFailure::new(AiErrorKind::InsufficientBalance, "额度/余额不足：请到服务商处充值或更换 Key")
        }
        500..=599 => AiFailure::new(AiErrorKind::Other, format!("服务端错误（HTTP {status}），已自动重试仍失败")),
        _ => AiFailure::new(AiErrorKind::Other, format!("请求失败（HTTP {status}）：{}", body)),
    }
}

/// 读取响应体（限长，避免把超大错误页全吞进内存）。
async fn read_body(resp: reqwest::Response) -> String {
    resp.text().await.unwrap_or_default()
}

/// 发一次 chat 请求（含一次重试）。返回内容 + token 用量。
///
/// `messages` 是**已经裁剪到位的**最终消息；本层不再做任何数据加工，
/// 只负责协议与错误分类。
pub async fn chat_completion(
    cfg: &AiServiceConfig,
    messages: &[ChatMessage],
    json_mode: bool,
) -> AiResult<ChatResponse> {
    if !cfg.is_configured() {
        return Err(AiFailure::new(
            AiErrorKind::NotConfigured,
            "尚未配置 API：请先在设置里填写 API Key 与模型",
        ));
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        match send_once(cfg, messages, json_mode).await {
            Ok(r) => return Ok(r),
            Err(e) if e.is_retryable() && attempt <= 1 => {
                tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS)).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

/// 单次发送（不含重试）。网络层错误（连接失败/超时）在这里归为 `Network`。
async fn send_once(
    cfg: &AiServiceConfig,
    messages: &[ChatMessage],
    json_mode: bool,
) -> AiResult<ChatResponse> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AiFailure::new(AiErrorKind::Network, format!("构造 HTTP 客户端失败：{e}")))?;

    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
    });
    if json_mode {
        // JSON 模式：要求结构化输出，后续结构化功能依赖它。
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }

    let resp = match client
        .post(cfg.endpoint())
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        // 连接失败 / 超时：reqwest 的错误里能区分超时（is_timeout）
        Err(e) => {
            let msg = if e.is_timeout() {
                "请求超时：请检查网络或服务端响应速度".to_string()
            } else {
                format!("网络请求失败：{e}")
            };
            return Err(AiFailure::new(AiErrorKind::Network, msg));
        }
    };

    let status = resp.status();
    let status_code = status.as_u16();
    let text = read_body(resp).await;

    if !status.is_success() {
        return Err(classify_http(status_code, &text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AiFailure::new(AiErrorKind::Other, format!("响应不是合法 JSON：{e}")))?;

    let mut content = parsed
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if content.is_empty() {
        // 兼容某些供应商把结果放在 choices[0].text 的写法
        let alt = parsed
            .pointer("/choices/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if alt.is_empty() {
            return Err(AiFailure::new(AiErrorKind::Other, "响应里没有可用的正文（choices[0].message.content 为空）"));
        }
        content = alt.to_string();
    }

    let usage = &parsed["usage"];
    let get_u64 = |key: &str| usage.get(key).and_then(|v| v.as_u64());

    Ok(ChatResponse {
        content,
        prompt_tokens: get_u64("prompt_tokens"),
        completion_tokens: get_u64("completion_tokens"),
        total_tokens: get_u64("total_tokens"),
    })
}

/// 「测试连接」：发一个最小请求验证配置可用，失败时返回具体原因。
///
/// 用 `max_tokens: 1` 把开销压到最小。成功只代表「配置能通」，
/// 不代表一定能处理长输入——那是后续功能自己的事。
pub async fn test_connection(cfg: &AiServiceConfig) -> AiResult<()> {
    if !cfg.is_configured() {
        return Err(AiFailure::new(
            AiErrorKind::NotConfigured,
            "尚未配置 API：请先填写 API Key 与模型",
        ));
    }

    let messages = [ChatMessage {
        role: "user".to_string(),
        content: "ping".to_string(),
    }];

    // 测试连接走最小请求体：messages + max_tokens 压小，不走 JSON 模式。
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AiFailure::new(AiErrorKind::Network, format!("构造 HTTP 客户端失败：{e}")))?;

    let body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "max_tokens": 1,
    });

    let resp = match client
        .post(cfg.endpoint())
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "请求超时：请检查网络或服务端响应速度".to_string()
            } else {
                format!("网络请求失败：{e}")
            };
            return Err(AiFailure::new(AiErrorKind::Network, msg));
        }
    };

    let status = resp.status();
    let text = read_body(resp).await;

    if status.is_success() {
        Ok(())
    } else {
        Err(classify_http(status.as_u16(), &text))
    }
}
