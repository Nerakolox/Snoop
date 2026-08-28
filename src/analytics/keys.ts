/**
 * 按键分类 —— 把采集层写入的 W3C `code` 归到不同区域。
 *
 * 键身份已统一为 W3C UI Events `code`（"KeyW"、"Digit1"、"Numpad1"、"Enter"、
 * "ArrowUp"、"Period"、"ShiftLeft" 等），分类表按此形状写，未匹配的走前缀兜底
 * 或落到 "other"。要增补新键位只改 KEY_REGIONS。
 */

import type { KeyRegion, KeyRegionStat } from "./types";
import type { RawKeyDetail } from "../data/types";

/**
 * 按 `code` 显式列举的区域归属。命中即取，找不到再走 fallback。
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
  Enter: "space_enter",
  Backspace: "space_enter",

  // 编辑区（方向、Home/End、Page Up/Down、Delete、Insert、Tab）
  ArrowUp: "editing",
  ArrowDown: "editing",
  ArrowLeft: "editing",
  ArrowRight: "editing",
  Home: "editing",
  End: "editing",
  PageUp: "editing",
  PageDown: "editing",
  Delete: "editing",
  Insert: "editing",
  Tab: "editing",
  Escape: "editing",

  // 修饰键（左右各自独立成键）
  ControlLeft: "modifier",
  ControlRight: "modifier",
  ShiftLeft: "modifier",
  ShiftRight: "modifier",
  AltLeft: "modifier",
  AltRight: "modifier",
  MetaLeft: "modifier",
  MetaRight: "modifier",
  CapsLock: "modifier",
};

/**
 * 前缀兜底 —— 字母键都是 KeyX 前缀、主区数字是 Digit 前缀、小键盘是 Numpad 前缀等。
 * 命中顺序按数组顺序，首个匹配即返回。
 */
const PREFIX_RULES: { prefix: string; region: KeyRegion }[] = [
  { prefix: "Key", region: "letter" }, // KeyE、KeyF …
  { prefix: "Digit", region: "number" }, // Digit1、Digit2 …
  { prefix: "F", region: "editing" }, // F1..F12 归到编辑区
  { prefix: "Numpad", region: "number" }, // 数字小键盘：NumpadEnter/NumpadAdd…也算数字区
];

/** 标点/符号相关的具名键。这些不好用前缀识别，单独放这。 */
const PUNCTUATION_KEYS = new Set([
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backquote",
]);

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

/** 把一个 `code` 判给某个区域。 */
export function classifyKeyCode(code: string): KeyRegion {
  if (KEY_REGIONS[code]) return KEY_REGIONS[code];
  if (PUNCTUATION_KEYS.has(code)) return "punctuation";
  for (const rule of PREFIX_RULES) {
    if (code.startsWith(rule.prefix)) return rule.region;
  }
  return "other";
}

/**
 * 聚合到"每区域一行"。details 里同一 `code` 若重复出现（跨桶未聚合场景），会自动求和。
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
