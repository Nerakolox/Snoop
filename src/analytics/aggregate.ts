/**
 * 时段/日/App 聚合 —— 给页面直接吃的派生数据。
 */

import type { RawBucket, RawHourBucket } from "../data/types";
import { DAY_MS } from "../data/ranges";
import { computeIntensity, computeIntensityFromTotals } from "./intensity";
import type { AppStat, DayStat, HourStat, Intensity } from "./types";

/**
 * 对桶的时间区间 [bucket_start, bucket_start + duration_ms) 求并集后再求和，
 * 得到"真实墙钟活跃时长"。这是总时长的权威口径：与"各桶 duration_ms 直接相加"
 * 不同的地方仅在于会自动吸收任何时间重叠（理论上落库端已用唯一索引 + 单一归因
 * 杜绝了重叠，这里是聚合层的防御性兜底，正常情况下两个值应几乎相等）。
 */
export function unionDurationMs(buckets: RawBucket[]): number {
  if (buckets.length === 0) return 0;
  const intervals = buckets
    .map((b) => [b.bucket_start, b.bucket_start + (b.duration_ms || 0)] as const)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let curStart = intervals[0][0];
  let curEnd = intervals[0][1];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * 直接对桶的 duration_ms 求和（不去重）。用于跟 unionDurationMs 对比校验：
 * 若两者差值过大，说明存在时间重叠的桶，落库端的单一归因可能失效了。
 */
function sumDurationMs(buckets: RawBucket[]): number {
  let total = 0;
  for (const b of buckets) total += b.duration_ms || 0;
  return total;
}

/**
 * 开发环境下的去重校验：若"直接相加"与"并集求和"的差值超过 1%，
 * 说明桶之间存在时间重叠，落库端的单一归因假设被打破了，输出 warn 便于回归监控。
 */
function warnIfDivergent(buckets: RawBucket[], context: string): void {
  if (!import.meta.env?.DEV) return;
  if (buckets.length === 0) return;
  const summed = sumDurationMs(buckets);
  if (summed === 0) return;
  const unioned = unionDurationMs(buckets);
  const diffRatio = Math.abs(summed - unioned) / summed;
  if (diffRatio > 0.01) {
    console.warn(
      `[aggregate] ${context}: 直接相加(${summed}ms) 与并集去重(${unioned}ms) 差值 ${(diffRatio * 100).toFixed(1)}%，` +
        `疑似存在重叠桶，请检查落库端单一归因是否失效`
    );
  }
}

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
 * 按**本地小时**把桶分组，每组走 computeIntensity 得到强度档。
 * 返回定长 24 的数组，无数据的小时为 0。
 *
 * 与 aggregateByHour 的区别：那个吃后端预聚合的 RawHourBucket[]，拿不到 app 维度；
 * 这个吃已按 appId 过滤好的 RawBucket[]，节奏区统一走这条路径（有无筛选同一条代码路径）。
 */
export function intensityByHourFromBuckets(buckets: RawBucket[]): Intensity[] {
  const groups: RawBucket[][] = Array.from({ length: 24 }, () => []);
  for (const b of buckets) {
    const h = new Date(b.bucket_start).getHours();
    groups[h].push(b);
  }
  return groups.map((g) => computeIntensity(g));
}

/**
 * 按**本地日期**把桶分组，返回 [startMs, endMs) 内每一天的
 * { dayMs, activeMs, intensity }，按日期升序，包含无数据的空天
 * （空天 activeMs=0、intensity=0），调用方不用自己补洞。
 */
export function statsByDayFromBuckets(
  buckets: RawBucket[],
  startMs: number,
  endMs: number
): Array<{ dayMs: number; activeMs: number; intensity: Intensity }> {
  const byDay = new Map<number, RawBucket[]>();
  for (const b of buckets) {
    const d = new Date(b.bucket_start);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(b);
  }

  const dayStart = new Date(startMs);
  dayStart.setHours(0, 0, 0, 0);

  const out: Array<{ dayMs: number; activeMs: number; intensity: Intensity }> = [];
  for (let t = dayStart.getTime(); t < endMs; t += DAY_MS) {
    const dayBuckets = byDay.get(t) ?? [];
    out.push({
      dayMs: t,
      activeMs: unionDurationMs(dayBuckets),
      intensity: computeIntensity(dayBuckets),
    });
  }
  return out;
}

/**
 * 一周 × 24 小时的三态网格。行 0=周一 … 6=周日。
 * 每格包含：活跃强度 (0-4) + 状态标记（活跃/挂机/未采集）。
 * weekStartMs: 本周一 0 点的 UTC ms 时间戳（本地时区）
 * heartbeats: Map<hour_start_ms, true>，key 为整点的 UTC ms
 */
export function aggregateWeekHourGrid(
  hourBuckets: RawHourBucket[],
  heartbeats: Map<number, boolean>,
  weekStartMs: number
): { intensity: Intensity; state: "active" | "idle" | "no_data" }[][] {
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

  // 记录每格是否有活动桶
  const hasActivity: boolean[][] = Array.from({ length: 7 }, () => Array(24).fill(false));

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
    hasActivity[row][col] = true;
  }

  const HOUR_MS = 60 * 60 * 1000;
  const out = grid.map((row, ri) =>
    row.map((c, ci) => {
      const intensity = computeIntensityFromTotals({
        key_total: c.key_total,
        mouse_left: c.mouse_total,
        mouse_right: 0,
        mouse_middle: 0,
        mouse_move_dist: c.mouse_move_dist,
        scroll_dist: c.scroll_dist,
        duration_ms: c.duration_ms,
      });

      // 判定状态：活跃 > 挂机 > 未采集
      let state: "active" | "idle" | "no_data";
      if (hasActivity[ri][ci]) {
        state = "active";
      } else {
        // 推导该格对应的 hour_start_ms（本地整点）
        const dayOffsetMs = ri * 24 * HOUR_MS;
        const hourOffsetMs = ci * HOUR_MS;
        const cellHourStartMs = weekStartMs + dayOffsetMs + hourOffsetMs;

        // 查心跳
        if (heartbeats.has(cellHourStartMs)) {
          state = "idle"; // 有心跳但无活动 = 挂机
        } else {
          state = "no_data"; // 无心跳也无活动 = 未采集
        }
      }

      return { intensity, state };
    })
  );
  return out;
}

