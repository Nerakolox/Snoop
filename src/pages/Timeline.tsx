/**
 * 时间线 —— 横向泳道图（甘特图）
 * 纵轴：每个 App 一条泳道，横轴：时间轴，色块表示使用时段。
 * 支持日期切换查看历史任意一天。
 *
 * 时间轴压缩：
 *  超过 COMPRESS_THRESHOLD_MS 的全局空白（所有 App 均无活动）会被压缩成
 *  一个固定宽 COMPRESSED_GAP_VIRT_MS 的灰色板。
 *  所有位置换算通过分段映射 timeToVirt / virtToTime 统一转换到"虚拟坐标"，
 *  缩放和平移直接操作虚拟坐标，避免坐标系混用。
 */

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { fetchBucketsInRange, type RawBucket } from "../data";
import { computeBucketIntensity } from "../analytics";
import AppIcon from "../components/AppIcon";

// ---- 压缩配置（可调） -------------------------------------------------------

/** 全局空白超过该时长才压缩 */
const COMPRESS_THRESHOLD_MS = 2 * 60 * 60 * 1000;
/** 压缩后每个灰块固定占用的"虚拟宽度"（等价 2 小时数据段的像素） */
const COMPRESSED_GAP_VIRT_MS = 2 * 60 * 60 * 1000;

type TimeBlock = {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  key_total: number;
  mouse_total: number;
};

type AppLane = {
  app_name: string;
  app_bundle_id: string;
  color: string;
  blocks: TimeBlock[];
  total_duration_ms: number;
};

// ---- 颜色生成：基于 bundle_id 哈希到调和色板 -------------------------------

