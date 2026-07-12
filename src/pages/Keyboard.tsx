/**
 * 键盘 —— 外设活动画像
 * KLE 格式驱动的键盘热力图 + 鼠标热力 + Top 按键排行。
 * 切换 App 筛选/时段可查看不同使用场景的真实数据。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Calendar, RefreshCw } from "lucide-react";
import {
  fetchBucketsInRange,
  fetchKeyDetailsInRange,
  fetchKeyDetailsOfBucket,
  todayRange,
  thisWeekRange,
  dayRangeOf,
  DAY_MS,
  type RawBucket,
  type RawKeyDetail,
} from "../data";
import { aggregateByApp, MOUSE_PIXELS_PER_METER } from "../analytics";
import { parseKLE, getLabelRdevCode, getDisplayLabel, type KLEKey } from "../kleParser";
import KLEKeyboard from "../components/KLEKeyboard";
import KLELayoutPicker, {
  getSavedLayout,
  saveLayout,
  loadLayoutJSON,
} from "../components/KLELayoutPicker";
import AppIcon from "../components/AppIcon";

type Intensity = 0 | 1 | 2 | 3 | 4;

type AppFilter = "all" | string;
type TimeFilter = "day" | "week";

// ---- 强度分档：分位数分档，避免极值压垮 ---------------------------------------
// 按相对排名而非绝对比例分档，让常用键之间有明显层次差异

function bucketByPercentile(n: number, allCounts: number[]): Intensity {
  if (n <= 0) return 0;
  // 只对有按压的键（>0）计算分位数
  const nonZero = allCounts.filter((c) => c > 0);
  if (nonZero.length === 0) return 0;

  // 排序
  const sorted = [...nonZero].sort((a, b) => a - b);

  // 计算分位数阈值（20/40/60/80 百分位）
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  const p40 = sorted[Math.floor(sorted.length * 0.4)];
  const p60 = sorted[Math.floor(sorted.length * 0.6)];
  const p80 = sorted[Math.floor(sorted.length * 0.8)];

  // 按分位数分档：反映相对排名而非绝对值
  if (n >= p80) return 4; // Top 20%
  if (n >= p60) return 3; // 60-80%
  if (n >= p40) return 2; // 40-60%
  if (n >= p20) return 1; // 20-40%
  return 1; // Bottom 20% 但有按压，用浅色
}

// 鼠标和 Top 按键用简单的相对归一化（它们场景不同，不需要分位数）
function bucketSimple(n: number, max: number): Intensity {
  if (n <= 0) return 0;
  const pct = n / (max || 1);
  if (pct >= 0.7) return 4;
  if (pct >= 0.5) return 3;
  if (pct >= 0.3) return 2;
  return 1;
}

function intensityVar(level: Intensity) {
  return `var(--intensity-${level})`;
}

// ---- 展示常量 ---------------------------------------------------------------

const TIME_LABELS: { id: TimeFilter; label: string }[] = [
  { id: "day", label: "日" },
  { id: "week", label: "周" },
];

// ---- 日期工具函数 -----------------------------------------------------------

function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfWeek(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  const dow = result.getDay();
  const offsetToMonday = dow === 0 ? 6 : dow - 1;
  result.setDate(result.getDate() - offsetToMonday);
  return result;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameWeek(a: Date, b: Date): boolean {
  const weekA = startOfWeek(a);
  const weekB = startOfWeek(b);
  return isSameDay(weekA, weekB);
}

function formatDateLabel(d: Date, mode: TimeFilter, isCurrentPeriod: boolean): string {
  if (isCurrentPeriod) {
    return mode === "day" ? "今天" : "本周";
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");

  if (mode === "day") {
    const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const dow = days[d.getDay()];
    return `${year}-${month}-${date} ${dow}`;
  } else {
    // 周模式：显示周一和周日
    const weekStart = startOfWeek(d);
    const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
    const endMonth = String(weekEnd.getMonth() + 1).padStart(2, "0");
    const endDate = String(weekEnd.getDate()).padStart(2, "0");
    return `${month}-${date} ~ ${endMonth}-${endDate}`;
  }
}

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
  const [kleKeys, setKleKeys] = useState<KLEKey[]>([]);
  const [kleLoading, setKleLoading] = useState(false);

  const kbContainerRef = useRef<HTMLDivElement>(null);
  const [unitSize, setUnitSize] = useState(48);

  useEffect(() => {
    const el = kbContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (kleKeys.length === 0) return;
      const maxX = Math.max(...kleKeys.map((k) => k.x + k.w));
      const gap = 6;
      const computed = Math.floor(w / maxX);
      setUnitSize(Math.min(Math.max(computed, 28), 56));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [kleKeys]);

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
    () => formatDateLabel(selectedDate, timeFilter, isCurrentPeriod),
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
      const parsedKeys = parseKLE(kleJson);
      setKleKeys(parsedKeys);
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
      if (targetApp === "all") {
        // 全部 App：用汇总 API
        const range = getTimeRange(selectedDate, timeFilter);
        const allKeys = await fetchKeyDetailsInRange(range);
        setFilteredData({ buckets, keyDetails: allKeys });
      } else {
        // 特定 App：筛选该 App 的桶，并逐桶查询 key_details 聚合
        const appBuckets = buckets.filter((b) => b.app_bundle_id === targetApp);

        // 逐桶查询并聚合 key_details
        const keyMap = new Map<string, number>();
        for (const bucket of appBuckets) {
          if (!(bucket as any).id) continue; // 跳过没有 id 的桶
          try {
            const details = await fetchKeyDetailsOfBucket((bucket as any).id);
            for (const d of details) {
              keyMap.set(d.key_code, (keyMap.get(d.key_code) ?? 0) + d.count);
            }
          } catch (e) {
            console.warn(`Failed to fetch key details for bucket ${(bucket as any).id}:`, e);
          }
        }

        const aggregatedKeys: RawKeyDetail[] = [...keyMap.entries()].map(([key_code, count]) => ({
          key_code,
          count,
        }));

        setFilteredData({ buckets: appBuckets, keyDetails: aggregatedKeys });
      }
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

  // 鼠标数据（从 filteredData.buckets 聚合）
  const mouseData = useMemo(() => {
    let left = 0;
    let right = 0;
    let middle = 0;
    let back = 0;
    let forward = 0;
    let moveDist = 0;
    let scrollDist = 0;
    for (const b of filteredData.buckets) {
      left += b.mouse_left || 0;
      right += b.mouse_right || 0;
      middle += b.mouse_middle || 0;
      back += b.mouse_back || 0;
      forward += b.mouse_forward || 0;
      moveDist += b.mouse_move_dist || 0;
      scrollDist += b.scroll_dist || 0;
    }
    const meters = moveDist / MOUSE_PIXELS_PER_METER;
    const travelKm =
      meters >= 1000 ? Number((meters / 1000).toFixed(1)) : Number((meters / 1000).toFixed(2));
    return {
      left,
      right,
      middle,
      back,
      forward,
      wheel: middle + Math.round(scrollDist / 100),
      travelKm,
    };
  }, [filteredData.buckets]);

  const maxMouse = Math.max(mouseData.left, mouseData.right, mouseData.wheel, mouseData.back, mouseData.forward, 1);

  // Top 按键排行（从 kleKeyCounts 派生）
  const topKeys = useMemo(() => {
    return Object.entries(kleKeyCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, n]) => ({ label, n }));
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
    <div className="kb-page">
      {/* ① 顶部筛选栏（吸顶） */}
      <div className="kb-filters kb-filters--sticky">
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
        <div className="kb-filter-right">
          <KLELayoutPicker value={layoutId} onChange={handleLayoutChange} />

          {/* 日/周切换 */}
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

          {/* 日期选择 */}
          <div className="kb-date-picker">
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
      </div>

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
            {/* 键盘热力图 */}
            <div className="kb-keyboard-section" ref={kbContainerRef}>
              <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
                <KLEKeyboard
                  keys={kleKeys}
                  keyCounts={kleKeyCounts}
                  allCounts={allKeyCounts}
                  unitSize={unitSize}
                />
              </div>
            </div>

            {/* 下方分栏：鼠标 + Top 按键 */}
            <div className="kb-lower-section">
              {/* 鼠标热力 */}
              <div className="kb-subsection">
                <h3 className="kb-subsection-title">鼠标</h3>
                <div className="mouse-card">
                  <div className="mouse-shape" aria-hidden>
                    <div
                      className="mouse-btn mouse-btn--left"
                      style={{
                        background: intensityVar(bucketSimple(mouseData.left, maxMouse)),
                      }}
                      title={`左键 · ${mouseData.left.toLocaleString()} 次`}
                    />
                    <div
                      className="mouse-btn mouse-btn--right"
                      style={{
                        background: intensityVar(bucketSimple(mouseData.right, maxMouse)),
                      }}
                      title={`右键 · ${mouseData.right.toLocaleString()} 次`}
                    />
                    <div
                      className="mouse-wheel"
                      style={{
                        background: intensityVar(bucketSimple(mouseData.wheel, maxMouse)),
                      }}
                      title={`滚轮 · ${mouseData.wheel.toLocaleString()}`}
                    />
                    {(mouseData.back > 0 || mouseData.forward > 0) && (
                      <>
                        <div
                          className="mouse-side mouse-side--back"
                          style={{
                            background: intensityVar(bucketSimple(mouseData.back, maxMouse)),
                          }}
                          title={`后退侧键 · ${mouseData.back.toLocaleString()} 次`}
                        />
                        <div
                          className="mouse-side mouse-side--forward"
                          style={{
                            background: intensityVar(bucketSimple(mouseData.forward, maxMouse)),
                          }}
                          title={`前进侧键 · ${mouseData.forward.toLocaleString()} 次`}
                        />
                      </>
                    )}
                  </div>
                  <dl className="mouse-stats">
                    <div className="mouse-stat">
                      <dt>左键</dt>
                      <dd>{mouseData.left.toLocaleString()}</dd>
                    </div>
                    <div className="mouse-stat">
                      <dt>右键</dt>
                      <dd>{mouseData.right.toLocaleString()}</dd>
                    </div>
                    <div className="mouse-stat">
                      <dt>滚轮</dt>
                      <dd>{mouseData.wheel.toLocaleString()}</dd>
                    </div>
                    {(mouseData.back > 0 || mouseData.forward > 0) && (
                      <>
                        <div className="mouse-stat">
                          <dt>侧键</dt>
                          <dd>{(mouseData.back + mouseData.forward).toLocaleString()}</dd>
                        </div>
                      </>
                    )}
                    <div className="mouse-stat">
                      <dt>移动</dt>
                      <dd>
                        {mouseData.travelKm}
                        <span className="mouse-stat-unit">公里</span>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              {/* Top 按键排行 */}
              <div className="kb-subsection">
                <h3 className="kb-subsection-title">{topPanelTitle}</h3>
                <div className="topkey-list">
                  {topKeys.length === 0 && (
                    <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>还没有数据</div>
                  )}
                  {topKeys.map((k) => {
                    const pct = topKeys[0] ? (k.n / topKeys[0].n) * 100 : 0;
                    const level = bucketByPercentile(k.n, allKeyCounts);
                    const displayLabel = getDisplayLabel(k.label);
                    return (
                      <div key={k.label} className="topkey-row">
                        <div className="topkey-name">{displayLabel}</div>
                        <div className="topkey-track">
                          <div
                            className="topkey-fill"
                            style={{ width: `${pct}%`, background: intensityVar(level) }}
                          />
                        </div>
                        <div className="topkey-count">{k.n.toLocaleString()}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
