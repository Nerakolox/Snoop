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
import { Calendar } from "lucide-react";
import { fetchBucketsInRange } from "../data";
import {
  buildAppLanes, computeGlobalGaps, buildSegments, timeToVirt, virtToTime, buildTicks,
  COMPRESS_THRESHOLD_MS,
  type AppLane, type TimeBlock,
} from "../analytics";
import TimelineHeader from "../components/timeline/TimelineHeader";
import TimelineTooltip from "../components/timeline/TimelineTooltip";
import SwimLane from "../components/timeline/SwimLane";
import { startOfDay, isSameDay, formatPeriodLabel } from "../utils/date";
import { formatTime, formatDuration } from "../utils/format";


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
    bundleId: string;
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
  const pageRef = useRef<HTMLDivElement>(null);

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
    () => formatPeriodLabel(selectedDate, "day", isToday),
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
    <div ref={pageRef} className="swimlane-page">
      <TimelineHeader
        dateLabel={dateLabel}
        isToday={isToday}
        hasCustomViewport={viewport !== null}
        compressed={compressed}
        onPrevDay={goPrevDay}
        onNextDay={goNextDay}
        onToday={goToday}
        onResetView={resetView}
        onToggleCompressed={toggleCompressed}
      />

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
          style={{ cursor: isDragging ? "grabbing" : "grab", userSelect: "none", WebkitUserSelect: "none" }}
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
                <SwimLane
                  key={lane.app_bundle_id}
                  lane={lane}
                  ticks={ticks}
                  virtToPct={virtToPct}
                  blockStyle={blockStyle}
                  isBlockVisible={isBlockVisible}
                  pageRef={pageRef}
                  trackRef={trackRef}
                  onHoverBlock={setHoveredBlock}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {hoveredBlock && (
        <TimelineTooltip hoveredBlock={hoveredBlock} pageRef={pageRef} />
      )}
    </div>
  );
}
