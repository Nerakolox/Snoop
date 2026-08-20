//! AI 子系统暴露给前端的 Tauri 命令。
//!
//! 与顶层 `commands.rs` 一致：命令按需打开自己的 SQLite 连接（短生命周期）。
//! 命名沿用 snake_case，前端 `invoke` 直接以同名调用。

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::ai::audit::{self, AuditEntry, AuditRecord};
use crate::ai::config::AiConfig;
use crate::ai::envelope::{self, FeatureDecl, Tier};
use crate::ai::provider::{self, AiFailure};
use crate::ai::AiState;
use crate::commands::DbPath;

fn open_db(state: &State<'_, DbPath>) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(&state.0).map_err(|e| e.to_string())
}

// ─── 审计日志 ────────────────────────────────────────────────────────────────

/// 取最近 `limit` 条审计记录（默认 100，倒序）。
#[tauri::command]
pub fn query_ai_audit(state: State<'_, DbPath>, limit: Option<i64>) -> Result<Vec<AuditRecord>, String> {
    let conn = open_db(&state)?;
    audit::query(&conn, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

/// 导出全部审计记录（正序 JSON）。
#[tauri::command]
pub fn export_ai_audit(state: State<'_, DbPath>) -> Result<Vec<AuditRecord>, String> {
    let conn = open_db(&state)?;
    audit::export_all(&conn).map_err(|e| e.to_string())
}

/// 清空全部审计记录。
#[tauri::command]
pub fn clear_ai_audit(state: State<'_, DbPath>) -> Result<u64, String> {
    let conn = open_db(&state)?;
    audit::clear(&conn).map_err(|e| e.to_string())
}

// ─── 服务配置 ────────────────────────────────────────────────────────────────

/// 返回给前端的配置视图。Key 永不回传明文，只带一个 `has_key` 布尔。
#[derive(Serialize)]
pub struct AiConfigView {
    pub base_url: String,
    pub model: String,
    pub tier: Tier,
    pub window_titles_enabled: bool,
    pub enabled: bool,
    pub enabled_features: std::collections::HashMap<String, bool>,
    pub has_key: bool,
}

#[tauri::command]
pub fn get_ai_config(state: State<'_, Arc<AiState>>) -> AiConfigView {
    let cfg = state.config.get();
    AiConfigView {
        base_url: cfg.base_url,
        model: cfg.model,
        tier: cfg.tier,
        window_titles_enabled: cfg.window_titles_enabled,
        enabled: cfg.enabled,
        enabled_features: cfg.enabled_features,
        has_key: state.config.has_key(),
    }
}

/// 保存非密配置（base_url / model / tier / T3 开关 / 功能开关）。不含 Key。
#[tauri::command]
pub fn save_ai_config(state: State<'_, Arc<AiState>>, config: AiConfig) {
    state.config.apply(config);
}

/// 设置 / 清除 API Key。传 `null` 或空串清除。
#[tauri::command]
pub fn set_ai_api_key(state: State<'_, Arc<AiState>>, key: Option<String>) -> Result<(), String> {
    state.config.set_api_key(key)
}

/// 全部 AI 功能的声明（设置页展示可用/锁定状态）。
#[tauri::command]
pub fn get_ai_features() -> Vec<FeatureDecl> {
    envelope::FEATURE_REGISTRY.to_vec()
}

/// 测试连接的返回。
#[derive(Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

/// 「测试连接」：发最小请求验证配置，并把结果记进审计（用户立刻能在发送记录里看到）。
#[tauri::command]
pub async fn test_ai_connection(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
) -> Result<TestResult, String> {
    // 先取出自有的可 Send 数据，结束对 State 的借用，再跨 await 发请求。
    let svc = state.config.service_config();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    let result = provider::test_connection(&svc).await;
    let (ok, message) = match &result {
        Ok(()) => (true, "连接成功".to_string()),
        Err(f) => (false, f.message.clone()),
    };
    record_test_audit(&db_path, &svc.model, ok, result.as_ref().err());
    Ok(TestResult { ok, message })
}

/// 记一条「测试连接」审计。tier 记 T0（ping 不带任何应用数据）。
fn record_test_audit(db_path: &Path, model: &str, ok: bool, err: Option<&AiFailure>) {
    let request_json = serde_json::to_string(&serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }))
    .ok();
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = audit::insert(
            &conn,
            &AuditEntry {
                created_at_ms: audit::now_ms(),
                feature_id: "ai.test-connection".into(),
                tier: "T0".into(),
                sent: true,
                request_json,
                response_len: None,
                success: ok,
                error_kind: err.map(|f| f.kind.as_str().to_string()),
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
                duration_ms: None,
            },
        );
    }
}

// ─── 单一出口 ────────────────────────────────────────────────────────────────

/// 所有 AI 功能的唯一调用入口。裁剪 / 审计 / 降级都在 `envelope::call_ai` 里完成。
#[tauri::command]
pub async fn call_ai(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
    feature_id: String,
    payload: Value,
    json_mode: Option<bool>,
) -> Result<envelope::AiCallResult, String> {
    let ai = state.inner().clone();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    // 信封层永不「报错」，失败一律以 ok=false 的 AiCallResult 表达（供前端降级）。
    Ok(
        envelope::call_ai(
            &ai.config,
            &ai.code_map,
            &db_path,
            &feature_id,
            payload,
            json_mode.unwrap_or(false),
        )
        .await,
    )
}
