/**
 * 键盘 —— 外设活动画像
 * KLE 格式驱动的键盘热力图 + 鼠标热力 + Top 按键排行。
 * 切换 App 筛选/时段可查看不同使用场景的真实数据。
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Calendar, RefreshCw } from "lucide-react";
import {
  fetchBucketsInRange,
  fetchKeyDetailsInRange,
  dayRangeOf,
  DAY_MS,
  type RawBucket,
  type RawKeyDetail,
} from "../data";
import { aggregateByApp } from "../analytics";
import { parseKLE, getLabelRdevCode, type ParsedLayout } from "../kleParser";
import { startOfDay, startOfWeek, isSameDay, isSameWeek, formatPeriodLabel } from "../utils/date";
import KLELayoutPicker, {
  getSavedLayout,
  saveLayout,
  loadLayoutJSON,
} from "../components/KLELayoutPicker";
import AppIcon from "../components/AppIcon";
import TopKeysPanel from "../components/keyboard/TopKeysPanel";
import MousePanel from "../components/keyboard/MousePanel";
import KeyboardPanel from "../components/keyboard/KeyboardPanel";
import PageShell from "../components/PageShell";

type AppFilter = "all" | string;
type TimeFilter = "day" | "week";

// ---- 展示常量 ---------------------------------------------------------------

const TIME_LABELS: { id: TimeFilter; label: string }[] = [
  { id: "day", label: "日" },
  { id: "week", label: "周" },
];

// ---- 日期工具函数 -----------------------------------------------------------




function getTimeRange(d: Date, mode: TimeFilter): { start_ms: number; end_ms: number } {
  if (mode === "day") {
    return dayRangeOf(d);
  } else {
    // 周模式：从选定日期所在周的周一到周日
    const weekStart = startOfWeek(d);
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    return { start_ms: weekStart.getTime(), end_ms: weekEnd.getTime() };
  }
}

// ---- 渲染 -------------------------------------------------------------------

export default function Keyboard() {
  const [appFilter, setAppFilter] = useState<AppFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("day");
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  // KLE 配列状态（从 localStorage 读取，默认 104 全尺寸）
  const [layoutId, setLayoutId] = useState<string>(() => getSavedLayout());
  const [layout, setLayout] = useState<ParsedLayout>({
    keys: [],
    maxX: 0,
    maxY: 0,
    unsupportedFeatures: [],
  });
  const kleKeys = layout.keys;
  const [kleLoading, setKleLoading] = useState(false);

  // 当前日期/周标签
  const today = useMemo(() => startOfDay(new Date()), []);
  const isCurrentPeriod = useMemo(() => {
    if (timeFilter === "day") {
      return isSameDay(selectedDate, today);
    } else {
      return isSameWeek(selectedDate, today);
    }
  }, [selectedDate, today, timeFilter]);
  const dateLabel = useMemo(
    () => formatPeriodLabel(selectedDate, timeFilter, isCurrentPeriod),
    [selectedDate, timeFilter, isCurrentPeriod]
  );

  // 保存配列选择并加载新配列
  const handleLayoutChange = async (id: string) => {
    setLayoutId(id);
    saveLayout(id);
    await loadKLELayout(id);
  };

  // 加载 KLE 配列 JSON 并解析
  const loadKLELayout = async (id: string) => {
    setKleLoading(true);
    try {
      const kleJson = await loadLayoutJSON(id);
      const parsed = parseKLE(kleJson);
      setLayout(parsed);
    } catch (e) {
      console.error("Failed to load KLE layout:", e);
    } finally {
      setKleLoading(false);
    }
  };

  // 初始加载配列
  useEffect(() => {
    loadKLELayout(layoutId);
  }, []);

  // 原始数据（全量，按时间段拉取）
  const [allBuckets, setAllBuckets] = useState<RawBucket[]>([]);
  const [appList, setAppList] = useState<string[]>([]);

  // 统一筛选后的数据集（三个区块的唯一数据源）
  const [filteredData, setFilteredData] = useState<{
    buckets: RawBucket[];
    keyDetails: RawKeyDetail[];
  }>({ buckets: [], keyDetails: [] });

  async function refresh() {
    setLoading(true);
    try {
      const range = getTimeRange(selectedDate, timeFilter);
      const fetchedBuckets = await fetchBucketsInRange(range);
      setAllBuckets(fetchedBuckets);

      // 构建 App 列表（按时长排序，取前几个）
      const appStats = aggregateByApp(fetchedBuckets);
      const topApps = appStats
        .slice(0, 8)
        .map((a) => a.app_bundle_id)
        .filter((id) => id && id !== "unknown");
      setAppList(topApps);

      // 时间段切换时，重置 App 筛选为"全部"并加载全部数据
      setAppFilter("all");
      await loadFilteredData("all", fetchedBuckets);
    } catch (e) {
      console.error("Keyboard refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }

  // 日期导航
  function goPrevPeriod() {
    setSelectedDate((d) => {
      const prev = new Date(d);
      if (timeFilter === "day") {
        prev.setDate(prev.getDate() - 1);
      } else {
        prev.setDate(prev.getDate() - 7);
      }
      return prev;
    });
  }

  function goNextPeriod() {
    if (!isCurrentPeriod) {
      setSelectedDate((d) => {
        const next = new Date(d);
        if (timeFilter === "day") {
          next.setDate(next.getDate() + 1);
        } else {
          next.setDate(next.getDate() + 7);
        }
        return next;
      });
    }
  }

  function goToToday() {
    setSelectedDate(new Date());
  }

  // 加载筛选后的数据（基于 App 筛选）
  async function loadFilteredData(targetApp: AppFilter, buckets: RawBucket[]) {
    try {
      const range = getTimeRange(selectedDate, timeFilter);
      const appBundleId = targetApp === "all" ? undefined : targetApp;
      const keyDetails = await fetchKeyDetailsInRange(range, appBundleId);
      const appBuckets =
        targetApp === "all" ? buckets : buckets.filter((b) => b.app_bundle_id === targetApp);
      setFilteredData({ buckets: appBuckets, keyDetails });
    } catch (e) {
      console.error("loadFilteredData failed:", e);
    }
  }

  useEffect(() => {
    refresh();
  }, [timeFilter, selectedDate]);

  // App 筛选变化时，重新加载数据
  useEffect(() => {
    if (allBuckets.length > 0) {
      setLoading(true);
      loadFilteredData(appFilter, allBuckets).finally(() => setLoading(false));
    }
  }, [appFilter]);

  // 延迟显示 loading 状态，避免快速切换时闪烁
  useEffect(() => {
    let timer: number | undefined;
    if (loading) {
      timer = window.setTimeout(() => setShowLoading(true), 200);
    } else {
      setShowLoading(false);
      if (timer) window.clearTimeout(timer);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [loading]);

  // ========== 从统一数据集派生三个区块的渲染数据 ==========

  // 构建 rdevCode → count 的映射（键盘热力）
  const keyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const kd of filteredData.keyDetails) {
      map[kd.key_code] = (map[kd.key_code] ?? 0) + kd.count;
    }
    return map;
  }, [filteredData.keyDetails]);

  // 构建 KLE 键标签 → count 的映射（通过 rdevCode 匹配）
  const kleKeyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const key of kleKeys) {
      const rdevCode = getLabelRdevCode(key.label);
      if (rdevCode) {
        map[key.label] = keyCounts[rdevCode] ?? 0;
      }
    }
    return map;
  }, [kleKeys, keyCounts]);

  // 提取所有键的按压次数数组，用于分位数分档
  const allKeyCounts = useMemo(() => {
    return Object.values(kleKeyCounts);
  }, [kleKeyCounts]);

  const topPanelTitle = timeFilter === "week" ? "本周按得最多" : "今天按得最多";

  // App 筛选按钮列表
  const appFilterButtons = useMemo(() => {
    const buttons: { id: AppFilter; label: string; bundleId: string }[] = [
      { id: "all", label: "全部", bundleId: "" },
    ];
    for (const bundleId of appList) {
      const appStat = aggregateByApp(allBuckets).find((a) => a.app_bundle_id === bundleId);
      const label = appStat?.app_name || bundleId;
      buttons.push({ id: bundleId, label, bundleId });
    }
    return buttons;
  }, [appList, allBuckets]);

  return (
    <PageShell
      className="kb-page"
      stickyHeader
      header={
        /* 顶部筛选栏（吸顶，三行：App / 日期 / 配列） */
        <div className="kb-filters">
          {/* 第 1 行：App 筛选 */}
          <div className="kb-filter-row kb-filter-row--apps">
          <div className="kb-filter-group">
            {appFilterButtons.map((a) => (
              <button
                key={a.id}
                className={`kb-filter-btn${appFilter === a.id ? " is-active" : ""}`}
                onClick={() => setAppFilter(a.id)}
                type="button"
                disabled={loading}
                title={a.label}
              >
                {a.id !== "all" && (
                  <AppIcon bundleId={a.bundleId} appName={a.label} size={16} />
                )}
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 第 2 行：日/周切换融入日期导航（同一胶囊） */}
        <div className="kb-filter-row kb-filter-row--date">
          <div className="kb-date-picker">
            <div className="kb-segmented" role="tablist" aria-label="时间范围">
              {TIME_LABELS.map((t) => (
                <button
                  key={t.id}
                  className={`kb-segmented-btn${timeFilter === t.id ? " is-active" : ""}`}
                  onClick={() => setTimeFilter(t.id)}
                  type="button"
                  role="tab"
                  aria-selected={timeFilter === t.id}
                  disabled={loading}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <span className="kb-picker-divider" aria-hidden="true" />
            <button
              className="kb-nav-btn"
              onClick={goPrevPeriod}
              title={timeFilter === "day" ? "前一天" : "前一周"}
              disabled={loading}
            >
              <ChevronLeft size={16} />
            </button>
            <div className="kb-date-label">
              <Calendar size={14} />
              <span>{dateLabel}</span>
            </div>
            <button
              className="kb-nav-btn"
              onClick={goNextPeriod}
              disabled={isCurrentPeriod || loading}
              title={timeFilter === "day" ? "后一天" : "后一周"}
            >
              <ChevronRight size={16} />
            </button>
            {!isCurrentPeriod && (
              <button
                className="kb-today-btn"
                onClick={goToToday}
                disabled={loading}
              >
                回到今天
              </button>
            )}
            <span className="kb-picker-divider" aria-hidden="true" />
            <button
              className="kb-nav-btn"
              onClick={refresh}
              disabled={loading}
              title="刷新"
            >
              <RefreshCw size={16} className={loading ? "kb-spin" : ""} />
            </button>
          </div>
        </div>

          {/* 第 3 行：KLE 配列选择 */}
          <div className="kb-filter-row kb-filter-row--layout">
            <KLELayoutPicker value={layoutId} onChange={handleLayoutChange} />
          </div>
        </div>
      }
    >
      {/* ② 统一活动面板：键盘热力图 + 鼠标 + Top 按键 */}
      <section className="panel kb-unified-panel" style={{ position: "relative" }}>
        {showLoading && (
          <div className="kb-loading-overlay">
            <div className="kb-loading-spinner" />
          </div>
        )}

        {kleLoading ? (
          <div style={{ padding: "var(--space-6)", textAlign: "center", color: "var(--color-text-3)" }}>
            加载配列中...
          </div>
        ) : kleKeys.length === 0 ? (
          <div style={{ padding: "var(--space-6)", textAlign: "center", color: "var(--color-text-3)" }}>
            配列加载失败
          </div>
        ) : (
          <>
            <KeyboardPanel
              kleKeys={kleKeys}
              kleKeyCounts={kleKeyCounts}
              allKeyCounts={allKeyCounts}
              maxX={layout.maxX}
              maxY={layout.maxY}
            />

            {/* 下方分栏：鼠标 + Top 按键 */}
            <div className="kb-lower-section">
              <MousePanel buckets={filteredData.buckets} />

              <TopKeysPanel
                kleKeyCounts={kleKeyCounts}
                allKeyCounts={allKeyCounts}
                title={topPanelTitle}
              />
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}
