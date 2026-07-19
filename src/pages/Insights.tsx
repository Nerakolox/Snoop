/**
 * 洞察 —— 跨天使用回顾
 * 以周为粒度：猫周报吐槽 + 本周活跃趋势柱状图 +
 * App 排行（带环比）+ 一周 x 24 小时作息热力网格。
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import DeltaBadge from "../components/DeltaBadge";
import WeekSelector from "../components/insights/WeekSelector";
import {
  fetchBucketsInRange,
  fetchHourlyActivity,
  fetchHourlyHeartbeats,
  DAY_MS,
} from "../data";
import {
  aggregateByDay,
  aggregateByApp,
  aggregateWeekHourGrid,
  bucketSimple,
  intensityVar,
  type DayStat,
  type Intensity,
} from "../analytics";
import AppIcon from "../components/AppIcon";
import { fmtHours } from "../utils/format";
import { startOfWeek, isSameWeek, formatWeekLabel } from "../utils/date";

type WeekDay = {
  short: string; // 一二三四五六日
  long: string; // 周一…周日
  hours: number; // 当天活跃小时
  isToday: boolean; // 是否是今天
  isFuture: boolean; // 是否未到
};

type WeekApp = {
  name: string;
  bundleId: string;
  hours: number;
  intensity: Intensity;
  /** 环比上周：> 0 上升，< 0 下降，null 视作持平/新 App */
  deltaPct: number | null;
};

const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

// ---- 工具 -------------------------------------------------------------------


/** 根据选中周的真实数据生成猫周报文案 */
function generateCatReport(
  weekTotalHours: number,
  topApp: { name: string; hours: number } | null,
  busiestDay: { name: string; hours: number; app: string } | null,
  weekChange: number | null,
  isCurrentWeek: boolean
): string {
  const parts: string[] = [];
  const weekPrefix = isCurrentWeek ? "这周" : "那周";

  parts.push(`${weekPrefix}你一共活跃了 ${fmtHours(weekTotalHours)} 小时`);

  if (topApp && topApp.hours > 0) {
    parts.push(`，其中 ${topApp.name} 占了 ${fmtHours(topApp.hours)} 小时`);
    if (weekChange !== null) {
      if (weekChange > 15) {
        parts.push(`——比前一周还多，我们真的需要谈谈`);
      } else if (weekChange < -15) {
        parts.push(`，比前一周少多了喵～`);
      }
    }
  }

  parts.push(`。`);

  if (busiestDay && busiestDay.hours >= 6) {
    parts.push(
      `不过${busiestDay.name}那天你在 ${busiestDay.app} 上爆肝了 ${fmtHours(busiestDay.hours)} 小时，算你厉害。`
    );
  } else if (weekTotalHours < 10) {
    parts.push(`${isCurrentWeek ? "这周" : "那周"}摸鱼有点狠喵～`);
  }

  return parts.join("");
}

/** 计算环比变化百分比 */
function calculateDelta(thisWeek: number, lastWeek: number): number | null {
  if (lastWeek === 0) return null; // 上周没用过，返回 null 表示"新"
  const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  // 变化极小（±5% 以内）视为持平
  if (Math.abs(pct) <= 5) return 0;
  return pct;
}

/** 构建周一到周日的完整 7 天数组，包含未来的空槽 */
function buildWeekDays(dayStats: DayStat[], weekStartMs: number): WeekDay[] {
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const result: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const dayMs = weekStartMs + i * DAY_MS;
    const stat = dayStats.find((d) => d.day_ms === dayMs);
    const hours = stat ? stat.active_ms / (60 * 60 * 1000) : 0;
    const isToday = dayMs === todayMs;
    const isFuture = dayMs > todayMs;

    result.push({
      short: DAY_LABELS[i],
      long: `周${DAY_LABELS[i]}`,
      hours,
      isToday,
      isFuture,
    });
  }
  return result;
}

// ---- 渲染 -------------------------------------------------------------------

