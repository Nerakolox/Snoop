/**
 * 规律 —— 跨天使用回顾（原「洞察」）
 * 以周/月为粒度：猫周报吐槽 + 活跃趋势柱状图 +
 * App 排行（带环比）+ 星期 x 24 小时作息热力网格。
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import DeltaBadge from "../components/DeltaBadge";
import {
  fetchHourlyActivity,
  fetchHourlyHeartbeats,
  DAY_MS,
} from "../data";
import {
  aggregateByDay,
  aggregateByApp,
  aggregateWeekHourGrid,
  bucketSimple,
  daysWithDataOf,
  intensityVar,
  type DayStat,
  type Intensity,
} from "../analytics";
import AppIcon from "../components/AppIcon";
import PageShell from "../components/PageShell";
import ContextChips from "../components/shared/ContextChips";
import { formatAnchor, toMs } from "../data/ranges";
import { useRangeData } from "../data/useRangeData";
import {
  adaptKind,
  normalizeAnchor,
  shiftAnchor,
  useContextState,
  type RangeKind,
} from "../store/context";
import { anchorLabel, fmtHours } from "../utils/format";

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
  /** 当期/基期用量，单位分钟，供 DeltaBadge 自行判断环比 */
  currentMin: number;
  previousMin: number;
};

const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

// ---- 工具 -------------------------------------------------------------------

/** 根据选中范围的真实数据生成猫报告文案 */
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

// ---- 页头 -------------------------------------------------------------------

function PatternsHeader({
  kind,
  anchor,
  note,
  daysWithData,
  appId,
  appName,
}: {
  kind: RangeKind;
  anchor: string;
  note: string | null;
  daysWithData: number;
  appId: string | null;
  appName?: string;
}) {
  const now = useMemo(() => new Date(), []);
  return (
    <div className="ins-header">
      <div className="ins-header-titlerow">
        <h1 className="ins-header-title">规律</h1>
        {note !== null && <span className="ins-header-note">{note}</span>}
      </div>
      <p className="ins-header-subtitle">
        {anchorLabel(kind, anchor, now)} · {daysWithData} 天数据
        {appId ? ` · 已筛选 ${appName ?? appId}` : ""}
      </p>
      <ContextChips show={["app"]} appName={appName} />
    </div>
  );
}

// ---- 渲染 -------------------------------------------------------------------

