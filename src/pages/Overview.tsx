/**
 * 概览 —— Snoop 的首页
 * 定位：消费全局 (kind, anchor, appId)，是当前范围的快照 + 猫的实时陪伴。
 */

import { useEffect, useMemo, useState } from "react";
import {
  aggregateByApp,
  computeIntensity,
  intensityByHourFromBuckets,
  intensityVar,
  statsByDayFromBuckets,
  type Intensity,
  MOOD_LABELS,
  MOUSE_PIXELS_PER_METER,
  RECENT_ACTIVITY_WINDOW_MS,
  pickCatQuip,
  unionDurationMs,
} from "../analytics";
import type { RawBucket } from "../data/types";
import AppIcon from "../components/AppIcon";
import DeltaBadge from "../components/DeltaBadge";
import PageShell from "../components/PageShell";
import ContextChips from "../components/shared/ContextChips";
import { useToast } from "../components/shared/Toast";
import type { NavKey } from "../components/Sidebar";
import { useRangeData } from "../data/useRangeData";
import { formatAnchor, toMs } from "../data/ranges";
import {
  adaptKind,
  normalizeAnchor,
  shiftAnchor,
  useContextActions,
  useContextState,
  type RangeKind,
} from "../store/context";
import { anchorLabel } from "../utils/format";

type NowStatus = {
  appName: string;
  appBundleId: string;
  moodLabel: string;
  moodIntensity: Intensity;
  catQuip: string;
};

type KpiPart = { kind: "num" | "unit"; text: string };
type Kpi = {
  label: string;
  parts: KpiPart[];
  target: NavKey;
  targetLabel: string;
  sub?: string;
};

type AppRow = {
  name: string;
  bundleId: string;
  minutes: number;
  intensity: Intensity;
};

/** 格式化时长：毫秒 → "X时Y分" 或 "X分" */
function formatDuration(ms: number): KpiPart[] {
  const totalMin = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) {
    return [
      { kind: "num", text: String(hours) },
      { kind: "unit", text: "时" },
      { kind: "num", text: String(mins) },
      { kind: "unit", text: "分" },
    ];
  }
  return [
    { kind: "num", text: String(mins) },
    { kind: "unit", text: "分" },
  ];
}

/** formatDuration 的纯字符串版，用于副文案/tooltip 里不需要分段样式的场合 */
function formatDurationPlain(ms: number): string {
  return formatDuration(ms).map((p) => p.text).join("");
}

/** 格式化数字：加千分位 */
function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 格式化鼠标里程：像素 → 米/公里 */
function formatMouseDistance(pixels: number): KpiPart[] {
  const meters = pixels / MOUSE_PIXELS_PER_METER;
  if (meters >= 1000) {
    const km = (meters / 1000).toFixed(1);
    return [
      { kind: "num", text: km },
      { kind: "unit", text: "公里" },
    ];
  }
  const m = Math.round(meters);
  return [
    { kind: "num", text: String(m) },
    { kind: "unit", text: "米" },
  ];
}

/** 该范围没有数据时的说明文案，随是否已筛选应用而不同 */
function noDataReason(appId: string | null, appName: string | undefined): string {
  return appId ? `${appName ?? appId} 在该范围内没有记录` : "该范围没有采集到数据";
}

