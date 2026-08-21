// 应用分类的前端元数据 —— 类别值 / 中文名。
// 与后端 `Category` 枚举严格对齐（as_str / label）。改枚举必须同步这里。

export interface CategoryMeta {
  value: string;
  label: string;
}

// 分类是离散互斥的类别，但**占比可视化不再给每个类别一个固定色相**：
// 颜色只编码「占比排名」（排名越靠前越深 / 越亮），类别身份交给文字（图例 / tooltip）。
// 这与时间线「颜色编码强度、身份交给行头」是同一套逻辑，整站一致。
export const CATEGORIES: CategoryMeta[] = [
  { value: "development", label: "开发" },
  { value: "communication", label: "沟通" },
  { value: "browsing", label: "浏览" },
  { value: "entertainment", label: "娱乐" },
  { value: "design", label: "设计" },
  { value: "document", label: "文档" },
  { value: "system", label: "系统" },
  { value: "remote", label: "远程控制" },
  { value: "download", label: "下载工具" },
  { value: "ai_assistant", label: "AI 助手" },
  { value: "other", label: "其他" },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

/**
 * 分类占比的「品牌紫深浅阶」—— 浅色态的 hex。
 * 排名 0 = 占比最高 → 最深；越靠后越浅；超出的都用最后一阶。
 * 必须与 `tokens.css` 里的 `--share-1..7`（`:root` / `[data-theme="light"]`）保持一致。
 */
export const SHARE_RAMP_LIGHT: readonly string[] = [
  "#4F3DCE", // 1 占比最高 → 最深
  "#5B48D4",
  "#6D5AE6", // 品牌主紫（中间档）
  "#8578EE",
  "#A49BF4",
  "#C5BEF9",
  "#E4E1FB", // 7 占比最低 → 最浅
];

const SHARE_RAMP_LEVELS = SHARE_RAMP_LIGHT.length;

/** 排名 rank（0 = 占比最高）→ 主题感知的 CSS 变量引用，深浅两态自动切换。 */
export function shareColorVar(rank: number): string {
  const level = Math.min(rank, SHARE_RAMP_LEVELS - 1);
  return `var(--share-${level + 1})`;
}

/** 排名 rank（0 = 占比最高）→ 浅色态 hex。
 *  导出版式在 foreignObject 里拿不到主文档的 CSS 变量，只能用 hex。 */
export function shareColorLight(rank: number): string {
  const level = Math.min(rank, SHARE_RAMP_LEVELS - 1);
  return SHARE_RAMP_LIGHT[level];
}
