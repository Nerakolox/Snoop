// AI 子系统前端类型 —— 与后端 `src-tauri/src/ai/*` 的 serde 序列化对齐。
// 注意：命令的**顶层参数**用 camelCase（Tauri 默认），嵌套结构体字段沿用
// snake_case（后端未加 rename_all）。

export type Tier = "T0" | "T1" | "T2" | "T3";

/** 一个 AI 功能的声明（来自 get_ai_features）。 */
export interface FeatureDecl {
  id: string;
  required_tier: Tier;
  label: string;
  description: string;
}

/** 非密配置。字段名与后端 AiConfig 的 serde 输出一致（snake_case）。 */
export interface AiConfig {
  base_url: string;
  model: string;
  tier: Tier;
  window_titles_enabled: boolean;
  enabled_features: Record<string, boolean>;
}

/** get_ai_config 的返回：非密配置 + 是否有 key（Key 明文永不回传）。 */
export interface AiConfigView extends AiConfig {
  has_key: boolean;
}

/** 测试连接返回。 */
export interface TestResult {
  ok: boolean;
  message: string;
}

/** 一条审计记录。 */
export interface AuditRecord {
  id: number;
  created_at_ms: number;
  feature_id: string;
  tier: string;
  sent: boolean;
  request_json: string | null;
  response_len: number | null;
  success: boolean;
  error_kind: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
}

/** call_ai 的返回。ok=false 表示未取得 AI 结果（前端应静默降级）。 */
export interface AiCallResult {
  ok: boolean;
  tier: string;
  content: string | null;
  reason: string | null;
}

/** classify_apps 的返回。status 取值见后端 ClassifyOutcome。 */
export interface ClassifyOutcome {
  status: string;
  queue_len: number;
  classified: number;
  message: string;
}

/** get_classify_status 的返回。 */
export interface ClassifyStatus {
  queue_len: number;
  last_classified_at_ms: number | null;
  running: boolean;
}

/** 设置页分类列表的一行（list_classified_apps 返回）。 */
export interface AppCategoryRow {
  app_id: string;
  app_name: string;
  category: string | null;
  source: string | null;
  confidence: number | null;
  classified_at_ms: number | null;
  needs_confirmation: boolean;
}

/** 分类占比的一格（get_category_breakdown 返回）。 */
export interface CategoryShare {
  category: string;
  duration_ms: number;
}
