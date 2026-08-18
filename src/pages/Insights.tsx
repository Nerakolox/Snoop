/**
 * 规律 —— 跨天使用回顾（原「洞察」）
 * 以周/月为粒度：猫的报告吐槽 + 顶部两张卡（活跃对比 · 键鼠比）+
 * 活跃趋势柱状图 + App 排行（带环比）+ 星期 x 24 小时作息热力网格。
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import DeltaBadge from "../components/DeltaBadge";
import {
  fetchBucketsInRange,
  fetchHourlyActivity,
  fetchHourlyHeartbeats,
  DAY_MS,
} from "../data";
import {
  aggregateByApp,
  aggregateDowHourGrid,
  bucketSimple,
  computeDelta,
  daysWithDataOf,
  intensityVar,
  ratioToSliderPos,
  ratioVerdict,
  statsByDayFromBuckets,
  unionDurationMs,
  type DowHourCell,
  type Intensity,
} from "../analytics";
import AppIcon from "../components/AppIcon";
import PageShell from "../components/PageShell";
import ContextChips from "../components/shared/ContextChips";
import { useToast } from "../components/shared/Toast";
import { formatAnchor, toMs } from "../data/ranges";
import { useRangeData } from "../data/useRangeData";
import {
  adaptKind,
  normalizeAnchor,
  shiftAnchor,
  useContextActions,
  useContextState,
  type RangeKind,
} from "../store/context";
import { anchorLabel, fmtHours } from "../utils/format";

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

/** JS getDay(): 周日=0..周六=6 → 周一为第一列的索引 0..6，与 analytics/aggregate.ts 的 mondayIndex 同一约定 */
function mondayIndex(dayMs: number): number {
  const dow = new Date(dayMs).getDay();
  return dow === 0 ? 6 : dow - 1;
}

