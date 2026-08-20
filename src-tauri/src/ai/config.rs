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
    api_key: Mutex<Option<String>>,
    config_path: PathBuf,
    key_path: PathBuf,
}

impl AiConfigState {
    pub fn load(config_path: PathBuf, key_path: PathBuf) -> Self {
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        // 密钥文件解不开（换用户 / 损坏）时按未配置处理，不阻塞启动。
        let api_key = secure::get_secret(&key_path).ok().flatten();
        AiConfigState {
            config: Mutex::new(config),
            api_key: Mutex::new(api_key),
            config_path,
            key_path,
        }
    }

    pub fn get(&self) -> AiConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn has_key(&self) -> bool {
        self.api_key.lock().unwrap().is_some()
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
                *self.api_key.lock().unwrap() = Some(k.trim().to_string());
            }
            _ => {
                secure::delete_secret(&self.key_path)?;
                *self.api_key.lock().unwrap() = None;
            }
        }
        Ok(())
    }

    /// 拼出发请求所需的运行期配置（含解密后的 Key）。
    pub fn service_config(&self) -> AiServiceConfig {
        let cfg = self.config.lock().unwrap();
        let key = self.api_key.lock().unwrap();
        AiServiceConfig {
            base_url: cfg.base_url.clone(),
            api_key: key.clone().unwrap_or_default(),
            model: cfg.model.clone(),
        }
    }
}