const COLOR_PALETTE = [
  "#4A90E2",
  "#7B68EE",
  "#50C878",
  "#FF6B6B",
  "#FFA500",
  "#20B2AA",
  "#DA70D6",
  "#FFD700",
  "#FF69B4",
  "#40E0D0",
  "#9370DB",
  "#3CB371",
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
  const hash = hashCode(bundleId);
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

// ---- 数据处理：桶 → 泳道 ----------------------------------------------------

function buildAppLanes(buckets: RawBucket[]): AppLane[] {
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

// ---- 全局空白检测 -----------------------------------------------------------

type GapRange = { start_ms: number; end_ms: number };

/**
 * 合并所有 App 的活动区间，找出跨越所有 App 都没有活动、且超过阈值的空白。
 */
function computeGlobalGaps(
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
  if (fullEnd - cursor > threshold) {
    gaps.push({ start_ms: cursor, end_ms: fullEnd });
  }
  return gaps;
}

// ---- 分段映射：真实时间 <-> 虚拟坐标 ---------------------------------------

type Segment = {
  time_start: number;
  time_end: number;
  virt_start: number;
  virt_end: number;
  type: "data" | "gap";
};

type VirtGap = {
  time_start: number;
  time_end: number;
  virt_start: number;
  virt_end: number;
};

type SegmentsData = {
  segments: Segment[];
  virtGaps: VirtGap[];
  totalVirt: number;
  compressed: boolean;
};

function buildSegments(
  fullStart: number,
  fullEnd: number,
  gaps: GapRange[],
  compressed: boolean
): SegmentsData {
  const totalTime = fullEnd - fullStart;
  if (!compressed || gaps.length === 0) {
    return {
      segments: [
        {
          time_start: fullStart,
          time_end: fullEnd,
          virt_start: 0,
          virt_end: totalTime,
          type: "data",
        },
      ],
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
      segs.push({
        time_start: timeCursor,
        time_end: g.start_ms,
        virt_start: virtCursor,
        virt_end: virtCursor + dur,
        type: "data",
      });
      virtCursor += dur;
    }
    const gapVirtStart = virtCursor;
    segs.push({
      time_start: g.start_ms,
      time_end: g.end_ms,
      virt_start: virtCursor,
      virt_end: virtCursor + COMPRESSED_GAP_VIRT_MS,
      type: "gap",
    });
    virtCursor += COMPRESSED_GAP_VIRT_MS;
    virtGaps.push({
      time_start: g.start_ms,
      time_end: g.end_ms,
      virt_start: gapVirtStart,
      virt_end: virtCursor,
    });
    timeCursor = g.end_ms;
  }
  if (timeCursor < fullEnd) {
    segs.push({
      time_start: timeCursor,
      time_end: fullEnd,
      virt_start: virtCursor,
      virt_end: virtCursor + (fullEnd - timeCursor),
      type: "data",
    });
    virtCursor += fullEnd - timeCursor;
  }
  return { segments: segs, virtGaps, totalVirt: virtCursor, compressed };
}

/** 时间 → 虚拟坐标（所有 X 定位统一走这里，唯一映射源） */
function timeToVirt(t: number, segs: Segment[]): number {
  if (segs.length === 0) return 0;
  if (t <= segs[0].time_start) return segs[0].virt_start;
  const last = segs[segs.length - 1];
  if (t >= last.time_end) return last.virt_end;
  for (const s of segs) {
    if (t >= s.time_start && t <= s.time_end) {
      const timeSpan = s.time_end - s.time_start;
      const virtSpan = s.virt_end - s.virt_start;
      if (timeSpan === 0) return s.virt_start;
      if (s.type === "data") {
        return s.virt_start + (t - s.time_start);
      }
      return s.virt_start + ((t - s.time_start) / timeSpan) * virtSpan;
    }
  }
  return last.virt_end;
}

/** 虚拟坐标 → 时间（tooltip、切换视图保留时间范围时使用） */
function virtToTime(v: number, segs: Segment[]): number {
  if (segs.length === 0) return 0;
  if (v <= segs[0].virt_start) return segs[0].time_start;
  const last = segs[segs.length - 1];
  if (v >= last.virt_end) return last.time_end;
  for (const s of segs) {
    if (v >= s.virt_start && v <= s.virt_end) {
      const timeSpan = s.time_end - s.time_start;
      const virtSpan = s.virt_end - s.virt_start;
      if (virtSpan === 0) return s.time_start;
      if (s.type === "data") {
        return s.time_start + (v - s.virt_start);
      }
      return s.time_start + ((v - s.virt_start) / virtSpan) * timeSpan;
    }
  }
  return last.time_end;
}

// ---- 时间刻度（跨压缩段跳变） ----------------------------------------------

type Tick = { time_ms: number; virt: number; label: string };

function buildTicks(
  segments: Segment[],
  viewStart: number,
  viewEnd: number
): Tick[] {
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
        raw.push({
          time_ms: t,
          virt: v,
          label: showMinutes ? `${h}:${m}` : `${h}:00`,
        });
      }
      t += interval;
    }
  }
  // 相邻刻度最小间距 3% 视口宽度，避免跨压缩段时标签堆叠
  const minVirtGap = virtSpan * 0.03;
  const pruned: Tick[] = [];
  for (const tk of raw) {
    if (
      pruned.length === 0 ||
      tk.virt - pruned[pruned.length - 1].virt >= minVirtGap
    ) {
      pruned.push(tk);
    }
  }
  return pruned;
}

// ---- 时间格式化 -------------------------------------------------------------

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

// ---- 日期工具 ---------------------------------------------------------------

function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatDateLabel(d: Date, isToday: boolean): string {
  if (isToday) return "今天";
  const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  const dow = days[d.getDay()];
  return `${year}-${month}-${date} ${dow}`;
}

function dataRange(
  d: Date,
  isToday: boolean,
  nowMs: number
): { start_ms: number; end_ms: number } {
  const start = startOfDay(d);
  let end: Date;
  if (isToday) {
    end = new Date(nowMs);
  } else {
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  }
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}

/**
 * 显示范围（也是压缩计算所依据的"日范围"）：
 *  - 今天：0 点 → 当前时刻（未来时间不参与渲染，也不作为空闲）
 *  - 历史：完整 0 点 → 次日 0 点
 */
