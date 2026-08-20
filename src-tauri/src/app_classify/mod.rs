//! 应用分类（F4）—— 给每个应用打类别标签，供概览/报告/规律页消费。
//!
//! 分类来源三种，优先级**硬规则** `manual > builtin > ai`（在 [`store`] 的写入口
//! 强制，不依赖调用方自觉）：
//!   - `manual` 用户手动指定，一旦改过，任何自动分类（builtin/ai）都不得覆盖。
//!   - `builtin` 内置规则表命中（见 [`builtin`]），离线即可用，不消耗 AI 调用。
//!   - `ai` 走批次 1 信封构造器（`featureId = ai.app-classify`）批量分类。

// 分类 API 由 Task 2/3/4 分批接入消费方，落库前先放行未用告警。
#![allow(dead_code)]

pub mod builtin;
pub mod commands;
pub mod engine;
pub mod store;

use serde::{Deserialize, Serialize};

/// 应用分类枚举。**固定 11 类，到顶**——历史数据都按它存，改一次代价极高。
///
/// 声明顺序即规范展示顺序，新增只允许追加到 `Other` 之前。
/// **这是最后一次扩展**：11 类封顶，后续再有归不进去的一律进 `Other`，
/// 或改做二级分类，不再加新枚举值。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Development,
    Communication,
    Browsing,
    Entertainment,
    Design,
    Document,
    System,
    /// 远程控制（ToDesk / 向日葵 / RDP / Parsec / TeamViewer / AnyDesk）。
    ///
    /// 定位：这是一段**有独立意义的活动模式**——你在「别的机器上干活」，
    /// 而不是本地开发/沟通的子集。单独成类后，报告才能把「远程工作时间」
    /// 与本地活动分开看待。
    Remote,
    /// 下载工具（IDM / 迅雷 / qBittorrent 等）。
    ///
    /// 定位：它是**伪活跃**——程序挂在前台但人可能不在，前台时长会严重虚高。
    /// 单独成类之后，统计/报告才能选择性地排除或折算这一段。
    Download,
    /// AI 助手（ChatGPT / Claude / Gemini / Copilot 等**独立桌面客户端**）。
    ///
    /// 定位：不并入 development——Snoop 的用户本身就是开发者，把「和模型聊天」混进
    /// 「开发」会让开发时长虚高、报告失真。两者性质差别足够大，且这类应用的时长
    /// 占比未来只会上升，现在混进去以后要拆就得重算历史数据。
    ///
    /// 边界：只有**独立客户端**算；编辑器里的 Copilot 插件等不算（那是宿主编辑器）。
    AiAssistant,
    Other,
}

impl Category {
    /// 稳定标识（snake_case），用于存储、AI 返回校验、前端序列化。
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Development => "development",
            Category::Communication => "communication",
            Category::Browsing => "browsing",
            Category::Entertainment => "entertainment",
            Category::Design => "design",
            Category::Document => "document",
            Category::System => "system",
            Category::Remote => "remote",
            Category::Download => "download",
            Category::AiAssistant => "ai_assistant",
            Category::Other => "other",
        }
    }

    /// 从字符串解析（AI 返回校验、DB 读出用）。未知值返回 None。
    pub fn from_str(s: &str) -> Option<Category> {
        Some(match s {
            "development" => Category::Development,
            "communication" => Category::Communication,
            "browsing" => Category::Browsing,
            "entertainment" => Category::Entertainment,
            "design" => Category::Design,
            "document" => Category::Document,
            "system" => Category::System,
            "remote" => Category::Remote,
            "download" => Category::Download,
            "ai_assistant" => Category::AiAssistant,
            "other" => Category::Other,
            _ => return None,
        })
    }

    /// 中文显示名（设置页 / 占比图用）。
    pub fn label(self) -> &'static str {
        match self {
            Category::Development => "开发",
            Category::Communication => "沟通",
            Category::Browsing => "浏览",
            Category::Entertainment => "娱乐",
            Category::Design => "设计",
            Category::Document => "文档",
            Category::System => "系统",
            Category::Remote => "远程控制",
            Category::Download => "下载工具",
            Category::AiAssistant => "AI 助手",
            Category::Other => "其他",
        }
    }

    /// 全部类别，规范顺序。
    pub const ALL: [Category; 11] = [
        Category::Development,
        Category::Communication,
        Category::Browsing,
        Category::Entertainment,
        Category::Design,
        Category::Document,
        Category::System,
        Category::Remote,
        Category::Download,
        Category::AiAssistant,
        Category::Other,
    ];
}
