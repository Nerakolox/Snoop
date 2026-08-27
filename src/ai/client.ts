// AI 命令的薄封装 —— 所有调用都走后端 Rust 侧，前端用 fetch 直接打不出去
// （OpenAI/DeepSeek 不发 CORS 头，且会把 Key 暴露给 JS），所以统一 invoke。

import { invoke } from "@tauri-apps/api/core";
import type {
  AiCallResult,
  AiConfig,
  AiConfigView,
  AppCategoryRow,
  AuditRecord,
  CategoryShare,
  ClassifyOutcome,
  ClassifyStatus,
  FeatureDecl,
  TestResult,
} from "./types";
import type { ClassifyScope } from "../categories/types";

export function getAiConfig(): Promise<AiConfigView> {
  return invoke<AiConfigView>("get_ai_config");
}

export function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export function setAiApiKey(key: string | null): Promise<void> {
  return invoke("set_ai_api_key", { key });
}

export function getAiFeatures(): Promise<FeatureDecl[]> {
  return invoke<FeatureDecl[]>("get_ai_features");
}

export function testAiConnection(): Promise<TestResult> {
  return invoke<TestResult>("test_ai_connection");
}

export function queryAiAudit(limit = 100): Promise<AuditRecord[]> {
  return invoke<AuditRecord[]>("query_ai_audit", { limit });
}

export function exportAiAudit(): Promise<AuditRecord[]> {
  return invoke<AuditRecord[]>("export_ai_audit");
}

export function clearAiAudit(): Promise<number> {
  return invoke<number>("clear_ai_audit");
}

/** 唯一调用出口。featureId 顶层参数走 camelCase（Tauri 默认）。 */
export function callAi(
  featureId: string,
  payload: unknown,
  jsonMode = false,
): Promise<AiCallResult> {
  return invoke<AiCallResult>("call_ai", { featureId, payload, jsonMode });
}

/** 触发应用分类。force=true 对应「立即分类」，跳过攒批阈值。
 *  scope 见 ClassifyScope，缺省「仅未分类」。 */
export function classifyApps(
  force = false,
  scope: ClassifyScope = "unclassified",
): Promise<ClassifyOutcome> {
  return invoke<ClassifyOutcome>("classify_apps", { force, scope });
}

/** 撤销最近一次批量分类，完整还原到执行前（含被覆盖掉的手动覆盖）。返回还原的应用数。 */
export function undoClassifyBatch(): Promise<number> {
  return invoke<number>("undo_classify_batch");
}

/** 应用分类队列状态。 */
export function getClassifyStatus(): Promise<ClassifyStatus> {
  return invoke<ClassifyStatus>("get_classify_status");
}

/** 列出全部应用及其生效分类。 */
export function listClassifiedApps(): Promise<AppCategoryRow[]> {
  return invoke<AppCategoryRow[]>("list_classified_apps");
}

/** 手动指定某应用分类（source=manual）。 */
export function setAppCategory(
  appId: string,
  appName: string,
  category: string,
): Promise<AppCategoryRow> {
  return invoke<AppCategoryRow>("set_app_category", { appId, appName, category });
}

/** 重置某应用为自动分类。 */
export function resetAppCategory(appId: string, appName: string): Promise<AppCategoryRow> {
  return invoke<AppCategoryRow>("reset_app_category", { appId, appName });
}

/** 聚合某时间范围内各分类的活跃时长（有输入，未分类计入 other），按时长降序。 */
export function getCategoryBreakdown(startMs: number, endMs: number): Promise<CategoryShare[]> {
  return invoke<CategoryShare[]>("get_category_breakdown", { startMs, endMs });
}