function displayRange(
  d: Date,
  isToday: boolean,
  nowMs: number
): { start_ms: number; end_ms: number } {
  const start = startOfDay(d);
  if (isToday) {
    return { start_ms: start.getTime(), end_ms: nowMs };
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}

// ---- 主组件 -----------------------------------------------------------------

export default function Timeline() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [lanes, setLanes] = useState<AppLane[]>([]);
  const [loading, setLoading] = useState(false);
  const [hoveredBlock, setHoveredBlock] = useState<{
    app: string;
    block: TimeBlock;
    x: number;
    y: number;
  } | null>(null);

  /** 压缩开关：默认开启 */
  const [compressed, setCompressed] = useState(true);

  /** 视口在虚拟坐标空间中的范围；null 表示"全视图" */
  const [viewport, setViewport] = useState<{ start: number; end: number } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    viewStart: number;
    viewEnd: number;
    scrollTop: number;
  } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const [fadeMasks, setFadeMasks] = useState({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });

  const today = useMemo(() => startOfDay(new Date()), []);
  const isToday = useMemo(
    () => isSameDay(selectedDate, today),
    [selectedDate, today]
  );
  const dateLabel = useMemo(
    () => formatDateLabel(selectedDate, isToday),
    [selectedDate, isToday]
  );

  // 当前时刻：仅在查看今天时按分钟推进（历史查看不需要）
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isToday) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isToday]);

  const fetchRange = useMemo(
    () => dataRange(selectedDate, isToday, nowMs),
    [selectedDate, isToday, nowMs]
  );
  const fullDayRange = useMemo(
    () => displayRange(selectedDate, isToday, nowMs),
    [selectedDate, isToday, nowMs]
  );

  // 全局空白（基于所有 App 合并区间）
  const globalGaps = useMemo(
    () =>
      computeGlobalGaps(
        lanes,
        fullDayRange.start_ms,
        fullDayRange.end_ms,
        COMPRESS_THRESHOLD_MS
      ),
    [lanes, fullDayRange.start_ms, fullDayRange.end_ms]
  );

  // 分段映射（时间 <-> 虚拟坐标）
  const segmentsData = useMemo(
    () =>
      buildSegments(
        fullDayRange.start_ms,
        fullDayRange.end_ms,
        globalGaps,
        compressed
      ),
    [fullDayRange.start_ms, fullDayRange.end_ms, globalGaps, compressed]
  );

  // 视口安全带：数据变化导致 totalVirt 变化时，越界就复位
  useEffect(() => {
    if (!viewport) return;
    if (
      viewport.end > segmentsData.totalVirt ||
      viewport.start < 0 ||
      viewport.end - viewport.start <= 0
    ) {
      setViewport(null);
    }
    // 仅关心 totalVirt；viewport 变化不该触发这里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsData.totalVirt]);

  const viewRange = useMemo(() => {
    if (!viewport) return { start: 0, end: segmentsData.totalVirt };
    return { start: viewport.start, end: viewport.end };
  }, [viewport, segmentsData.totalVirt]);

  const viewSpan = viewRange.end - viewRange.start;

  const ticks = useMemo(
    () => buildTicks(segmentsData.segments, viewRange.start, viewRange.end),
    [segmentsData, viewRange.start, viewRange.end]
  );

  const resetView = useCallback(() => {
    setViewport(null);
  }, []);

  // 切换日期时重置视图
  useEffect(() => {
    setViewport(null);
  }, [selectedDate]);

  function goPrevDay() {
    setSelectedDate((d) => {
      const prev = new Date(d);
      prev.setDate(prev.getDate() - 1);
      return prev;
    });
  }

  function goNextDay() {
    if (!isToday) {
      setSelectedDate((d) => {
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        return next;
      });
    }
  }

  function goToday() {
    setSelectedDate(new Date());
  }

  // 切换压缩：保留当前视口的真实时间范围
  const toggleCompressed = useCallback(() => {
    const newCompressed = !compressed;
    const wasFullView = viewport === null;
    const oldSegs = segmentsData;
    const curStart = viewport?.start ?? 0;
    const curEnd = viewport?.end ?? oldSegs.totalVirt;
    const t1 = virtToTime(curStart, oldSegs.segments);
    const t2 = virtToTime(curEnd, oldSegs.segments);

    const newSegs = buildSegments(
      fullDayRange.start_ms,
      fullDayRange.end_ms,
      globalGaps,
      newCompressed
    );

    setCompressed(newCompressed);
    if (wasFullView) {
      setViewport(null);
    } else {
      const v1 = timeToVirt(t1, newSegs.segments);
      const v2 = timeToVirt(t2, newSegs.segments);
      const clampedStart = Math.max(0, Math.min(newSegs.totalVirt, v1));
      const clampedEnd = Math.max(0, Math.min(newSegs.totalVirt, v2));
      if (clampedEnd - clampedStart < 30 * 60 * 1000) {
        setViewport(null);
      } else {
        setViewport({ start: clampedStart, end: clampedEnd });
      }
    }
  }, [compressed, viewport, segmentsData, fullDayRange, globalGaps]);

  // 加载数据（fetchRange 会随 nowMs 每分钟变化，天然驱动刷新，无需再挂 interval）
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      try {
        const buckets = await fetchBucketsInRange(fetchRange);
        if (cancelled) return;
        const appLanes = buildAppLanes(buckets);
        setLanes(appLanes);
      } catch (e) {
        console.error("Timeline refresh failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [fetchRange.start_ms, fetchRange.end_ms]);

  // 滚轮缩放（虚拟坐标空间）
  useEffect(() => {
    const chartEl = chartRef.current;
    if (!chartEl) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;

      const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const total = segmentsData.totalVirt;
      const curStart = viewport?.start ?? 0;
      const curEnd = viewport?.end ?? total;
      const curSpan = curEnd - curStart;
      const mouseVirt = curStart + curSpan * relX;

      const zoomDelta = e.deltaY > 0 ? 1.2 : 0.8;
      let newSpan = curSpan * zoomDelta;
      const minSpan = 30 * 60 * 1000;
      newSpan = Math.max(minSpan, Math.min(total, newSpan));

      let newStart = mouseVirt - newSpan * relX;
      let newEnd = newStart + newSpan;
      if (newStart < 0) {
        newStart = 0;
        newEnd = newSpan;
      }
      if (newEnd > total) {
        newEnd = total;
        newStart = newEnd - newSpan;
      }
      setViewport({ start: newStart, end: newEnd });
    };

    chartEl.addEventListener("wheel", handleWheel, { passive: false });
    return () => chartEl.removeEventListener("wheel", handleWheel);
  }, [viewport, segmentsData.totalVirt]);

  // 拖拽平移（也在虚拟坐标空间）
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const total = segmentsData.totalVirt;
      const curStart = viewport?.start ?? 0;
      const curEnd = viewport?.end ?? total;
      const curScrollTop = bodyRef.current?.scrollTop ?? 0;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        viewStart: curStart,
        viewEnd: curEnd,
        scrollTop: curScrollTop,
      };
      setIsDragging(true);
    },
    [viewport, segmentsData.totalVirt]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (
        !isDragging ||
        !dragStartRef.current ||
        !trackRef.current ||
        !bodyRef.current
      )
        return;

      const rect = trackRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;

      // 横向：平移虚拟坐标
      const deltaX = e.clientX - dragStartRef.current.x;
      const spanAtStart =
        dragStartRef.current.viewEnd - dragStartRef.current.viewStart;
      const deltaVirt = -(deltaX / rect.width) * spanAtStart;

      let newStart = dragStartRef.current.viewStart + deltaVirt;
      let newEnd = dragStartRef.current.viewEnd + deltaVirt;
      const span = newEnd - newStart;
      const total = segmentsData.totalVirt;
      if (newStart < 0) {
        newStart = 0;
        newEnd = span;
      }
      if (newEnd > total) {
        newEnd = total;
        newStart = newEnd - span;
      }
      setViewport({ start: newStart, end: newEnd });

      // 纵向：滚动泳道列表
      const deltaY = e.clientY - dragStartRef.current.y;
      const newScrollTop = dragStartRef.current.scrollTop - deltaY;
      bodyRef.current.scrollTop = Math.max(
        0,
        Math.min(
          newScrollTop,
          bodyRef.current.scrollHeight - bodyRef.current.clientHeight
        )
      );
    },
    [isDragging, segmentsData.totalVirt]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => setIsDragging(false);
      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
    }
  }, [isDragging]);

  // 渐隐遮罩：都在虚拟坐标空间判断
  const updateFadeMasks = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const scrollTop = body.scrollTop;
    const scrollHeight = body.scrollHeight;
    const clientHeight = body.clientHeight;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;
    const hasTop = scrollTop > 10;
    const hasBottom = scrollBottom > 10;
    const total = segmentsData.totalVirt;
    const curStart = viewport?.start ?? 0;
    const curEnd = viewport?.end ?? total;
    const hasLeft = curStart > 0;
    const hasRight = curEnd < total;
    setFadeMasks({
      top: hasTop,
      bottom: hasBottom,
      left: hasLeft,
      right: hasRight,
    });
  }, [viewport, segmentsData.totalVirt]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    updateFadeMasks();
    const handleScroll = () => updateFadeMasks();
    body.addEventListener("scroll", handleScroll, { passive: true });
    return () => body.removeEventListener("scroll", handleScroll);
  }, [updateFadeMasks]);

  useEffect(() => {
    updateFadeMasks();
  }, [viewport, lanes, updateFadeMasks]);

  // ---- 位置换算：统一入口 ---------------------------------------------------

  /** 虚拟坐标 → 视口内百分比（左侧 %） */
  function virtToPct(v: number): number {
    if (viewSpan <= 0) return 0;
    return ((v - viewRange.start) / viewSpan) * 100;
  }

  function blockStyle(block: TimeBlock): CSSProperties {
    const vs = timeToVirt(block.start_ms, segmentsData.segments);
    const ve = timeToVirt(block.end_ms, segmentsData.segments);
    const left = virtToPct(vs);
    const width = Math.max(virtToPct(ve) - left, 0.3);
    return { left: `${left}%`, width: `${width}%` };
  }

  function isBlockVisible(block: TimeBlock): boolean {
    // 直接用真实时间判断可见性（避免非必要 timeToVirt 调用）
    const vs = timeToVirt(block.start_ms, segmentsData.segments);
    const ve = timeToVirt(block.end_ms, segmentsData.segments);
    return ve >= viewRange.start && vs <= viewRange.end;
  }

  const gapBands = useMemo(() => {
    return segmentsData.virtGaps.map((g) => {
      const left = virtToPct(g.virt_start);
      const width = virtToPct(g.virt_end) - left;
      const durationMs = g.time_end - g.time_start;
      return {
        key: `${g.time_start}-${g.time_end}`,
        left,
        width,
        durationMs,
        time_start: g.time_start,
        time_end: g.time_end,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsData, viewRange.start, viewRange.end]);

  return (
    <div className="swimlane-page">
      {/* 日期切换控件 */}
      <div className="swimlane-date-picker">
        <button
          className="swimlane-nav-btn"
          onClick={goPrevDay}
          title="前一天"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="swimlane-date-label">
          <Calendar size={16} />
          <span>{dateLabel}</span>
        </div>
        <button
          className="swimlane-nav-btn"
          onClick={goNextDay}
          disabled={isToday}
          title="后一天"
        >
          <ChevronRight size={18} />
        </button>
        {!isToday && (
          <button className="swimlane-today-btn" onClick={goToday}>
            回到今天
          </button>
        )}
        {viewport && (
          <button
            className="swimlane-reset-btn"
            onClick={resetView}
            title="重置视图"
          >
            <Maximize2 size={16} />
            <span>重置视图</span>
          </button>
        )}
        <button
          className="swimlane-compress-toggle"
          onClick={toggleCompressed}
          title={compressed ? "切换到完整视图" : "切换到压缩视图"}
        >
          {compressed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
          <span>{compressed ? "展开空白" : "压缩空白"}</span>
        </button>
      </div>

      {lanes.length === 0 && !loading && (
        <div className="swimlane-empty">
          <Calendar size={48} strokeWidth={1.5} />
          <p>{isToday ? "今天还没有活动数据" : "这天没有记录"}</p>
        </div>
      )}

      {lanes.length > 0 && (
        <div
          ref={chartRef}
          className="swimlane-chart"
          style={{ cursor: isDragging ? "grabbing" : "grab" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {/* 时间轴刻度 */}
          <div className="swimlane-header">
            <div className="swimlane-axis-label">App</div>
            <div className="swimlane-axis">
              {ticks.map((tk) => (
                <div
                  key={tk.time_ms}
                  className="swimlane-tick"
                  style={{ left: `${virtToPct(tk.virt)}%` }}
                >
                  {tk.label}
                </div>
              ))}
            </div>
          </div>

          {/* 泳道列表容器（带渐隐遮罩） */}
          <div className="swimlane-body-wrap">
            {fadeMasks.top && <div className="swimlane-fade-mask swimlane-fade-top" />}
            {fadeMasks.bottom && <div className="swimlane-fade-mask swimlane-fade-bottom" />}
            {fadeMasks.left && <div className="swimlane-fade-mask swimlane-fade-left" />}
            {fadeMasks.right && <div className="swimlane-fade-mask swimlane-fade-right" />}

            {/* 空白压缩：灰色空闲板 —— 单层覆盖，不随泳道滚动 */}
            {gapBands.length > 0 && (
              <div className="swimlane-gap-overlay" style={{ height: lanes.length * 48 + Math.max(0, lanes.length - 1) * 8 + 32 }}>
                {gapBands.map((g) => (
                  <div
                    key={g.key}
                    className="swimlane-gap-band"
                    style={{ left: `${g.left}%`, width: `${g.width}%` }}
                    title={`空闲 ${formatDuration(g.durationMs)} · ${formatTime(g.time_start)} – ${formatTime(g.time_end)}`}
                  >
                    <span className="swimlane-gap-label">
                      空闲 {formatDuration(g.durationMs)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* 泳道列表 */}
            <div ref={bodyRef} className="swimlane-body">
              {lanes.map((lane) => (
                <div key={lane.app_bundle_id} className="swimlane-row">
                  <div className="swimlane-label">
                    <AppIcon
                      bundleId={lane.app_bundle_id}
                      appName={lane.app_name}
                      size={16}
                    />
                    <span className="swimlane-app-name" title={lane.app_name}>
                      {lane.app_name}
                    </span>
                  </div>
                  <div ref={trackRef} className="swimlane-track">
                    {/* 背景网格线 */}
                    {ticks.map((tk) => (
                      <div
                        key={tk.time_ms}
                        className="swimlane-grid-line"
                        style={{ left: `${virtToPct(tk.virt)}%` }}
                      />
                    ))}
                    {/* 色块（只渲染可见的） */}
                    {lane.blocks.filter(isBlockVisible).map((block, i) => (
                      <div
                        key={i}
                        className="swimlane-block"
                        style={{
                          ...blockStyle(block),
                          background: lane.color,
                        }}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setHoveredBlock({
                            app: lane.app_name,
                            block,
                            x: rect.left + rect.width / 2,
                            y: rect.top,
                          });
                        }}
                        onMouseLeave={() => setHoveredBlock(null)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tooltip */}
      {hoveredBlock && (
        <div
          className="swimlane-tooltip"
          style={{ left: hoveredBlock.x, top: hoveredBlock.y - 8 }}
        >
          <div className="swimlane-tooltip-app">{hoveredBlock.app}</div>
          <div className="swimlane-tooltip-time">
            {formatTime(hoveredBlock.block.start_ms)} –{" "}
            {formatTime(hoveredBlock.block.end_ms)}
          </div>
          <div className="swimlane-tooltip-duration">
            {formatDuration(hoveredBlock.block.duration_ms)}
          </div>
          <div className="swimlane-tooltip-intensity">
            强度 {hoveredBlock.block.intensity}
          </div>
        </div>
      )}
    </div>
  );
}
