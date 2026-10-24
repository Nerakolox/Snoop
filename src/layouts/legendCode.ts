/**
 * KLE 印字 → W3C `code` 的推断。
 *
 * 自定义配列是用户从 keyboard-layout-editor 导出的原始 JSON，里面只有印字，
 * 没有按键身份。热力统计按 `code` join，所以这里做一层「尽力而为」的推断：
 * 认识的印字映射到与内置 104/87 完全相同的 code，不认识的返回 undefined
 * （按 0 次/无数据渲染），绝不猜一个错误的身份把别人的次数算到这个键上。
 *
 * 推断依据有两部分：
 * - 印字本身（字母、数字、标点、命名键）；
 * - 位置（KLE 坐标，U 单位）：用于区分左右 Shift/Ctrl/Alt/Win，以及数字小键盘
 *   （小键盘的 "5" 和主键区的 "5" 印字相同，只能靠 x 坐标分辨）。
 */

/** 推断所需的位置上下文（都是 KLE 原始坐标，U）。 */
export type LegendContext = {
  /** 键左缘 x（U） */
  x: number;
  /** 键宽（U） */
  w: number;
  /** 键上缘 y（U） */
  y: number;
  /** 配列总宽（U） */
  maxX: number;
  /** 配列是否含数字小键盘（有 "Num Lock" 印字即视为有） */
  hasNumpad: boolean;
};

const BR_RE = /<br\s*\/?>/gi;

/** 把 KLE 多行印字拆成渲染层要的 lower/upper。
 *
 *  KLE 的约定：`"~\n\`"` 这种一格里多行，第一行是 Shift 后的字符，最后一行是基准字符。
 *  内置配列的 lower/upper 语义正好相反的顺序无关 —— lower 是大字（基准），upper 是小字
 *  （Shift）。空印字（如 KLE 里写作 "" 的空格键）保留为空串，由渲染层补 "Space"。 */
export function splitLegend(raw: string): { lower: string; upper: string } {
  const lines = raw
    .replace(BR_RE, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (lines.length === 0) return { lower: "", upper: "" };
  if (lines.length === 1) return { lower: lines[0], upper: "" };
  return { lower: lines[lines.length - 1], upper: lines[0] };
}

/** 规范成查表用的键：折叠空白、转小写。 */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 命名键表。键是规范化后的印字，值是不受左右影响的 code。 */
const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  "caps lock": "CapsLock",
  capslock: "CapsLock",
  backwards: "Backspace",
  backspace: "Backspace",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  spacebar: "Space",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  home: "Home",
  end: "End",
  "page up": "PageUp",
  pageup: "PageUp",
  pgup: "PageUp",
  "page down": "PageDown",
  pagedown: "PageDown",
  pgdn: "PageDown",
  "print screen": "PrintScreen",
  printscreen: "PrintScreen",
  prtsc: "PrintScreen",
  "scroll lock": "ScrollLock",
  scrolllock: "ScrollLock",
  "scroll lk": "ScrollLock",
  scrlk: "ScrollLock",
  pause: "Pause",
  "num lock": "NumLock",
  numlock: "NumLock",
  menu: "ContextMenu",
  "context menu": "ContextMenu",
  "application menu": "ContextMenu",
  compose: "ContextMenu",
  "fn lock": "FnLock",
  "left": "ArrowLeft",
  "←": "ArrowLeft",
  "up": "ArrowUp",
  "↑": "ArrowUp",
  "right": "ArrowRight",
  "→": "ArrowRight",
  "down": "ArrowDown",
  "↓": "ArrowDown",
};

/** 标点印字表：基准字符与 Shift 字符都归属于同一个物理键。 */
const PUNCT: Record<string, string> = {
  "`": "Backquote",
  "~": "Backquote",
  "-": "Minus",
  _: "Minus",
  "=": "Equal",
  "+": "Equal",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  "\\": "Backslash",
  "|": "Backslash",
  ";": "Semicolon",
  ":": "Semicolon",
  "'": "Quote",
  '"': "Quote",
  ",": "Comma",
  "<": "Comma",
  ".": "Period",
  ">": "Period",
  "/": "Slash",
  "?": "Slash",
};

/** 左右成对的修饰键：印字 → [左, 右]。 */
const SIDED: Record<string, readonly [string, string] | undefined> = {
  shift: ["ShiftLeft", "ShiftRight"],
  ctrl: ["ControlLeft", "ControlRight"],
  control: ["ControlLeft", "ControlRight"],
  alt: ["AltLeft", "AltRight"],
  option: ["AltLeft", "AltRight"],
  opt: ["AltLeft", "AltRight"],
  win: ["MetaLeft", "MetaRight"],
  meta: ["MetaLeft", "MetaRight"],
  super: ["MetaLeft", "MetaRight"],
  cmd: ["MetaLeft", "MetaRight"],
  command: ["MetaLeft", "MetaRight"],
};

/** 小键盘印字表（仅在判定为小键盘区域时使用）。 */
const NUMPAD: Record<string, string> = {
  "num lock": "NumLock",
  "/": "NumpadDivide",
  "*": "NumpadMultiply",
  "-": "NumpadSubtract",
  "+": "NumpadAdd",
  ".": "NumpadDecimal",
  ",": "NumpadDecimal",
  del: "NumpadDecimal",
  "delete": "NumpadDecimal",
  "=": "NumpadEqual",
  enter: "NumpadEnter",
  return: "NumpadEnter",
  home: "Numpad7",
  up: "Numpad8",
  "↑": "Numpad8",
  "page up": "Numpad9",
  pgup: "Numpad9",
  end: "Numpad1",
  down: "Numpad2",
  "↓": "Numpad2",
  "page down": "Numpad3",
  pgdn: "Numpad3",
  ins: "Numpad0",
  insert: "Numpad0",
  "←": "Numpad4",
  "→": "Numpad6",
};

/**
 * 由印字 + 位置推断 W3C code。推断不出时返回 undefined。
 *
 * @param raw KLE 原始印字（可含 `\n` / `<br>` 多行）
 */
export function resolveCodeFromLegend(raw: string, ctx: LegendContext): string | undefined {
  const { lower } = splitLegend(raw);
  // 空印字：只有足够宽才当空格键，避免把 KLE 里忘记写印字的键误判成空格
  if (lower === "") return ctx.w >= 2.5 ? "Space" : undefined;
  const s = norm(lower);

  // 小键盘：靠 x 落在配列最右侧 4.25U 内判定，优先于一切通用规则
  if (ctx.hasNumpad && ctx.x >= ctx.maxX - 4.25) {
    if (/^[0-9]$/.test(s)) return `Numpad${s}`;
    return NUMPAD[s];
  }

  // ISO 键位：左 Shift 右侧那个 \| 键，印字与 ANSI 的 Backslash 相同，靠位置区分
  if (ctx.x < 2.5 && ctx.y > 3.5 && (s === "\\" || s === "|")) return "IntlBackslash";

  // 字母 / 数字 / 功能键
  if (/^[a-z]$/.test(s)) return `Key${s.toUpperCase()}`;
  if (/^[0-9]$/.test(s)) return `Digit${s}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(s)) return s.toUpperCase();

  const named = NAMED[s];
  if (named) return named;

  // 左右修饰键：键中心落在配列中线左侧 → Left，否则 Right
  const sided = SIDED[s];
  if (sided) return ctx.x + ctx.w / 2 < ctx.maxX / 2 ? sided[0] : sided[1];

  const punct = PUNCT[s];
  if (punct) return punct;

  return undefined;
}
