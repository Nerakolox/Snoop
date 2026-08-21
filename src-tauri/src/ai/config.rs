//! AI 服务配置（非密部分）+ 运行期状态。
//!
//! 非密配置（base_url / model / tier / T3 开关 / 功能开关）落 `ai_config.json`；
//! API Key 单独走 [`super::secure`] 存到 OS 凭证（DPAPI / Keychain），**绝不进**
//! 这个明文 JSON。两者文件分离，导出/清空配置时不会碰到密钥文件。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::ai::envelope::Tier;
use crate::ai::provider::{AiServiceConfig, DEFAULT_BASE_URL};
use crate::ai::secure;

#[derive(Serialize, Deserialize, Clone)]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
    pub tier: Tier,
    pub window_titles_enabled: bool,
    /// 「AI 功能」总开关：关闭时一切 AI 调用在信封层直接退回 T0。
    /// `#[serde(default)]` 保证老配置文件（无此字段）缺省关闭，而不是
    /// 反序列化失败 → 整体回落 default，把已配置的 base_url/model/tier 清空。
    #[serde(default)]
    pub enabled: bool,
    /// 功能开关：feature_id → 是否启用。缺省视为启用（空 map = 全开）。
    pub enabled_features: HashMap<String, bool>,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: String::new(),
            tier: Tier::T1,
            window_titles_enabled: false,
            enabled: false,
            enabled_features: HashMap::new(),
        }
    }
}

impl AiConfig {
    /// 功能是否被用户开启（缺省开启）。
    pub fn feature_enabled(&self, id: &str) -> bool {
        self.enabled_features.get(id).copied().unwrap_or(true)
    }
}

pub struct AiConfigState {
    config: Mutex<AiConfig>,
    /// 解密后的 Key，仅内存持有，从不落明文盘。
    /// 外层 `Option` 表示「是否已从 OS 凭证库读过」：`None` = 尚未读（懒加载），
    /// `Some(None)` = 已读、无 Key，`Some(Some(k))` = 已读、有 Key。
    /// 懒加载的目的：setup 阶段不触碰 Security.framework（macOS），避免启动瞬间
    /// 与其它线程在 objc 运行时抢首次类实现 → 崩溃；也避免 Keychain 弹授权框卡死启动。
    api_key: Mutex<Option<Option<String>>>,
    config_path: PathBuf,
    key_path: PathBuf,
}

impl AiConfigState {
    pub fn load(config_path: PathBuf, key_path: PathBuf) -> Self {
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        // Key 懒加载：这里不读 OS 凭证库，首次真正需要时（发起 AI 调用 / 前端查状态）
        // 才由 `ensure_key_loaded` 读取并缓存。setup 阶段绝不能碰 Security.framework。
        AiConfigState {
            config: Mutex::new(config),
            api_key: Mutex::new(None),
            config_path,
            key_path,
        }
    }

    pub fn get(&self) -> AiConfig {
        self.config.lock().unwrap().clone()
    }

    /// 惰性读取并缓存 Key。首次调用触发一次 OS 凭证库访问，之后命中内存缓存。
    /// 读不到 / 解不开（换用户 / 损坏）一律按无 Key 处理，不阻塞调用方。
    fn ensure_key_loaded(&self) -> Option<String> {
        let mut slot = self.api_key.lock().unwrap();
        match &*slot {
            Some(cached) => cached.clone(),
            None => {
                let loaded = secure::get_secret(&self.key_path).ok().flatten();
                let out = loaded.clone();
                *slot = Some(loaded);
                out
            }
        }
    }

    pub fn has_key(&self) -> bool {
        self.ensure_key_loaded().is_some()
    }

    pub fn apply(&self, cfg: AiConfig) {
        *self.config.lock().unwrap() = cfg.clone();
        if let Ok(json) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(&self.config_path, json);
        }
    }

    /// 设置或清除 Key。`None` / 空串 = 清除。
    pub fn set_api_key(&self, key: Option<String>) -> Result<(), String> {
        match key {
            Some(k) if !k.trim().is_empty() => {
                secure::set_secret(&self.key_path, k.trim())?;
                *self.api_key.lock().unwrap() = Some(Some(k.trim().to_string()));
            }
            _ => {
                secure::delete_secret(&self.key_path)?;
                *self.api_key.lock().unwrap() = Some(None);
            }
        }
        Ok(())
    }

    /// 拼出发请求所需的运行期配置（含解密后的 Key）。
    pub fn service_config(&self) -> AiServiceConfig {
        let cfg = self.config.lock().unwrap().clone();
        let key = self.ensure_key_loaded().unwrap_or_default();
        AiServiceConfig {
            base_url: cfg.base_url,
            api_key: key,
            model: cfg.model,
        }
    }
}
