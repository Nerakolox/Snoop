/**
 * 键盘配列定义 - 支持主流物理布局
 */

export type KeyVariant = "letter" | "num" | "mod" | "space" | "fn";

export type KeyDef = {
  id: string;
  label: string;
  w?: number; // 键宽，单位 u（标准键宽）
  variant?: KeyVariant;
  rdevCode: string;
};

export type LayoutId = "60" | "64" | "75" | "87" | "96" | "104";

export type LayoutDef = {
  id: LayoutId;
  name: string;
  keys: number; // 键数
  rows: KeyDef[][];
};

const letter = (l: string): KeyDef => ({
  id: l.toLowerCase(),
  label: l,
  variant: "letter",
  rdevCode: `Key${l.toUpperCase()}`,
});

const num = (l: string, rdev: string): KeyDef => ({
  id: l,
  label: l,
  variant: "num",
  rdevCode: rdev,
});

// ============ 60% (61键) ============
// 仅主区：数字行 + 三行字母 + 底排修饰键
const LAYOUT_60: LayoutDef = {
  id: "60",
  name: "60%",
  keys: 61,
  rows: [
    [
      { id: "grave", label: "`", rdevCode: "BackQuote", variant: "num" },
      num("1", "Num1"),
      num("2", "Num2"),
      num("3", "Num3"),
      num("4", "Num4"),
      num("5", "Num5"),
      num("6", "Num6"),
      num("7", "Num7"),
      num("8", "Num8"),
      num("9", "Num9"),
      num("0", "Num0"),
      { id: "minus", label: "-", rdevCode: "Minus", variant: "num" },
      { id: "equal", label: "=", rdevCode: "Equal", variant: "num" },
      { id: "backspace", label: "BS", w: 2, variant: "mod", rdevCode: "Backspace" },
    ],
    [
      { id: "tab", label: "Tab", w: 1.5, variant: "mod", rdevCode: "Tab" },
      letter("Q"),
      letter("W"),
      letter("E"),
      letter("R"),
      letter("T"),
      letter("Y"),
      letter("U"),
      letter("I"),
      letter("O"),
      letter("P"),
      { id: "lbracket", label: "[", rdevCode: "LeftBracket" },
      { id: "rbracket", label: "]", rdevCode: "RightBracket" },
      { id: "backslash", label: "\\", w: 1.5, rdevCode: "BackSlash" },
    ],
    [
      { id: "caps", label: "Caps", w: 1.75, variant: "mod", rdevCode: "CapsLock" },
      letter("A"),
      letter("S"),
      letter("D"),
      letter("F"),
      letter("G"),
      letter("H"),
      letter("J"),
      letter("K"),
      letter("L"),
      { id: "semicolon", label: ";", rdevCode: "SemiColon" },
      { id: "quote", label: "'", rdevCode: "Quote" },
      { id: "enter", label: "Enter", w: 2.25, variant: "mod", rdevCode: "Return" },
    ],
    [
      { id: "lshift", label: "Shift", w: 2.25, variant: "mod", rdevCode: "LeftShift" },
      letter("Z"),
      letter("X"),
      letter("C"),
      letter("V"),
      letter("B"),
      letter("N"),
      letter("M"),
      { id: "comma", label: ",", rdevCode: "Comma" },
      { id: "period", label: ".", rdevCode: "Period" },
      { id: "slash", label: "/", rdevCode: "Slash" },
      { id: "rshift", label: "Shift", w: 2.75, variant: "mod", rdevCode: "RightShift" },
    ],
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", w: 1.25, variant: "mod", rdevCode: "Function" },
      { id: "menu", label: "Menu", w: 1.25, variant: "mod", rdevCode: "Apps" },
      { id: "rctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "RightControl" },
    ],
  ],
};

// ============ 64% ============
// 60% + 独立方向键（底排右侧压缩）
const LAYOUT_64: LayoutDef = {
  id: "64",
  name: "64%",
  keys: 64,
  rows: [
    LAYOUT_60.rows[0],
    LAYOUT_60.rows[1],
    LAYOUT_60.rows[2],
    [
      ...LAYOUT_60.rows[3],
      { id: "up", label: "↑", variant: "mod", rdevCode: "UpArrow" },
    ],
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", variant: "mod", rdevCode: "Function" },
      { id: "left", label: "←", variant: "mod", rdevCode: "LeftArrow" },
      { id: "down", label: "↓", variant: "mod", rdevCode: "DownArrow" },
      { id: "right", label: "→", variant: "mod", rdevCode: "RightArrow" },
    ],
  ],
};

