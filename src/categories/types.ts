// 分类子系统的前端类型 —— 与 `src-tauri/src/app_classify/*` 的 serde 输出对齐。
// 命令的**顶层参数**用 camelCase（Tauri 默认），结构体字段沿用 snake_case。

/** 一个分类。`id` 创建后永不变更，所有引用都用它，绝不用 `name`。 */
export interface Category {
  id: string;
  name: string;
  /** 分类说明。会逐条进 AI 分类 prompt，是 AI 判断归属的唯一依据。 */
  description: string;
  /** OKLCH 色相角 [0,360)。只存色相，L/C 由主题层给。 */
  hue: number;
  /** 用户手选的完整色值；非空时优先于 hue，且不再参与主题适配。 */
  custom_color: string | null;
  /** 仅「未分类」「其他」为 true。系统分类不可归档、不可删除。 */
  is_system: boolean;
  is_archived: boolean;
  sort_order: number;
}

/** 分类列表的一行：分类本体 + 该分类下的应用数量。 */
export interface CategoryRow extends Category {
  app_count: number;
}

/** 永久删除的影响面（确认弹窗如实显示这三个数）。 */
export interface DeleteImpact {
  app_count: number;
  manual_count: number;
  rule_count: number;
}

/** 批量分类的范围。 */
export type ClassifyScope = "unclassified" | "all_skip_manual" | "all_override";

/** 最近一个可撤销批次。 */
export interface BatchInfo {
  created_at_ms: number;
  scope: string;
  affected: number;
}
