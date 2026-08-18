/**
 * 时间范围助手 —— 生成传给后端的 [start_ms, end_ms) 闭右开区间。
 * 所有边界都按 **本地时区** 计算（用户看到的"今天"就是本地的今天）。
 * 纯函数，不依赖 Date.now() 之外的运行时状态；测试时可传 now 参数。
 */

import type { TimeRange } from "./types";
import type { RangeKind } from "../store/context";

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

/**
 * anchor 是 'YYYY-MM-DD' 字符串，语义为**本地时区**的某一天。
 *
 * ⚠️ 绝对不要用 `new Date("2026-08-03")` 解析它。
 * 那是 ISO date-only 格式，JS 按 **UTC** 解析，东八区会得到本地时间
 * 2026-08-03T08:00，跨时区/跨夏令时会整体漂一天。必须用下面这个。
 */
export function parseAnchor(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d); // 本地 00:00:00.000
}

/** Date → 'YYYY-MM-DD'（本地）。同样不要用 toISOString()，那是 UTC。 */
export function formatAnchor(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 语义 (kind, anchor) → 后端要的 [start_ms, end_ms)。
 *
 * anchor 的约定：day = 当天；week = 该周周一；month = 该月 1 号。
 * 调用前 anchor 应已被 `normalizeAnchor` 规范化过。
 *
 * opts.liveEnd：区间**包含当前时刻**时，把 end_ms 收到 now。
 *   这是 Timeline 现有的"活范围"语义（原 Timeline.tsx:123），
 *   **只有时间线传 true**，其他页面用完整区间。
 */
export function toMs(
  kind: RangeKind,
  anchor: string,
  opts?: { liveEnd?: boolean },
  now: Date = new Date()
): TimeRange {
  const start = parseAnchor(anchor);
  let end: Date;

  if (kind === "day") {
    end = new Date(start.getTime() + DAY_MS);
  } else if (kind === "week") {
    end = new Date(start.getTime() + 7 * DAY_MS);
  } else {
    // ⚠️ 月份不能用 +30*DAY_MS。必须走 setMonth，让 JS 处理 28/29/30/31 天。
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  }

  let end_ms = end.getTime();
  const nowMs = now.getTime();
  if (opts?.liveEnd && nowMs >= start.getTime() && nowMs < end_ms) {
    end_ms = nowMs;
  }
  return { start_ms: start.getTime(), end_ms };
}
