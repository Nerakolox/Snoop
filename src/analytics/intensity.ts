/**
 * 强度分档 —— 把"每分钟键鼠事件总数"（EPM）映射到 0..4 档。
 *
 * 分档思路：
 *   0 → 完全静默（人不在或纯挂机）
 *   1 → 偶尔戳一下，几十下/分钟
 *   2 → 中等活跃，摸鱼型输入
 *   3 → 稳定输入
 *   4 → 猛敲，写代码/打字/打游戏峰值
 *
 * 阈值集中放在这里，后面调档只改 THRESHOLDS_EPM。
 */

import type { Intensity } from "./types";
import type { RawBucket } from "../data/types";

/**
 * EPM 分档阈值。索引 = 结果强度；值 = 达到该档所需的下限。
 * 例如 EPM ≥ 40 → 至少档 2；EPM ≥ 180 → 档 4。
 *
 * 之所以是 EPM（events per minute）而不是绝对事件数：
 * 桶时长会因为 App 切换提前结算而不足 5 秒，比不同长度桶的
 * 原始数会不公平。归一化到"每分钟"后各种时长的桶可直接比较。
 */
export const THRESHOLDS_EPM: readonly [number, number, number, number] = [
  10, // ≥ 10 → 档 1
  40, // ≥ 40 → 档 2
  90, // ≥ 90 → 档 3
  180, // ≥ 180 → 档 4
];

/** 桶或会话的鼠标事件总数（点击 + 移动/滚动的粗略事件数）。 */
function mouseEventCount(b: {
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_move_dist: number;
  scroll_dist: number;
}): number {
  // 移动/滚动是"距离"不是"事件"，用一个粗略系数折算。
  // 100px 移动折算 1 个事件，10 单位滚轮折算 1 个事件。
  const moveEvents = Math.floor((b.mouse_move_dist || 0) / 100);
  const scrollEvents = Math.floor((b.scroll_dist || 0) / 10);
  return (
    (b.mouse_left || 0) +
    (b.mouse_right || 0) +
    (b.mouse_middle || 0) +
    moveEvents +
    scrollEvents
  );
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
