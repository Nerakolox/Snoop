//! 应用分类暴露给前端的 Tauri 命令。

use std::sync::Arc;

use tauri::State;

use crate::ai::AiState;
use crate::app_classify::engine::{self, ClassifyOutcome, ClassifyStatus};
use crate::commands::DbPath;

/// 触发一次分类（`force=true` 对应「立即分类」，跳过攒批阈值）。
#[tauri::command]
pub async fn classify_apps(
    state: State<'_, Arc<AiState>>,
    db: State<'_, DbPath>,
    force: Option<bool>,
) -> Result<ClassifyOutcome, String> {
    let ai = state.inner().clone();
    let db_path = db.0.clone();
    drop(state);
    drop(db);

    Ok(engine::classify_if_due(&ai.config, &ai.code_map, &db_path, force.unwrap_or(false)).await)
}

/// 分类队列状态：待分类数量 / 上次分类时间 / 是否正在运行。
#[tauri::command]
pub fn get_classify_status(db: State<'_, DbPath>) -> Result<ClassifyStatus, String> {
    Ok(engine::classify_status(&db.0))
}