// ============ 75% (84键) ============
// 紧凑全功能：F 行 + 主区 + 方向键 + 部分编辑键竖排，无间隙
const LAYOUT_75: LayoutDef = {
  id: "75",
  name: "75%",
  keys: 84,
  rows: [
    // F 行（顶部）+ Esc + Del
    [
      { id: "esc", label: "Esc", variant: "mod", rdevCode: "Escape" },
      { id: "f1", label: "F1", variant: "fn", rdevCode: "F1" },
      { id: "f2", label: "F2", variant: "fn", rdevCode: "F2" },
      { id: "f3", label: "F3", variant: "fn", rdevCode: "F3" },
      { id: "f4", label: "F4", variant: "fn", rdevCode: "F4" },
      { id: "f5", label: "F5", variant: "fn", rdevCode: "F5" },
      { id: "f6", label: "F6", variant: "fn", rdevCode: "F6" },
      { id: "f7", label: "F7", variant: "fn", rdevCode: "F7" },
      { id: "f8", label: "F8", variant: "fn", rdevCode: "F8" },
      { id: "f9", label: "F9", variant: "fn", rdevCode: "F9" },
      { id: "f10", label: "F10", variant: "fn", rdevCode: "F10" },
      { id: "f11", label: "F11", variant: "fn", rdevCode: "F11" },
      { id: "f12", label: "F12", variant: "fn", rdevCode: "F12" },
      { id: "prtsc", label: "Prt", variant: "fn", rdevCode: "PrintScreen" },
      { id: "del", label: "Del", variant: "mod", rdevCode: "Delete" },
    ],
    // 数字行 + PgUp
    [
      ...LAYOUT_60.rows[0],
      { id: "pgup", label: "PgUp", variant: "mod", rdevCode: "PageUp" },
    ],
    // QWERTY 第一行 + PgDn
    [
      ...LAYOUT_60.rows[1],
      { id: "pgdn", label: "PgDn", variant: "mod", rdevCode: "PageDown" },
    ],
    // ASDF 行 + Home
    [
      ...LAYOUT_60.rows[2],
      { id: "home", label: "Home", variant: "mod", rdevCode: "Home" },
    ],
    // ZXCV 行 + Up + End
    [
      ...LAYOUT_60.rows[3],
      { id: "up", label: "↑", variant: "mod", rdevCode: "UpArrow" },
      { id: "end", label: "End", variant: "mod", rdevCode: "End" },
    ],
    // 底排 + 方向键
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", variant: "mod", rdevCode: "Function" },
      { id: "left", label: "←", variant: "mod", rdevCode: "LeftArrow" },
      { id: "down", label: "↓", variant: "mod", rdevCode: "DownArrow" },
      { id: "right", label: "→", variant: "mod", rdevCode: "RightArrow" },
    ],
  ],
};

