/**
 * 按键分类 —— 把 rdev 上报的 key_code 归到不同区域。
 *
 * rdev Key 通过 `format!("{:?}", key)` 序列化，形如 "KeyW"、"Num1"、"LeftControl"、
 * "Space"、"Return"、"Backspace"、"UpArrow" 等。分类表按此形状写，未匹配的走
 * 前缀兜底或落到 "other"。要增补新键位只改 KEY_REGIONS。
 */

import type { KeyRegion, KeyRegionStat } from "./types";
import type { RawKeyDetail } from "../data/types";

/**
 * 按 key_code 显式列举的区域归属。命中即取，找不到再走 fallback。
 * 顺序不重要 —— 是 Map 精确查表。
 */
export const KEY_REGIONS: Record<string, KeyRegion> = {
  // WASD（可能与"字母"重复归属，走这里优先）
  KeyW: "wasd",
  KeyA: "wasd",
  KeyS: "wasd",
  KeyD: "wasd",

  // 空格 / 回车 / 退格 —— 单列一档，输入量占比通常极高
  Space: "space_enter",
  Return: "space_enter",
  Enter: "space_enter",
  Backspace: "space_enter",

  // 编辑区（方向、Home/End、Page Up/Down、Delete、Insert、Tab）
  UpArrow: "editing",
  DownArrow: "editing",
  LeftArrow: "editing",
  RightArrow: "editing",
  Home: "editing",
  End: "editing",
  PageUp: "editing",
  PageDown: "editing",
  Delete: "editing",
  Insert: "editing",
  Tab: "editing",
  Escape: "editing",

  // 修饰键
  LeftControl: "modifier",
  RightControl: "modifier",
  ControlLeft: "modifier",
  ControlRight: "modifier",
  LeftShift: "modifier",
  RightShift: "modifier",
  ShiftLeft: "modifier",
  ShiftRight: "modifier",
  LeftAlt: "modifier",
  RightAlt: "modifier",
  Alt: "modifier",
  AltGr: "modifier",
  MetaLeft: "modifier",
  MetaRight: "modifier",
  LeftMeta: "modifier",
  RightMeta: "modifier",
  CapsLock: "modifier",
  Function: "modifier",
};

/**
 * 前缀兜底 —— rdev 的字母键都是 KeyX 前缀、数字是 Num 前缀等。
 * 命中顺序按数组顺序，首个匹配即返回。
 */
const PREFIX_RULES: { prefix: string; region: KeyRegion }[] = [
  { prefix: "Key", region: "letter" }, // KeyE、KeyF …
  { prefix: "Num", region: "number" }, // Num1、Num2 …
  { prefix: "F", region: "editing" }, // F1..F12 归到编辑区
  { prefix: "Kp", region: "number" }, // 数字小键盘：KpMinus/KpEnter…也算数字区
];

/** 标点/符号相关的具名键。这些不好用前缀识别，单独放这。 */
const PUNCTUATION_KEYS = new Set([
  "Minus",
  "Equal",
  "LeftBracket",
  "RightBracket",
  "BackSlash",
  "Backslash",
  "SemiColon",
  "Semicolon",
  "Quote",
  "Comma",
  "Dot",
  "Period",
  "Slash",
  "BackQuote",
  "Grave",
]);

/**
 * 修饰键的左右合并组。KLE 配列里左右键帽共用同一个标签（如左右 Shift 都写
 * "Shift"），`kleParser.ts` 的 `getLabelRdevCode` 只能把标签映射到左侧 code，
 * 右侧物理键实际上报的 rdev code（`ShiftRight` 等）会在计数时被漏掉。
 * key 是 `getLabelRdevCode` 返回的主 code，value 含主 code 自身，取按键次数时
 * 按组求和即得左右合计。
 */
export const MERGED_KEY_GROUPS: Record<string, string[]> = {
  ShiftLeft: ["ShiftLeft", "ShiftRight"],
  ControlLeft: ["ControlLeft", "ControlRight"],
  Alt: ["Alt", "AltGr"],
  MetaLeft: ["MetaLeft", "MetaRight"],
};

/**
 * 键鼠比 → 滑块位置 [0,1]。
 * 比值在不同 App 间跨度约 60 倍（终端类 ~0.03，播放器类 ~1.7），线性映射会把
 * 大半应用挤在最左端，必须走对数。ratio <= 0 时 log10 是 -Infinity，
 * 先行短路成 0，避免 NaN% 渗进 style。
 */
export function ratioToSliderPos(ratio: number): number {
  if (ratio <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.log10(ratio) + 1.6) / 2.2));
}

/** 键鼠比判定标签。输入页指标条与规律页共用，改这里两页同时生效。 */
export function ratioVerdict(ratio: number): "鼠标型" | "键盘型" | "均衡型" {
  return ratio > 0.25 ? "鼠标型" : ratio < 0.08 ? "键盘型" : "均衡型";
}

/** 把一个 key_code 判给某个区域。 */
export function classifyKeyCode(code: string): KeyRegion {
  if (KEY_REGIONS[code]) return KEY_REGIONS[code];
  if (PUNCTUATION_KEYS.has(code)) return "punctuation";
  for (const rule of PREFIX_RULES) {
    if (code.startsWith(rule.prefix)) return rule.region;
  }
  return "other";
}

/**
 * 聚合到"每区域一行"。details 里同一 key_code 若重复出现（跨桶未聚合场景），会自动求和。
 * @param topN 每个区域返回按次数排序的 top N，默认 5。
 */
export function classifyKeys(
  details: RawKeyDetail[],
  topN = 5
): KeyRegionStat[] {
  const byRegion = new Map<
    KeyRegion,
    { count: number; keys: Map<string, number> }
  >();
  const all: KeyRegion[] = [
    "wasd",
    "letter",
    "number",
    "editing",
    "modifier",
    "space_enter",
    "punctuation",
    "other",
  ];
  for (const r of all) byRegion.set(r, { count: 0, keys: new Map() });

  for (const d of details) {
    const region = classifyKeyCode(d.key_code);
    const slot = byRegion.get(region)!;
    slot.count += d.count;
    slot.keys.set(d.key_code, (slot.keys.get(d.key_code) ?? 0) + d.count);
  }

  return all.map<KeyRegionStat>((region) => {
    const slot = byRegion.get(region)!;
    const top = [...slot.keys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([key_code, count]) => ({ key_code, count }));
    return { region, count: slot.count, top };
  });
}
