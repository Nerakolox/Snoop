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
  pickSpikeQuip,
  quantizeLane,
  segmentsToCellLevels,
} from "../analytics";
import PageShell from "../components/PageShell";
import TimelineTooltip, { type HoverTarget } from "../components/timeline/TimelineTooltip";
import SwimLane from "../components/timeline/SwimLane";
import AggregateLane from "../components/timeline/AggregateLane";
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
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

  /** 当前展开身份标识副文本的 lane（bundleId）；同一时刻只展开一行 */
  const [expandedLane, setExpandedLane] = useState<string | null>(null);
  const toggleIdentity = useCallback((bundleId: string) => {
    setExpandedLane((cur) => (cur === bundleId ? null : bundleId));
  }, []);

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

  // LOD 判据:单个 5 秒原始桶在屏幕上 ≥ 3px 宽时,量化格(≈2min/格)已比真实 block 更粗,切回真实 block 渲染。
  // 3px 是人眼可辨/可点击的最小宽度;参考轨道宽 940px(审计 §2.2:窗口宽 − 侧栏 240px − 标签 200px − padding)。
  // 推导:5000ms 需 ≥ 3px,而 3px = 3/940 的轨道 = (3/940×100)%;故 msPerPct ≤ 5000×940/(3×100) ≈ 15667。
  const LOD_REAL_BLOCK_MS_PER_PCT = (5000 * 940) / (3 * 100);
  const renderBlocks = scale.msPerPct <= LOD_REAL_BLOCK_MS_PER_PCT;
  const cellCount = Math.max(80, Math.min(420, Math.round((viewRange.end - viewRange.start) / (2 * 60_000))));

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

  function selectApp(bundleId: string, name: string, startMs: number) {
    const hour = new Date(startMs).getHours();
    actions.navigate({ appId: bundleId, focusHour: hour });
    // 点击色块顺带展开该 lane 的身份标识；强制置为该 bundleId（不 toggle），
    // 避免和"筛选"这个主动作的语义冲突——再点一次同一色块应该还是"选中"，不该被理解成"收起"。
    setExpandedLane(bundleId);
    toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
  }

  function handleBlockClick(e: React.MouseEvent, bundleId: string, name: string, startMs: number) {
    if (!isClickNotDrag(e)) return;
    selectApp(bundleId, name, startMs);
  }

  function handleBlockKeyDown(e: React.KeyboardEvent, bundleId: string, name: string, startMs: number) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    selectApp(bundleId, name, startMs);
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

  // "全部"聚合条：合并所有 lane 的 block，走与普通泳道完全相同的量化管线
  // (同一个 quantizeLane，同一个 scale/cellCount)，不写第二套量化逻辑。
  // 现实里同一时刻只有一个前台 App，各 lane 的 block 天然不重叠，直接拼接即是"时间区间的并集"。
  const allBlocks = useMemo(() => lanes.flatMap((l) => l.blocks), [lanes]);
  const aggSegments = useMemo(
    () => quantizeLane(allBlocks, scale, cellCount),
    [allBlocks, scale, cellCount]
  );

  // 突变检测：v > prev*1.8 且 v > 当日峰值*0.45（照抄工单公式，不改阈值）。
  // 原来挂在 24 个整点采样点上；现在改成挂在聚合条的量化格上，随当前视图缩放联动，
  // 无数据的格按 0 处理，与原来"无数据小时强度记 0"的约定一致。
  const aggCellLevels = useMemo(
    () => segmentsToCellLevels(aggSegments, cellCount),
    [aggSegments, cellCount]
  );

  const spikes = useMemo(() => {
    const W = 100 / cellCount;
    const maxLevel = Math.max(...aggCellLevels, 0);
    const result: { cellIndex: number; x: number; hour: number; level: number }[] = [];
    for (let i = 1; i < cellCount; i++) {
      const v = aggCellLevels[i];
      const prev = aggCellLevels[i - 1];
      if (v > prev * 1.8 && v > maxLevel * 0.45) {
        const x = i * W;
        const hour = new Date(scale.pctToTime(x)).getHours();
        result.push({ cellIndex: i, x, hour, level: v });
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggCellLevels, cellCount, scale]);

  const [spikePopover, setSpikePopover] = useState<{ cellIndex: number; x: number; text: string } | null>(null);

  function handleSpikeClick(cellIndex: number, x: number, hour: number, level: number) {
    setSpikePopover((cur) =>
      cur?.cellIndex === cellIndex ? null : { cellIndex, x, text: pickSpikeQuip(hour, level as 0 | 1 | 2 | 3 | 4) }
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

          {/* "全部"聚合条 + 突变标记（挪到聚合条上方），与下方泳道用细分隔线隔开 */}
          <div className="swimlane-agg-section">
            <div className="swimlane-spike-row">
              <div className="swimlane-axis-label" aria-hidden />
              <div className="swimlane-spike-track">
                {spikes.map((sp) => (
                  <Tooltip key={sp.cellIndex} content={`${sp.hour}:00 突变`}>
                    <button
                      type="button"
                      className="swimlane-spike-marker"
                      style={{ left: `${sp.x}%` }}
                      onClick={() => handleSpikeClick(sp.cellIndex, sp.x, sp.hour, sp.level)}
                    />
                  </Tooltip>
                ))}
                {spikePopover && (
                  <div className="swimlane-spike-popover" style={{ left: `${spikePopover.x}%` }}>
                    {spikePopover.text}
                  </div>
                )}
              </div>
            </div>
            <AggregateLane segments={aggSegments} />
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
                        ⋯ {formatDuration(g.durationMs)} 无活动
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
                  onHover={setHovered}
                  dimmed={appId !== null && lane.app_bundle_id !== appId}
                  renderBlocks={renderBlocks}
                  cellCount={cellCount}
                  onBlockClick={handleBlockClick}
                  onBlockKeyDown={handleBlockKeyDown}
                  expanded={expandedLane === lane.app_bundle_id}
                  onToggleIdentity={toggleIdentity}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {lanes.length > 0 && (
        <div className="swimlane-legend">
          <span className="swimlane-legend-item swimlane-legend-ramp">
            <span className="swimlane-legend-label">低</span>
            {[0, 1, 2, 3, 4].map((lv) => (
              <span
                key={lv}
                className="swimlane-legend-swatch"
                style={{ background: `var(--intensity-${lv})` }}
              />
            ))}
            <span className="swimlane-legend-label">高</span>
          </span>
          <span className="swimlane-legend-title">活跃强度</span>
        </div>
      )}

      {hovered && (
        <TimelineTooltip hovered={hovered} onClose={() => setHovered(null)} />
      )}
    </PageShell>
  );
}
