import type { RawBucket } from "../data/types";
import { computeBucketIntensity } from "./intensity";

export type TimeBlock = {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  key_total: number;
  mouse_total: number;
};

export type AppLane = {
  app_name: string;
  app_bundle_id: string;
  color: string;
  blocks: TimeBlock[];
  total_duration_ms: number;
};

export type GapRange = { start_ms: number; end_ms: number };

export type Segment = {
  time_start: number;
  time_end: number;
  virt_start: number;
  virt_end: number;
  type: "data" | "gap";
};

export type VirtGap = {
  time_start: number;
  time_end: number;
  virt_start: number;
  virt_end: number;
};

export type SegmentsData = {
  segments: Segment[];
  virtGaps: VirtGap[];
  totalVirt: number;
  compressed: boolean;
};

export type Tick = { time_ms: number; virt: number; label: string };

export const COMPRESS_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const COMPRESSED_GAP_VIRT_MS = 2 * 60 * 60 * 1000;

const COLOR_PALETTE = [
  "#4A90E2", "#7B68EE", "#50C878", "#FF6B6B", "#FFA500",
  "#20B2AA", "#DA70D6", "#FFD700", "#FF69B4", "#40E0D0",
  "#9370DB", "#3CB371",
];

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getAppColor(bundleId: string): string {
  return COLOR_PALETTE[hashCode(bundleId) % COLOR_PALETTE.length];
}

export function buildAppLanes(buckets: RawBucket[]): AppLane[] {
  if (buckets.length === 0) return [];
  const sorted = [...buckets].sort((a, b) => a.bucket_start - b.bucket_start);
  const laneMap = new Map<string, AppLane>();

  for (const b of sorted) {
    const key = b.app_bundle_id;
    if (!laneMap.has(key)) {
      laneMap.set(key, {
        app_name: b.app_name,
        app_bundle_id: b.app_bundle_id,
        color: getAppColor(b.app_bundle_id),
        blocks: [],
        total_duration_ms: 0,
      });
    }
    const lane = laneMap.get(key)!;
    const intensity = computeBucketIntensity(b);
    const mouse_total = b.mouse_left + b.mouse_right + b.mouse_middle;
    const lastBlock = lane.blocks[lane.blocks.length - 1];
    const gap = lastBlock ? b.bucket_start - lastBlock.end_ms : Infinity;

    if (lastBlock && gap <= 1000) {
      lastBlock.end_ms = b.bucket_start + b.duration_ms;
      lastBlock.duration_ms = lastBlock.end_ms - lastBlock.start_ms;
      lastBlock.key_total += b.key_total;
      lastBlock.mouse_total += mouse_total;
      lastBlock.intensity = Math.max(lastBlock.intensity, intensity) as 0 | 1 | 2 | 3 | 4;
    } else {
      lane.blocks.push({
        start_ms: b.bucket_start,
        end_ms: b.bucket_start + b.duration_ms,
        duration_ms: b.duration_ms,
        intensity,
        key_total: b.key_total,
        mouse_total,
      });
    }
    lane.total_duration_ms += b.duration_ms;
  }

  const lanes = Array.from(laneMap.values());
  lanes.sort((a, b) => b.total_duration_ms - a.total_duration_ms);
  return lanes;
}

