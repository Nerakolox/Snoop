/**
 * KLE (keyboard-layout-editor.com) 格式解析器
 * 将 KLE JSON 转换为可渲染的键位数据。
 *
 * 注意：本解析器只服务于设置页的配列选择器（预览/导入校验），输入页的渲染
 * 已改用项目自有配列（src/keyboardLayout.ts + src/assets/layout/ansi-104.json），
 * 不再走这里。印字→按键身份的那套映射（KLE_LABEL_TO_RDEV 等）已随按键身份
 * 统一为 W3C `code` 而删除。
 */

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
