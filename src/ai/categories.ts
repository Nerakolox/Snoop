// 分类占比的**排名色阶** —— 只管「第几名」，不管「是哪一类」。
//
// 分类身份（名称、颜色、说明）已经数据化，住在 `src/categories/*`：
// 显示名走 `categories/store.ts` 的 labelOf，分类色走 `categories/color.ts`。
// 这个文件只剩下占比可视化用的排名色阶，与分类是谁无关。
//
// 分类是离散互斥的类别，但**占比可视化不给每个类别一个固定色相**：
// 颜色只编码「占比排名」（排名越靠前越深 / 越亮），类别身份交给文字（图例 / tooltip）。
// 这与时间线「颜色编码强度、身份交给行头」是同一套逻辑，整站一致。
//
// 排名色阶走**中性灰阶**而非品牌紫：暖色阶是「活跃强度」的唯一编码，品牌紫只归交互与身份，
// 占比是第三个维度，两套都不能借用，否则读者会把"深浅"误读成"活跃"。
// 唯一的紫是第一名那一段 —— 那是"强调单个关键项"，与「XX% 是娱乐」的结论句呼应。

/**
 * 分类占比的「品牌紫深浅阶」—— 浅色态的 hex，**仅供导出版式（report/ReportCard）使用**。
 * 排名 0 = 占比最高 → 最深；越靠后越浅；超出的都用最后一阶。
 *
 * 导出卡片是脱离应用主题的独立静态版式（foreignObject 里拿不到主文档的 CSS 变量），
 * 配色自成一套，不跟随应用内的色彩规约，故这条紫阶保留。
 * 应用内的分类占比一律走 `categoryColorVar`（中性阶 + 第一名品牌紫）。
 */
export const SHARE_RAMP_LIGHT: readonly string[] = [
  "#3C2FB9", // 1 占比最高 → 最深
  "#5644D9",
  "#6D5AE6", // 品牌主紫（中间档）
  "#8B7DF0",
  "#ABA2F5",
  "#C9C4F9",
  "#E8E5FC", // 7 占比最低 → 最浅（接近背景）
];

const SHARE_RAMP_LEVELS = SHARE_RAMP_LIGHT.length;

/** 中性阶的档位数（`tokens.css` 的 `--neutral-1..6`），排名超出后一律用最后一阶。 */
const NEUTRAL_RAMP_LEVELS = 6;

/**
 * 排名 rank（0 = 占比最高）→ 主题感知的 CSS 变量引用，深浅两态自动切换。
 *
 * rank 0 用品牌紫（强调第一名这一个关键项），rank ≥ 1 走中性阶（--neutral-1 深 → --neutral-6 浅）。
 * 中性阶从 1 起算，所以 rank 1 对应 --neutral-1，rank 6 及以后都压在 --neutral-6。
 */
export function categoryColorVar(rank: number): string {
  if (rank <= 0) return "var(--color-accent)";
  const level = Math.min(rank, NEUTRAL_RAMP_LEVELS);
  return `var(--neutral-${level})`;
}

/** 排名 rank（0 = 占比最高）→ 浅色态 hex。
 *  导出版式在 foreignObject 里拿不到主文档的 CSS 变量，只能用 hex。 */
export function shareColorLight(rank: number): string {
  const level = Math.min(rank, SHARE_RAMP_LEVELS - 1);
  return SHARE_RAMP_LIGHT[level];
}
