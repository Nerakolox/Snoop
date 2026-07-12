/**
 * 时间线 —— 横向泳道图（甘特图）
 * 纵轴：每个 App 一条泳道，横轴：时间轴，色块表示使用时段。
 * 支持日期切换查看历史任意一天。
 */

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Calendar, Maximize2 } from "lucide-react";
import { fetchBucketsInRange, type RawBucket } from "../data";
import { computeBucketIntensity } from "../analytics";
import AppIcon from "../components/AppIcon";

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
  "#4A90E2", // 蓝
  "#7B68EE", // 紫
  "#50C878", // 绿
  "#FF6B6B", // 红
  "#FFA500", // 橙
  "#20B2AA", // 青绿
  "#DA70D6", // 兰花紫
  "#FFD700", // 金
  "#FF69B4", // 粉
  "#40E0D0", // 绿松石
  "#9370DB", // 中紫
  "#3CB371", // 海绿
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

  // 按时间排序
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

    // 检查是否可以与上一个块合并（连续同 App）
    const lastBlock = lane.blocks[lane.blocks.length - 1];
    const gap = lastBlock ? b.bucket_start - lastBlock.end_ms : Infinity;

    if (lastBlock && gap <= 1000) {
      // 连续（间隔 ≤1s），合并
      lastBlock.end_ms = b.bucket_start + b.duration_ms;
      lastBlock.duration_ms = lastBlock.end_ms - lastBlock.start_ms;
      lastBlock.key_total += b.key_total;
      lastBlock.mouse_total += mouse_total;
      // 重新计算强度（合并后需要重算，这里简化为取较大值）
      lastBlock.intensity = Math.max(lastBlock.intensity, intensity) as 0 | 1 | 2 | 3 | 4;
    } else {
      // 新块
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

  // 转数组，按总时长倒序（用得多的在上）
  const lanes = Array.from(laneMap.values());
  lanes.sort((a, b) => b.total_duration_ms - a.total_duration_ms);

  return lanes;
}

// ---- 时间轴刻度 -------------------------------------------------------------

/** 根据可见时间跨度动态生成刻度 */
function buildTimeScale(viewStart: number, viewEnd: number): number[] {
  const span = viewEnd - viewStart;
  const hourMs = 60 * 60 * 1000;
  const minMs = 60 * 1000;

  const scale: number[] = [];

  // 根据可见跨度决定刻度间隔
  if (span <= 2 * hourMs) {
    // 缩放到 2 小时以内 → 每 10 分钟一个刻度
    const interval = 10 * minMs;
    let t = Math.floor(viewStart / interval) * interval;
    while (t <= viewEnd) {
      if (t >= viewStart) scale.push(t);
      t += interval;
    }
  } else if (span <= 6 * hourMs) {
    // 2-6 小时 → 每 30 分钟
    const interval = 30 * minMs;
    let t = Math.floor(viewStart / interval) * interval;
    while (t <= viewEnd) {
      if (t >= viewStart) scale.push(t);
      t += interval;
    }
  } else if (span <= 12 * hourMs) {
    // 6-12 小时 → 每小时
    const interval = hourMs;
    let t = Math.floor(viewStart / interval) * interval;
    while (t <= viewEnd) {
      if (t >= viewStart) scale.push(t);
      t += interval;
    }
  } else {
    // 12 小时以上 → 每 3 小时
    const interval = 3 * hourMs;
    let t = Math.floor(viewStart / interval) * interval;
    while (t <= viewEnd) {
      if (t >= viewStart) scale.push(t);
      t += interval;
    }
  }

  return scale;
}

function formatTimeLabel(ms: number, span: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();

  // 可见跨度小于 6 小时时显示分钟
  if (span <= 6 * 60 * 60 * 1000) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return `${String(h).padStart(2, "0")}:00`;
}

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

// ---- 渲染 -------------------------------------------------------------------

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

/** 数据查询范围：今天到当前时刻，历史到 24 小时 */
function dataRange(d: Date, isToday: boolean): { start_ms: number; end_ms: number } {
  const start = startOfDay(d);
  let end: Date;
  if (isToday) {
    end = new Date(); // 今天：到当前时刻
  } else {
    end = new Date(start);
    end.setDate(end.getDate() + 1); // 历史：完整 24 小时
  }
  return {
    start_ms: start.getTime(),
    end_ms: end.getTime(),
  };
}