// ============ 87键 / TKL (80%) ============
// F 行 + 主区 + 独立编辑区（6键）+ 方向键，标准间隙
const LAYOUT_87: LayoutDef = {
  id: "87",
  name: "TKL",
  keys: 87,
  rows: [
    // F 行 + Esc + 编辑区上排（Prt/Scr/Pause）
    [
      { id: "esc", label: "Esc", variant: "mod", rdevCode: "Escape" },
      { id: "_gap1", label: "", w: 0.5, variant: "mod", rdevCode: "" }, // 间隙
      { id: "f1", label: "F1", variant: "fn", rdevCode: "F1" },
      { id: "f2", label: "F2", variant: "fn", rdevCode: "F2" },
      { id: "f3", label: "F3", variant: "fn", rdevCode: "F3" },
      { id: "f4", label: "F4", variant: "fn", rdevCode: "F4" },
      { id: "_gap2", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "f5", label: "F5", variant: "fn", rdevCode: "F5" },
      { id: "f6", label: "F6", variant: "fn", rdevCode: "F6" },
      { id: "f7", label: "F7", variant: "fn", rdevCode: "F7" },
      { id: "f8", label: "F8", variant: "fn", rdevCode: "F8" },
      { id: "_gap3", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "f9", label: "F9", variant: "fn", rdevCode: "F9" },
      { id: "f10", label: "F10", variant: "fn", rdevCode: "F10" },
      { id: "f11", label: "F11", variant: "fn", rdevCode: "F11" },
      { id: "f12", label: "F12", variant: "fn", rdevCode: "F12" },
      { id: "_gap4", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "prtsc", label: "Prt", variant: "fn", rdevCode: "PrintScreen" },
      { id: "scrlk", label: "Scr", variant: "fn", rdevCode: "ScrollLock" },
      { id: "pause", label: "Pau", variant: "fn", rdevCode: "Pause" },
    ],
    // 数字行 + 编辑区上 3 键
    [
      ...LAYOUT_60.rows[0],
      { id: "_gap5", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "insert", label: "Ins", variant: "mod", rdevCode: "Insert" },
      { id: "home", label: "Home", variant: "mod", rdevCode: "Home" },
      { id: "pgup", label: "PgUp", variant: "mod", rdevCode: "PageUp" },
    ],
    // QWERTY 行 + 编辑区中 3 键
    [
      ...LAYOUT_60.rows[1],
      { id: "_gap6", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "del", label: "Del", variant: "mod", rdevCode: "Delete" },
      { id: "end", label: "End", variant: "mod", rdevCode: "End" },
      { id: "pgdn", label: "PgDn", variant: "mod", rdevCode: "PageDown" },
    ],
    // ASDF 行
    LAYOUT_60.rows[2],
    // ZXCV 行 + Up
    [
      ...LAYOUT_60.rows[3],
      { id: "_gap7", label: "", w: 1.25, variant: "mod", rdevCode: "" },
      { id: "up", label: "↑", variant: "mod", rdevCode: "UpArrow" },
    ],
    // 底排 + 方向键下排
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", w: 1.25, variant: "mod", rdevCode: "Function" },
      { id: "menu", label: "Menu", w: 1.25, variant: "mod", rdevCode: "Apps" },
      { id: "rctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "RightControl" },
      { id: "_gap8", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "left", label: "←", variant: "mod", rdevCode: "LeftArrow" },
      { id: "down", label: "↓", variant: "mod", rdevCode: "DownArrow" },
      { id: "right", label: "→", variant: "mod", rdevCode: "RightArrow" },
    ],
  ],
};

// ============ 96% / 98键 ============
// 紧凑全配列：F 行 + 主区 + 编辑键 + 小键盘，几乎无间隙
const LAYOUT_96: LayoutDef = {
  id: "96",
  name: "96%",
  keys: 98,
  rows: [
    // F 行 + Esc + 小键盘顶行
    [
      { id: "esc", label: "Esc", variant: "mod", rdevCode: "Escape" },
      { id: "f1", label: "F1", variant: "fn", rdevCode: "F1" },
      { id: "f2", label: "F2", variant: "fn", rdevCode: "F2" },
      { id: "f3", label: "F3", variant: "fn", rdevCode: "F3" },
      { id: "f4", label: "F4", variant: "fn", rdevCode: "F4" },
      { id: "f5", label: "F5", variant: "fn", rdevCode: "F5" },
      { id: "f6", label: "F6", variant: "fn", rdevCode: "F6" },
      { id: "f7", label: "F7", variant: "fn", rdevCode: "F7" },
      { id: "f8", label: "F8", variant: "fn", rdevCode: "F8" },
      { id: "f9", label: "F9", variant: "fn", rdevCode: "F9" },
      { id: "f10", label: "F10", variant: "fn", rdevCode: "F10" },
      { id: "f11", label: "F11", variant: "fn", rdevCode: "F11" },
      { id: "f12", label: "F12", variant: "fn", rdevCode: "F12" },
      { id: "prtsc", label: "Prt", variant: "fn", rdevCode: "PrintScreen" },
      { id: "scrlk", label: "Scr", variant: "fn", rdevCode: "ScrollLock" },
      { id: "pause", label: "Pau", variant: "fn", rdevCode: "Pause" },
      { id: "numlock", label: "Num", variant: "fn", rdevCode: "NumLock" },
      { id: "kp_divide", label: "/", variant: "num", rdevCode: "KpDivide" },
      { id: "kp_multiply", label: "*", variant: "num", rdevCode: "KpMultiply" },
      { id: "kp_minus", label: "-", variant: "num", rdevCode: "KpMinus" },
    ],
    // 数字行 + 小键盘第二行
    [
      ...LAYOUT_60.rows[0],
      { id: "kp_7", label: "7", variant: "num", rdevCode: "Kp7" },
      { id: "kp_8", label: "8", variant: "num", rdevCode: "Kp8" },
      { id: "kp_9", label: "9", variant: "num", rdevCode: "Kp9" },
      { id: "kp_plus", label: "+", w: 1, variant: "num", rdevCode: "KpPlus" },
    ],
    // QWERTY 行 + 小键盘第三行
    [
      ...LAYOUT_60.rows[1],
      { id: "kp_4", label: "4", variant: "num", rdevCode: "Kp4" },
      { id: "kp_5", label: "5", variant: "num", rdevCode: "Kp5" },
      { id: "kp_6", label: "6", variant: "num", rdevCode: "Kp6" },
      { id: "kp_plus_cont", label: "", w: 1, variant: "num", rdevCode: "" }, // + 键占两行
    ],
    // ASDF 行 + 小键盘第四行
    [
      ...LAYOUT_60.rows[2],
      { id: "kp_1", label: "1", variant: "num", rdevCode: "Kp1" },
      { id: "kp_2", label: "2", variant: "num", rdevCode: "Kp2" },
      { id: "kp_3", label: "3", variant: "num", rdevCode: "Kp3" },
      { id: "kp_enter", label: "Ent", w: 1, variant: "mod", rdevCode: "KpReturn" },
    ],
    // ZXCV 行 + 小键盘第五行
    [
      ...LAYOUT_60.rows[3],
      { id: "up", label: "↑", variant: "mod", rdevCode: "UpArrow" },
      { id: "kp_0", label: "0", w: 2, variant: "num", rdevCode: "Kp0" },
      { id: "kp_dot", label: ".", variant: "num", rdevCode: "KpDecimal" },
      { id: "kp_enter_cont", label: "", w: 1, variant: "mod", rdevCode: "" }, // Enter 占两行
    ],
    // 底排 + 方向键 + 小键盘底行
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", variant: "mod", rdevCode: "Function" },
      { id: "left", label: "←", variant: "mod", rdevCode: "LeftArrow" },
      { id: "down", label: "↓", variant: "mod", rdevCode: "DownArrow" },
      { id: "right", label: "→", variant: "mod", rdevCode: "RightArrow" },
    ],
  ],
};

