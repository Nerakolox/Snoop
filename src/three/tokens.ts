// @ts-nocheck
/**
 * 设计 token → THREE.Color：从 :root / [data-theme] 读 CSS 变量，供 3D 键帽取色。
 *
 * - 键帽填充色沿用暖色阶 --intensity-0..4（0 档为中性「挂机」色，不进暖色 ramp），
 *   与 analytics/intensity.ts 的分档输出同域。
 * - 标签的深/浅两色取自 --color-text 与 --color-bg 的明暗两极：浅色键帽用深标签、
 *   深色键帽用浅标签。之所以不直接写死「深=--color-text」，是因为深色主题下
 *   --color-text 会反转为浅色，反而失去对比；取明暗两极可保证任意主题下
 *   「深标签 / 浅标签」都各自成立。
 * - 切主题时 data-theme 属性变化，经 observeTheme 通知上层重读 token。
 */

import { Color } from "three";

export type ThemeColors = {
  /** 档位 0..4 的填充色（sRGB 读入，three 内部转为线性，渲染回 sRGB 不变）。 */
  intensity: Color[];
  /** 浅色键帽上的深色标签色。 */
  darkText: Color;
  /** 深色键帽上的浅色标签色。 */
  lightText: Color;
  /** 定位板（键帽缝隙露出的深中性表面）。 */
  plate: Color;
  /** 外壳（四周边框 + 底座的中性色）。 */
  caseColor: Color;
  /** 轴柱（高度编码时把键帽顶起的柱体中性色）。 */
  stem: Color;
};

/** 强度色阶回退值（与 tokens.css 浅色主题一致，仅用于 SSR/无 DOM 兜底）。 */
const FALLBACK_INTENSITY = ["#E7E4DE", "#F3C88F", "#F0B77A", "#E68A3C", "#D1602C"];

function readVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 相对亮度（BT.601），用于决定标签用深色还是浅色。 */
function luminance(c: Color): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

/** 读当前主题的键帽填充色 + 标签深/浅色。 */
export function readThemeColors(): ThemeColors {
  const intensity = FALLBACK_INTENSITY.map(
    (fallback, lvl) => new Color(readVar(`--intensity-${lvl}`, fallback))
  );
  const text = new Color(readVar("--color-text", "#2A2730"));
  const bg = new Color(readVar("--color-bg", "#FAF8F5"));
  const darkText = luminance(text) <= luminance(bg) ? text : bg;
  const lightText = luminance(text) <= luminance(bg) ? bg : text;
  const plate = new Color(readVar("--kb3d-plate", "#3B363F"));
  const caseColor = new Color(readVar("--kb3d-case", "#CCC7BE"));
  const stem = new Color(readVar("--kb3d-stem", "#8C868F"));
  return { intensity, darkText, lightText, plate, caseColor, stem };
}

/** 监听 `data-theme` 属性变化（含系统主题切换），回调中重读 token。返回清理函数。 */
export function observeTheme(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const mo = new MutationObserver(() => onChange());
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => mo.disconnect();
}
