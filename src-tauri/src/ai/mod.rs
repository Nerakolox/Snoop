//! AI 基础设施接入层。
//!
//! 本模块只承载「接入 / 隐私控制 / 审计」三层，不实现任何面向用户的功能：
//! 后续所有 AI 功能都通过 [`envelope::call_ai`] 这一单一出口发请求，
//! 由此保证「用户能看见、能控制、能审计什么数据离开了本机」。

pub mod audit;
pub mod commands;
pub mod provider;