function dateLabelOf(dayMs: number): string {
  const d = new Date(dayMs);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 范围内该 dow(0=周一) 的最后一天，不晚于今天；没有则返回 null。 */
function lastDateOfDow(
  dowIndex: number,
  startMs: number,
  endMs: number,
  now: Date
): string | null {
  const nowDayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const cur = new Date(endMs);
  cur.setHours(0, 0, 0, 0);
  cur.setDate(cur.getDate() - 1); // endMs 是闭右开，范围内最后一天是 endMs 前一天
  while (cur.getTime() >= startMs) {
    if (mondayIndex(cur.getTime()) === dowIndex && cur.getTime() <= nowDayMs) {
      return formatAnchor(cur);
    }
    cur.setDate(cur.getDate() - 1);
  }
  return null;
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
  const actions = useContextActions();
  const toast = useToast();

  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("patterns", { kind, anchor });

  // 全量（未按 app 过滤）——App 排行要看全站数据
  const { buckets: allBuckets } = useRangeData(viewKind, viewAnchor, null);
  // 按当前筛选过滤——顶部两张卡、趋势图、猫报告的数字用它
  const buckets = useMemo(
    () => (appId === null ? allBuckets : allBuckets.filter((b) => b.app_bundle_id === appId)),
    [allBuckets, appId]
  );

  // 基期，供所有 DeltaBadge 环比用
  const prevAnchor = shiftAnchor(viewKind, viewAnchor, -1);
  const { buckets: prevAllBuckets } = useRangeData(viewKind, prevAnchor, null);
  const prevBuckets = useMemo(
    () => (appId === null ? prevAllBuckets : prevAllBuckets.filter((b) => b.app_bundle_id === appId)),
    [prevAllBuckets, appId]
  );

  const vsLabel = viewKind === "week" ? "vs 上周" : "vs 上月";
  const baseThreshold = viewKind === "week" ? 120 : 600;

  const range = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);
  const todayMs = useMemo(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  }, []);

  const daysWithData = daysWithDataOf(buckets);
  const appName =
    appId === null
      ? undefined
      : allBuckets.find((b) => b.app_bundle_id === appId)?.app_name ?? appId;

  const isCurrentAnchor = viewAnchor === normalizeAnchor(viewKind, formatAnchor(new Date()));

  function goToApp(bundleId: string, name: string) {
    actions.navigate({ page: "overview", appId: bundleId });
    toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
  }

  function goToDay(dayMs: number) {
    const dayAnchor = formatAnchor(new Date(dayMs));
    actions.navigate({ kind: "day", anchor: dayAnchor });
    toast.show({ message: `已切换到 ${dateLabelOf(dayMs)}`, undoLabel: "返回" });
  }

  // ---- 作息画像：星期 × 24 小时，任意范围通用（月粒度下同一格对应 4~5 天） ---

  const [hourlyGrid, setHourlyGrid] = useState<DowHourCell[][]>(
    Array.from({ length: 7 }, () =>
      Array(24).fill({ intensity: 0, state: "no_data" as const, sampleDays: 0 })
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
        setHourlyGrid(aggregateDowHourGrid(hourly, heartbeatMap, range.start_ms, range.end_ms));
      })
      .catch((e) => console.error("规律页作息数据获取失败:", e));
    return () => {
      cancelled = true;
    };
  }, [range]);

  function goToRhythmCell(ri: number, ci: number) {
    const dayAnchor = lastDateOfDow(ri, range.start_ms, range.end_ms, new Date());
    if (dayAnchor === null) return;
    actions.navigate({ page: "timeline", kind: "day", anchor: dayAnchor, focusHour: ci });
    toast.show({ message: "已跳转到时间线", undoLabel: "返回" });
  }

  // ---- 卡 A · 活跃对比 ------------------------------------------------------

  const activeDurationMs = useMemo(() => unionDurationMs(buckets), [buckets]);
  const prevActiveDurationMs = useMemo(() => unionDurationMs(prevBuckets), [prevBuckets]);
  const activeCurrentMin = Math.round(activeDurationMs / 60_000);
  const activePreviousMin = Math.round(prevActiveDurationMs / 60_000);
  const avgActiveMs = daysWithData > 0 ? activeDurationMs / daysWithData : 0;

  // ---- 卡 B · 键鼠比 --------------------------------------------------------

  const { clicks, keys } = useMemo(() => {
    let c = 0;
    let k = 0;
    for (const b of buckets) {
      c += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
      k += b.key_total || 0;
    }
    return { clicks: c, keys: k };
  }, [buckets]);
  const ratio = keys > 0 ? clicks / keys : 0;
  const ratioPos = ratioToSliderPos(ratio);
  const ratioLabel = keys > 0 ? ratioVerdict(ratio) : null;

  // 近 14 天键鼠比趋势——恒相对“今天”，与当前查看的范围无关，故不能走 useRangeData
  const [trend14, setTrend14] = useState<Array<{ dayMs: number; ratio: number }>>([]);
  useEffect(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1); // 明天 0 点，闭右开
    const start = new Date(end);
    start.setDate(start.getDate() - 14);
    let cancelled = false;
    fetchBucketsInRange({ start_ms: start.getTime(), end_ms: end.getTime() })
      .then((raw) => {
        if (cancelled) return;
        const src = appId === null ? raw : raw.filter((b) => b.app_bundle_id === appId);
        const days = statsByDayFromBuckets(src, start.getTime(), end.getTime());
        const byDay = new Map<number, { keys: number; clicks: number }>();
        for (const b of src) {
          const d = new Date(b.bucket_start);
          d.setHours(0, 0, 0, 0);
          const key = d.getTime();
          const slot = byDay.get(key) ?? { keys: 0, clicks: 0 };
          slot.keys += b.key_total || 0;
          slot.clicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
          byDay.set(key, slot);
        }
        setTrend14(
          days.map((d) => {
            const kc = byDay.get(d.dayMs);
            return { dayMs: d.dayMs, ratio: kc && kc.keys > 0 ? kc.clicks / kc.keys : 0 };
          })
        );
      })
      .catch((e) => console.error("近 14 天键鼠比趋势获取失败:", e));
    return () => {
      cancelled = true;
    };
  }, [appId]);
  const maxTrend14Ratio = Math.max(...trend14.map((d) => d.ratio), 0.0001);

  // ---- 活跃趋势柱状图 --------------------------------------------------------

  const dailyStats = useMemo(
    () => statsByDayFromBuckets(buckets, range.start_ms, range.end_ms),
    [buckets, range]
  );
  const maxDayActiveMs = Math.max(...dailyStats.map((d) => d.activeMs), 1);

  // ---- App 排行 --------------------------------------------------------------

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

  // ---- 猫发现的规律 -----------------------------------------------------------

  /** 统计类规律至少要看这么多天数据，太少容易是噪音 */
  const CAT_RULE_MIN_DAYS = 3;

  type RhythmPeak = { ri: number; ci: number; intensity: Intensity };
  const topRhythmCell = useMemo<RhythmPeak | null>(() => {
    if (daysWithData < CAT_RULE_MIN_DAYS) return null;
    let best: RhythmPeak | null = null;
    hourlyGrid.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        if (cell.state !== "active" || cell.intensity <= 0) return;
        if (!best || cell.intensity > best.intensity) {
          best = { ri, ci, intensity: cell.intensity };
        }
      });
    });
    return best;
  }, [hourlyGrid, daysWithData]);

  const topRhythmAnchor = useMemo(() => {
    if (!topRhythmCell) return null;
    return lastDateOfDow(topRhythmCell.ri, range.start_ms, range.end_ms, new Date());
  }, [topRhythmCell, range]);

  const homeAppShare = useMemo(() => {
    if (apps.length === 0) return null;
    const totalMs = unionDurationMs(allBuckets);
    if (totalMs <= 0) return null;
    const top = apps[0];
    return { app: top, pct: ((top.hours * 3_600_000) / totalMs) * 100 };
  }, [apps, allBuckets]);

  const nightOwl = useMemo(() => {
    if (daysWithData < CAT_RULE_MIN_DAYS) return null;
    let nightMs = 0;
    let totalMs = 0;
    let lastDataMs = 0;
    for (const b of allBuckets) {
      const h = new Date(b.bucket_start).getHours();
      const dur = b.duration_ms || 0;
      totalMs += dur;
      if (h >= 22 || h < 2) nightMs += dur;
      if (b.bucket_start > lastDataMs) lastDataMs = b.bucket_start;
    }
    if (totalMs <= 0) return null;
    return { pct: (nightMs / totalMs) * 100, anchor: formatAnchor(new Date(lastDataMs)) };
  }, [allBuckets, daysWithData]);

  type CatRule = { key: string; title: string; body: string; onClick: () => void };
  const catRules: CatRule[] = [];

  if (topRhythmCell && topRhythmAnchor) {
    catRules.push({
      key: "peak",
      title: "你的高产时段",
      body: `周${DAY_LABELS[topRhythmCell.ri]} ${topRhythmCell.ci}:00 前后强度常年拉满第 ${topRhythmCell.intensity} 档，猫都替你紧张喵。`,
      onClick: () => {
        actions.navigate({
          page: "timeline",
          kind: "day",
          anchor: topRhythmAnchor,
          focusHour: topRhythmCell.ci,
        });
        toast.show({ message: "已跳转到时间线", undoLabel: "返回" });
      },
    });
  }

  if (homeAppShare) {
    catRules.push({
      key: "home",
      title: "你几乎住在这里",
      body: `${homeAppShare.app.name} 占了 ${homeAppShare.pct.toFixed(0)}% 的活跃时长，是当之无愧的第二个家喵。`,
      onClick: () => {
        actions.navigate({ page: "overview", appId: homeAppShare.app.bundleId });
        toast.show({ message: `已筛选 ${homeAppShare.app.name}，全站生效`, undoLabel: "取消筛选" });
      },
    });
  }

  if (keys > 0 && ratioLabel) {
    catRules.push({
      key: "ratio",
      title: "键鼠画像",
      body: `键鼠比 ${ratio.toFixed(2)}，判定为「${ratioLabel}」，去输入页看细账喵？`,
      onClick: () => {
        actions.navigate({ page: "input" });
        toast.show({ message: "已跳转到输入页", undoLabel: "返回" });
      },
    });
  }

  if (nightOwl) {
    catRules.push({
      key: "night-owl",
      title: "夜猫子指数",
      body: `22 点到次日 2 点贡献了 ${nightOwl.pct.toFixed(1)}% 的活跃时长，早点睡喵～`,
      onClick: () => {
        actions.navigate({ page: "timeline", kind: "day", anchor: nightOwl.anchor, focusHour: 23 });
        toast.show({ message: "已跳转到时间线", undoLabel: "返回" });
      },
    });
  }

  // ---- 猫的报告（临时挂账，C4 整块删除） ------------------------------------

  const weekTotalHours = activeDurationMs / (60 * 60 * 1000);
  const weekDailyAvg = daysWithData > 0 ? weekTotalHours / daysWithData : 0;
  const topApp = apps[0] ?? null;

  const busiestDay = useMemo(() => {
    if (dailyStats.length === 0) return null;
    const maxDayStat = dailyStats.reduce((max, d) => (d.activeMs > max.activeMs ? d : max));
    if (maxDayStat.activeMs <= 0) return null;
    const maxDayStart = maxDayStat.dayMs;
    const maxDayEnd = maxDayStart + DAY_MS;
    const maxDayBuckets = buckets.filter(
      (b) => b.bucket_start >= maxDayStart && b.bucket_start < maxDayEnd
    );
    const maxDayApps = aggregateByApp(maxDayBuckets);
    if (maxDayApps.length === 0) return null;
    const topAppOnDay = maxDayApps[0];
    return {
      name: `周${DAY_LABELS[mondayIndex(maxDayStat.dayMs)]}`,
      hours: topAppOnDay.duration_ms / (60 * 60 * 1000),
      app: topAppOnDay.app_name || topAppOnDay.app_bundle_id,
    };
  }, [dailyStats, buckets]);

  // 环比口径与 DeltaBadge 共用 computeDelta，不再自己算百分比（挂账 #1 的正解）
  const topAppDeltaPct = useMemo(() => {
    if (!topApp) return null;
    const verdict = computeDelta(topApp.currentMin, topApp.previousMin, baseThreshold);
    if (verdict.kind === "up") return verdict.pct;
    if (verdict.kind === "down") return -verdict.pct;
    if (verdict.kind === "flat") return 0;
    return null; // "na" | "new"：基数不够，不给百分比
  }, [topApp, baseThreshold]);

  const catReport = useMemo(
    () => generateCatReport(weekTotalHours, topApp, busiestDay, topAppDeltaPct, isCurrentAnchor),
    [weekTotalHours, topApp, busiestDay, topAppDeltaPct, isCurrentAnchor]
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
      {/* ① 猫的报告 —— 顶部通栏（临时挂账，C4 删除并迁往概览的周期总结卡） */}
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

      {/* ⓪ 顶部两张卡：活跃对比 · 键鼠比 */}
      <section className="ins-top-cards">
        <div className="panel ins-card">
          <h3 className="panel-title">活跃对比</h3>
          <div className="ins-card-value">{fmtHours(activeDurationMs / (60 * 60 * 1000))} 小时</div>
          <DeltaBadge
            current={activeCurrentMin}
            previous={activePreviousMin}
            vsLabel={vsLabel}
            baseThreshold={baseThreshold}
          />
          <div className="ins-card-sub">
            {daysWithData > 0
              ? `日均 ${fmtHours(avgActiveMs / (60 * 60 * 1000))} 小时 · 分母 ${daysWithData} 天`
              : "暂无数据"}
          </div>
        </div>

        <div className="panel ins-card">
          <h3 className="panel-title">键鼠比</h3>
          {keys === 0 ? (
            <p className="ins-card-empty">无按键数据</p>
          ) : (
            <div className="ratio-card">
              <div className="ratio-number">
                {ratio.toFixed(2)}
                <span className="ratio-tag">{ratioLabel}</span>
              </div>
              <div className="ratio-slider">
                <div className="ratio-slider-track">
                  <div className="ratio-slider-thumb" style={{ left: `${ratioPos * 100}%` }} />
                </div>
                <div className="ratio-slider-ends">
                  <span>偏键盘</span>
                  <span>偏鼠标</span>
                </div>
              </div>
            </div>
          )}
          <div className="ins-trend14" title="近 14 天键鼠比趋势（不随范围变化）">
            {trend14.map((d) => (
              <div
                key={d.dayMs}
                className="ins-trend14-bar-wrap"
                title={`${dateLabelOf(d.dayMs)} · ${d.ratio.toFixed(2)}`}
              >
                {d.ratio > 0 && (
                  <div
                    className="ins-trend14-bar"
                    style={{ height: `${Math.max((d.ratio / maxTrend14Ratio) * 100, 4)}%` }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ②③ 中间左右分栏：趋势图 · App 排行 */}
      <div className="ins-split">
        {/* ② 活跃趋势 */}
        <section className="panel ins-trend-panel">
          <h3 className="panel-title">
            {isCurrentAnchor ? (viewKind === "week" ? "本周" : "本月") : "该范围"}活跃趋势
          </h3>
          <div className="ins-trend" style={{ gridTemplateColumns: `repeat(${dailyStats.length}, 1fr)` }}>
            {dailyStats.map((d, i) => {
              const hasData = d.activeMs > 0;
              const pct = hasData ? (d.activeMs / maxDayActiveMs) * 100 : 0;
              const level = bucketSimple(d.activeMs, maxDayActiveMs);
              const isToday = d.dayMs === todayMs;
              const barStyle: CSSProperties = {
                height: `${pct}%`,
                background: isToday ? "var(--color-accent)" : intensityVar(level),
              };
              const showLabel = viewKind === "week" || i % 5 === 0 || i === dailyStats.length - 1;
              const label =
                viewKind === "week"
                  ? DAY_LABELS[mondayIndex(d.dayMs)]
                  : String(new Date(d.dayMs).getDate());
              return (
                <button
                  key={d.dayMs}
                  type="button"
                  className="ins-trend-col drillable"
                  onClick={() => goToDay(d.dayMs)}
                  title={
                    hasData
                      ? `${dateLabelOf(d.dayMs)} · ${fmtHours(d.activeMs / (60 * 60 * 1000))}h`
                      : `${dateLabelOf(d.dayMs)} · 无采集数据`
                  }
                >
                  <div className="ins-trend-bar-wrap">
                    {hasData && <div className="ins-trend-bar" style={barStyle} />}
                  </div>
                  {hasData && (
                    <div className="ins-trend-value">{fmtHours(d.activeMs / (60 * 60 * 1000))}h</div>
                  )}
                  <div className="ins-trend-label">{showLabel ? label : ""}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ③ App 排行 + 环比 */}
        <section className="panel ins-apps-panel">
          <h3 className="panel-title">App 排行 · 环比</h3>
          <div className="ins-apps">
            {apps.length === 0 && (
              <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>
                这段范围还没有足够的数据
              </div>
            )}
            {apps.map((a) => {
              const pct = apps[0] ? (a.hours / apps[0].hours) * 100 : 0;
              const dim = appId !== null && appId !== a.bundleId;
              return (
                <button
                  key={a.bundleId}
                  type="button"
                  className={`ins-app-row drillable${dim ? " ins-app-row--dim" : ""}`}
                  onClick={() => goToApp(a.bundleId, a.name)}
                >
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
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* ④ 作息画像 —— 星期 × 24 小时 */}
      <section className="panel ins-rhythm-panel">
        <h3 className="panel-title">
          作息画像
          {appId !== null && (
            <span
              className="ins-rhythm-note"
              title="此视图基于 get_hourly_heartbeats，与前台 App 无关"
            >
              不受应用筛选影响
            </span>
          )}
        </h3>
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
                  const dayLabel = `周${DAY_LABELS[ri]}`;
                  const hourLabel = `${ci}:00`;
                  const sampleSuffix = cell.sampleDays > 1 ? ` · 合并 ${cell.sampleDays} 天` : "";

                  if (cell.state === "active") {
                    return (
                      <button
                        key={`${ri}-${ci}`}
                        type="button"
                        className="ins-rhythm-cell drillable"
                        style={{ background: intensityVar(cell.intensity) }}
                        title={`${dayLabel} ${hourLabel} · 强度 ${cell.intensity}${sampleSuffix}`}
                        onClick={() => goToRhythmCell(ri, ci)}
                      />
                    );
                  }

                  const bg = cell.state === "idle" ? "#D1D5DB" : "#F3F4F6"; // 挂机=中性灰实心 / 未采集=极浅底色
                  const stateLabel = cell.state === "idle" ? "挂机（无输入）" : "未采集";
                  return (
                    <div
                      key={`${ri}-${ci}`}
                      className={`ins-rhythm-cell ${cell.state === "no_data" ? "ins-rhythm-cell--no-data" : ""}`}
                      style={{ background: bg }}
                      title={`${dayLabel} ${hourLabel} · ${stateLabel}${sampleSuffix}`}
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

      {/* ⑤ 猫发现的规律 */}
      <section className="panel ins-rules-panel">
        <h3 className="panel-title">猫发现的规律</h3>
        {catRules.length === 0 ? (
          <p className="ins-card-empty">数据还不够，猫还没发现规律喵～</p>
        ) : (
          <div className="ins-rules">
            {catRules.map((r) => (
              <button
                key={r.key}
                type="button"
                className="ins-rule-card drillable"
                onClick={r.onClick}
              >
                <div className="ins-rule-title">{r.title}</div>
                <p className="ins-rule-body">{r.body}</p>
              </button>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
