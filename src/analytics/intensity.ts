/**
 * 强度分档 —— 全项目**唯一**的活跃强度计算入口。
 *
 * 铁律（历史上反复复发的坑）：
 *   ① 输入永远是"每分钟事件密度（EPM）"，不是累积总量。累积量随时长无限增长必爆表。
 *   ② 阈值走对数分档：相邻两档大约 3× 关系，抗极值，避免"稍微一动全顶到 4"。
 *   ③ 鼠标移动/滚轮的权重要压低：那是连续信号，不是"意图明确的事件"。
 *      不压的话，普通浏览 30 分钟就能刷出上万个"合成事件"，直接把所有活跃档顶到 4。
 *
 * 分档语义：
 *   0 → 完全静默（人不在或纯挂机）
 *   1 → 偶尔戳一下，读页面/看视频掺杂零星输入
 *   2 → 摸鱼型输入，聊天/浏览带点交互
 *   3 → 稳定工作，正常写代码/写文档
 *   4 → 猛敲峰值，密集打字/激烈游戏
 *
 * 阈值集中在 THRESHOLDS_EPM，后面手感不对只改这一个数组。
 */

import type { Intensity } from "./types";
import type { RawBucket } from "../data/types";

/**
 * EPM（events per minute）分档阈值 —— 对数刻度，四档大约 4× / 3× / 3× 关系。
 * 索引 = 达到该档所需的下限；例如 EPM ≥ 80 至少档 2，≥ 700 才是档 4。
 *
 * 之所以是 EPM 而非绝对事件数：
 * 桶时长可能不足 5 秒（App 切换提前结算），聚合窗口从 5s 到 24h 都有可能，
 * 只有除以时长归一化后不同尺度的窗口才能同框比较。
 *
 * 阈值的经验值来自真实数据：把鼠标移动/滚轮权重压低（下面 MOVE_PX_PER_EVENT / SCROLL_UNIT_PER_EVENT）
 * 之后，正常写代码 ≈ 200 EPM 落档 3，猛敲 ≈ 700+ 才到档 4，游戏峰值也到 4。
 * 挂机时 5-20 EPM 落档 1。
 */
export const THRESHOLDS_EPM: readonly [number, number, number, number] = [
  20, // ≥ 20 → 档 1（偶尔）
  80, // ≥ 80 → 档 2（摸鱼）
  250, // ≥ 250 → 档 3（稳定）
  700, // ≥ 700 → 档 4（爆肝）
];

/**
 * 鼠标位移折算：800 px 位移 = 1 "事件"。
 * 一次拖动/扫过屏幕就是 1000+ px，故意压低权重让位移不至于淹没点击/按键。
 */
const MOVE_PX_PER_EVENT = 800;
/**
 * 滚轮折算：60 单位（rdev 每格 ±1 或更多）= 1 "事件"。
 * 让一次翻页的滚动不至于顶穿分档。
 */
const SCROLL_UNIT_PER_EVENT = 60;

/** 桶或会话的鼠标事件总数（点击 + 位移/滚动的粗略事件数）。 */
function mouseEventCount(b: {
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_move_dist: number;
  scroll_dist: number;
}): number {
  const moveEvents = Math.floor((b.mouse_move_dist || 0) / MOVE_PX_PER_EVENT);
  const scrollEvents = Math.floor((b.scroll_dist || 0) / SCROLL_UNIT_PER_EVENT);
  return (
    (b.mouse_left || 0) +
    (b.mouse_right || 0) +
    (b.mouse_middle || 0) +
    moveEvents +
    scrollEvents
  );
}

/**
 * 用于 dev 页 / 调试打印：给一组桶输出 EPM 明细，便于观察分档是否合理。
 * 生产代码不要调它 —— 只用来定位"档位分布是不是又全挤到 4"。
 */