/** 显示范围：始终完整 24 小时（用于横轴和色块位置计算） */
function displayRange(d: Date): { start_ms: number; end_ms: number } {
  const start = startOfDay(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start_ms: start.getTime(),
    end_ms: end.getTime(),
  };
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

  // 视口状态：当前可见的时间窗口
  const [viewport, setViewport] = useState<{ start: number; end: number } | null>(null);

  // 拖拽状态
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    viewStart: number;
    viewEnd: number;
    scrollTop: number;
  } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 渐隐遮罩状态：追踪是否还有内容在可视区域外
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

  const fetchRange = useMemo(() => dataRange(selectedDate, isToday), [selectedDate, isToday]);
  const fullDayRange = useMemo(() => displayRange(selectedDate), [selectedDate]);

  // 当前视口（缩放/平移后的可见范围），默认全天
  const viewRange = useMemo(() => {
    if (!viewport) return fullDayRange;
    return { start_ms: viewport.start, end_ms: viewport.end };
  }, [viewport, fullDayRange]);

  const timeScale = useMemo(() => {
    return buildTimeScale(viewRange.start_ms, viewRange.end_ms);
  }, [viewRange]);

  // 重置视图到全天
  const resetView = useCallback(() => {
    setViewport(null);
  }, []);

  // 切换日期时重置视图
  useEffect(() => {
    resetView();
  }, [selectedDate, resetView]);

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

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        console.log("Fetching buckets for range:", fetchRange);
        const buckets = await fetchBucketsInRange(fetchRange);
        console.log("Fetched buckets:", buckets.length);
        const appLanes = buildAppLanes(buckets);
        console.log("Built lanes:", appLanes.length);
        setLanes(appLanes);
      } catch (e) {
        console.error("Timeline refresh failed:", e);
      } finally {
        setLoading(false);
      }
    }

    fetchData();

    // 查看今天时每 60 秒自动刷新，查看历史时不刷新
    if (isToday) {
      const timer = setInterval(fetchData, 60_000);
      return () => clearInterval(timer);
    }
  }, [fetchRange.start_ms, fetchRange.end_ms, isToday]);

  const daySpan = viewRange.end_ms - viewRange.start_ms;

  // 滚轮缩放（使用 useEffect + addEventListener 确保 preventDefault 生效）
  useEffect(() => {
    const chartEl = chartRef.current;
    if (!chartEl) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;

      // 鼠标在轨道内的相对位置（0-1）
      const relX = (e.clientX - rect.left) / rect.width;

      // 当前视口
      const curStart = viewport?.start ?? fullDayRange.start_ms;
      const curEnd = viewport?.end ?? fullDayRange.end_ms;
      const curSpan = curEnd - curStart;

      // 鼠标指向的时间点
      const mouseTime = curStart + curSpan * relX;

      // 缩放因子
      const zoomDelta = e.deltaY > 0 ? 1.2 : 0.8;
      let newSpan = curSpan * zoomDelta;

      // 限制缩放范围：最小 30 分钟，最大全天
      const minSpan = 30 * 60 * 1000;
      const maxSpan = fullDayRange.end_ms - fullDayRange.start_ms;
      newSpan = Math.max(minSpan, Math.min(maxSpan, newSpan));

      // 以鼠标位置为锚点计算新视口
      let newStart = mouseTime - newSpan * relX;
      let newEnd = newStart + newSpan;

      // 限制在当天范围内
      if (newStart < fullDayRange.start_ms) {
        newStart = fullDayRange.start_ms;
        newEnd = newStart + newSpan;
      }
      if (newEnd > fullDayRange.end_ms) {
        newEnd = fullDayRange.end_ms;
        newStart = newEnd - newSpan;
      }

      setViewport({ start: newStart, end: newEnd });
    };

    // passive: false 确保 preventDefault 生效
    chartEl.addEventListener("wheel", handleWheel, { passive: false });
    return () => chartEl.removeEventListener("wheel", handleWheel);
  }, [viewport, fullDayRange]);

  // 拖拽开始
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // 只响应左键
      const curStart = viewport?.start ?? fullDayRange.start_ms;
      const curEnd = viewport?.end ?? fullDayRange.end_ms;
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
    [viewport, fullDayRange]
  );

  // 拖拽中
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !dragStartRef.current || !trackRef.current || !bodyRef.current) return;

      const rect = trackRef.current.getBoundingClientRect();

      // 横向：平移时间视窗
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaTime = -(deltaX / rect.width) * (dragStartRef.current.viewEnd - dragStartRef.current.viewStart);

      let newStart = dragStartRef.current.viewStart + deltaTime;
      let newEnd = dragStartRef.current.viewEnd + deltaTime;
      const span = newEnd - newStart;

      // 限制在当天范围内
      if (newStart < fullDayRange.start_ms) {
        newStart = fullDayRange.start_ms;
        newEnd = newStart + span;
      }
      if (newEnd > fullDayRange.end_ms) {
        newEnd = fullDayRange.end_ms;
        newStart = newEnd - span;
      }

      setViewport({ start: newStart, end: newEnd });

      // 纵向：滚动泳道列表
      const deltaY = e.clientY - dragStartRef.current.y;
      const newScrollTop = dragStartRef.current.scrollTop - deltaY;
      bodyRef.current.scrollTop = Math.max(
        0,
        Math.min(newScrollTop, bodyRef.current.scrollHeight - bodyRef.current.clientHeight)
      );
    },
    [isDragging, fullDayRange]
  );

  // 拖拽结束
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  // 全局监听鼠标释放
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => setIsDragging(false);
      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
    }
  }, [isDragging]);

  // 更新渐隐遮罩状态
  const updateFadeMasks = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;

    const scrollTop = body.scrollTop;
    const scrollHeight = body.scrollHeight;
    const clientHeight = body.clientHeight;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;

    // 纵向：上下是否还有内容
    const hasTop = scrollTop > 10; // 超过 10px 显示顶部遮罩
    const hasBottom = scrollBottom > 10;

    // 横向：左右是否缩放到看不全当天
    const curStart = viewport?.start ?? fullDayRange.start_ms;
    const curEnd = viewport?.end ?? fullDayRange.end_ms;
    const hasLeft = curStart > fullDayRange.start_ms;
    const hasRight = curEnd < fullDayRange.end_ms;

    setFadeMasks({
      top: hasTop,
      bottom: hasBottom,
      left: hasLeft,
      right: hasRight,
    });
  }, [viewport, fullDayRange]);

  // 监听滚动变化
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    updateFadeMasks();

    const handleScroll = () => updateFadeMasks();
    body.addEventListener("scroll", handleScroll, { passive: true });
    return () => body.removeEventListener("scroll", handleScroll);
  }, [updateFadeMasks]);

  // 监听视口变化
  useEffect(() => {
    updateFadeMasks();
  }, [viewport, lanes, updateFadeMasks]);

  // 计算色块位置与宽度百分比（基于当前视口）
  function blockStyle(block: TimeBlock): CSSProperties {
    const left = ((block.start_ms - viewRange.start_ms) / daySpan) * 100;
    const width = (block.duration_ms / daySpan) * 100;
    // 最小可见宽度 0.3%
    const finalWidth = Math.max(width, 0.3);
    return {
      left: `${left}%`,
      width: `${finalWidth}%`,
    };
  }

  // 过滤可见色块（性能优化）
  function isBlockVisible(block: TimeBlock): boolean {
    return block.end_ms >= viewRange.start_ms && block.start_ms <= viewRange.end_ms;
  }

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
        >
          {/* 时间轴刻度 */}
          <div className="swimlane-header">
            <div className="swimlane-axis-label">App</div>
            <div className="swimlane-axis">
              {timeScale.map((ts) => {
                const pct = ((ts - viewRange.start_ms) / daySpan) * 100;
                return (
                  <div
                    key={ts}
                    className="swimlane-tick"
                    style={{ left: `${pct}%` }}
                  >
                    {formatTimeLabel(ts, daySpan)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 泳道列表容器（带渐隐遮罩） */}
          <div className="swimlane-body-wrap">
            {/* 渐隐遮罩 */}
            {fadeMasks.top && <div className="swimlane-fade-mask swimlane-fade-top" />}
            {fadeMasks.bottom && <div className="swimlane-fade-mask swimlane-fade-bottom" />}
            {fadeMasks.left && <div className="swimlane-fade-mask swimlane-fade-left" />}
            {fadeMasks.right && <div className="swimlane-fade-mask swimlane-fade-right" />}

            {/* 泳道列表 */}
            <div
              ref={bodyRef}
              className="swimlane-body"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
            >
            {lanes.map((lane) => (
              <div key={lane.app_bundle_id} className="swimlane-row">
                <div className="swimlane-label">
                  <AppIcon
                    bundleId={lane.app_bundle_id}
                    appName={lane.app_name}
                    size={16}
                  />
                  <span className="swimlane-app-name" title={lane.app_name}>{lane.app_name}</span>
                </div>
                <div ref={trackRef} className="swimlane-track">
                  {/* 背景网格线 */}
                  {timeScale.map((ts) => {
                    const pct = ((ts - viewRange.start_ms) / daySpan) * 100;
                    return (
                      <div
                        key={ts}
                        className="swimlane-grid-line"
                        style={{ left: `${pct}%` }}
                      />
                    );
                  })}
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
          style={{
            left: hoveredBlock.x,
            top: hoveredBlock.y - 8,
          }}
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

