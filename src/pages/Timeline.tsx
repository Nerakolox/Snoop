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

import { useEffect, useLayoutEffect, useMemo, useState, useRef, useCallback } from "react";
import { Calendar, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { fetchBucketsInRange } from "../data";
import { formatAnchor, toMs } from "../data/ranges";
import type { RawBucket } from "../data/types";
import {
  buildAppLanes, computeGlobalGaps, buildSegments, timeToVirt, virtToTime, buildTicks,
  COMPRESS_THRESHOLD_MS,
  pickSpikeQuip,
  pickCellWidthVirt,
  quantizeLaneVirtual,
  sliceQuantized,
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
  const { kind, anchor, appId, focusHour } = useContextState();
  const actions = useContextActions();
  const toast = useToast();
  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("timeline", { kind, anchor });

  const [buckets, setBuckets] = useState<RawBucket[]>([]);
  const lanes = useMemo(() => buildAppLanes(buckets), [buckets]);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

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

  /** 滚动区底部常驻的"+N 个应用"行需要的隐藏行数 —— 行高是常量，用 scrollTop / clientHeight /
   *  总行数解析计算，不逐行测量、不用 ResizeObserver。随滚动实时更新，滚动到底时数字应归零。 */
  const [hiddenLaneCount, setHiddenLaneCount] = useState(0);
  const updateHiddenLaneCount = useCallback(() => {
    const body = bodyRef.current;
    const chart = chartRef.current;
    if (!body || !chart) return;
    const cs = getComputedStyle(chart);
    const laneH = parseFloat(cs.getPropertyValue("--lane-h")) || 48;
    const laneGap = parseFloat(cs.getPropertyValue("--lane-gap")) || 8;
    const rowH = laneH + laneGap;
    const rowsShown = Math.max(0, Math.floor((body.scrollTop + body.clientHeight) / rowH));
    setHiddenLaneCount((cur) => {
      const next = Math.max(0, lanes.length - rowsShown);
      return next === cur ? cur : next;
    });
  }, [lanes.length]);

  useEffect(() => {
    updateHiddenLaneCount();
    window.addEventListener("resize", updateHiddenLaneCount);
    return () => window.removeEventListener("resize", updateHiddenLaneCount);
  }, [updateHiddenLaneCount]);

  // 滚动实时更新隐藏行数：rAF 节流，一帧最多算一次。
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let raf: number | null = null;
    const onScroll = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        updateHiddenLaneCount();
      });
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [updateHiddenLaneCount]);

  const scrollToMore = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }, []);

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
  // 格宽锚定虚拟时间轴、按视口跨度取离散档位(2min/30s/5s)，与视口位置无关 —— 见 quantize.ts 顶部说明。
  const cellWidthVirt = pickCellWidthVirt(viewRange.end - viewRange.start);

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

  // 跨页定位消费：其他页面（如"规律"/概览）通过全局 focusHour 带第几小时跳转到本页，
  // 本页收到后定位一次即清空，避免顶栏定位芯片常驻。定位窗口/是否连带缩放等细节本轮从简，
  // 取目标小时前后各 1 小时的窗口居中；本页内部点击色块不再写 focusHour（见 selectApp）。
  useEffect(() => {
    if (focusHour === null) return;
    if (segmentsData.totalVirt <= 0) return;
    const targetTime = range.start_ms + focusHour * 60 * 60 * 1000;
    const targetVirt = timeToVirt(targetTime, segmentsData.segments);
    const halfWindow = 60 * 60 * 1000;
    const start = Math.max(0, targetVirt - halfWindow);
    const end = Math.min(segmentsData.totalVirt, targetVirt + halfWindow);
    if (end - start >= 30 * 60 * 1000) {
      setViewport({ start, end });
    }
    actions.setFocusHour(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusHour, segmentsData, range.start_ms]);

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

  // rAF 节流：一帧最多提交一次视口/滚动更新，原生 mousemove 触发频率可能远高于刷新率。
  const dragRafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ start: number; end: number; scrollTop: number } | null>(null);

  const cancelPendingMove = useCallback(() => {
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingMoveRef.current = null;
  }, []);

  const flushPendingMove = useCallback(() => {
    dragRafRef.current = null;
    const pending = pendingMoveRef.current;
    if (!pending) return;
    setViewport({ start: pending.start, end: pending.end });
    if (bodyRef.current) bodyRef.current.scrollTop = pending.scrollTop;
  }, []);

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

      // 纵向：滚动泳道列表
      const deltaY = e.clientY - dragStartRef.current.y;
      const newScrollTop = Math.max(
        0,
        Math.min(
          dragStartRef.current.scrollTop - deltaY,
          bodyRef.current.scrollHeight - bodyRef.current.clientHeight
        )
      );

      pendingMoveRef.current = { start: newStart, end: newEnd, scrollTop: newScrollTop };
      if (dragRafRef.current === null) {
        dragRafRef.current = requestAnimationFrame(flushPendingMove);
      }
    },
    [isDragging, segmentsData.totalVirt, flushPendingMove]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    cancelPendingMove();
    // 注意：这里不清 dragStartRef —— click 事件在浏览器里晚于 mouseup 触发，
    // 若此处置 null，色块的 onClick 里就再也读不到本次拖拽的起点，
    // 拖拽/点击判定会失效。dragStartRef 留到下一次 mousedown 时自然覆盖。
  }, [cancelPendingMove]);

  useEffect(() => {
    return cancelPendingMove;
  }, [cancelPendingMove]);

  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => {
        setIsDragging(false);
        cancelPendingMove();
      };
      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
    }
  }, [isDragging, cancelPendingMove]);

  useEffect(() => {
    updateHiddenLaneCount();
  }, [lanes, updateHiddenLaneCount]);

  // 拖拽平移松手时会在同一位置触发 click，需按位移量区分「点击」与「拖拽后松手」
  function isClickNotDrag(e: React.MouseEvent): boolean {
    const s = dragStartRef.current;
    if (!s) return true;
    return Math.abs(e.clientX - s.x) < 4 && Math.abs(e.clientY - s.y) < 4;
  }

  function selectApp(bundleId: string, name: string) {
    // 不写 focusHour：用户正在看时间线，点一个块再被告知"已定位到 HH:00"没有信息量——
    // 他本来就在那个位置。focusHour 只用于跨页跳转定位（见下方 4b 的消费逻辑）。
    actions.navigate({ appId: bundleId });
    toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
  }

  function handleBlockClick(e: React.MouseEvent, bundleId: string, name: string) {
    if (!isClickNotDrag(e)) return;
    selectApp(bundleId, name);
  }

  function handleBlockKeyDown(e: React.KeyboardEvent, bundleId: string, name: string) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    selectApp(bundleId, name);
  }

  const gapBands = useMemo(() => {
    return segmentsData.virtGaps.map((g) => {
      const left = scale.toPct(g.virt_start);
      const right = scale.toPct(g.virt_end);
      const durationMs = g.time_end - g.time_start;
      // 斜纹带在轨道百分比坐标系里可能延伸到视口外(left<0 / right>100)，
      // 标签要居中在「斜纹带 ∩ 视口」=[max(left,0), min(right,100)] 上，而非整条带。
      const intersectLeft = Math.max(left, 0);
      const intersectRight = Math.min(right, 100);
      return {
        key: `${g.time_start}-${g.time_end}`,
        left: `${left}%`,
        width: `${right - left}%`,
        intersectLeft,
        intersectRight,
        center: (intersectLeft + intersectRight) / 2,
        intersectWidth: intersectRight - intersectLeft,
        durationMs,
        time_start: g.time_start,
        time_end: g.time_end,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsData, scale]);

  // 空白带标签宽度(占轨道宽的百分比)——每个空隙文本固定，只在首帧/窗口 resize 时量一次，
  // 缓存到 labelPcts，不在拖拽 mousemove 里每帧测 DOM。渲染层用它判断交集是否窄到放不下标签。
  const [labelPcts, setLabelPcts] = useState<Record<string, number>>({});

  // 标签集合的稳定签名：key 由空隙起止时间戳决定，拖拽/缩放不改变它，只有数据或压缩开关变化才变。
  const gapLabelKeys = useMemo(() => gapBands.map((g) => g.key).join("|"), [gapBands]);

  useLayoutEffect(() => {
    const measure = () => {
      const trackPx = trackRef.current?.getBoundingClientRect().width ?? 0;
      const pcts: Record<string, number> = {};
      if (trackPx > 0) {
        document.querySelectorAll<HTMLElement>(".swimlane-gap-label").forEach((el) => {
          const k = el.dataset.key;
          if (k) pcts[k] = (el.offsetWidth / trackPx) * 100;
        });
      }
      setLabelPcts((prev) => {
        // 合并而非替换：被隐藏(未渲染)的标签这次量不到，但其宽度已缓存且文本不变，必须保留，
        // 否则 resize 后会把隐藏标签的缓存冲掉，造成一次闪烁。
        const merged = { ...prev, ...pcts };
        const same =
          Object.keys(merged).length === Object.keys(prev).length &&
          Object.keys(merged).every((k) => merged[k] === prev[k]);
        return same ? prev : merged;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [gapLabelKeys]);

  // "全部"聚合条：合并所有 lane 的 block，走与普通泳道完全相同的量化管线
  // (同一个 quantizeLaneVirtual + sliceQuantized，同一个 cellWidthVirt)，不写第二套量化逻辑。
  // 现实里同一时刻只有一个前台 App，各 lane 的 block 天然不重叠，直接拼接即是"时间区间的并集"。
  const allBlocks = useMemo(() => lanes.flatMap((l) => l.blocks), [lanes]);
  // 全量缓存：只在数据版本/格宽档位变化时重算，拖拽平移不触发。
  const aggFull = useMemo(
    () => quantizeLaneVirtual(allBlocks, segmentsData.segments, segmentsData.totalVirt, cellWidthVirt),
    [allBlocks, segmentsData.segments, segmentsData.totalVirt, cellWidthVirt]
  );
  const aggSegments = useMemo(
    () => sliceQuantized(aggFull, viewRange, scale.toPct),
    [aggFull, viewRange.start, viewRange.end, scale]
  );

  // 突变检测：v > prev*1.8 且 v > 当日峰值*0.45（照抄工单公式，不改阈值）。
  // 原来挂在 24 个整点采样点上；现在改成挂在聚合条的量化格上，随当前视图缩放联动，
  // 无数据的格按 0 处理，与原来"无数据小时强度记 0"的约定一致。
  const viewportCellCount = Math.max(1, Math.round((viewRange.end - viewRange.start) / cellWidthVirt));
  const aggCellLevels = useMemo(
    () => segmentsToCellLevels(aggSegments, viewportCellCount),
    [aggSegments, viewportCellCount]
  );

  const spikes = useMemo(() => {
    const cellCount = viewportCellCount;
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
  }, [aggCellLevels, viewportCellCount, scale]);

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

          {/* 泳道列表容器 */}
          <div className="swimlane-body-wrap">
            {/* 泳道列表：滚动视口，本身只负责 overflow-y:auto，不参与内容布局 */}
            <div ref={bodyRef} className="swimlane-body">
              {/* 滚动内容层：position:relative + 高度随泳道行自然撑开（而非贴视口的 100%）。
                  网格线层、空白压缩遮罩都挂在这里而不是挂在 .swimlane-body / .swimlane-body-wrap
                  上 —— 后两者高度都锁定成可视区，其内 inset:0 的子层只够盖首屏，一滚动就露空。 */}
              <div className="swimlane-content">
                <div className="swimlane-grid-layer" aria-hidden>
                  {ticks.map((tk) => (
                    <div
                      key={tk.time_ms}
                      className="swimlane-grid-line"
                      style={{ left: `${scale.toPct(tk.virt)}%` }}
                    />
                  ))}
                </div>
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
                        />
                      </Tooltip>
                    ))}
                  </div>
                )}
                {/* 空白带标签：独立于遮罩层，sticky 垂直居中 + 交集水平居中，见 .swimlane-gap-labels */}
                {gapBands.length > 0 && (
                  <div className="swimlane-gap-labels" aria-hidden>
                    {gapBands.map((g) => {
                      const pct = labelPcts[g.key];
                      const fits =
                        g.intersectWidth > 0 && (pct === undefined ? true : g.intersectWidth >= pct);
                      if (!fits) return null;
                      return (
                        <div
                          key={g.key}
                          className="swimlane-gap-label-slot"
                          style={{ left: `${g.center}%` }}
                        >
                          <span className="swimlane-gap-label" data-key={g.key}>
                            ⋯ {formatDuration(g.durationMs)} 无活动
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {lanes.map((lane) => (
                  <SwimLane
                    key={lane.app_bundle_id}
                    lane={lane}
                    scale={scale}
                    segments={segmentsData.segments}
                    totalVirt={segmentsData.totalVirt}
                    viewRange={viewRange}
                    cellWidthVirt={cellWidthVirt}
                    trackRef={trackRef}
                    onHover={setHovered}
                    dimmed={appId !== null && lane.app_bundle_id !== appId}
                    renderBlocks={renderBlocks}
                    onBlockClick={handleBlockClick}
                    onBlockKeyDown={handleBlockKeyDown}
                  />
                ))}
              </div>
            </div>
            {hiddenLaneCount > 0 && (
              <button type="button" className="swimlane-more-row" onClick={scrollToMore}>
                <span className="swimlane-more-label">+{hiddenLaneCount} 个应用</span>
                <ChevronDown size={14} />
              </button>
            )}
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
