/**
 * 会话合并 —— 把连续同 App 的桶粘成一段"会话"，再做一层碎片处理。
 * 全是纯函数：不动入参，不看时间，不 IO。
 */

import type { RawBucket } from "../data/types";
import { computeIntensityFromTotals } from "./intensity";
import type { Session } from "./types";

/** 视为"太短"的会话时长阈值（ms）。60 秒以下算瞟一眼。 */
export const SHORT_SESSION_MS = 60_000;

/** 打包"分心时段"时的滑动窗口（ms）。窗口内切换次数达到 DISTRACTION_MIN_SWITCHES 就打包。 */
export const DISTRACTION_WINDOW_MS = 5 * 60_000;
export const DISTRACTION_MIN_SWITCHES = 4;

/**
 * 把连续同 app_bundle_id 的桶合并成会话。
 * 桶列表可以是无序的 —— 内部先按 bucket_start 排序，避免调用方担心。
 * 相邻桶只要 bundle_id 相同就并入同一会话，不看它们之间的时间间隙；
 * "两段之间有几十分钟没输入"这种情形，请在调用方过滤或分成两段传入。
 */
export function mergeSessions(input: RawBucket[]): Session[] {
  if (!input || input.length === 0) return [];
  const buckets = [...input].sort((a, b) => a.bucket_start - b.bucket_start);

  const out: Session[] = [];
  let cur: Session | null = null;
  let curTotals = zeroTotals();

  for (const b of buckets) {
    if (cur && cur.app_bundle_id === b.app_bundle_id) {
      cur.end_ms = b.bucket_start + b.duration_ms;
      cur.duration_ms += b.duration_ms;
      cur.key_total += b.key_total;
      cur.mouse_total += mouseTotal(b);
      cur.bucket_count += 1;
      accum(curTotals, b);
    } else {
      if (cur) cur.intensity = computeIntensityFromTotals(curTotals);
      cur = {
        start_ms: b.bucket_start,
        end_ms: b.bucket_start + b.duration_ms,
        app_name: b.app_name,
        app_bundle_id: b.app_bundle_id,
        duration_ms: b.duration_ms,
        key_total: b.key_total,
        mouse_total: mouseTotal(b),
        bucket_count: 1,
        intensity: 0,
      };
      curTotals = zeroTotals();
      accum(curTotals, b);
      out.push(cur);
    }
  }
  if (cur) cur.intensity = computeIntensityFromTotals(curTotals);
  return out;
}

/**
 * 处理碎会话：
 *   1) 若一段短会话被两侧同一 App 前后包夹，把它并进主会话（视为主 App 内的一次瞟一眼，
 *      比如写代码时切浏览器几秒又切回来）；
 *   2) 若窗口内切换次数密集（DISTRACTION_MIN_SWITCHES 次以上），把这段打包为
 *      单个 kind='distraction' 会话；
 *   3) 剩下的短会话标记 kind='glance'。
 *
 * 传入未经处理的 mergeSessions 结果；返回新数组，原数组不变。
 */
export function aggregateShortSessions(sessions: Session[]): Session[] {
  if (!sessions || sessions.length === 0) return [];

  // ---- Pass 1：同 App 包夹合并 ----------------------------------------------
  const pass1: Session[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const cur = sessions[i];
    const prev = pass1[pass1.length - 1];
    const next = sessions[i + 1];

    const sandwiched =
      prev &&
      next &&
      cur.duration_ms < SHORT_SESSION_MS &&
      prev.app_bundle_id === next.app_bundle_id &&
      cur.app_bundle_id !== prev.app_bundle_id;

    if (sandwiched && prev) {
      // 把 cur 与随后的 next 都并入 prev（并入 next 是为了让 prev 一次性吃掉夹心 + 后段主会话）
      prev.end_ms = next!.end_ms;
      prev.duration_ms += cur.duration_ms + next!.duration_ms;
      prev.key_total += cur.key_total + next!.key_total;
      prev.mouse_total += cur.mouse_total + next!.mouse_total;
      prev.bucket_count += cur.bucket_count + next!.bucket_count;
      // 强度取最大档：主会话若已是高强度就不应被短暂低强度拉低
      prev.intensity = maxIntensity(prev.intensity, next!.intensity);
      i += 1; // 跳过 next
      continue;
    }
    pass1.push({ ...cur });
  }

  // ---- Pass 2：滑动窗口打包分心段 -------------------------------------------
  const pass2: Session[] = [];
  let i = 0;
  while (i < pass1.length) {
    // 以 i 为起点，往后收集所有起始时间还在 window 内的短会话
    const winStart = pass1[i].start_ms;
    let j = i;
    let shortCount = 0;
    while (
      j < pass1.length &&
      pass1[j].start_ms - winStart < DISTRACTION_WINDOW_MS
    ) {
      if (pass1[j].duration_ms < SHORT_SESSION_MS) shortCount += 1;
      j += 1;
    }
    // j 现在指向"超出窗口"的第一个会话（或数组末尾）
    if (shortCount >= DISTRACTION_MIN_SWITCHES) {
      const packed = pack(pass1.slice(i, j), "distraction");
      pass2.push(packed);
      i = j;
    } else {
      const s = pass1[i];
      if (s.duration_ms < SHORT_SESSION_MS) {
        pass2.push({ ...s, kind: "glance" });
      } else {
        pass2.push(s);
      }
      i += 1;
    }
  }

  return pass2;
}

// ---- helpers ---------------------------------------------------------------

function mouseTotal(b: RawBucket): number {
  return (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
}

type Totals = {
  key_total: number;
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_move_dist: number;
  scroll_dist: number;
  duration_ms: number;
};

function zeroTotals(): Totals {
  return {
    key_total: 0,
    mouse_left: 0,
    mouse_right: 0,
    mouse_middle: 0,
    mouse_move_dist: 0,
    scroll_dist: 0,
    duration_ms: 0,
  };
}

function accum(t: Totals, b: RawBucket) {
  t.key_total += b.key_total || 0;
  t.mouse_left += b.mouse_left || 0;
  t.mouse_right += b.mouse_right || 0;
  t.mouse_middle += b.mouse_middle || 0;
  t.mouse_move_dist += b.mouse_move_dist || 0;
  t.scroll_dist += b.scroll_dist || 0;
  t.duration_ms += b.duration_ms || 0;
}

function maxIntensity(a: Session["intensity"], b: Session["intensity"]) {
  return (a > b ? a : b) as Session["intensity"];
}

/** 把连续几个 session 压缩成一个"分心/瞟一眼"段，app 名取时长最多的那个。 */
function pack(sessions: Session[], kind: NonNullable<Session["kind"]>): Session {
  const dominant = [...sessions].sort(
    (a, b) => b.duration_ms - a.duration_ms
  )[0];
  let key = 0;
  let mouse = 0;
  let duration = 0;
  let bucketCount = 0;
  let maxI: Session["intensity"] = 0;
  for (const s of sessions) {
    key += s.key_total;
    mouse += s.mouse_total;
    duration += s.duration_ms;
    bucketCount += s.bucket_count;
    if (s.intensity > maxI) maxI = s.intensity;
  }
  return {
    start_ms: sessions[0].start_ms,
    end_ms: sessions[sessions.length - 1].end_ms,
    app_name: kind === "distraction" ? "分心时段" : dominant.app_name,
    app_bundle_id: dominant.app_bundle_id,
    duration_ms: duration,
    key_total: key,
    mouse_total: mouse,
    bucket_count: bucketCount,
    intensity: maxI,
    kind,
  };
}
