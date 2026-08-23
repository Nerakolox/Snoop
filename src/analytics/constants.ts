/**
 * 分析层常量配置 —— 集中放置所有可调参数。
 */

import type { Intensity } from "./types";

/** 鼠标移动像素 → 物理距离（米）的换算系数。
 * 假设典型显示器 DPI ~96，1 像素约等于 0.26mm。
 * 这个值可根据实际显示器调整；1000 像素 ≈ 0.26 米。 */
export const MOUSE_PIXELS_PER_METER = 3846; // ~1 米 = 3846 像素

/** "此刻状态"判断的时间窗口（ms）—— 取最近这段时间的桶算当前强度。 */
export const RECENT_ACTIVITY_WINDOW_MS = 2 * 60_000; // 2 分钟

/**
 * 时长 → 0..5 六档（品牌紫深浅阶索引）。sqrt 感知分档，把小值多拉开几档。
 * 概览页节奏图与规律页趋势图共用这一条，保证「时长深浅」的视觉语言一致。
 */
export function durationLevel(ms: number, maxMs: number): number {
  if (ms <= 0 || maxMs <= 0) return 0;
  return Math.min(5, Math.round(Math.sqrt(ms / maxMs) * 5));
}

/** 档位 → 主题感知的品牌紫 CSS 变量引用（--duration-1 最浅 → --duration-6 最深）。 */
export function durationColorVar(level: number): string {
  return `var(--duration-${level + 1})`;
}

/** 侧栏实时区的四态标签——五档强度折叠成四态，3/4 合并为"爆肝中"。 */
export function moodLabelOf(intensity: Intensity): string {
  if (intensity >= 3) return "爆肝中";
  if (intensity === 2) return "正常节奏";
  if (intensity === 1) return "摸鱼中";
  return "挂机中";
}

/** 猫吐槽文案库 —— 按强度 + App 类型匹配。
 * 结构：intensity → appPattern → quips[]，随机抽一句。
 * appPattern 用简单的关键词匹配（toLowerCase + includes）。 */
type QuipDb = Record<
  0 | 1 | 2 | 3 | 4,
  { pattern?: string; quips: string[] }[]
>;

export const CAT_QUIPS: QuipDb = {
  0: [
    {
      quips: [
        "人呢？",
        "没动静了",
        "键盘睡着了",
        "屏幕快落灰了",
        "手放哪儿了？",
        "又没声了",
        "鼠标也歇了",
      ],
    },
  ],
  1: [
    {
      pattern: "chrome",
      quips: [
        "浏览器还开着呢",
        "标签页又开了一片",
        "刷到哪了，这么投入",
      ],
    },
    {
      pattern: "qq",
      quips: [
        "水群水得挺勤",
        "对话框比工作多",
        "聊得比敲得多",
      ],
    },
    {
      pattern: "wechat",
      quips: [
        "微信又占上风了",
        "消息回得挺快",
        "群聊翻得勤",
      ],
    },
    {
      quips: [
        "哦，又在刷了",
        "摸得挺专业",
        "今天这鱼，摸得开心吗？",
        "动一下歇一下，挺会",
        "这强度，主打一个陪跑",
        "手是借来用用的",
        "茶叶泡开了没",
      ],
    },
  ],
  2: [
    {
      pattern: "vscode",
      quips: [
        "编辑器开着，像那么回事",
        "代码敲得倒是不慌",
        "这个节奏，能交差吗？",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "命令行敲得有模有样",
        "黑框框里跑着啥",
        "命令倒是没停",
      ],
    },
    {
      quips: [
        "行吧，还算像样",
        "就这？",
        "稳定输出，及格线上下",
        "节奏是有了，亮点呢",
        "照这么敲，勉强能看",
        "不紧不慢，差强人意",
        "手没停，脑子在不在？",
      ],
    },
  ],
  3: [
    {
      pattern: "vscode",
      quips: [
        "键盘倒是没停",
        "码农上头了",
        "Bug 修了几个？",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "命令刷得挺快",
        "终端快被敲出火星了",
        "这一通操作，出事了没",
      ],
    },
    {
      quips: [
        "终于干正事了",
        "这强度，像被 deadline 追",
        "手速上来了",
        "专注得让人不习惯",
        "敲这么猛，是要交差了？",
        "状态还行，别停",
        "难得，居然在干活",
      ],
    },
  ],
  4: [
    {
      pattern: "vscode",
      quips: [
        "代码敲出残影了",
        "VSCode 快扛不住了",
        "在救火还是在重构？",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "命令刷屏刷出残影了",
        "终端快跟不上了",
        "这是在打仗吗？",
      ],
    },
    {
      quips: [
        "这速度，键盘要冒烟了",
        "手速拉满，命还要吗？",
        "爆肝实锤了",
        "键盘招谁惹谁了",
        "键鼠齐飞，当心手",
        "这么拼，图什么",
        "慢点，键盘没买保险",
      ],
    },
  ],
};

/** 从吐槽库里随机挑一句。appName 转小写后匹配 pattern。 */
export function pickCatQuip(
  intensity: 0 | 1 | 2 | 3 | 4,
  appName: string
): string {
  const candidates = CAT_QUIPS[intensity];
  const app = appName.toLowerCase();
  // 先找有 pattern 且匹配的
  const matched = candidates.find((c) => c.pattern && app.includes(c.pattern));
  const pool = matched
    ? matched.quips
    : candidates.find((c) => !c.pattern)?.quips || [];
  if (pool.length === 0) return "喵～";
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 时间线突变标记的吐槽模板库 —— 按强度分池，`{H}` 会被替换成具体小时数。 */
const SPIKE_QUIP_TEMPLATES: Record<0 | 1 | 2 | 3 | 4, string[]> = {
  0: ["{H}点这波动静，猫都被吵醒了喵", "{H}点忽然有点响动喵，谁在敲键盘？"],
  1: ["{H}点悄悄提了提速喵，摸鱼摸出加速度了？", "{H}点这一下比之前活跃了点喵"],
  2: ["{H}点节奏突然往上走了喵，进入状态了？", "{H}点这波提速，是灵感来了喵？"],
  3: ["{H}点突然来劲了喵，键盘要冒烟了", "{H}点这速度，是不是被 deadline 追了喵？"],
  4: ["{H}点直接原地起飞喵！手速拉满了！", "{H}点这是爆发了喵？键盘都要被敲穿了！"],
};

/** 从突变吐槽库里随机挑一句，替换具体时刻。 */
export function pickSpikeQuip(hour: number, intensity: 0 | 1 | 2 | 3 | 4): string {
  const pool = SPIKE_QUIP_TEMPLATES[intensity];
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template.replace("{H}", String(hour));
}