/**
 * 按天聚合。返回按 day_ms 升序的每日活跃。
 * 若某天没有任何桶，就不会出现在结果里；调用方需要"补齐 7 天"时可用返回值填空。
 *
 * active_ms 用区间并集去重求和（见 unionDurationMs），而非各桶 duration_ms 直接相加，
 * 防御任何时间重叠导致的时长虚高——正常情况下（落库端单一归因生效）两者应几乎相等。
 */
export function aggregateByDay(buckets: RawBucket[]): DayStat[] {
  const acc = new Map<
    number,
    {
      day_ms: number;
      day_of_week: number;
      key_total: number;
      mouse_total: number;
      buckets: RawBucket[];
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
        key_total: 0,
        mouse_total: 0,
        buckets: [],
      });
    }
    const slot = acc.get(key)!;
    slot.key_total += b.key_total || 0;
    slot.mouse_total +=
      (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
    slot.buckets.push(b);
  }
  return [...acc.values()]
    .sort((a, b) => a.day_ms - b.day_ms)
    .map(({ buckets: dayBuckets, ...rest }) => {
      warnIfDivergent(dayBuckets, `aggregateByDay day_ms=${rest.day_ms}`);
      return { ...rest, active_ms: unionDurationMs(dayBuckets) };
    });
}

/**
 * 按 app_bundle_id 聚合时长、键鼠、平均强度。
 * 返回按 duration_ms 降序。
 *
 * duration_ms 用区间并集去重求和（见 unionDurationMs），而非各桶 duration_ms 直接相加，
 * 防御任何时间重叠导致的时长虚高——正常情况下（落库端单一归因生效）两者应几乎相等。
 */
