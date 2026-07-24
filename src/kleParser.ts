/**
 * KLE (keyboard-layout-editor.com) 格式解析器
 * 将 KLE JSON 转换为可渲染的键位数据
 */

import { lookupTiers } from "./layouts/labels";

export type KLEKey = {
  /** 键位标签（显示在键帽上的文字） */
  label: string;
  /** 键宽（单位：U，标准键宽为 1） */
  w: number;
  /** 键高（单位：U，标准键高为 1） */
  h: number;
  /** 当前行内的 X 坐标（单位：U） */
  x: number;
  /** Y 坐标（单位：U，全局累积） */
  y: number;
  /** 行索引 */
  row: number;
  /** 列索引（在当前行内的顺序） */
  col: number;
  /** 装饰键（KLE `d:true`）：标记但不丢弃，渲染层不画键帽、不参与热力 */
  decal: boolean;
};

/**
 * 解析结果：键位数组 + 一次性算好的边界 + 未支持特性记录。
 */
export type ParsedLayout = {
  keys: KLEKey[];
  /** max(k.x + k.w)，配列总 U 宽 */
  maxX: number;
  /** max(k.y + k.h)，配列总 U 高 */
  maxY: number;
  /** 检测到但不支持的 KLE 特性（x2/y2/w2/h2/r/rx/ry），供导入时提示 */
  unsupportedFeatures: string[];
};

type KLEProperties = {
  x?: number; // 水平偏移
  y?: number; // 垂直偏移（换行用）
  w?: number; // 键宽
  h?: number; // 键高
  a?: number; // 对齐方式（刻意忽略：对齐由渲染层独占）
  [key: string]: any; // 其他属性暂忽略
};

/** 一次性（放置一个键后重置）之外，需检测并上报的不支持特性键。 */
const UNSUPPORTED_KEYS = ["x2", "y2", "w2", "h2", "r", "rx", "ry"] as const;

/**
 * 解析 KLE JSON 为结构化配列（键位 + 边界 + 未支持特性）
 * @param kleJson KLE 格式的 JSON 数组
 * @returns ParsedLayout
 */
export function parseKLE(kleJson: any[]): ParsedLayout {
  const keys: KLEKey[] = [];
  const unsupported = new Set<string>();

  let currentY = 0; // 全局 Y 坐标
  let currentX = 0; // 当前行 X 坐标
  let rowIndex = 0;
  let colIndex = 0;

  // 当前键的属性（从属性对象累积）
  let currentProps: KLEProperties = {
    w: 1,
    h: 1,
  };
  // decal 是一次性属性，随 w/h 一起重置
  let currentDecal = false;

  for (const row of kleJson) {
    if (!Array.isArray(row)) continue;

    currentX = 0; // 每行开头重置 X
    colIndex = 0;

    for (const item of row) {
      if (typeof item === "string") {
        // 字符串 = 键位标签
        const label = item;

        // 应用当前属性，生成键位
        keys.push({
          label,
          w: currentProps.w ?? 1,
          h: currentProps.h ?? 1,
          x: currentX,
          y: currentY,
          row: rowIndex,
          col: colIndex,
          decal: currentDecal,
        });

        // 推进 X 坐标（键宽）
        currentX += currentProps.w ?? 1;
        colIndex++;

        // 重置键属性为默认值（每个键后重置）
        currentProps = { w: 1, h: 1 };
        currentDecal = false;
      } else if (typeof item === "object" && item !== null) {
        // 对象 = 属性修改
        if (item.y !== undefined) {
          // y 表示垂直偏移（通常在新行开头，表示与上一行的间距）
          currentY += item.y;
        }
        if (item.x !== undefined) {
          // x 表示水平偏移（在当前行内跳过空隙）
          currentX += item.x;
        }
        if (item.w !== undefined) {
          currentProps.w = item.w;
        }
        if (item.h !== undefined) {
          currentProps.h = item.h;
        }
        if (item.d === true) {
          currentDecal = true;
        }
        // 记录检测到的不支持特性（不使用，仅上报）
        for (const k of UNSUPPORTED_KEYS) {
          if (item[k] !== undefined) unsupported.add(k);
        }
        // n/c/t/a/f 维持忽略：键色由热力档独占、字号由分级系统独占
      }
    }

    // 行结束，Y 推进 1U
    currentY += 1;
    rowIndex++;
  }

  let maxX = 0;
  let maxY = 0;
  for (const k of keys) {
    if (k.x + k.w > maxX) maxX = k.x + k.w;
    if (k.y + k.h > maxY) maxY = k.y + k.h;
  }

  return { keys, maxX, maxY, unsupportedFeatures: [...unsupported] };
}

/**
 * KLE 键标签 → rdev key_code 映射
 * 用于将渲染出的键位匹配到真实按键数据
 */
