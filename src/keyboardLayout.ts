/**
 * 项目自有配列（一次性从第三方 KLE 104.json 转换而来，转换脚本未保留）。
 * 运行时只读这一份文件，不再解析第三方 KLE JSON（见 layouts/index.ts 的设置页
 * 配列选择器仍走 parseKLE，那是设置页的预览，不参与输入页渲染）。
 *
 * 每个键三组字段：
 * - code：W3C UI Events `code`，是按键的唯一身份。采集层翻译、统计桶写入、
 *   历史迁移、输入页匹配，全部以它对齐。
 * - x/y/w/h：几何（单位 U），与转换前完全一致。
 * - lower/upper：印字（仅显示）。lower = 键帽下排基准字符（渲染为大字），
 *   upper = 键帽上排 Shift 后字符（渲染为小字）；单印字键 upper 为空串。
 */

import raw from "./assets/layout/ansi-104.json";
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

export const LAYOUT: LayoutKey[] = raw as LayoutKey[];

export const LAYOUT_MAX_X = Math.max(...LAYOUT.map((k) => k.x + k.w));
export const LAYOUT_MAX_Y = Math.max(...LAYOUT.map((k) => k.y + k.h));

/** 按 code 查键（code 在 104 配列内唯一）。 */
export function keyByCode(code: string): LayoutKey | undefined {
  return LAYOUT.find((k) => k.code === code);
}

/**
 * 键的显示名（详情条 / 排行榜 / 顶栏等纯文本场景用）。
 * 复刻旧 getDisplayLabel 口径：取上排印字（单印字则取唯一印字），
 * 命中三级表走 abbr 档。空格键上下皆空 → 固定 "Space"，避免空名。
 */
export function displayLabel(key: LayoutKey): string {
  const top = key.upper !== "" ? key.upper : key.lower;
  if (!top) return "Space";
  const tiers = lookupTiers(top);
  return tiers ? tiers.abbr : top;
}

/** 按 code 取显示名；code 不在配列内则原样返回 code（供未识别键等场景）。 */
export function displayLabelByCode(code: string): string {
  const key = keyByCode(code);
  return key ? displayLabel(key) : code;
}