export function aggregateByApp(buckets: RawBucket[]): AppStat[] {
  const acc = new Map<
    string,
    {
      app_bundle_id: string;
      app_name: string;
      buckets: RawBucket[];
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
        app_name: b.app_name,
        buckets: [],
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
    slot.buckets.push(b);
    slot.key_total += b.key_total || 0;
    slot.mouse_left += b.mouse_left || 0;
    slot.mouse_right += b.mouse_right || 0;
    slot.mouse_middle += b.mouse_middle || 0;
    slot.mouse_move_dist += b.mouse_move_dist || 0;
    slot.scroll_dist += b.scroll_dist || 0;
    slot.bucket_count += 1;
  }
  const out: AppStat[] = [...acc.values()].map((s) => {
    warnIfDivergent(s.buckets, `aggregateByApp app=${s.app_bundle_id}`);
    const intensity: Intensity = computeIntensityFromTotals({
      key_total: s.key_total,
      mouse_left: s.mouse_left,
      mouse_right: s.mouse_right,
      mouse_middle: s.mouse_middle,
      mouse_move_dist: s.mouse_move_dist,
      scroll_dist: s.scroll_dist,
      duration_ms: unionDurationMs(s.buckets),
    });
    return {
      app_bundle_id: s.app_bundle_id,
      app_name: s.app_name,
      duration_ms: unionDurationMs(s.buckets),
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

/**
 * 有采集数据的天数（按本地日期去重计数）。用作「日均 = 总量 / 有数据天数」
 * 这类分母 —— 历史范围里可能有几天完全没跑应用，不能除以自然天数。
 */
export function daysWithDataOf(buckets: RawBucket[]): number {
  const days = new Set<string>();
  for (const b of buckets) {
    const d = new Date(b.bucket_start);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

export type DowHourCell = {
  intensity: Intensity;
  state: "active" | "idle" | "no_data";
  /** 该格在本范围内覆盖了几天（周粒度恒为 1，月粒度 4~5） */
  sampleDays: number;
};

/**
 * 星期 × 小时的三态网格，适用于**任意长度**的范围。行 0=周一 … 6=周日。
 *
 * 与 aggregateWeekHourGrid 的区别：那个把「格子 → 时刻」的映射写死成
 * weekStartMs + ri*24h + ci*1h，只在范围恰好是一周时成立。月粒度下同一格
 * 对应 4~5 个不同日期，那个式子算出来的时刻是错的，会让挂机/未采集大面积误判。
 * 这里改为遍历范围内每一个本地整点，逐格累计。
 */
export function aggregateDowHourGrid(
  hourBuckets: RawHourBucket[],
  heartbeats: Map<number, boolean>,
  startMs: number,
  endMs: number
): DowHourCell[][] {
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
  const hasActivity: boolean[][] = Array.from({ length: 7 }, () => Array(24).fill(false));

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
    hasActivity[row][col] = true;
  }

  // 心跳 + 样本天数：从 startMs 所在日 0 点起，逐天推进游标（setDate，不用 t += DAY_MS，
  // 避免 DST 地区漂移），每天内 h=0..23 用 new Date(y,m,d,h) 生成本地整点，
  // 落在 [startMs, endMs) 内才计入。
  const hasHeartbeat: boolean[][] = Array.from({ length: 7 }, () => Array(24).fill(false));
  const sampleDays: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  const cur = new Date(startMs);
  cur.setHours(0, 0, 0, 0);
  while (cur.getTime() < endMs) {
    const row = mondayIndex(cur.getDay());
    const y = cur.getFullYear();
    const m = cur.getMonth();
    const dd = cur.getDate();
    for (let h = 0; h < 24; h++) {
      const hourStartMs = new Date(y, m, dd, h).getTime();
      if (hourStartMs < startMs || hourStartMs >= endMs) continue;
      sampleDays[row][h] += 1;
      if (heartbeats.has(hourStartMs)) hasHeartbeat[row][h] = true;
    }
    cur.setDate(cur.getDate() + 1);
  }

  return grid.map((row, ri) =>
    row.map((c, ci) => {
      const intensity = computeIntensityFromTotals({
        key_total: c.key_total,
        mouse_left: c.mouse_total,
        mouse_right: 0,
        mouse_middle: 0,
        mouse_move_dist: c.mouse_move_dist,
        scroll_dist: c.scroll_dist,
        duration_ms: c.duration_ms,
      });

      // 判定状态：活跃 > 挂机 > 未采集
      let state: "active" | "idle" | "no_data";
      if (hasActivity[ri][ci]) {
        state = "active";
      } else if (hasHeartbeat[ri][ci]) {
        state = "idle";
      } else {
        state = "no_data";
      }

      return { intensity, state, sampleDays: sampleDays[ri][ci] };
    })
  );
}