export const KLE_LABEL_TO_RDEV: Record<string, string> = {
  // ========== 字母键 ==========
  Q: "KeyQ",
  W: "KeyW",
  E: "KeyE",
  R: "KeyR",
  T: "KeyT",
  Y: "KeyY",
  U: "KeyU",
  I: "KeyI",
  O: "KeyO",
  P: "KeyP",
  A: "KeyA",
  S: "KeyS",
  D: "KeyD",
  F: "KeyF",
  G: "KeyG",
  H: "KeyH",
  J: "KeyJ",
  K: "KeyK",
  L: "KeyL",
  Z: "KeyZ",
  X: "KeyX",
  C: "KeyC",
  V: "KeyV",
  B: "KeyB",
  N: "KeyN",
  M: "KeyM",

  // ========== 数字行（顶排）==========
  "~\n`": "BackQuote",
  "!\n1": "Num1",
  "@\n2": "Num2",
  "#\n3": "Num3",
  "$\n4": "Num4",
  "%\n5": "Num5",
  "^\n6": "Num6",
  "&\n7": "Num7",
  "*\n8": "Num8",
  "(\n9": "Num9",
  ")\n0": "Num0",
  "_\n-": "Minus",
  "+\n=": "Equal",

  // 符号键（仅符号形式）
  "`": "BackQuote",
  "1": "Num1",
  "2": "Num2",
  "3": "Num3",
  "4": "Num4",
  "5": "Num5",
  "6": "Num6",
  "7": "Num7",
  "8": "Num8",
  "9": "Num9",
  "0": "Num0",
  "-": "Minus",
  "=": "Equal",

  // ========== 标点符号 ==========
  "{\n[": "LeftBracket",
  "}\n]": "RightBracket",
  "|\n\\": "BackSlash",
  ":\n;": "SemiColon",
  '"\n\'': "Quote",
  "<\n,": "Comma",
  ">\n.": "Period",
  "?\n/": "Slash",

  "[": "LeftBracket",
  "]": "RightBracket",
  "\\": "BackSlash",
  ";": "SemiColon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",

  // ========== 修饰键 ==========
  Tab: "Tab",
  tab: "Tab",
  "Caps Lock": "CapsLock",
  "caps lock": "CapsLock",
  Shift: "ShiftLeft",
  shift: "ShiftLeft",
  Ctrl: "ControlLeft",
  control: "ControlLeft",
  Alt: "Alt",
  alt: "Alt",
  option: "Alt",
  Win: "MetaLeft",
  command: "MetaLeft",
  "⌘": "MetaLeft",
  Menu: "Apps",
  Backspace: "Backspace",
  "Back Space": "Backspace",
  delete: "Delete",
  Enter: "Return",
  enter: "Return",
  return: "Return",
  Esc: "Escape",
  esc: "Escape",
  Fn: "Function",
  fn: "Function",

  // 40% 配列特殊修饰键
  Hyper: "ControlLeft",
  Super: "MetaLeft",
  Meta: "MetaLeft",

  // ========== 功能键 ==========
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",

  // ========== 编辑键 ==========
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PgUp: "PageUp",
  PgDn: "PageDown",
  "Page Up": "PageUp",
  "Page Down": "PageDown",

  // ========== 方向键 ==========
  "↑": "UpArrow",
  "↓": "DownArrow",
  "←": "LeftArrow",
  "→": "RightArrow",

  // ========== 小键盘 ==========
  "Num Lock": "NumLock",
  "/": "KpDivide",
  "*": "KpMultiply",
  "+": "KpPlus",

  // 小键盘数字（带副标签形式，如 "7\nHome"）
  "7\nHome": "Kp7",
  "8\n↑": "Kp8",
  "9\nPgUp": "Kp9",
  "4\n←": "Kp4",
  "6\n→": "Kp6",
  "1\nEnd": "Kp1",
  "2\n↓": "Kp2",
  "3\nPgDn": "Kp3",
  "0\nIns": "Kp0",
  ".\nDel": "KpDecimal",

  // ========== 其他 ==========
  PrtSc: "PrintScreen",
  "Scroll Lock": "ScrollLock",
  "Pause\nBreak": "Pause",

  // 84% 键盘的组合标签
  "PrtSc\nNmLk": "PrintScreen",
  "Pause\nScrLk": "Pause",
  "Delete\nInsert": "Delete",

  // 空格（空字符串或 "Space"）
  "": "Space",
  Space: "Space",
};

/**
 * 根据 KLE 键标签获取 rdev key_code
 * @param label KLE 键标签
 * @returns rdev key_code，未找到返回 undefined
 */
