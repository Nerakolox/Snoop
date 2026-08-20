/**
 * 时间线 —— 横向泳道图（甘特图）
 * 纵轴：每个 App 一条泳道，横轴：时间轴，色块表示使用时段。
 * 消费全局 (kind, anchor, appId)；本页粒度恒为「日」（PAGE_KIND_CAP 限制），
 * 日期切换与范围导航统一由顶栏驱动。
 *
 * 时间轴压缩：
 *  超过 COMPRESS_THRESHOLD_MS 的全局空白（所有 App 均无活动）会被压缩成
 *  一个固定宽 COMPRESSED_GAP_VIRT_MS 的灰色板。
 *  所有位置换算通过分段映射 timeToVirt / virtToTime 统一转换到"虚拟坐标"，
 *  缩放和平移直接操作虚拟坐标，避免坐标系混用。
 */

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Calendar, Maximize2, Minimize2 } from "lucide-react";
import { fetchBucketsInRange } from "../data";
import { formatAnchor, toMs } from "../data/ranges";
import type { RawBucket } from "../data/types";
import {
  buildAppLanes, computeGlobalGaps, buildSegments, timeToVirt, virtToTime, buildTicks,
  COMPRESS_THRESHOLD_MS,
  intensityByHourFromBuckets,
  pickSpikeQuip,
  type TimeBlock,
} from "../analytics";
import PageShell from "../components/PageShell";
import TimelineTooltip from "../components/timeline/TimelineTooltip";
import SwimLane from "../components/timeline/SwimLane";
import { useTimeScale } from "../hooks/useTimeScale";
import { useToast } from "../components/shared/Toast";
import Tooltip from "../components/shared/Tooltip";
import { useTopBarTools } from "../components/topbar/TopBarToolsContext";
import { adaptKind, useContextActions, useContextState } from "../store/context";
import { formatTime, formatDuration } from "../utils/format";

// ---- 主组件 -----------------------------------------------------------------

