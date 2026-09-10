/**
 * 项目自有配列。每个键：code（身份）、x/y/w/h（几何，U）、lower/upper（印字）。
 * 目前内置 104（全尺寸）和 87（TKL，去掉数字小键盘）两种。
 * 自定义配列仍走 KLE 选择器（设置页预览），输入页热力图只用这里的格式。
 */

import raw104 from "./assets/layout/ansi-104.json";
import raw87 from "./assets/layout/ansi-87.json";
import { lookupTiers } from "./layouts/labels";

export type LayoutKey = {
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lower: string;
  upper: string;
};

export const LAYOUT: LayoutKey[] = raw104 as LayoutKey[];
export const LAYOUT_MAX_X = Math.max(...LAYOUT.map((k) => k.x + k.w));
export const LAYOUT_MAX_Y = Math.max(...LAYOUT.map((k) => k.y + k.h));

const LAYOUT_87: LayoutKey[] = raw87 as LayoutKey[];
const LAYOUT_87_MAX_X = Math.max(...LAYOUT_87.map((k) => k.x + k.w));
const LAYOUT_87_MAX_Y = Math.max(...LAYOUT_87.map((k) => k.y + k.h));

/** 按配列 ID 返回对应键表和边界；未知 ID 回落到 104。 */
export function getLayoutForId(id: string): {
  keys: LayoutKey[];
  maxX: number;
  maxY: number;
} {
  if (id === "87") {
    return { keys: LAYOUT_87, maxX: LAYOUT_87_MAX_X, maxY: LAYOUT_87_MAX_Y };
  }
  return { keys: LAYOUT, maxX: LAYOUT_MAX_X, maxY: LAYOUT_MAX_Y };
}

/** 按 code 查键（104 配列）。 */
export function keyByCode(code: string): LayoutKey | undefined {
  return LAYOUT.find((k) => k.code === code);
}

/** 键帽显示名（详情条 / 排行榜 / 顶栏等纯文本场景）。 */
export function displayLabel(key: LayoutKey): string {
  const top = key.upper !== "" ? key.upper : key.lower;
  if (!top) return "Space";
  const tiers = lookupTiers(top);
  return tiers ? tiers.abbr : top;
}

/** 按 code 取显示名；code 不在配列内则原样返回 code。 */
export function displayLabelByCode(code: string): string {
  const key = keyByCode(code);
  return key ? displayLabel(key) : code;
}