export default function Insights() {
  const today = useMemo(() => new Date(), []);
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date>(() => startOfWeek(today));
  const [, setLoading] = useState(false);
  const [weekDays, setWeekDays] = useState<WeekDay[]>([]);
  const [weekApps, setWeekApps] = useState<WeekApp[]>([]);
  const [hourlyGrid, setHourlyGrid] = useState<
    Array<Array<{ intensity: Intensity; state: "active" | "idle" | "no_data" }>>
  >(
    Array.from({ length: 7 }, () =>
      Array(24).fill({ intensity: 0, state: "no_data" as const })
    )
  );
  const [catReport, setCatReport] = useState("");
  const [weekTotalHours, setWeekTotalHours] = useState(0);
  const [weekDailyAvg, setWeekDailyAvg] = useState(0);

  const isCurrentWeek = useMemo(
    () => isSameWeek(selectedWeekStart, today),
    [selectedWeekStart, today]
  );

  const weekLabel = useMemo(
    () => formatWeekLabel(selectedWeekStart, today),
    [selectedWeekStart, today]
  );

  function goPrevWeek() {
    setSelectedWeekStart((prev) => new Date(prev.getTime() - 7 * DAY_MS));
  }

  function goNextWeek() {
    if (!isCurrentWeek) {
      setSelectedWeekStart((prev) => new Date(prev.getTime() + 7 * DAY_MS));
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const weekStartMs = selectedWeekStart.getTime();
      const weekEndMs = weekStartMs + 7 * DAY_MS;
      const range = { start_ms: weekStartMs, end_ms: weekEndMs };
      const lastWeekRange = {
        start_ms: weekStartMs - 7 * DAY_MS,
        end_ms: weekStartMs,
      };

      const [thisWeekBuckets, lastWeekBuckets, thisWeekHourly] = await Promise.all([
        fetchBucketsInRange(range),
        fetchBucketsInRange(lastWeekRange),
        fetchHourlyActivity(range),
      ]);

      // 拉取心跳数据
      const heartbeatList = await fetchHourlyHeartbeats(range);
      const heartbeatMap = new Map<number, boolean>();
      for (const hb of heartbeatList) {
        heartbeatMap.set(hb.hour_start, hb.has_heartbeat);
      }

      const dayStats = aggregateByDay(thisWeekBuckets);
      const days = buildWeekDays(dayStats, weekStartMs);
      setWeekDays(days);

      const totalMs = dayStats.reduce((sum, d) => sum + d.active_ms, 0);
      const totalHours = totalMs / (60 * 60 * 1000);
      setWeekTotalHours(totalHours);

      const passedDays = days.filter((d) => !d.isFuture).length;
      const dailyAvg = passedDays > 0 ? totalHours / passedDays : 0;
      setWeekDailyAvg(dailyAvg);

      const thisWeekAppStats = aggregateByApp(thisWeekBuckets);
      const lastWeekAppStats = aggregateByApp(lastWeekBuckets);

      const apps: WeekApp[] = thisWeekAppStats.slice(0, 6).map((a) => {
        const hours = a.duration_ms / (60 * 60 * 1000);
        const lastWeekApp = lastWeekAppStats.find(
          (la) => la.app_bundle_id === a.app_bundle_id
        );
        const lastWeekHours = lastWeekApp
          ? lastWeekApp.duration_ms / (60 * 60 * 1000)
          : 0;
        const deltaPct = calculateDelta(hours, lastWeekHours);

        return {
          name: a.app_name || a.app_bundle_id,
          bundleId: a.app_bundle_id,
          hours,
          intensity: a.intensity,
          deltaPct,
        };
      });
      setWeekApps(apps);

      const grid = aggregateWeekHourGrid(thisWeekHourly, heartbeatMap, weekStartMs);
      setHourlyGrid(grid);

      const topApp = apps[0] || null;

      let busiestDay: { name: string; hours: number; app: string } | null = null;
      if (dayStats.length > 0) {
        const maxDayStat = dayStats.reduce((max, d) =>
          d.active_ms > max.active_ms ? d : max
        );

        const maxDayStart = maxDayStat.day_ms;
        const maxDayEnd = maxDayStart + DAY_MS;
        const maxDayBuckets = thisWeekBuckets.filter(
          (b) => b.bucket_start >= maxDayStart && b.bucket_start < maxDayEnd
        );
        const maxDayApps = aggregateByApp(maxDayBuckets);
        if (maxDayApps.length > 0) {
          const topAppOnDay = maxDayApps[0];
          const dayIndex = maxDayStat.day_of_week;
          busiestDay = {
            name: `周${DAY_LABELS[dayIndex]}`,
            hours: topAppOnDay.duration_ms / (60 * 60 * 1000),
            app: topAppOnDay.app_name || topAppOnDay.app_bundle_id,
          };
        }
      }

      const weekChange = topApp && topApp.hours > 0
        ? (() => {
            const lastWeekSameApp = lastWeekAppStats.find(
              (la) => la.app_bundle_id === thisWeekAppStats[0]?.app_bundle_id
            );
            const lastWeekHours = lastWeekSameApp
              ? lastWeekSameApp.duration_ms / (60 * 60 * 1000)
              : 0;
            return calculateDelta(topApp.hours, lastWeekHours);
          })()
        : null;

      const report = generateCatReport(totalHours, topApp, busiestDay, weekChange, isCurrentWeek);
      setCatReport(report);
    } catch (e) {
      console.error("Insights refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [selectedWeekStart, isCurrentWeek]);

  const maxDay = useMemo(
    () => Math.max(...weekDays.map((d) => d.hours), 1),
    [weekDays]
  );

  return (
    <div className="ins-page">
      {/* 周选择器 */}
      <WeekSelector
        weekLabel={weekLabel}
        isCurrentWeek={isCurrentWeek}
        onPrevWeek={goPrevWeek}
        onNextWeek={goNextWeek}
      />

      {/* ① 猫的周报吐槽 —— 顶部通栏 */}
      <section className="ins-report">
        <div className="ins-report-avatar" aria-hidden>
          <Sparkles size={20} />
        </div>
        <div className="ins-report-body">
          <div className="ins-report-title">猫的周报</div>
          <p className="ins-report-text">
            {catReport || "还没有足够的数据生成周报喵～"}
          </p>
          <div className="ins-report-chips">
            <span className="ins-chip">
              <span className="ins-chip-num">{fmtHours(weekTotalHours)}</span>
              <span className="ins-chip-unit">小时 · {isCurrentWeek ? "本周" : "该周"}活跃</span>
            </span>
            <span className="ins-chip">
              <span className="ins-chip-num">{fmtHours(weekDailyAvg)}</span>
              <span className="ins-chip-unit">小时 · 日均</span>
            </span>
          </div>
        </div>
      </section>

      {/* ②③ 中间左右分栏：趋势图 · App 排行 */}
      <div className="ins-split">
        {/* ② 本周活跃趋势 */}
        <section className="panel ins-trend-panel">
          <h3 className="panel-title">{isCurrentWeek ? "本周" : "该周"}活跃趋势</h3>
          <div className="ins-trend">
            {weekDays.map((d) => {
              const pct = d.hours > 0 ? (d.hours / maxDay) * 100 : 0;
              // 柱子颜色：按天时长占本周最忙一天的比例分档（相对量，不是活跃强度本身）
              const level = bucketSimple(d.hours, maxDay);
              const barStyle: CSSProperties = {
                height: d.isFuture ? "0%" : `${pct}%`,
                background: d.isToday
                  ? "var(--color-accent)"
                  : intensityVar(level),
              };
              return (
                <div key={d.short} className="ins-trend-col">
                  <div className="ins-trend-bar-wrap">
                    {!d.isFuture && d.hours > 0 && (
                      <div className="ins-trend-bar" style={barStyle} />
                    )}
                  </div>
                  {d.hours > 0 && !d.isFuture && (
                    <div className="ins-trend-value">
                      {fmtHours(d.hours)}h
                    </div>
                  )}
                  <div className="ins-trend-label">{d.short}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ③ 本周 App 排行 + 环比 */}
        <section className="panel ins-apps-panel">
          <h3 className="panel-title">{isCurrentWeek ? "本周" : "该周"} App 排行</h3>
          <div className="ins-apps">
            {weekApps.length === 0 && (
              <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>
                {isCurrentWeek ? "本周" : "这一周"}还没有足够的数据
              </div>
            )}
            {weekApps.map((a) => {
              const pct = weekApps[0] ? (a.hours / weekApps[0].hours) * 100 : 0;
              return (
                <div key={a.bundleId} className="ins-app-row">
                  <div className="ins-app-name" title={a.name}>
                    <AppIcon bundleId={a.bundleId} appName={a.name} size={18} />
                    <span>{a.name}</span>
                  </div>
                  <div className="app-row-track">
                    <div
                      className="app-row-fill"
                      style={{
                        width: `${pct}%`,
                        background: intensityVar(a.intensity),
                      }}
                    />
                  </div>
                  <div className="ins-app-time">{fmtHours(a.hours)}h</div>
                  <DeltaBadge delta={a.deltaPct} />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* ④ 作息画像 —— 一周 × 24 小时 */}
      <section className="panel ins-rhythm-panel">
        <h3 className="panel-title">作息画像</h3>
        <div className="ins-rhythm">
          <div className="ins-rhythm-days" aria-hidden>
            {DAY_LABELS.map((d) => (
              <span key={d} className="ins-rhythm-day">
                {d}
              </span>
            ))}
          </div>
          <div className="ins-rhythm-body">
            <div className="ins-rhythm-grid">
              {hourlyGrid.map((row, ri) =>
                row.map((cell, ci) => {
                  let bg: string;
                  let tooltipText: string;
                  const dayLabel = `周${DAY_LABELS[ri]}`;
                  const hourLabel = `${ci}:00`;

                  if (cell.state === "active") {
                    bg = intensityVar(cell.intensity);
                    tooltipText = `${dayLabel} ${hourLabel} · 活跃强度 ${cell.intensity}`;
                  } else if (cell.state === "idle") {
                    bg = "#D1D5DB"; // 中性灰实心
                    tooltipText = `${dayLabel} ${hourLabel} · 挂机（无输入）`;
                  } else {
                    bg = "#F3F4F6"; // 极浅底色
                    tooltipText = `${dayLabel} ${hourLabel} · 未采集`;
                  }

                  return (
                    <div
                      key={`${ri}-${ci}`}
                      className={`ins-rhythm-cell ${cell.state === "no_data" ? "ins-rhythm-cell--no-data" : ""}`}
                      style={{ background: bg }}
                      title={tooltipText}
                    />
                  );
                })
              )}
            </div>
            <div className="ins-rhythm-scale">
              <span
                className="ins-rhythm-tick ins-rhythm-tick--edge-start"
                style={{ gridColumn: 1 }}
              >
                0
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 7 }}>
                6
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 13 }}>
                12
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 19 }}>
                18
              </span>
              <span
                className="ins-rhythm-tick ins-rhythm-tick--edge-end"
                style={{ gridColumn: 24 }}
              >
                24
              </span>
            </div>
          </div>
        </div>

        {/* 图例 */}
        <div className="ins-rhythm-legend">
          <div className="ins-legend-item">
            <div className="ins-legend-gradient">
              <span style={{ background: intensityVar(1) }}></span>
              <span style={{ background: intensityVar(2) }}></span>
              <span style={{ background: intensityVar(3) }}></span>
              <span style={{ background: intensityVar(4) }}></span>
            </div>
            <span className="ins-legend-label">活跃</span>
          </div>
          <div className="ins-legend-item">
            <span className="ins-legend-sample" style={{ background: "#D1D5DB" }}></span>
            <span className="ins-legend-label">挂机</span>
          </div>
          <div className="ins-legend-item">
            <span className="ins-legend-sample ins-legend-sample--no-data" style={{ background: "#F3F4F6", border: "1px solid #E5E7EB" }}></span>
            <span className="ins-legend-label">未采集</span>
          </div>
        </div>
      </section>
    </div>
  );
}

