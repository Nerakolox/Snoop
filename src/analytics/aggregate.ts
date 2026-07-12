/**
 * 时段/日/App 聚合 —— 给页面直接吃的派生数据。
 */

import type { RawBucket, RawHourBucket } from "../data/types";
import { computeIntensityFromTotals } from "./intensity";
import type { AppStat, DayStat, HourStat, Intensity, WeekHourGrid } from "./types";

/**
 * 按 **本地时区小时**（0..23）平均聚合。
 * 输入的 hour_start 已是"本地整点对应的 UTC ms"，所以 new Date().getHours() 直出本地小时。
 * 输出 24 行；某个小时无数据则强度 = 0。
 */
export function aggregateByHour(hourBuckets: RawHourBucket[]): HourStat[] {
  // 每个小时都可能被多次覆盖（跨天），所以要累计后再取平均。
  const acc: Record<
    number,
    {
      key_total: number;
      mouse_total: number;
      mouse_move_dist: number;
      scroll_dist: number;
      duration_ms: number;
      days: Set<string>;
    }
  > = {};
  for (let h = 0; h < 24; h++) {
    acc[h] = {
      key_total: 0,
      mouse_total: 0,
      mouse_move_dist: 0,
      scroll_dist: 0,
      duration_ms: 0,
      days: new Set(),
    };
  }
  for (const hb of hourBuckets) {
    const d = new Date(hb.hour_start);
    const h = d.getHours();
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const slot = acc[h];
    slot.key_total += hb.key_total;
    slot.mouse_total += hb.mouse_clicks;
    slot.mouse_move_dist += hb.mouse_move_dist;
    slot.scroll_dist += hb.scroll_dist;
    slot.duration_ms += hb.duration_ms;
    slot.days.add(dayKey);
  }
  const out: HourStat[] = [];
  for (let h = 0; h < 24; h++) {
    const s = acc[h];
    const intensity = computeIntensityFromTotals({
      key_total: s.key_total,
      // 平均到"每次出现该小时"的量级，避免跨天累加把强度虚高
      mouse_left: s.mouse_total,
      mouse_right: 0,
      mouse_middle: 0,
      mouse_move_dist: s.mouse_move_dist,
      scroll_dist: s.scroll_dist,
      duration_ms: s.duration_ms,
    });
    out.push({
      hour: h,
      day_count: s.days.size,
      key_total: s.key_total,
      mouse_total: s.mouse_total,
      intensity,
    });
  }
  return out;
}

/**
 * 一周 × 24 小时的强度网格。行 0=周一 … 6=周日。
 * 没有覆盖到的格子返回 0。
 */
export function aggregateWeekHourGrid(hourBuckets: RawHourBucket[]): WeekHourGrid {
  // 每格独立累计，然后各自计算强度。
  type Cell = {
    key_total: number;
    mouse_total: number;
    mouse_move_dist: number;
    scroll_dist: number;
    duration_ms: number;
  };
  const grid: Cell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({
      key_total: 0,
      mouse_total: 0,
      mouse_move_dist: 0,
      scroll_dist: 0,
      duration_ms: 0,
    }))
  );

  for (const hb of hourBuckets) {
    const d = new Date(hb.hour_start);
    const row = mondayIndex(d.getDay());
    const col = d.getHours();
    const cell = grid[row][col];
    cell.key_total += hb.key_total;
    cell.mouse_total += hb.mouse_clicks;
    cell.mouse_move_dist += hb.mouse_move_dist;
    cell.scroll_dist += hb.scroll_dist;
    cell.duration_ms += hb.duration_ms;
  }

  const out: WeekHourGrid = grid.map((row) =>
    row.map((c) =>
      computeIntensityFromTotals({
        key_total: c.key_total,
        mouse_left: c.mouse_total,
        mouse_right: 0,
        mouse_middle: 0,
        mouse_move_dist: c.mouse_move_dist,
        scroll_dist: c.scroll_dist,
        duration_ms: c.duration_ms,
      })
    )
  );
  return out;
}

/**
 * 按天聚合。返回按 day_ms 升序的每日活跃。
 * 若某天没有任何桶，就不会出现在结果里；调用方需要"补齐 7 天"时可用返回值填空。
 */
export function aggregateByDay(buckets: RawBucket[]): DayStat[] {
  const acc = new Map<
    number,
    {
      day_ms: number;
      day_of_week: number;
      active_ms: number;
      key_total: number;
      mouse_total: number;
    }
  >();
  for (const b of buckets) {
    const d = new Date(b.bucket_start);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (!acc.has(key)) {
      acc.set(key, {
        day_ms: key,
        day_of_week: mondayIndex(d.getDay()),
        active_ms: 0,
        key_total: 0,
        mouse_total: 0,
      });
    }
    const slot = acc.get(key)!;
    slot.active_ms += b.duration_ms || 0;
    slot.key_total += b.key_total || 0;
    slot.mouse_total +=
      (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
  }
  return [...acc.values()].sort((a, b) => a.day_ms - b.day_ms);
}

/**
 * 按 app_bundle_id 聚合时长、键鼠、平均强度。
 * 返回按 duration_ms 降序。
 */
export function aggregateByApp(buckets: RawBucket[]): AppStat[] {
  const acc = new Map<
    string,
    {
      app_bundle_id: string;
      app_name: string;
      duration_ms: number;
      key_total: number;
      mouse_left: number;
      mouse_right: number;
      mouse_middle: number;
      mouse_move_dist: number;
      scroll_dist: number;
      bucket_count: number;
    }
  >();
  for (const b of buckets) {
    if (!acc.has(b.app_bundle_id)) {
      acc.set(b.app_bundle_id, {
        app_bundle_id: b.app_bundle_id,
        // 用最近一次遇到的 app_name（同一 bundle 一般不变，但个别 App 会跟着窗口标题变动）
        app_name: b.app_name,
        duration_ms: 0,
        key_total: 0,
        mouse_left: 0,
        mouse_right: 0,
        mouse_middle: 0,
        mouse_move_dist: 0,
        scroll_dist: 0,
        bucket_count: 0,
      });
    }
    const slot = acc.get(b.app_bundle_id)!;
    slot.app_name = b.app_name;
    slot.duration_ms += b.duration_ms || 0;
    slot.key_total += b.key_total || 0;
    slot.mouse_left += b.mouse_left || 0;
    slot.mouse_right += b.mouse_right || 0;
    slot.mouse_middle += b.mouse_middle || 0;
    slot.mouse_move_dist += b.mouse_move_dist || 0;
    slot.scroll_dist += b.scroll_dist || 0;
    slot.bucket_count += 1;
  }
  const out: AppStat[] = [...acc.values()].map((s) => {
    const intensity: Intensity = computeIntensityFromTotals(s);
    return {
      app_bundle_id: s.app_bundle_id,
      app_name: s.app_name,
      duration_ms: s.duration_ms,
      key_total: s.key_total,
      mouse_total: s.mouse_left + s.mouse_right + s.mouse_middle,
      intensity,
      bucket_count: s.bucket_count,
    };
  });
  return out.sort((a, b) => b.duration_ms - a.duration_ms);
}

/** JS getDay(): Sun=0..Sat=6 → 我们的 Mon=0..Sun=6。 */
function mondayIndex(getDayValue: number): number {
  return getDayValue === 0 ? 6 : getDayValue - 1;
}