export default function Insights() {
  const { kind, anchor, appId } = useContextState();

  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("patterns", { kind, anchor });

  // 全量（未按 app 过滤）——App 排行要看全站数据
  const { buckets: allBuckets } = useRangeData(viewKind, viewAnchor, null);
  // 按当前筛选过滤——趋势图、猫报告的数字用它
  const buckets = useMemo(
    () => (appId === null ? allBuckets : allBuckets.filter((b) => b.app_bundle_id === appId)),
    [allBuckets, appId]
  );

  // 基期，供所有 DeltaBadge 环比用
  const prevAnchor = shiftAnchor(viewKind, viewAnchor, -1);
  const { buckets: prevAllBuckets } = useRangeData(viewKind, prevAnchor, null);

  const vsLabel = viewKind === "week" ? "vs 上周" : "vs 上月";
  const baseThreshold = viewKind === "week" ? 120 : 600;

  const range = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);

  const daysWithData = daysWithDataOf(buckets);
  const appName =
    appId === null
      ? undefined
      : allBuckets.find((b) => b.app_bundle_id === appId)?.app_name ?? appId;

  const [hourlyGrid, setHourlyGrid] = useState<
    Array<Array<{ intensity: Intensity; state: "active" | "idle" | "no_data" }>>
  >(
    Array.from({ length: 7 }, () =>
      Array(24).fill({ intensity: 0, state: "no_data" as const })
    )
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHourlyActivity(range), fetchHourlyHeartbeats(range)])
      .then(([hourly, heartbeatList]) => {
        if (cancelled) return;
        const heartbeatMap = new Map<number, boolean>();
        for (const hb of heartbeatList) {
          heartbeatMap.set(hb.hour_start, hb.has_heartbeat);
        }
        setHourlyGrid(aggregateWeekHourGrid(hourly, heartbeatMap, range.start_ms));
      })
      .catch((e) => console.error("规律页作息数据获取失败:", e));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const dayStats = useMemo(() => aggregateByDay(buckets), [buckets]);
  const weekDays = useMemo(() => buildWeekDays(dayStats, range.start_ms), [dayStats, range]);
  const maxDay = useMemo(() => Math.max(...weekDays.map((d) => d.hours), 1), [weekDays]);

  const apps = useMemo<WeekApp[]>(() => {
    const cur = aggregateByApp(allBuckets);
    const prev = aggregateByApp(prevAllBuckets);
    return cur.slice(0, 6).map((a) => {
      const prevApp = prev.find((p) => p.app_bundle_id === a.app_bundle_id);
      return {
        name: a.app_name || a.app_bundle_id,
        bundleId: a.app_bundle_id,
        hours: a.duration_ms / (60 * 60 * 1000),
        intensity: a.intensity,
        currentMin: a.duration_ms / (60 * 1000),
        previousMin: prevApp ? prevApp.duration_ms / (60 * 1000) : 0,
      };
    });
  }, [allBuckets, prevAllBuckets]);

  const weekTotalHours = useMemo(
    () => dayStats.reduce((sum, d) => sum + d.active_ms, 0) / (60 * 60 * 1000),
    [dayStats]
  );
  const weekDailyAvg = useMemo(() => {
    const passedDays = weekDays.filter((d) => !d.isFuture).length;
    return passedDays > 0 ? weekTotalHours / passedDays : 0;
  }, [weekDays, weekTotalHours]);

  const isCurrentAnchor = viewAnchor === normalizeAnchor(viewKind, formatAnchor(new Date()));

  const topApp = apps[0] ?? null;

  const busiestDay = useMemo(() => {
    if (dayStats.length === 0) return null;
    const maxDayStat = dayStats.reduce((max, d) => (d.active_ms > max.active_ms ? d : max));
    const maxDayStart = maxDayStat.day_ms;
    const maxDayEnd = maxDayStart + DAY_MS;
    const maxDayBuckets = buckets.filter(
      (b) => b.bucket_start >= maxDayStart && b.bucket_start < maxDayEnd
    );
    const maxDayApps = aggregateByApp(maxDayBuckets);
    if (maxDayApps.length === 0) return null;
    const topAppOnDay = maxDayApps[0];
    return {
      name: `周${DAY_LABELS[maxDayStat.day_of_week]}`,
      hours: topAppOnDay.duration_ms / (60 * 60 * 1000),
      app: topAppOnDay.app_name || topAppOnDay.app_bundle_id,
    };
  }, [dayStats, buckets]);

  const weekChange = useMemo(() => {
    if (!topApp || topApp.hours <= 0) return null;
    const prevSameApp = aggregateByApp(prevAllBuckets).find(
      (p) => p.app_bundle_id === topApp.bundleId
    );
    const prevHours = prevSameApp ? prevSameApp.duration_ms / (60 * 60 * 1000) : 0;
    if (prevHours === 0) return null;
    const pct = Math.round(((topApp.hours - prevHours) / prevHours) * 100);
    return Math.abs(pct) <= 5 ? 0 : pct;
  }, [topApp, prevAllBuckets]);

  const catReport = useMemo(
    () => generateCatReport(weekTotalHours, topApp, busiestDay, weekChange, isCurrentAnchor),
    [weekTotalHours, topApp, busiestDay, weekChange, isCurrentAnchor]
  );

  return (
    <PageShell
      className="ins-page"
      header={
        <PatternsHeader
          kind={viewKind}
          anchor={viewAnchor}
          note={note}
          daysWithData={daysWithData}
          appId={appId}
          appName={appName}
        />
      }
    >
      {/* ① 猫的报告 —— 顶部通栏 */}
      <section className="ins-report">
        <div className="ins-report-avatar" aria-hidden>
          <Sparkles size={20} />
        </div>
        <div className="ins-report-body">
          <div className="ins-report-title">猫的报告</div>
          <p className="ins-report-text">
            {catReport || "还没有足够的数据生成报告喵～"}
          </p>
          <div className="ins-report-chips">
            <span className="ins-chip">
              <span className="ins-chip-num">{fmtHours(weekTotalHours)}</span>
              <span className="ins-chip-unit">小时 · {isCurrentAnchor ? "本" : "该"}{viewKind === "week" ? "周" : "月"}活跃</span>
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
        {/* ② 活跃趋势 */}
        <section className="panel ins-trend-panel">
          <h3 className="panel-title">{isCurrentAnchor ? "本周" : "该周"}活跃趋势</h3>
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

        {/* ③ App 排行 + 环比 */}
        <section className="panel ins-apps-panel">
          <h3 className="panel-title">App 排行</h3>
          <div className="ins-apps">
            {apps.length === 0 && (
              <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>
                这段范围还没有足够的数据
              </div>
            )}
            {apps.map((a) => {
              const pct = apps[0] ? (a.hours / apps[0].hours) * 100 : 0;
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
                  <DeltaBadge
                    current={a.currentMin}
                    previous={a.previousMin}
                    vsLabel={vsLabel}
                    baseThreshold={baseThreshold}
                  />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* ④ 作息画像 —— 星期 × 24 小时 */}
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
    </PageShell>
  );
}
