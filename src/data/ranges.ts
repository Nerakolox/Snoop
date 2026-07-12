/**
 * 时间范围助手 —— 生成传给后端的 [start_ms, end_ms) 闭右开区间。
 * 所有边界都按 **本地时区** 计算（用户看到的"今天"就是本地的今天）。
 * 纯函数，不依赖 Date.now() 之外的运行时状态；测试时可传 now 参数。
 */

import type { TimeRange } from "./types";

/** 一天有多少毫秒。分号只是提醒别到处硬编码。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区的今天 00:00:00.000 ~ 明天 00:00:00.000 */
export function todayRange(now: Date = new Date()): TimeRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY_MS);
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}

/**
 * 本地时区的本周一 00:00:00.000 ~ 下周一 00:00:00.000。
 * 把周日算作"上一周的第 7 天"，与设计稿"周一到周日"一致。
 */
export function thisWeekRange(now: Date = new Date()): TimeRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // getDay(): 周日=0，周一=1 … 周六=6
  // 把周日归为 +6（周日往前退 6 天到上周一）
  const dow = start.getDay();
  const offsetToMonday = dow === 0 ? 6 : dow - 1;
  start.setDate(start.getDate() - offsetToMonday);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}

/** 指定"某一天"的本地时区当天窗口。传参用来做"本周内的某天"这类子窗口。 */
export function dayRangeOf(d: Date): TimeRange {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY_MS);
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}