export function computeGlobalGaps(
  lanes: AppLane[],
  fullStart: number,
  fullEnd: number,
  threshold: number
): GapRange[] {
  const intervals: Array<[number, number]> = [];
  for (const l of lanes) {
    for (const b of l.blocks) intervals.push([b.start_ms, b.end_ms]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const gaps: GapRange[] = [];
  let cursor = fullStart;
  for (const [s, e] of merged) {
    if (s - cursor > threshold) gaps.push({ start_ms: cursor, end_ms: s });
    cursor = Math.max(cursor, e);
  }
  if (fullEnd - cursor > threshold) gaps.push({ start_ms: cursor, end_ms: fullEnd });
  return gaps;
}

export function buildSegments(
  fullStart: number,
  fullEnd: number,
  gaps: GapRange[],
  compressed: boolean
): SegmentsData {
  const totalTime = fullEnd - fullStart;
  if (!compressed || gaps.length === 0) {
    return {
      segments: [{ time_start: fullStart, time_end: fullEnd, virt_start: 0, virt_end: totalTime, type: "data" }],
      virtGaps: [],
      totalVirt: totalTime,
      compressed,
    };
  }
  const segs: Segment[] = [];
  const virtGaps: VirtGap[] = [];
  let virtCursor = 0;
  let timeCursor = fullStart;
  for (const g of gaps) {
    if (g.start_ms > timeCursor) {
      const dur = g.start_ms - timeCursor;
      segs.push({ time_start: timeCursor, time_end: g.start_ms, virt_start: virtCursor, virt_end: virtCursor + dur, type: "data" });
      virtCursor += dur;
    }
    const gapVirtStart = virtCursor;
    segs.push({ time_start: g.start_ms, time_end: g.end_ms, virt_start: virtCursor, virt_end: virtCursor + COMPRESSED_GAP_VIRT_MS, type: "gap" });
    virtCursor += COMPRESSED_GAP_VIRT_MS;
    virtGaps.push({ time_start: g.start_ms, time_end: g.end_ms, virt_start: gapVirtStart, virt_end: virtCursor });
    timeCursor = g.end_ms;
  }
  if (timeCursor < fullEnd) {
    segs.push({ time_start: timeCursor, time_end: fullEnd, virt_start: virtCursor, virt_end: virtCursor + (fullEnd - timeCursor), type: "data" });
    virtCursor += fullEnd - timeCursor;
  }
  return { segments: segs, virtGaps, totalVirt: virtCursor, compressed };
}

export function timeToVirt(t: number, segs: Segment[]): number {
  if (segs.length === 0) return 0;
  if (t <= segs[0].time_start) return segs[0].virt_start;
  const last = segs[segs.length - 1];
  if (t >= last.time_end) return last.virt_end;
  for (const s of segs) {
    if (t >= s.time_start && t <= s.time_end) {
      const timeSpan = s.time_end - s.time_start;
      const virtSpan = s.virt_end - s.virt_start;
      if (timeSpan === 0) return s.virt_start;
      if (s.type === "data") return s.virt_start + (t - s.time_start);
      return s.virt_start + ((t - s.time_start) / timeSpan) * virtSpan;
    }
  }
  return last.virt_end;
}

export function virtToTime(v: number, segs: Segment[]): number {
  if (segs.length === 0) return 0;
  if (v <= segs[0].virt_start) return segs[0].time_start;
  const last = segs[segs.length - 1];
  if (v >= last.virt_end) return last.time_end;
  for (const s of segs) {
    if (v >= s.virt_start && v <= s.virt_end) {
      const timeSpan = s.time_end - s.time_start;
      const virtSpan = s.virt_end - s.virt_start;
      if (virtSpan === 0) return s.time_start;
      if (s.type === "data") return s.time_start + (v - s.virt_start);
      return s.time_start + ((v - s.virt_start) / virtSpan) * timeSpan;
    }
  }
  return last.time_end;
}

export function buildTicks(segments: Segment[], viewStart: number, viewEnd: number): Tick[] {
  const virtSpan = viewEnd - viewStart;
  if (virtSpan <= 0) return [];
  const hourMs = 60 * 60 * 1000;
  const minMs = 60 * 1000;
  let interval: number;
  if (virtSpan <= 2 * hourMs) interval = 10 * minMs;
  else if (virtSpan <= 6 * hourMs) interval = 30 * minMs;
  else if (virtSpan <= 12 * hourMs) interval = hourMs;
  else interval = 3 * hourMs;

  const showMinutes = virtSpan <= 6 * hourMs;
  const raw: Tick[] = [];
  for (const s of segments) {
    if (s.type !== "data") continue;
    if (s.virt_end < viewStart || s.virt_start > viewEnd) continue;
    let t = Math.ceil(s.time_start / interval) * interval;
    while (t <= s.time_end) {
      const v = s.virt_start + (t - s.time_start);
      if (v >= viewStart && v <= viewEnd) {
        const d = new Date(t);
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        raw.push({ time_ms: t, virt: v, label: showMinutes ? `${h}:${m}` : `${h}:00` });
      }
      t += interval;
    }
  }
  const minVirtGap = virtSpan * 0.03;
  const pruned: Tick[] = [];
  for (const tk of raw) {
    if (pruned.length === 0 || tk.virt - pruned[pruned.length - 1].virt >= minVirtGap) {
      pruned.push(tk);
    }
  }
  return pruned;
}