// ============ 104键 / 100% (全尺寸) ============
// 标准全键盘：F 行分组 + 主区 + 独立编辑区 + 独立方向键 + 完整小键盘（17键）
const LAYOUT_104: LayoutDef = {
  id: "104",
  name: "100%",
  keys: 104,
  rows: [
    // F 行 + Esc，带标准分组间隙
    [
      { id: "esc", label: "Esc", variant: "mod", rdevCode: "Escape" },
      { id: "_gap1", label: "", w: 1, variant: "mod", rdevCode: "" },
      { id: "f1", label: "F1", variant: "fn", rdevCode: "F1" },
      { id: "f2", label: "F2", variant: "fn", rdevCode: "F2" },
      { id: "f3", label: "F3", variant: "fn", rdevCode: "F3" },
      { id: "f4", label: "F4", variant: "fn", rdevCode: "F4" },
      { id: "_gap2", label: "", w: 0.5, variant: "mod", rdevCode: "" },
      { id: "f5", label: "F5", variant: "fn", rdevCode: "F5" },
      { id: "f6", label: "F6", variant: "fn", rdevCode: "F6" },
      { id: "f7", label: "F7", variant: "fn", rdevCode: "F7" },
      { id: "f8", label: "F8", variant: "fn", rdevCode: "F8" },
      { id: "_gap3", label: "", w: 0.5, variant: "mod", rdevCode: "" },
      { id: "f9", label: "F9", variant: "fn", rdevCode: "F9" },
      { id: "f10", label: "F10", variant: "fn", rdevCode: "F10" },
      { id: "f11", label: "F11", variant: "fn", rdevCode: "F11" },
      { id: "f12", label: "F12", variant: "fn", rdevCode: "F12" },
      { id: "_gap4", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "prtsc", label: "Prt", variant: "fn", rdevCode: "PrintScreen" },
      { id: "scrlk", label: "Scr", variant: "fn", rdevCode: "ScrollLock" },
      { id: "pause", label: "Pau", variant: "fn", rdevCode: "Pause" },
      { id: "_gap5", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "numlock", label: "Num", variant: "fn", rdevCode: "NumLock" },
      { id: "kp_divide", label: "/", variant: "num", rdevCode: "KpDivide" },
      { id: "kp_multiply", label: "*", variant: "num", rdevCode: "KpMultiply" },
      { id: "kp_minus", label: "-", variant: "num", rdevCode: "KpMinus" },
    ],
    // 数字行 + 编辑区 + 小键盘
    [
      ...LAYOUT_60.rows[0],
      { id: "_gap6", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "insert", label: "Ins", variant: "mod", rdevCode: "Insert" },
      { id: "home", label: "Home", variant: "mod", rdevCode: "Home" },
      { id: "pgup", label: "PgUp", variant: "mod", rdevCode: "PageUp" },
      { id: "_gap7", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "kp_7", label: "7", variant: "num", rdevCode: "Kp7" },
      { id: "kp_8", label: "8", variant: "num", rdevCode: "Kp8" },
      { id: "kp_9", label: "9", variant: "num", rdevCode: "Kp9" },
      { id: "kp_plus", label: "+", w: 1, variant: "num", rdevCode: "KpPlus" },
    ],
    // QWERTY 行 + 编辑区 + 小键盘
    [
      ...LAYOUT_60.rows[1],
      { id: "_gap8", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "del", label: "Del", variant: "mod", rdevCode: "Delete" },
      { id: "end", label: "End", variant: "mod", rdevCode: "End" },
      { id: "pgdn", label: "PgDn", variant: "mod", rdevCode: "PageDown" },
      { id: "_gap9", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "kp_4", label: "4", variant: "num", rdevCode: "Kp4" },
      { id: "kp_5", label: "5", variant: "num", rdevCode: "Kp5" },
      { id: "kp_6", label: "6", variant: "num", rdevCode: "Kp6" },
      { id: "kp_plus_cont", label: "", w: 1, variant: "num", rdevCode: "" },
    ],
    // ASDF 行 + 小键盘
    [
      ...LAYOUT_60.rows[2],
      { id: "_gap10", label: "", w: 3.5, variant: "mod", rdevCode: "" },
      { id: "kp_1", label: "1", variant: "num", rdevCode: "Kp1" },
      { id: "kp_2", label: "2", variant: "num", rdevCode: "Kp2" },
      { id: "kp_3", label: "3", variant: "num", rdevCode: "Kp3" },
      { id: "kp_enter", label: "Ent", w: 1, variant: "mod", rdevCode: "KpReturn" },
    ],
    // ZXCV 行 + Up + 小键盘
    [
      ...LAYOUT_60.rows[3],
      { id: "_gap11", label: "", w: 1.25, variant: "mod", rdevCode: "" },
      { id: "up", label: "↑", variant: "mod", rdevCode: "UpArrow" },
      { id: "_gap12", label: "", w: 1.25, variant: "mod", rdevCode: "" },
      { id: "kp_0", label: "0", w: 2, variant: "num", rdevCode: "Kp0" },
      { id: "kp_dot", label: ".", variant: "num", rdevCode: "KpDecimal" },
      { id: "kp_enter_cont", label: "", w: 1, variant: "mod", rdevCode: "" },
    ],
    // 底排 + 方向键
    [
      { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "LeftControl" },
      { id: "lwin", label: "Win", w: 1.25, variant: "mod", rdevCode: "MetaLeft" },
      { id: "lalt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "LeftAlt" },
      { id: "space", label: "", w: 6.25, variant: "space", rdevCode: "Space" },
      { id: "ralt", label: "Alt", w: 1.25, variant: "mod", rdevCode: "RightAlt" },
      { id: "fn", label: "Fn", w: 1.25, variant: "mod", rdevCode: "Function" },
      { id: "menu", label: "Menu", w: 1.25, variant: "mod", rdevCode: "Apps" },
      { id: "rctrl", label: "Ctrl", w: 1.25, variant: "mod", rdevCode: "RightControl" },
      { id: "_gap13", label: "", w: 0.25, variant: "mod", rdevCode: "" },
      { id: "left", label: "←", variant: "mod", rdevCode: "LeftArrow" },
      { id: "down", label: "↓", variant: "mod", rdevCode: "DownArrow" },
      { id: "right", label: "→", variant: "mod", rdevCode: "RightArrow" },
    ],
  ],
};

export const ALL_LAYOUTS: LayoutDef[] = [
  LAYOUT_60,
  LAYOUT_64,
  LAYOUT_75,
  LAYOUT_87,
  LAYOUT_96,
  LAYOUT_104,
];

export function getLayout(id: LayoutId): LayoutDef {
  return ALL_LAYOUTS.find((l) => l.id === id) || LAYOUT_104;
}