function daysWithDataOf(buckets: RawBucket[]): number {
  const days = new Set<string>();
  for (const b of buckets) {
    const d = new Date(b.bucket_start);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** JS getDay(): 周日=0..周六=6 → 周一为第一列的索引 0..6，与 analytics/aggregate.ts 的 mondayIndex 同一约定 */
function mondayIndex(dayMs: number): number {
  const dow = new Date(dayMs).getDay();
  return dow === 0 ? 6 : dow - 1;
}

function dateLabelOf(dayMs: number): string {
  const d = new Date(dayMs);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function OverviewHeader({
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
    <div className="overview-header">
      <div className="overview-header-titlerow">
        <h1 className="overview-header-title">概览</h1>
        {note !== null && <span className="overview-header-note">{note}</span>}
      </div>
      <p className="overview-header-subtitle">
        {anchorLabel(kind, anchor, now)} · {daysWithData} 天数据
        {appId ? ` · 已筛选 ${appName ?? appId}` : ""}
      </p>
      <ContextChips show={["app"]} appName={appName} />
    </div>
  );
}

export default function Overview() {
  const { kind, anchor, appId } = useContextState();
  const actions = useContextActions();
  const toast = useToast();

  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("overview", { kind, anchor });
  const { buckets: allBuckets, loading, refetch } = useRangeData(viewKind, viewAnchor, null);
  const buckets = useMemo(
    () => (appId === null ? allBuckets : allBuckets.filter((b) => b.app_bundle_id === appId)),
    [allBuckets, appId]
  );

  // 基期数据，仅供 App 排行的 DeltaBadge 环比用
  const prevAnchor = shiftAnchor(viewKind, viewAnchor, -1);
  const { buckets: prevAllBuckets } = useRangeData(viewKind, prevAnchor, null);
  const prevMinutesByApp = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of aggregateByApp(prevAllBuckets)) {
      map.set(a.app_bundle_id, Math.round(a.duration_ms / 60_000));
    }
    return map;
  }, [prevAllBuckets]);
  const vsLabel = viewKind === "day" ? "vs 昨天" : viewKind === "week" ? "vs 上周" : "vs 上月";
  const baseThreshold = viewKind === "day" ? 20 : viewKind === "week" ? 120 : 600;

  function goTo(target: NavKey, targetLabel: string) {
    actions.navigate({ page: target });
    toast.show({ message: `已跳转到${targetLabel}`, undoLabel: "返回" });
  }

  function goToApp(bundleId: string, name: string) {
    actions.navigate({ page: "timeline", appId: bundleId });
    toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
  }

  const isLive = kind === "day" && anchor === formatAnchor(new Date());

  useEffect(() => {
    if (!isLive) return; // 看历史数据没必要轮询
    const timer = setInterval(() => refetch(), 30_000);
    return () => clearInterval(timer);
  }, [isLive, refetch]);

  const [now, setNow] = useState<NowStatus>({
    appName: "—",
    appBundleId: "",
    moodLabel: "静默中",
    moodIntensity: 0,
    catQuip: "还没有数据喵～",
  });

  useEffect(() => {
    if (!isLive) return;
    const nowTs = Date.now();
    const recentBuckets = buckets.filter(
      (b) => nowTs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS
    );
    if (recentBuckets.length > 0) {
      const appDurations = new Map<string, { duration: number; name: string; bundleId: string }>();
      for (const b of recentBuckets) {
        const key = b.app_bundle_id;
        const existing = appDurations.get(key);
        if (existing) {
          existing.duration += b.duration_ms || 0;
        } else {
          appDurations.set(key, {
            duration: b.duration_ms || 0,
            name: b.app_name || b.app_bundle_id,
            bundleId: b.app_bundle_id,
          });
        }
      }
      const dominant = [...appDurations.values()].sort((a, b) => b.duration - a.duration)[0];
      const recentIntensity = computeIntensity(recentBuckets);
      setNow({
        appName: dominant.name || "未知应用",
        appBundleId: dominant.bundleId || "",
        moodLabel: MOOD_LABELS[recentIntensity],
        moodIntensity: recentIntensity,
        catQuip: pickCatQuip(recentIntensity, dominant.name || ""),
      });
    } else {
      setNow({
        appName: "—",
        appBundleId: "",
        moodLabel: "挂机中",
        moodIntensity: 0,
        catQuip: "人呢？挂机了喵？",
      });
    }
  }, [isLive, buckets]);

  const activeDuration = unionDurationMs(buckets);
  let totalKeys = 0;
  let totalClicks = 0;
  let totalMouseDist = 0;
  for (const b of buckets) {
    totalKeys += b.key_total || 0;
    totalClicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
    totalMouseDist += b.mouse_move_dist || 0;
  }
  const daysWithData = daysWithDataOf(buckets);
  const avgMs = daysWithData > 0 ? activeDuration / daysWithData : 0;
  const avgLabel = formatDurationPlain(avgMs);

  const kpis: Kpi[] = [
    {
      label: "活跃时长",
      parts: formatDuration(activeDuration),
      target: "timeline",
      targetLabel: "时间线",
      sub: viewKind !== "day" ? `日均 ${avgLabel} · 分母 ${daysWithData} 天` : undefined,
    },
    {
      label: "总按键",
      parts: [
        { kind: "num", text: formatNumber(totalKeys) },
        { kind: "unit", text: "次" },
      ],
      target: "keyboard",
      targetLabel: "键盘",
    },
    {
      label: "总点击",
      parts: [
        { kind: "num", text: formatNumber(totalClicks) },
        { kind: "unit", text: "次" },
      ],
      target: "keyboard",
      targetLabel: "键盘",
    },
    {
      label: "鼠标里程",
      parts: formatMouseDistance(totalMouseDist),
      target: "keyboard",
      targetLabel: "键盘",
    },
  ];

  const apps: AppRow[] = aggregateByApp(allBuckets)
    .slice(0, 6)
    .map((a) => ({
      name: a.app_name || a.app_bundle_id,
      bundleId: a.app_bundle_id,
      minutes: Math.round(a.duration_ms / 60_000),
      intensity: a.intensity,
    }));
  const maxMinutes = Math.max(...apps.map((a) => a.minutes), 1);

  const hourly = intensityByHourFromBuckets(buckets);

  const rhythmRange = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);
  const dailyStats = useMemo(() => {
    const stats = statsByDayFromBuckets(buckets, rhythmRange.start_ms, rhythmRange.end_ms);
    return stats.map((s) => ({ ...s, hasData: s.activeMs > 0 }));
  }, [buckets, rhythmRange]);
  const maxDayActiveMs = Math.max(...dailyStats.map((d) => d.activeMs), 1);

  const appName =
    appId === null
      ? undefined
      : buckets.find((b) => b.app_bundle_id === appId)?.app_name ?? appId;

  const nowLabel = useMemo(() => new Date(), []);
  // 「当前筛选下」是否没有数据 —— 用来决定 KPI / 节奏区的空态说明。
  // App 排行不受筛选影响（展示全量），空态单独按 apps.length 判断。
  const isEmpty = !loading && buckets.length === 0;

  const isCurrentAnchor = viewAnchor === normalizeAnchor(viewKind, formatAnchor(nowLabel));
  const rhythmTitle = isCurrentAnchor
    ? viewKind === "day"
      ? "今日节奏"
      : viewKind === "week"
        ? "本周节奏"
        : "本月节奏"
    : `${anchorLabel(viewKind, viewAnchor, nowLabel)}节奏`;

  function goToHour(hour: number) {
    actions.navigate({ page: "timeline", focusHour: hour });
    toast.show({ message: "已跳转到时间线", undoLabel: "返回" });
  }

  function goToDay(dayMs: number) {
    const dayAnchor = formatAnchor(new Date(dayMs));
    actions.navigate({ kind: "day", anchor: dayAnchor });
    toast.show({ message: `已切换到 ${dateLabelOf(dayMs)}`, undoLabel: "返回" });
  }

  if (loading && allBuckets.length === 0) {
    return (
      <PageShell
        className="overview"
        header={
          <OverviewHeader
            kind={viewKind}
            anchor={viewAnchor}
            note={note}
            daysWithData={0}
            appId={appId}
            appName={appName}
          />
        }
      >
        <div className="overview-loading">加载中…</div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="overview"
      header={
        <OverviewHeader
          kind={viewKind}
          anchor={viewAnchor}
          note={note}
          daysWithData={daysWithData}
          appId={appId}
          appName={appName}
        />
      }
    >
      {/* ① 此刻状态 —— 猫的舞台，仅当查看的是"今天"时才出现，历史范围不该有实时状态 */}
      {isLive && (
        <section className="now-card">
          <div className="now-mascot" aria-hidden>
            {now.appBundleId ? (
              <AppIcon bundleId={now.appBundleId} appName={now.appName} size={64} />
            ) : (
              <span className="now-mascot-placeholder">猫</span>
            )}
          </div>
          <div className="now-info">
            <div className="now-label">此刻</div>
            <div className="now-app" title={now.appName}>{now.appName}</div>
            <div
              className="now-mood"
              style={{
                background: intensityVar(now.moodIntensity),
                color: now.moodIntensity >= 3 ? "#fff" : "var(--color-text)",
              }}
            >
              {now.moodLabel}
            </div>
            <p className="now-quip">{now.catQuip}</p>
          </div>
        </section>
      )}

      {/* ② 核心数字 */}
      <section className="kpi-row">
        {kpis.map((k) => (
          <button
            key={k.label}
            type="button"
            className="kpi-card drillable"
            data-target-label={k.targetLabel}
            onClick={() => goTo(k.target, k.targetLabel)}
          >
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">
              {k.parts.map((p, i) => (
                <span key={i} className={p.kind === "num" ? "kpi-num" : "kpi-unit"}>
                  {p.text}
                </span>
              ))}
            </div>
            {k.sub && <div className="kpi-sub">{k.sub}</div>}
          </button>
        ))}
      </section>
      {isEmpty && <p className="overview-empty-note">{noDataReason(appId, appName)}</p>}

      {/* ③ App 时长排行 */}
      <section className="panel">
        <h3 className="panel-title">App 排行</h3>
        <div className="app-list">
          {apps.length === 0 && (
            <div className="overview-empty-note">
              {anchorLabel(viewKind, viewAnchor, nowLabel)}还没有数据
            </div>
          )}
          {apps.map((app) => {
            const pct = (app.minutes / maxMinutes) * 100;
            const dim = appId !== null && appId !== app.bundleId;
            return (
              <button
                key={app.bundleId}
                type="button"
                className={`app-row drillable${dim ? " app-row--dim" : ""}`}
                onClick={() => goToApp(app.bundleId, app.name)}
              >
                <div className="app-row-name" title={app.name}>
                  <AppIcon bundleId={app.bundleId} appName={app.name} size={18} />
                  <span>{app.name}</span>
                </div>
                <div className="app-row-track">
                  <div
                    className="app-row-fill"
                    style={{
                      width: `${pct}%`,
                      background: intensityVar(app.intensity),
                    }}
                  />
                </div>
                <div className="app-row-time">{app.minutes} 分</div>
                <DeltaBadge
                  current={app.minutes}
                  previous={prevMinutesByApp.get(app.bundleId) ?? 0}
                  vsLabel={vsLabel}
                  baseThreshold={baseThreshold}
                />
              </button>
            );
          })}
        </div>
      </section>

      {/* ④ 节奏 —— 日=24 格热力条 / 周=7 柱 / 月=日历热力 */}
      <section className="panel">
        <h3 className="panel-title">{rhythmTitle}</h3>

        {viewKind === "day" && (
          <>
            <div className="heat-strip">
              {hourly.map((level, hour) => (
                <button
                  key={hour}
                  type="button"
                  className="heat-cell drillable"
                  style={{ background: intensityVar(level) }}
                  title={`${hour}:00 · 强度 ${level}`}
                  onClick={() => goToHour(hour)}
                />
              ))}
            </div>
            <div className="heat-scale">
              <span className="heat-scale-tick heat-scale-tick--edge-start" style={{ gridColumn: 1 }}>
                0
              </span>
              <span className="heat-scale-tick" style={{ gridColumn: 7 }}>
                6
              </span>
              <span className="heat-scale-tick" style={{ gridColumn: 13 }}>
                12
              </span>
              <span className="heat-scale-tick" style={{ gridColumn: 19 }}>
                18
              </span>
              <span className="heat-scale-tick heat-scale-tick--edge-end" style={{ gridColumn: 24 }}>
                24
              </span>
            </div>
          </>
        )}

        {viewKind === "week" && (
          <div className="week-bars">
            {dailyStats.map((d) => {
              const pct = d.hasData ? Math.max((d.activeMs / maxDayActiveMs) * 100, 4) : 0;
              return (
                <button
                  key={d.dayMs}
                  type="button"
                  className={`week-bar drillable${d.hasData ? "" : " week-bar--empty"}`}
                  onClick={() => goToDay(d.dayMs)}
                  title={
                    d.hasData
                      ? `${dateLabelOf(d.dayMs)} · ${formatDurationPlain(d.activeMs)}`
                      : `${dateLabelOf(d.dayMs)} · 无采集数据`
                  }
                >
                  <span className="week-bar-track">
                    {d.hasData && (
                      <span
                        className="week-bar-fill"
                        style={{ height: `${pct}%`, background: intensityVar(d.intensity) }}
                      />
                    )}
                  </span>
                  <span className="week-bar-label">{WEEKDAY_LABELS[mondayIndex(d.dayMs)]}</span>
                </button>
              );
            })}
          </div>
        )}

        {viewKind === "month" && (
          <div className="month-grid">
            {dailyStats.map((d, i) => (
              <button
                key={d.dayMs}
                type="button"
                className={`month-cell drillable${d.hasData ? "" : " month-cell--empty"}`}
                style={{
                  gridColumnStart: i === 0 ? mondayIndex(d.dayMs) + 1 : undefined,
                  background: d.hasData ? intensityVar(d.intensity) : undefined,
                }}
                title={d.hasData ? `${dateLabelOf(d.dayMs)} · 强度 ${d.intensity}` : `${dateLabelOf(d.dayMs)} · 无采集数据`}
                onClick={() => goToDay(d.dayMs)}
              >
                <span className="month-cell-date">{new Date(d.dayMs).getDate()}</span>
              </button>
            ))}
          </div>
        )}

        {isEmpty && <p className="overview-empty-note">{noDataReason(appId, appName)}</p>}
      </section>
    </PageShell>
  );
}
