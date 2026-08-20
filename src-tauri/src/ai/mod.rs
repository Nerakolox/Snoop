//! AI 基础设施接入层。
//!
//! 本模块只承载「接入 / 隐私控制 / 审计」三层，不实现任何面向用户的功能：
//! 后续所有 AI 功能都通过 [`envelope::call_ai`] 这一单一出口发请求，
//! 由此保证「用户能看见、能控制、能审计什么数据离开了本机」。

pub mod audit;
pub mod commands;
pub mod config;
pub mod envelope;
pub mod provider;
pub mod secure;

use std::path::PathBuf;
use std::sync::Mutex;

use config::AiConfigState;
use envelope::AiCodeMap;

/// 托管给 Tauri 的 AI 运行期状态。
///
/// 以 `Arc` 包一层再 `app.manage`，让异步命令能在 `await` 前后安全地持有它
/// （`State<'_, T>` 内含借用、非 Send，不能跨 await）。
pub struct AiState {
    /// 服务配置 + 内存中的 Key。
    pub config: AiConfigState,
    /// `app_id → "App A"` 稳定代号映射（裁剪时加锁访问）。
    pub code_map: Mutex<AiCodeMap>,
}

impl AiState {
    pub fn load(config_path: PathBuf, key_path: PathBuf, code_map_path: PathBuf) -> Self {
        AiState {
            config: AiConfigState::load(config_path, key_path),
            code_map: Mutex::new(AiCodeMap::load(code_map_path)),
        }
    }
}