export function getLabelRdevCode(label: string): string | undefined {
  if (label == null) return undefined;

  // Direct match — handles "" → "Space" and all normal labels
  if (KLE_LABEL_TO_RDEV[label] !== undefined) {
    return KLE_LABEL_TO_RDEV[label];
  }

  // 清理 HTML 标记后再匹配
  let cleanLabel = label;

  // 移除 <br> 标签（替换为空格）
  cleanLabel = cleanLabel.replace(/<br\s*\/?>/gi, " ");

  // 移除 Font Awesome 图标标记
  cleanLabel = cleanLabel.replace(/<i\s+class=['"]fa\s+[^'"]*['"]><\/i>/gi, "");

  // 移除其他 HTML 标签（保留内容）
  cleanLabel = cleanLabel.replace(/<[^>]+>/g, "");

  // 清理多余空白
  cleanLabel = cleanLabel.trim();

  // 尝试匹配清理后的标签
  if (KLE_LABEL_TO_RDEV[cleanLabel]) {
    return KLE_LABEL_TO_RDEV[cleanLabel];
  }

  // 如果有 \n，尝试取最后一部分（主标签）
  const parts = cleanLabel.split("\n");
  const mainLabel = parts[parts.length - 1].trim();

  if (KLE_LABEL_TO_RDEV[mainLabel]) {
    return KLE_LABEL_TO_RDEV[mainLabel];
  }

  return undefined;
}

/**
 * Font Awesome 图标类名映射
 * 将 KLE 中的 FA 类名映射到 @fortawesome/free-solid-svg-icons 中的实际图标名称
 */
export const FA_CLASS_TO_ICON_NAME: Record<string, string> = {
  "fa-backward": "faBackward",
  "fa-play": "faPlay",
  "fa-pause": "faPause",
  "fa-forward": "faForward",
  "fa-volume-off": "faVolumeXmark",
  "fa-volume-down": "faVolumeDown",
  "fa-volume-up": "faVolumeHigh",
  "fa-eject": "faEject",
  "fa-step-backward": "faBackwardStep",
  "fa-step-forward": "faForwardStep",
  "fa-fast-backward": "faBackwardFast",
  "fa-fast-forward": "faForwardFast",
};

/**
 * 提取键标签中的 Font Awesome 图标类名
 * @param text 键标签文本
 * @returns 图标类名（如 "fa-play"），如果没有则返回 undefined
 */
export function extractFAIcon(text: string): string | undefined {
  // 匹配多种 FA 图标标记格式：
  // <i class="fa fa-play"></i>
  // <i class='fa fa-play'></i>
  // <i class="fa fa-play"/>
  // <i class='fa fa-play'/>
  const match = text.match(/<i\s+class=['"]fa\s+([^'"]+)['"]\s*\/?>/i);
  if (!match) return undefined;

  const classNames = match[1].trim().split(/\s+/);
  return classNames.find((c) => c.startsWith("fa-"));
}

/**
 * 提取键标签的显示文本（取主标签）
 * KLE 键标签格式：主标签在 \n 前，副标签在 \n 后
 * 例如："1\n!" 主标签是 "1"，副标签是 "!"（Shift+1）
 *
 * @param label 完整键标签
 * @returns 显示文本（保留 FA 图标标记，供组件渲染）
 */
export function getDisplayLabel(label: string): string {
  if (!label) return "";

  // 如果有 \n，取第一部分（主标签在前）
  const parts = label.split("\n");
  let mainLabel = parts[0];

  // 1. 移除 <br> 标签（替换为空格）
  mainLabel = mainLabel.replace(/<br\s*\/?>/gi, " ");

  // 2. 移除其他 HTML 标签（但保留 <i class="fa ..."> 图标标记）
  mainLabel = mainLabel.replace(/<(?!i\s+class=['"]fa\s)[^>]+>/g, "");

  // 3. 清理多余空白
  mainLabel = mainLabel.trim();

  // 命名键走三级表的 abbr 档（排行榜/日志等纯文本场景用简称）。
  const tiers = lookupTiers(mainLabel);
  if (tiers) return tiers.abbr;

  return mainLabel || label;
}

/**
 * 解析键标签的主副字符（用于双字符渲染）
 * @param label 完整键标签
 * @returns { main: 主字符, sub?: 副字符 }
 */
export function parseLabelParts(label: string): { main: string; sub?: string } {
  if (!label) return { main: "" };

  const parts = label.split("\n");

  // 清理 HTML 标签的辅助函数
  const cleanLabel = (text: string) => {
    let cleaned = text.replace(/<br\s*\/?>/gi, " ");
    cleaned = cleaned.replace(/<(?!i\s+class=['"]fa\s)[^>]+>/g, "");
    return cleaned.trim();
  };

  const main = cleanLabel(parts[0]);
  const sub = parts.length > 1 ? cleanLabel(parts[1]) : undefined;

  return { main, sub };
}
