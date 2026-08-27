//! 应用分类（F4）—— 给每个应用打类别标签，供概览/报告/规律页消费。
//!
//! 分类来源三种，优先级**硬规则** `manual > builtin > ai`（在 [`store`] 的写入口
//! 强制，不依赖调用方自觉）：
//!   - `manual` 用户手动指定，一旦改过，任何自动分类（builtin/ai）都不得覆盖。
//!   - `builtin` 内置规则表命中（见 [`builtin`]），离线即可用，不消耗 AI 调用。
//!   - `ai` 走批次 1 信封构造器（`featureId = ai.app-classify`）批量分类。
//!
//! **分类本身是数据，不是枚举。** 全部分类存在 `categories` 表里，用户可增删改。
//! 一切引用（`app_categories.category`、`builtin_rules.category_id`、报告 JSON）
//! 都用分类 **id**，绝不用名称——名称是可改的显示名，改名不该动历史数据。

// 分类 API 由各消费方分批接入，落库前先放行未用告警。
#![allow(dead_code)]

pub mod builtin;
pub mod catalog;
pub mod commands;
pub mod engine;
pub mod store;

/// 「未分类」的分类 id。**结构依赖**：永久删除一个分类时，其下应用落到这里。
///
/// 注意存储约定：未分类在 `app_categories` 里的表示是**没有行**，而不是写一行
/// `category = 'uncategorized'`。这条记录只为展示层提供显示名与颜色。
pub const ID_UNCATEGORIZED: &str = "uncategorized";

/// 「其他」的分类 id。**结构依赖**：归档一个分类后，其下应用在展示层并入这里。
pub const ID_OTHER: &str = "other";

/// 未归档分类数量上限（不含已归档）。超出时新建入口置灰。
pub const MAX_ACTIVE_CATEGORIES: usize = 24;

/// 一条内置分类的种子数据。迁移时写入 `categories` 表，此后由用户接管。
pub struct SeedCategory {
    pub id: &'static str,
    pub name: &'static str,
    /// 分类说明。**这是 AI 判断归属的唯一依据**——分类 prompt 逐条列出它。
    pub description: &'static str,
    /// OKLCH 色相角。由 `scripts/seed-hues.mjs` 从 `tokens.css` 的实际 token 值
    /// 算出（避开强度色与品牌色禁区后均匀铺满允许弧），不是随手填的。
    pub hue: f64,
    pub is_system: bool,
}

/// 内置分类种子。**声明顺序即初始 `sort_order`**。
///
/// `description` 取自改造前 `engine.rs` 里那段硬编码分类 prompt 的说明文字，
/// 保证迁移后 AI 的判断依据与改造前逐字一致。
pub static SEED_CATEGORIES: &[SeedCategory] = &[
    SeedCategory {
        id: "development",
        name: "开发",
        description: "IDE、终端、版本控制、数据库",
        hue: 99.9,
        is_system: false,
    },
    SeedCategory {
        id: "communication",
        name: "沟通",
        description: "微信、QQ、邮件、Slack、会议",
        hue: 121.7,
        is_system: false,
    },
    SeedCategory {
        id: "browsing",
        name: "浏览",
        description: "浏览器",
        hue: 143.5,
        is_system: false,
    },
    SeedCategory {
        id: "entertainment",
        name: "娱乐",
        description: "游戏、视频播放器、音乐",
        hue: 165.3,
        is_system: false,
    },
    SeedCategory {
        id: "design",
        name: "设计",
        description: "Figma、Photoshop、剪辑、录屏",
        hue: 187.1,
        is_system: false,
    },
    SeedCategory {
        id: "document",
        name: "文档",
        description: "Office、笔记、PDF",
        hue: 208.9,
        is_system: false,
    },
    SeedCategory {
        id: "system",
        name: "系统",
        description: "资源管理器、任务管理器、系统工具、代理",
        hue: 230.7,
        is_system: false,
    },
    SeedCategory {
        id: "remote",
        name: "远程控制",
        description: "ToDesk、向日葵、RDP、TeamViewer",
        hue: 252.5,
        is_system: false,
    },
    SeedCategory {
        id: "download",
        name: "下载工具",
        description: "IDM、迅雷、BT",
        hue: 307.9,
        is_system: false,
    },
    SeedCategory {
        id: "ai_assistant",
        name: "AI 助手",
        description: "ChatGPT、Claude、Gemini、Copilot 等独立桌面客户端；编辑器/IDE 里的 Copilot 插件不算，那是宿主开发工具",
        hue: 329.7,
        is_system: false,
    },
    SeedCategory {
        id: ID_OTHER,
        name: "其他",
        description: "无法归入以上任何一类",
        hue: 351.5,
        is_system: true,
    },
    SeedCategory {
        id: ID_UNCATEGORIZED,
        name: "未分类",
        description: "尚未归类的应用。此分类不参与 AI 分配，不会出现在分类 prompt 里。",
        hue: 13.3,
        is_system: true,
    },
];