export function debugEpm(buckets: RawBucket[]): {
  totalMs: number;
  totalEvents: number;
  epm: number;
  intensity: Intensity;
  breakdown: { keys: number; clicks: number; moveEvents: number; scrollEvents: number };
} {
  let totalMs = 0;
  let keys = 0;
  let clicks = 0;
  let moveEvents = 0;
  let scrollEvents = 0;
  for (const b of buckets) {
    totalMs += b.duration_ms || 0;
    keys += b.key_total || 0;
    clicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
    moveEvents += Math.floor((b.mouse_move_dist || 0) / MOVE_PX_PER_EVENT);
    scrollEvents += Math.floor((b.scroll_dist || 0) / SCROLL_UNIT_PER_EVENT);
  }
  const totalEvents = keys + clicks + moveEvents + scrollEvents;
  const durationMin = totalMs / 60_000;
  const epm = durationMin > 0 ? totalEvents / durationMin : 0;
  return {
    totalMs,
    totalEvents,
    epm,
    intensity: bucketIntensityFromEpm(epm),
    breakdown: { keys, clicks, moveEvents, scrollEvents },
  };
}

/** 把 EPM 值映射到强度档。 */
export function bucketIntensityFromEpm(epm: number): Intensity {
  if (epm <= 0) return 0;
  if (epm >= THRESHOLDS_EPM[3]) return 4;
  if (epm >= THRESHOLDS_EPM[2]) return 3;
  if (epm >= THRESHOLDS_EPM[1]) return 2;
  if (epm >= THRESHOLDS_EPM[0]) return 1;
  return 0;
}

/** 单个原始桶 → 强度档。 */
export function computeBucketIntensity(bucket: RawBucket): Intensity {
  const durationMin = (bucket.duration_ms || 0) / 60_000;
  if (durationMin <= 0) return 0;
  const events = (bucket.key_total || 0) + mouseEventCount(bucket);
  return bucketIntensityFromEpm(events / durationMin);
}

/** 一段桶 → 平均强度档（先合计再归一化，避免加权错乱）。 */
export function computeIntensity(buckets: RawBucket[]): Intensity {
  if (!buckets || buckets.length === 0) return 0;
  let totalMs = 0;
  let totalEvents = 0;
  for (const b of buckets) {
    totalMs += b.duration_ms || 0;
    totalEvents += (b.key_total || 0) + mouseEventCount(b);
  }
  const durationMin = totalMs / 60_000;
  if (durationMin <= 0) return 0;
  return bucketIntensityFromEpm(totalEvents / durationMin);
}

export function bucketByPercentile(n: number, allCounts: number[]): Intensity {
  if (n <= 0) return 0;
  const nonZero = allCounts.filter((c) => c > 0);
  if (nonZero.length === 0) return 0;
  const sorted = [...nonZero].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  const p40 = sorted[Math.floor(sorted.length * 0.4)];
  const p60 = sorted[Math.floor(sorted.length * 0.6)];
  const p80 = sorted[Math.floor(sorted.length * 0.8)];
  if (n >= p80) return 4;
  if (n >= p60) return 3;
  if (n >= p40) return 2;
  if (n >= p20) return 1;
  return 1;
}

export function bucketSimple(n: number, max: number): Intensity {
  if (n <= 0) return 0;
  const pct = n / (max || 1);
  if (pct >= 0.7) return 4;
  if (pct >= 0.5) return 3;
  if (pct >= 0.3) return 2;
  return 1;
}

/** CSS 强度变量引用。 */
export function intensityVar(level: Intensity): string {
  return `var(--intensity-${level})`;
}

export function computeIntensityFromTotals(totals: {
  key_total: number;
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_move_dist: number;
  scroll_dist: number;
  duration_ms: number;
}): Intensity {
  const durationMin = (totals.duration_ms || 0) / 60_000;
  if (durationMin <= 0) return 0;
  const events = (totals.key_total || 0) + mouseEventCount(totals);
  return bucketIntensityFromEpm(events / durationMin);
}