export default function Timeline() {
  const { kind, anchor, appId } = useContextState();
  const actions = useContextActions();
  const toast = useToast();
  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("timeline", { kind, anchor });

  const [buckets, setBuckets] = useState<RawBucket[]>([]);
  const lanes = useMemo(() => buildAppLanes(buckets), [buckets]);
  const [loading, setLoading] = useState(false);
  const [hoveredBlock, setHoveredBlock] = useState<{
    app: string;
    bundleId: string;
    block: TimeBlock;
    anchorX: number;
    anchorY: number;
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

  // 当前时刻：仅在查看今天时按分钟推进（历史查看不需要）
  const isTodayView = viewAnchor === formatAnchor(new Date());
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isTodayView) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isTodayView]);

  // 今天：0 点 → 当前时刻（活范围）；历史：完整 0 点 → 次日 0 点。
  // 由 toMs(..., {liveEnd:true}) 统一给出，nowMs 是驱动它按分钟前进的依赖。
  const range = useMemo(
    () => toMs(viewKind, viewAnchor, { liveEnd: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewKind, viewAnchor, nowMs]
  );

  // 全局空白（基于所有 App 合并区间）
  const globalGaps = useMemo(
    () =>
      computeGlobalGaps(
        lanes,
        range.start_ms,
        range.end_ms,
        COMPRESS_THRESHOLD_MS
      ),
    [lanes, range.start_ms, range.end_ms]
  );

  // 分段映射（时间 <-> 虚拟坐标）
  const segmentsData = useMemo(
    () =>
      buildSegments(
        range.start_ms,
        range.end_ms,
        globalGaps,
        compressed
      ),
    [range.start_ms, range.end_ms, globalGaps, compressed]
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

  // 时间 → 横向百分比换算统一入口（供刻度/色块/强度曲线/空白带共享）
  const scale = useTimeScale(segmentsData.segments, viewRange);

  const ticks = useMemo(
    () => buildTicks(segmentsData.segments, viewRange.start, viewRange.end),
    [segmentsData, viewRange.start, viewRange.end]
  );

  const resetView = useCallback(() => {
    setViewport(null);
  }, []);

  // 换天时重置视图（顶栏切 anchor 驱动）
  useEffect(() => {
    setViewport(null);
  }, [viewAnchor]);

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
      range.start_ms,
      range.end_ms,
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
  }, [compressed, viewport, segmentsData, range, globalGaps]);

  // 加载数据：直接调 fetchBucketsInRange 拿全量（不接 useRangeData），因为
  // ① 其他 App 的泳道要灰化显示而不是被过滤掉，取数阶段必须是全量；
  // ② useRangeData 的缓存键不含 liveEnd，会把"今天"的 now 冻在首次加载那一刻。
  // range 随 nowMs 每分钟变化，天然驱动刷新，无需再挂 interval。
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      try {
        const raw = await fetchBucketsInRange(range);
        if (cancelled) return;
        setBuckets(raw);
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
  }, [range.start_ms, range.end_ms]);

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
    // 注意：这里不清 dragStartRef —— click 事件在浏览器里晚于 mouseup 触发，
    // 若此处置 null，色块的 onClick 里就再也读不到本次拖拽的起点，
    // 拖拽/点击判定会失效。dragStartRef 留到下一次 mousedown 时自然覆盖。
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

  // 拖拽平移松手时会在同一位置触发 click，需按位移量区分「点击」与「拖拽后松手」
  function isClickNotDrag(e: React.MouseEvent): boolean {
    const s = dragStartRef.current;
    if (!s) return true;
    return Math.abs(e.clientX - s.x) < 4 && Math.abs(e.clientY - s.y) < 4;
  }

  function selectApp(bundleId: string, name: string, block: TimeBlock) {
    const hour = new Date(block.start_ms).getHours();
    actions.navigate({ appId: bundleId, focusHour: hour });
    toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
  }

  function handleBlockClick(e: React.MouseEvent, bundleId: string, name: string, block: TimeBlock) {
    if (!isClickNotDrag(e)) return;
    selectApp(bundleId, name, block);
  }

  function handleBlockKeyDown(e: React.KeyboardEvent, bundleId: string, name: string, block: TimeBlock) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    selectApp(bundleId, name, block);
  }

  const gapBands = useMemo(() => {
    return segmentsData.virtGaps.map((g) => {
      const { left, width } = scale.bandStyle(g.virt_start, g.virt_end);
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
  }, [segmentsData, scale]);

  // 强度曲线：SVG viewBox 高度，与 CSS 里 .swimlane-intensity-track 的高度对应
  const CURVE_VB_H = 32;

  // 按小时的活跃强度 —— 复用 Batch 2 的 intensityByHourFromBuckets，不新写聚合
  const hourlyIntensity = useMemo(() => intensityByHourFromBuckets(buckets), [buckets]);

  // x 坐标统一走 scale.timeToPct，与刻度尺/色块共用同一套映射
  const curvePoints = useMemo(() => {
    return hourlyIntensity.map((level, hour) => {
      const t = range.start_ms + hour * 3_600_000;
      const x = scale.timeToPct(t);
      const y = CURVE_VB_H - 2 - (level / 4) * (CURVE_VB_H - 4);
      return { hour, level, x, y };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourlyIntensity, range.start_ms, scale]);

  const curvePathD = useMemo(
    () => curvePoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" "),
    [curvePoints]
  );

  // 突变检测：v > prev*1.8 且 v > 当日峰值*0.45（照抄工单公式，不改阈值）
  const spikeHours = useMemo(() => {
    const maxLevel = Math.max(...hourlyIntensity, 0);
    const spikes: number[] = [];
    for (let h = 1; h < 24; h++) {
      const v = hourlyIntensity[h];
      const prev = hourlyIntensity[h - 1];
      if (v > prev * 1.8 && v > maxLevel * 0.45) {
        spikes.push(h);
      }
    }
    return spikes;
  }, [hourlyIntensity]);

  const [spikePopover, setSpikePopover] = useState<{ hour: number; text: string } | null>(null);

  function handleSpikeClick(hour: number, level: number) {
    setSpikePopover((cur) =>
      cur?.hour === hour ? null : { hour, text: pickSpikeQuip(hour, level as 0 | 1 | 2 | 3 | 4) }
    );
  }

  // 气泡关闭：再点一次（上面 toggle 已处理）/ 点别处 / Esc
  useEffect(() => {
    if (!spikePopover) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSpikePopover(null);
    }
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".swimlane-spike-marker") && !target.closest(".swimlane-spike-popover")) {
        setSpikePopover(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [spikePopover]);

  // TODO(样式大改): focusHour 目前只经顶栏内建芯片展示，不驱动视口。
  // 现有时间线是 viewport 虚拟坐标模型（无 scrollLeft），自动定位需要
  // 与 viewport 安全带、压缩开关同步，等样式重构定稿后再实现。

  useTopBarTools(
    [
      ...(note !== null
        ? [
            {
              key: "note",
              priority: "high" as const,
              node: <span className="topbar__chip topbar__chip--readonly">{note}</span>,
            },
          ]
        : []),
      ...(viewport !== null
        ? [
            {
              key: "reset",
              node: (
                <Tooltip content="重置视图">
                  <button
                    type="button"
                    className="topbar__tool-btn"
                    data-tauri-drag-region="false"
                    onClick={resetView}
                  >
                    <Maximize2 size={14} />
                    <span>重置视图</span>
                  </button>
                </Tooltip>
              ),
            },
          ]
        : []),
      {
        key: "compress",
        node: (
          <Tooltip content={compressed ? "切换到完整视图" : "切换到压缩视图"}>
            <button
              type="button"
              className="topbar__tool-btn"
              data-tauri-drag-region="false"
              onClick={toggleCompressed}
            >
              {compressed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
              <span>{compressed ? "展开空白" : "压缩空白"}</span>
            </button>
          </Tooltip>
        ),
      },
    ],
    [note, viewport !== null, compressed]
  );

  return (
    <PageShell className="swimlane-page" fill>
      {lanes.length === 0 && !loading && (
        <div className="swimlane-empty">
          <Calendar size={48} strokeWidth={1.5} />
          <p>{isTodayView ? "今天还没有活动数据" : "这天没有记录"}</p>
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
                  style={{ left: `${scale.toPct(tk.virt)}%` }}
                >
                  {tk.label}
                </div>
              ))}
            </div>
          </div>

          {/* 活跃强度曲线 + 突变标记 */}
          <div className="swimlane-intensity-row">
            <div className="swimlane-axis-label" aria-hidden />
            <div className="swimlane-intensity-track">
              <svg
                viewBox={`0 0 100 ${CURVE_VB_H}`}
                preserveAspectRatio="none"
                className="swimlane-intensity-svg"
              >
                <path d={curvePathD} className="swimlane-intensity-line" />
              </svg>
              {spikeHours.map((hour) => {
                const point = curvePoints[hour];
                return (
                  <Tooltip key={hour} content={`${hour}:00 突变`}>
                    <button
                      type="button"
                      className="swimlane-spike-marker"
                      style={{ left: `${point.x}%` }}
                      onClick={() => handleSpikeClick(hour, point.level)}
                    />
                  </Tooltip>
                );
              })}
              {spikePopover && (
                <div
                  className="swimlane-spike-popover"
                  style={{ left: `${curvePoints[spikePopover.hour].x}%` }}
                >
                  {spikePopover.text}
                </div>
              )}
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
              <div className="swimlane-gap-overlay">
                {gapBands.map((g) => (
                  <Tooltip
                    key={g.key}
                    content={`空闲 ${formatDuration(g.durationMs)} · ${formatTime(g.time_start)} – ${formatTime(g.time_end)}`}
                  >
                    <div
                      className="swimlane-gap-band"
                      style={{ left: g.left, width: g.width }}
                    >
                      <span className="swimlane-gap-label">
                        空闲 {formatDuration(g.durationMs)}
                      </span>
                    </div>
                  </Tooltip>
                ))}
              </div>
            )}

            {/* 泳道列表 */}
            <div ref={bodyRef} className="swimlane-body">
              <div className="swimlane-grid-layer" aria-hidden>
                {ticks.map((tk) => (
                  <div
                    key={tk.time_ms}
                    className="swimlane-grid-line"
                    style={{ left: `${scale.toPct(tk.virt)}%` }}
                  />
                ))}
              </div>
              {lanes.map((lane) => (
                <SwimLane
                  key={lane.app_bundle_id}
                  lane={lane}
                  scale={scale}
                  trackRef={trackRef}
                  onHoverBlock={setHoveredBlock}
                  dimmed={appId !== null && lane.app_bundle_id !== appId}
                  onBlockClick={handleBlockClick}
                  onBlockKeyDown={handleBlockKeyDown}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {lanes.length > 0 && (
        <div className="swimlane-legend">
          <span className="swimlane-legend-item">
            <span className="swimlane-legend-swatch swimlane-legend-swatch--idle" />
            挂机（有心跳无输入）
          </span>
          <span className="swimlane-legend-item">
            <span className="swimlane-legend-swatch swimlane-legend-swatch--gap" />
            压缩空白 (&gt;2h)
          </span>
          <span className="swimlane-legend-item">
            <span className="swimlane-legend-swatch swimlane-legend-swatch--curve" />
            活跃强度曲线
          </span>
        </div>
      )}

      {hoveredBlock && (
        <TimelineTooltip hoveredBlock={hoveredBlock} onClose={() => setHoveredBlock(null)} />
      )}
    </PageShell>
  );
}
