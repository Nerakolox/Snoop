/**
 * 分析层常量配置 —— 集中放置所有可调参数。
 */

/** 鼠标移动像素 → 物理距离（米）的换算系数。
 * 假设典型显示器 DPI ~96，1 像素约等于 0.26mm。
 * 这个值可根据实际显示器调整；1000 像素 ≈ 0.26 米。 */
export const MOUSE_PIXELS_PER_METER = 3846; // ~1 米 = 3846 像素

/** "此刻状态"判断的时间窗口（ms）—— 取最近这段时间的桶算当前强度。 */
export const RECENT_ACTIVITY_WINDOW_MS = 2 * 60_000; // 2 分钟

/** 强度等级 → 状态标签映射 */
export const MOOD_LABELS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "挂机中",
  1: "摸鱼中",
  2: "正常节奏",
  3: "认真工作",
  4: "爆肝模式",
};

/** 猫吐槽文案库 —— 按强度 + App 类型匹配。
 * 结构：intensity → appPattern → quips[]，随机抽一句。
 * appPattern 用简单的关键词匹配（toLowerCase + includes）。 */
type QuipDb = Record<
  0 | 1 | 2 | 3 | 4,
  { pattern?: string; quips: string[] }[]
>;

export const CAT_QUIPS: QuipDb = {
  0: [
    { quips: ["人呢？挂机了喵？", "静悄悄的，去哪了喵？", "屏幕都快睡着了喵～"] },
  ],
  1: [
    {
      pattern: "chrome",
      quips: [
        "盯着 Chrome 半小时了，在看什么好东西喵？",
        "又在摸鱼？浏览器都快把你埋了喵～",
        "Chrome 标签页开了 47 个，找得到要看的那个吗喵？",
      ],
    },
    {
      pattern: "qq",
      quips: ["聊得挺嗨？工作群还是水群喵？", "QQ 小窗弹个不停，忙着社交呢喵～"],
    },
    {
      pattern: "wechat",
      quips: ["微信消息轰炸中，是不是该开勿扰了喵？", "又在微信上划水？小心被老板抓包喵～"],
    },
    {
      quips: [
        "节奏挺悠闲嘛，喝杯茶？喵～",
        "轻轻松松摸个鱼，不亦乐乎喵～",
        "这强度…是在看文档还是在发呆喵？",
      ],
    },
  ],
  2: [
    {
      pattern: "vscode",
      quips: [
        "VSCode 开着，看起来在写代码？加油喵～",
        "代码敲得不紧不慢，稳扎稳打喵～",
        "写了半天，编译过了吗喵？",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "终端里跑着啥？看着还挺认真喵～",
        "命令行敲得有模有样，靠谱喵～",
        "终端黑屏配绿字，极客范儿十足喵～",
      ],
    },
    {
      quips: [
        "节奏不错，保持住喵～",
        "这个强度刚刚好，可持续发展喵～",
        "稳定输出中，继续加油喵～",
      ],
    },
  ],
  3: [
    {
      pattern: "vscode",
      quips: [
        "键盘敲得飞起，代码狂魔上线了喵！",
        "VSCode 里一顿操作猛如虎，Bug 修了几个喵？",
        "这强度，是在重构还是在救火喵？",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "终端里狂飙命令，运维还是开发喵？",
        "命令行敲得噼里啪啦，别把服务器搞炸了喵～",
        "终端刷屏速度堪比瀑布，厉害了喵！",
      ],
    },
    {
      quips: [
        "认真工作的样子，真帅喵～",
        "这个强度，离 deadline 还有多远喵？",
        "全力以赴中，记得眨眼睛喵～",
      ],
    },
  ],
  4: [
    {
      pattern: "vscode",
      quips: [
        "键盘都快冒烟了！是在写什么救命代码喵？！",
        "VSCode 里疯狂输出，手速惊人喵！别累坏了喵～",
        "这是爆肝现场？键盘要被你敲穿了喵！",
      ],
    },
    {
      pattern: "terminal",
      quips: [
        "终端刷屏速度突破天际，出什么大事了喵？！",
        "命令行噼里啪啦响成一片，这是在打仗吗喵？！",
        "手速爆表！终端都快跟不上你了喵！",
      ],
    },
    {
      quips: [
        "爆肝模式全开！注意身体喵！",
        "这个强度…是赶 deadline 还是在拯救世界喵？！",
        "键鼠齐飞，战力爆表！别猝死了喵！",
        "冲冲冲！但别忘了喝水和眨眼喵～",
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
