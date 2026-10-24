/**
 * 项目自有配列。每个键：code（身份）、x/y/w/h（几何，U）、lower/upper（印字）、
 * row（行序号，供 Cherry 行高分级用）。目前内置 104（全尺寸）和 87（TKL）两种。
 *
 * 自定义 KLE 配列（设置页导入）也从这里的 getLayoutForId 出。KLE 里只有印字没有
 * 按键身份，buildCustomLayout 用 legendCode.ts 的启发式从印字 + 位置推断 code；
 * 推断不出的键 code 留空，不参与热力统计（按 0 次/无数据处理）。
 */

import raw104 from "./assets/layout/ansi-104.json";
import raw87 from "./assets/layout/ansi-87.json";
import { lookupTiers } from "./layouts/labels";
import { getLayoutById, isCustomLayoutId } from "./layouts";
import { parseKLE } from "./kleParser";
import { resolveCodeFromLegend, splitLegend } from "./layouts/legendCode";

export type LayoutKey = {
  /** W3C code（按键身份）；自定义配列推断不出时为 undefined。 */
  code?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lower: string;
  upper: string;
  /** 行序号（从上往下，0-based）；缺失时渲染层按 y 聚类兜底。 */
  row?: number;
};

export const LAYOUT: LayoutKey[] = raw104 as LayoutKey[];
export const LAYOUT_MAX_X = Math.max(...LAYOUT.map((k) => k.x + k.w));
export const LAYOUT_MAX_Y = Math.max(...LAYOUT.map((k) => k.y + k.h));

const LAYOUT_87: LayoutKey[] = raw87 as LayoutKey[];
const LAYOUT_87_MAX_X = Math.max(...LAYOUT_87.map((k) => k.x + k.w));
const LAYOUT_87_MAX_Y = Math.max(...LAYOUT_87.map((k) => k.y + k.h));

/** 把自定义配列的原始 KLE JSON 转成渲染层键表。
 *
 *  code 由印字 + 位置尽力推断（见 legendCode.ts）：能认出的键与内置配列共用同一套
 *  W3C code，正常参与热力统计；认不出的键 code 留空，按 0 次渲染。 */
function buildCustomLayout(id: string): { keys: LayoutKey[]; maxX: number; maxY: number } | null {
  const entry = getLayoutById(id);
  if (!entry) return null;
  const parsed = parseKLE(entry.data);
  const visible = parsed.keys.filter((k) => !k.decal);
  // 有 "Num Lock" 印字即视为带小键盘：小键盘的数字键要靠这个区分 Numpad5 与 Digit5
  const hasNumpad = visible.some((k) => splitLegend(k.label).lower.toLowerCase() === "num lock");
  const keys: LayoutKey[] = visible.map((k) => {
    const { lower, upper } = splitLegend(k.label);
    return {
      code: resolveCodeFromLegend(k.label, {
        x: k.x,
        w: k.w,
        y: k.y,
        maxX: parsed.maxX,
        hasNumpad,
      }),
      x: k.x,
      y: k.y,
      w: k.w,
      h: k.h,
      lower,
      upper,
      row: k.row,
    };
  });
  return { keys, maxX: parsed.maxX, maxY: parsed.maxY };
}

/** 按配列 ID 返回对应键表和边界。自定义 ID 解析失败时才回落 104。 */
export function getLayoutForId(id: string): {
  keys: LayoutKey[];
  maxX: number;
  maxY: number;
} {
  if (id === "87") {
    return { keys: LAYOUT_87, maxX: LAYOUT_87_MAX_X, maxY: LAYOUT_87_MAX_Y };
  }
  if (isCustomLayoutId(id)) {
    const custom = buildCustomLayout(id);
    if (custom) return custom;
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
