/**
 * 键帽标签三级降级表 + 文本适配算法。
 *
 * - KEY_LABELS：命名键的三级候选（full / abbr / symbol?），键名规范化后匹配
 *   （<br>→空格、折叠空白、去首尾、小写不敏感）。
 * - fitLabel：给定候选层级与可用宽，按固定候选序列取第一个放得下的。
 * - measureLabel：单例 canvas measureText，font 串与键帽 CSS 的 family/weight 一致，
 *   按 `${text}|${fontSize}` memo 缓存。
 *
 * 注意：测量在**未缩放坐标系**进行，与 .kle-keyboard 的 transform: scale 无关。
 */

import { KEY_UNIT, KEY_GAP, KEY_PADDING } from "./metrics";

export type LabelTiers = { full: string; abbr: string; symbol?: string };

/** 与 tokens.css 的 body font-family 一致；weight 与 .kle-key 一致（600）。 */
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif`;
const FONT_WEIGHT = 600;

/** 主标签字号阶梯（px，未缩放）。 */
export const FONT_TIERS = [14, 12, 10, 9] as const;
/** 双行标签副标签固定字号（px）。 */
export const SUB_FONT = 9;

// ---- 文本测量（单例 canvas + memo） ----------------------------------------

let _ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D | null {
  if (_ctx) return _ctx;
  if (typeof document === "undefined") return null;
  _ctx = document.createElement("canvas").getContext("2d");
  return _ctx;
}

const _cache = new Map<string, number>();

/** 测量 text 在 fontSize 下的像素宽（键帽字体）。无 canvas 环境回退到字符数估算。 */
export function measureLabel(text: string, fontSize: number): number {
  const key = `${text}|${fontSize}`;
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;
  const ctx = measureCtx();
  let w: number;
  if (ctx) {
    ctx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * fontSize * 0.6; // 仅测试/SSR 兜底
  }
  _cache.set(key, w);
  return w;
}

// ---- 可用宽 ----------------------------------------------------------------

/** 单键在未缩放坐标系下的文字可用宽。halfWidth 用于双行主标签（副标签占半高时
 *  主标签宽度判定不变，但此参数保留以便将来按需收紧；当前主/单行同宽）。 */
export function usableLabelWidth(keyW: number): number {
  return keyW * KEY_UNIT - KEY_GAP - 2 * KEY_PADDING;
}

// ---- 适配算法 --------------------------------------------------------------

/** 一个被选中的候选。 */
export type FittedLabel = {
  text: string;
  fontSize: number;
  /** 候选层级名，供调试/审计输出（full@14 / abbr@12 / symbol@10 …） */
  tierName: string;
  /** 全部候选都放不下、取了最后一个兜底 → 需 CSS ellipsis 截断 */
  truncated: boolean;
};

/** 主标签候选序列：full@14 → full@12 → abbr@12 → abbr@10 → symbol@10 → abbr@9 → symbol@9。
 *  无 symbol 的键自动跳过 symbol 候选。 */
function candidateList(t: LabelTiers): { text: string; fontSize: number; tierName: string }[] {
  const list: { text: string; fontSize: number; tierName: string }[] = [
    { text: t.full, fontSize: 14, tierName: "full@14" },
    { text: t.full, fontSize: 12, tierName: "full@12" },
    { text: t.abbr, fontSize: 12, tierName: "abbr@12" },
    { text: t.abbr, fontSize: 10, tierName: "abbr@10" },
  ];
  if (t.symbol) list.push({ text: t.symbol, fontSize: 10, tierName: "symbol@10" });
  list.push({ text: t.abbr, fontSize: 9, tierName: "abbr@9" });
  if (t.symbol) list.push({ text: t.symbol, fontSize: 9, tierName: "symbol@9" });
  return list;
}

/**
 * 为单行/主标签选一档：按候选序列取第一个测量宽 <= usable 的候选；
 * 全不通过则取最后一个候选并标记 truncated（CSS 走 ellipsis）。
 */
export function fitLabel(tiers: LabelTiers, usable: number): FittedLabel {
  const cands = candidateList(tiers);
  for (const c of cands) {
    if (measureLabel(c.text, c.fontSize) <= usable) {
      return { ...c, truncated: false };
    }
  }
  const last = cands[cands.length - 1];
  return { ...last, truncated: true };
}

/**
 * 副标签（双行下半）：固定 SUB_FONT，只在 abbr / symbol 级里取第一个放得下的；
 * 都放不下则取 abbr@SUB_FONT 兜底并标记 truncated。
 */
export function fitSubLabel(tiers: LabelTiers, usable: number): FittedLabel {
  const cands: { text: string; fontSize: number; tierName: string }[] = [
    { text: tiers.abbr, fontSize: SUB_FONT, tierName: `abbr@${SUB_FONT}` },
  ];
  if (tiers.symbol) cands.push({ text: tiers.symbol, fontSize: SUB_FONT, tierName: `symbol@${SUB_FONT}` });
  for (const c of cands) {
    if (measureLabel(c.text, c.fontSize) <= usable) return { ...c, truncated: false };
  }
  return { ...cands[0], truncated: true };
}

// ---- 规范化 + 查表 ----------------------------------------------------------

/** 规范化键名：<br>→空格、去 HTML、折叠空白、去首尾、小写。用于 KEY_LABELS 匹配。 */
export function normalizeLabelKey(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 命名键三级表。键为 normalizeLabelKey 后的规范名，可多个别名指向同一档。 */
export const KEY_LABELS: Record<string, LabelTiers> = {
  "back space": { full: "Backspace", abbr: "Bksp", symbol: "⌫" },
  backspace: { full: "Backspace", abbr: "Bksp", symbol: "⌫" },
  "caps lock": { full: "Caps Lock", abbr: "Caps", symbol: "⇪" },
  caps: { full: "Caps Lock", abbr: "Caps", symbol: "⇪" },
  "num lock": { full: "Num Lock", abbr: "NumLk" },
  "scroll lock": { full: "Scroll Lock", abbr: "ScrLk" },
  scrlk: { full: "Scroll Lock", abbr: "ScrLk" },
  sclk: { full: "Scroll Lock", abbr: "ScrLk" },
  "print screen": { full: "Print Screen", abbr: "PrtSc" },
  prtsc: { full: "Print Screen", abbr: "PrtSc" },
  print: { full: "Print Screen", abbr: "PrtSc" },
  insert: { full: "Insert", abbr: "Ins" },
  ins: { full: "Insert", abbr: "Ins" },
  delete: { full: "Delete", abbr: "Del", symbol: "⌦" },
  del: { full: "Delete", abbr: "Del", symbol: "⌦" },
  "page up": { full: "Page Up", abbr: "PgUp" },
  pgup: { full: "Page Up", abbr: "PgUp" },
  "page down": { full: "Page Down", abbr: "PgDn" },
  pgdn: { full: "Page Down", abbr: "PgDn" },
  home: { full: "Home", abbr: "Home" },
  end: { full: "End", abbr: "End" },
  enter: { full: "Enter", abbr: "Enter", symbol: "⏎" },
  return: { full: "Enter", abbr: "Enter", symbol: "⏎" },
  tab: { full: "Tab", abbr: "Tab", symbol: "⇥" },
  shift: { full: "Shift", abbr: "Shift", symbol: "⇧" },
  control: { full: "Control", abbr: "Ctrl", symbol: "⌃" },
  ctrl: { full: "Control", abbr: "Ctrl", symbol: "⌃" },
  alt: { full: "Alt", abbr: "Alt", symbol: "⌥" },
  option: { full: "option", abbr: "⌥", symbol: "⌥" },
  win: { full: "Win", abbr: "Win", symbol: "⌘" },
  command: { full: "command", abbr: "⌘", symbol: "⌘" },
  "⌘": { full: "command", abbr: "⌘", symbol: "⌘" },
  esc: { full: "Esc", abbr: "Esc" },
  escape: { full: "Esc", abbr: "Esc" },
  space: { full: "Space", abbr: "Space", symbol: " " },
  "↑": { full: "↑", abbr: "↑", symbol: "↑" },
  "↓": { full: "↓", abbr: "↓", symbol: "↓" },
  "←": { full: "←", abbr: "←", symbol: "←" },
  "→": { full: "→", abbr: "→", symbol: "→" },
  // built-in 里出现的其它命名键
  menu: { full: "Menu", abbr: "Menu" },
  fn: { full: "Fn", abbr: "Fn" },
  pause: { full: "Pause", abbr: "Pause" },
  hyper: { full: "Hyper", abbr: "Hypr" },
  super: { full: "Super", abbr: "Sup" },
  meta: { full: "Meta", abbr: "Meta" },
};

/** 查命名键三级表；未命中返回 undefined（调用方自行处理裸标签）。 */
export function lookupTiers(rawMain: string): LabelTiers | undefined {
  return KEY_LABELS[normalizeLabelKey(rawMain)];
}


