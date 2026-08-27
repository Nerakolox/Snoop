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

/** 侧栏实时区的四态标签——五档强度折叠成四态，3/4 合并为"爆肝中"。 */
export function moodLabelOf(intensity: Intensity): string {
  if (intensity >= 3) return "爆肝中";
  if (intensity === 2) return "正常节奏";
  if (intensity === 1) return "摸鱼中";
  return "挂机中";
}

/** 侧栏实时区的四态颜文字——折叠口径与 moodLabelOf 完全一致，四张脸互不相同。
 * 爆肝档的 (=°Д°=) 取自「！？这么强？！」表情包的睁眼 O 型嘴，跟吐槽库的梗同源。 */
export function moodFaceOf(intensity: Intensity): string {
  if (intensity >= 3) return "(=°Д°=)";
  if (intensity === 2) return "(=・ω・=)";
  if (intensity === 1) return "(=¬ω¬=)";
  return "(=_=)";
}

/** 猫吐槽文案库 —— 按强度 + App 类型匹配。
 * 结构：intensity → appPattern → quips[]，随机抽一句。
 * appPattern 用简单的关键词匹配（toLowerCase + includes）。
 *
 * 人设：贱兮兮、爱抬杠、句句带梗（与 ai/quip 的 SYSTEM_PROMPT 同源）。
 * 这里是 AI 不可用时的兜底，硬编码的梗会过期，所以只用最耐放的那批
 * （「就这？」「啊这」「啊对对对」「这位更是重量级」），
 * 时效性强的新梗留给 AI 侧——那边改 prompt 就能换，不用发版。
 * 只用品类词（浏览器 / 群 / 编辑器 / 终端），不出现具体应用名，与 AI 侧口径一致。 */
type QuipDb = Record<
  0 | 1 | 2 | 3 | 4,
  { pattern?: string; quips: string[] }[]
>;

export const CAT_QUIPS: QuipDb = {
  // 挂机档只能拿「没输入」这个事实说事，不能断言人跑了/偷懒（与 AI 侧同一条禁令）。
  0: [
    {
      quips: [
        "！？这么闲？！",
        "啊？没动静了",
        "活人感呢",
        "人呢，我要验牌",
        "这位更是静音级",
        "键盘凉了，牌也不亮",
        "手放哪儿了，摊牌吧",
      ],
    },
  ],
  1: [
    {
      pattern: "chrome",
      quips: [
        "！？这么会刷？！",
        "标签页开一片，就这？",
        "刷一下就能想出办法？",
      ],
    },
    {
      pattern: "qq",
      quips: [
        "！？这么能聊？！",
        "水群水出专业度了属于是",
        "聊得比敲得多，我要验牌",
      ],
    },
    {
      pattern: "wechat",
      quips: [
        "啊对对对，都是正事",
        "消息回得比活快",
        "群聊翻得勤，就这？",
      ],
    },
    {
      quips: [
        "你说你在工作？我要验牌",
        "啊对对对，在忙呢",
        "！？这么会摸？！",
        "间歇性上进了属于是",
        "这位更是重量级",
        "那你厉害咯",
        "手是借来用用的吧",
      ],
    },
  ],
  2: [
    {
      pattern: "vscode",
      quips: [
        "代码敲得不慌，就这？",
        "啊这，及格线上下",
        "这节奏，能交差咯",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "命令有模有样，就这？",
        "黑框框里跑着啥，我要验牌",
        "啊这，勉强算在干活",
      ],
    },
    {
      quips: [
        "就这？",
        "啊这",
        "及格了属于是",
        "那你厉害咯",
        "稳定发挥，稳定平庸",
        "手没停，脑子在不在",
        "牌没有问题，就是不亮",
      ],
    },
  ],
  3: [
    {
      pattern: "vscode",
      quips: [
        "键盘没停，！？强强？！",
        "Bug 修了几个，我要验牌",
        "码得挺猛，早干嘛去了",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "！？这么能敲？！",
        "命令刷得飞起，早干嘛去了",
        "这一通操作，出事了没",
      ],
    },
    {
      quips: [
        "！？强强？！",
        "早干嘛去了",
        "他急了他急了",
        "难得，居然在干活",
        "临时抱佛脚了属于是",
        "遥遥领先呢",
        "专注得让人不习惯",
      ],
    },
  ],
  4: [
    {
      pattern: "vscode",
      quips: [
        "代码敲出残影，！？强强？！",
        "在救火还是在重构，我要验牌",
        "编辑器都快应激了",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "！？这么猛？！",
        "命令刷屏刷出残影了属于是",
        "终端跟不上了，急了急了",
      ],
    },
    {
      quips: [
        "！？强强？！",
        "手速拉满，命还要吗",
        "键盘要冒烟了属于是",
        "他急了他急了他急了",
        "这位更是重量级",
        "遥遥领先，键盘先烈",
        "键盘招谁惹谁了",
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
  // 兜底的兜底（池为空才会走到）：「啊这」是万能的无语反应，比「喵～」更贴人设。
  if (pool.length === 0) return "啊这";
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 时间线突变标记的吐槽模板库 —— 按强度分池，`{H}` 会被替换成具体小时数。
 * 毒舌低音量人设（与 ai/quip 的猫同源）：阴阳怪气挤兑突变本身，少「喵」，不夸人。 */
const SPIKE_QUIP_TEMPLATES: Record<0 | 1 | 2 | 3 | 4, string[]> = {
  0: ["{H}点忽然有响动，吵到猫了", "{H}点这点动静，谁在敲键盘"],
  1: ["{H}点提速了，摸鱼还摸出节奏了", "{H}点比刚才活跃点，就这"],
  2: ["{H}点这波提速，早干嘛去了", "{H}点突然来劲，撑得住吗"],
  3: ["{H}点键盘没停，是欠了多少活", "{H}点来劲了，deadline 追到门口了"],
  4: ["{H}点手速拉满，命不要了", "{H}点突然爆发，键盘要冒烟了"],
};

/** 从突变吐槽库里随机挑一句，替换具体时刻。 */
export function pickSpikeQuip(hour: number, intensity: 0 | 1 | 2 | 3 | 4): string {
  const pool = SPIKE_QUIP_TEMPLATES[intensity];
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template.replace("{H}", String(hour));
}
