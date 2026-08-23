/**
 * 概览 —— Snoop 的首页
 * 定位：消费全局 (kind, anchor, appId)，是当前范围的快照 + 猫的实时陪伴。
 */

import { useEffect, useMemo, useState } from "react";
import {
  aggregateByApp,
  daysWithDataOf,
  durationByHourFromBuckets,
  durationColorVar,
  durationLevel,
  intensityVar,
  statsByDayFromBuckets,
  type Intensity,
  MOUSE_PIXELS_PER_METER,
  unionDurationMs,
} from "../analytics";
import AppIcon from "../components/AppIcon";
import DeltaBadge from "../components/DeltaBadge";
import PageShell from "../components/PageShell";
import { useToast } from "../components/shared/Toast";
import Tooltip from "../components/shared/Tooltip";
import type { NavKey } from "../components/Sidebar";
import { useRangeData } from "../data/useRangeData";
import { fetchHourlyHeartbeats } from "../data/client";
import { getCategoryBreakdown } from "../ai/client";
import { useTodayNotice } from "../ai/notice";
import { CATEGORY_LABEL, shareColorVar } from "../ai/categories";
import type { CategoryShare } from "../ai/types";
import { formatAnchor, parseAnchor, toMs } from "../data/ranges";
import {
  adaptKind,
  normalizeAnchor,
  shiftAnchor,
  useContextActions,
  useContextState,
  useToday,
  type RangeKind,
} from "../store/context";
import { anchorLabel, formatDuration as fmtDuration, formatSharePct } from "../utils/format";

type KpiPart = { kind: "num" | "unit"; text: string };
type Kpi = {
  label: string;
  parts: KpiPart[];
  target: NavKey;
  targetLabel: string;
  sub?: string;
  title?: string;
};

type AppRow = {
  name: string;
  bundleId: string;
  minutes: number;
  intensity: Intensity;
};

/** 格式化时长：毫秒 → "X小时Y分"（整点省 "0分" → "X小时"，不足 1 小时 → "X分"） */
function formatDuration(ms: number): KpiPart[] {
  const totalMin = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0 && mins > 0) {
    return [
      { kind: "num", text: String(hours) },
      { kind: "unit", text: "小时" },
      { kind: "num", text: String(mins) },
      { kind: "unit", text: "分" },
    ];
  }
  if (hours > 0) {
    return [
      { kind: "num", text: String(hours) },
      { kind: "unit", text: "小时" },
    ];
  }
  return [
    { kind: "num", text: String(mins) },
    { kind: "unit", text: "分" },
  ];
}

/** formatDuration 的纯字符串版，用于副文案/tooltip 里不需要分段样式的场合 */
function formatDurationPlain(ms: number): string {
  return formatDuration(ms).map((p) => p.text).join(" ");
}

/** 紧凑时长：周视图格内文字。小于 1 分钟显示秒、小于 1 小时显示分、否则显示「N.Nh」。
 *  例：45s / 12m / 3.2h。 */
function formatCompactDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  return `${(totalMin / 60).toFixed(1)}h`;
}

/** 周视图 tooltip 的星期标签：「周三」。 */
function weekdayLabelOf(dayMs: number): string {
  return `周${WEEKDAY_LABELS[mondayIndex(dayMs)]}`;
}

/** 小时 → 「14:00」。 */
function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** 格式化数字：加千分位 */
function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** KPI 大整数缩写：≥1 亿→「X.X亿」、≥1 万→「X.X万」，否则千分位原文。
 *  完整值经 KPI 卡片的 title 悬浮展示，不丢精度。 */
function formatCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return formatNumber(n);
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

/** 周期总结卡的判语，按日均活跃小时数分四档（阈值 9 / 6 / 3，工单写死）。 */
function judgeLabel(avgHours: number): string {
  if (avgHours >= 9) return "妥妥的爆肝档，悠着点喵";
  if (avgHours >= 6) return "认真档，稳扎稳打喵";
  if (avgHours >= 3) return "正常档，张弛有度喵";
  return "摸鱼档，劳逸结合也不错喵";
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** 时长深浅阶的 6 个档位索引，供图例逐一渲染色块。 */
const DURATION_LEVELS = [0, 1, 2, 3, 4, 5] as const;

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
  const today = useToday();
  return (
    <div className="overview-header">
      <div className="overview-header-titlerow">
        <h1 className="overview-header-title">概览</h1>
        {note !== null && <span className="overview-header-note">{note}</span>}
      </div>
      <p className="overview-header-subtitle">
        {anchorLabel(kind, anchor, today)} · {daysWithData} 天数据
        {appId ? ` · 已筛选 ${appName ?? appId}` : ""}
      </p>
    </div>
  );
}

/** 分类占比的「结论句 + chip」块（D 方案）：
 *  第一名用结论句大字突出（占比 + 类别 + 时长），其余压成可换行的圆角 chip。
 *  删掉原逐行图例，只保留这一种形态。 */
function CategoryVerdict({
  categories,
  totalMs,
}: {
  categories: CategoryShare[];
  totalMs: number;
}) {
  if (categories.length === 0) return null;
  const top = categories[0];
  const rest = categories.slice(1);
  const restTotalMs = rest.reduce((s, x) => s + x.duration_ms, 0);
  const topPct = totalMs > 0 ? (top.duration_ms / totalMs) * 100 : 0;

  const labelOf = (c: string) => CATEGORY_LABEL[c] ?? c;
  const tipOf = (s: CategoryShare, pct: number) =>
    `${labelOf(s.category)} · ${fmtDuration(s.duration_ms)} · ${formatSharePct(pct)}`;

  return (
    <>
      <p className="cat-verdict">
        <span className="cat-verdict-pct">{formatSharePct(topPct)}</span>
        <span className="cat-verdict-rest">
          是{labelOf(top.category)}，{fmtDuration(top.duration_ms)}
        </span>
      </p>
      {rest.length > 0 && (
        <>
          <p className="cat-rest-line">其余 {rest.length} 类合计 {fmtDuration(restTotalMs)}</p>
          <div className="cat-chips">
            {rest.map((s, i) => {
              const pct = totalMs > 0 ? (s.duration_ms / totalMs) * 100 : 0;
              return (
                <Tooltip key={s.category} content={tipOf(s, pct)}>
                  <span className="cat-chip">
                    <span className="cat-chip-dot" style={{ background: shareColorVar(i + 1) }} />
                    <span className="cat-chip-label">{labelOf(s.category)}</span>
                    <span className="cat-chip-pct">{formatSharePct(pct)}</span>
                  </span>
                </Tooltip>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export default function Overview() {
  const { kind, anchor, appId } = useContextState();
  const actions = useContextActions();
  const toast = useToast();
  const today = useToday();

  // 是否正停在「今天」（日视图 + 今天）。留意卡片只在此时计算与展示。
  const isLive = kind === "day" && anchor === today;
  const notice = useTodayNotice(isLive);

  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("overview", { kind, anchor }, today);
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

  // 读全局基准而非自己读钟：跨日时 today 与 anchor 同步前进，isLive 保持 true，
  // 下面的 30s 轮询不会被 cleanup 清掉（旧写法会在午夜后把自己的 interval 清死）。
  useEffect(() => {
    if (!isLive) return; // 看历史数据没必要轮询
    const timer = setInterval(() => refetch(), 30_000);
    return () => clearInterval(timer);
  }, [isLive, refetch]);

  const foregroundDuration = unionDurationMs(buckets);
  let totalKeys = 0;
  let totalClicks = 0;
  let totalMouseDist = 0;
  for (const b of buckets) {
    totalKeys += b.key_total || 0;
    totalClicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
    totalMouseDist += b.mouse_move_dist || 0;
  }
  const daysWithData = daysWithDataOf(buckets);
  const avgMs = daysWithData > 0 ? foregroundDuration / daysWithData : 0;
  const avgLabel = formatDurationPlain(avgMs);

  const kpis: Kpi[] = [
    {
      label: "前台时长",
      parts: formatDuration(foregroundDuration),
      target: "timeline",
      targetLabel: "时间线",
      sub: viewKind !== "day" ? `日均 ${avgLabel}\n分母 ${daysWithData} 天` : undefined,
    },
    {
      label: "总按键",
      parts: [
        { kind: "num", text: formatCount(totalKeys) },
        { kind: "unit", text: "次" },
      ],
      target: "input",
      targetLabel: "输入",
      title: `${formatNumber(totalKeys)} 次`,
    },
    {
      label: "总点击",
      parts: [
        { kind: "num", text: formatCount(totalClicks) },
        { kind: "unit", text: "次" },
      ],
      target: "input",
      targetLabel: "输入",
      title: `${formatNumber(totalClicks)} 次`,
    },
    {
      label: "鼠标里程",
      parts: formatMouseDistance(totalMouseDist),
      target: "input",
      targetLabel: "输入",
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

  const rhythmRange = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);
  const dailyStats = useMemo(() => {
    const stats = statsByDayFromBuckets(buckets, rhythmRange.start_ms, rhythmRange.end_ms);
    return stats.map((s) => ({ ...s, hasData: s.foregroundMs > 0 }));
  }, [buckets, rhythmRange]);
  const maxDayForegroundMs = Math.max(...dailyStats.map((d) => d.foregroundMs), 1);

  // 心跳（Snoop 是否在运行）按本地整点 —— 用于区分「零活跃(有采集但无输入)」与「无数据(未采集)」。
  // 与 Insights 作息画像同源：get_hourly_heartbeats 不接 app 参数，但心跳是「应用是否在跑」的全局事实，
  // 与前台 App 无关，故 appId 筛选下仍成立（零活跃 = 有采集却没有任何前台桶）。
  const [heartbeatHours, setHeartbeatHours] = useState<Set<number>>(new Set());
  useEffect(() => {
    let cancelled = false;
    fetchHourlyHeartbeats(rhythmRange)
      .then((list) => {
        if (cancelled) return;
        const s = new Set<number>();
        for (const hb of list) if (hb.has_heartbeat) s.add(hb.hour_start);
        setHeartbeatHours(s);
      })
      .catch((e) => console.error("概览心跳数据获取失败:", e));
    return () => { cancelled = true; };
  }, [rhythmRange]);

  // 「今日节奏」的 24 个时段。状态四态：future(未到来,仅今日) > idle(零活跃) > no_data(无数据) > 有数据。
  // 此处不能引用下面才声明的 isCurrentAnchor（TDZ），直接等价地内联其判据。
  const isTodayView = viewKind === "day" && viewAnchor === normalizeAnchor(viewKind, today);
  const currentHour = new Date().getHours();
  const hourlyDuration = useMemo(() => durationByHourFromBuckets(buckets), [buckets]);
  const hourCells = useMemo(() => {
    const HOUR_MS = 60 * 60 * 1000;
    const maxMs = Math.max(...hourlyDuration, 1);
    return Array.from({ length: 24 }, (_, h) => {
      const durationMs = hourlyDuration[h];
      const future = isTodayView && h > currentHour;
      const hasData = durationMs > 0;
      const idle = !future && !hasData && heartbeatHours.has(rhythmRange.start_ms + h * HOUR_MS);
      const state = future ? "future" : hasData ? "has_data" : idle ? "idle" : "no_data";
      return { hour: h, durationMs, level: hasData ? durationLevel(durationMs, maxMs) : 0, state };
    });
  }, [hourlyDuration, isTodayView, currentHour, heartbeatHours, rhythmRange.start_ms]);

  // 「本周/本月节奏」的逐日状态：在 dailyStats 上补状态 + 格内文字 + 深浅档位。
  // 三态 + 有数据（渲染优先级：未到来 > 零活跃 > 有数据 > 无数据）：
  //   future  未到来 = 日期在今天之后
  //   idle    零活跃 = 有桶（有前台时长）但无活跃输入（强度 0，纯挂机）
  //   no_data 无数据 = 完全没有桶（未采集）
  //   hasData 有数据 = 有桶且有活跃输入 → 品牌紫深浅编码时长
  // 判据用「桶存在性 + 强度」，不用心跳：心跳只说明 Snoop 在跑，区分不了「有桶没输入」。
  const dayCells = useMemo(() => {
    const todayMs = parseAnchor(today).getTime();
    return dailyStats.map((d) => {
      const hasBucket = d.foregroundMs > 0;   // 有采集到任何前台桶
      const active = d.intensity > 0;         // 有活跃输入
      const hasData = active;
      const idle = hasBucket && !active;
      const level = hasData ? durationLevel(d.foregroundMs, maxDayForegroundMs) : 0;
      return {
        dayMs: d.dayMs,
        foregroundMs: d.foregroundMs,
        hasData,
        idle,
        level,
        isDeep: hasData && level >= 4,
        isToday: d.dayMs === todayMs,
        future: d.dayMs > todayMs,
        label: hasData ? formatCompactDuration(d.foregroundMs) : "",
      };
    });
  }, [dailyStats, maxDayForegroundMs, today]);

  const rhythmTotalLabel = foregroundDuration > 0 ? `合计 ${fmtDuration(foregroundDuration)}` : null;

  // 节奏图例（周/月共用）：时长深浅阶 + 三态示意，逐项与格子实际渲染对齐。
  const rhythmLegend = (
    <div className="rhythm-legend">
      <span className="rhythm-legend-caption">少</span>
      {DURATION_LEVELS.map((l) => (
        <span key={l} className="rhythm-legend-swatch" style={{ background: durationColorVar(l) }} />
      ))}
      <span className="rhythm-legend-caption">多</span>
      <span className="rhythm-legend-swatch rhythm-legend-swatch--idle" />
      <span className="rhythm-legend-caption">零活跃</span>
      <span className="rhythm-legend-swatch rhythm-legend-swatch--empty" />
      <span className="rhythm-legend-caption">无数据</span>
      <span className="rhythm-legend-swatch rhythm-legend-swatch--future" />
      <span className="rhythm-legend-caption">未到来</span>
    </div>
  );

  // 分类占比：后端按范围聚合各分类活跃时长（有输入，未分类计入 other）。
  // 依赖 allBuckets，使 live 30s 轮询刷新 buckets 时占比也一并刷新。
  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryShare[]>([]);
  useEffect(() => {
    let cancelled = false;
    getCategoryBreakdown(rhythmRange.start_ms, rhythmRange.end_ms)
      .then((r) => { if (!cancelled) setCategoryBreakdown(r); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [rhythmRange.start_ms, rhythmRange.end_ms, allBuckets]);
  const totalCategoryMs = categoryBreakdown.reduce((s, x) => s + x.duration_ms, 0);
  // 零值类别不渲染：后端已过滤 duration_ms <= 0，这里再兜底，并确保排名颜色按占比降序。
  const shownCategories = useMemo(
    () =>
      categoryBreakdown
        .filter((s) => s.duration_ms > 0)
        .sort((a, b) => b.duration_ms - a.duration_ms),
    [categoryBreakdown],
  );

  const appName =
    appId === null
      ? undefined
      : buckets.find((b) => b.app_bundle_id === appId)?.app_name ?? appId;

  // 「当前筛选下」是否没有数据 —— 用来决定 KPI / 节奏区的空态说明。
  // App 排行不受筛选影响（展示全量），空态单独按 apps.length 判断。
  const isEmpty = !loading && buckets.length === 0;

  // 周期总结卡：纯展示，不可点、不弹 toast，X/Y/Z/W 复用上面已算好的数字，不重算。
  const avgForegroundHours = daysWithData > 0 ? foregroundDuration / daysWithData / (60 * 60 * 1000) : 0;
  const summaryText = useMemo(() => {
    const introParts = [anchorLabel(viewKind, viewAnchor, today)];
    if (viewKind !== "day") introParts.push(`共 ${daysWithData} 天有数据`);
    if (appId !== null) introParts.unshift(`已筛选 ${appName ?? appId}`);

    const topApp = apps[0];
    const homeSentence =
      appId === null && topApp
        ? `住得最久的是 ${topApp.name}（${formatDurationPlain(topApp.minutes * 60_000)}）。`
        : "";

    return (
      `${introParts.join("，")}，你在前台待了 ${formatDurationPlain(foregroundDuration)}，` +
      `敲下 ${formatNumber(totalKeys)} 次按键、点出 ${formatNumber(totalClicks)} 次点击，` +
      `鼠标跑了 ${formatMouseDistance(totalMouseDist).map((p) => p.text).join("")}。` +
      homeSentence +
      judgeLabel(avgForegroundHours)
    );
  }, [
    viewKind,
    viewAnchor,
    today,
    daysWithData,
    appId,
    appName,
    apps,
    foregroundDuration,
    totalKeys,
    totalClicks,
    totalMouseDist,
    avgForegroundHours,
  ]);

  const isCurrentAnchor = viewAnchor === normalizeAnchor(viewKind, today);
  const rhythmTitle = isCurrentAnchor
    ? viewKind === "day"
      ? "今日节奏"
      : viewKind === "week"
        ? "本周节奏"
        : "本月节奏"
    : `${anchorLabel(viewKind, viewAnchor, today)}节奏`;

  const categoryTitle = isCurrentAnchor
    ? viewKind === "day"
      ? "今日分类占比"
      : viewKind === "week"
        ? "本周分类占比"
        : "本月分类占比"
    : `${anchorLabel(viewKind, viewAnchor, today)}分类占比`;

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
      {/* ⓪ 留意 —— 顶部一条最弱的静默句子，命中才出现，无图标无红点 */}
      {notice && <p className="notice-card">{notice}</p>}

      {/* ① 核心数字 */}
      <section className="kpi-row">
        {kpis.map((k) => (
          <button
            key={k.label}
            type="button"
            className="kpi-card"
            data-target-label={k.targetLabel}
            title={k.title}
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

      {/* ②' 周期总结卡 —— 纯展示，不可点、不弹 toast，没有单一的下钻目标 */}
      {!isEmpty && (
        <section className="overview-summary">
          <p className="overview-summary-text">{summaryText}</p>
        </section>
      )}

      {/* ③ App 时长排行 */}
      <section className="panel">
        <h3 className="panel-title">App 排行</h3>
        <div className="app-list">
          {apps.length === 0 && (
            <div className="overview-empty-note">
              {anchorLabel(viewKind, viewAnchor, today)}还没有数据
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
                <Tooltip content={app.name}>
                  <div className="app-row-name">
                    <AppIcon bundleId={app.bundleId} appName={app.name} size={18} />
                    <span>{app.name}</span>
                  </div>
                </Tooltip>
                <div className="app-row-track">
                  <div
                    className="app-row-fill"
                    style={{
                      width: `${pct}%`,
                      background: intensityVar(app.intensity),
                    }}
                  />
                </div>
                <div className="app-row-time">{formatDurationPlain(app.minutes * 60_000)}</div>
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

      {/* ③½ 分类占比 —— 水平堆叠条 + 结论句 + chip，颜色只编码占比排名（品牌紫深浅阶） */}
      <section className="panel">
        <h3 className="panel-title cat-panel-title">
          <span>{categoryTitle}</span>
          <span className="cat-note">按活跃时长统计</span>
          {totalCategoryMs > 0 && (
            <span className="cat-total">合计 {fmtDuration(totalCategoryMs)}</span>
          )}
        </h3>
        {shownCategories.length === 0 ? (
          <div className="overview-empty-note">
            {loading ? "加载中…" : "该范围还没有分类数据"}
          </div>
        ) : (
          <>
            <div className="cat-stack">
              {shownCategories.map((s, i) => {
                const pct = totalCategoryMs > 0 ? (s.duration_ms / totalCategoryMs) * 100 : 0;
                const tip = `${CATEGORY_LABEL[s.category] ?? s.category} · ${fmtDuration(
                  s.duration_ms,
                )} · ${formatSharePct(pct)}`;
                return (
                  <Tooltip key={s.category} content={tip}>
                    <div
                      className="cat-stack-seg"
                      style={{
                        width: `${pct}%`,
                        background: shareColorVar(i),
                      }}
                    />
                  </Tooltip>
                );
              })}
            </div>
            <CategoryVerdict categories={shownCategories} totalMs={totalCategoryMs} />
          </>
        )}
      </section>

      {/* ④ 节奏 —— 日=24 格时长条 / 周=7 方格 / 月=紧凑格子带（均品牌紫深浅阶编码时长） */}
      <section className="panel">
        <h3 className="panel-title rhythm-panel-title">
          <span>{rhythmTitle}</span>
          {rhythmTotalLabel && <span className="rhythm-total">{rhythmTotalLabel}</span>}
        </h3>

        {viewKind === "day" && (
          <>
            <div className="hour-bars">
              {hourCells.map((cell) => {
                const isNow = isTodayView && cell.hour === currentHour;
                const cls =
                  "hour-bar" +
                  (cell.state === "idle" ? " hour-bar--idle" : "") +
                  (cell.state === "no_data" ? " hour-bar--no-data" : "") +
                  (cell.state === "future" ? " hour-bar--future" : "") +
                  (isNow ? " hour-bar--now" : "");
                const style = cell.state === "has_data" ? { background: durationColorVar(cell.level) } : undefined;
                const tip =
                  cell.state === "has_data"
                    ? `${formatHour(cell.hour)} · ${fmtDuration(cell.durationMs)}`
                    : cell.state === "idle"
                      ? `${formatHour(cell.hour)} · 无输入`
                      : cell.state === "future"
                        ? `${formatHour(cell.hour)} · 未到来`
                        : `${formatHour(cell.hour)} · 无数据`;
                return (
                  <Tooltip key={cell.hour} content={tip}>
                    <button type="button" className={cls} style={style} onClick={() => goToHour(cell.hour)} />
                  </Tooltip>
                );
              })}
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
          <>
            <div className="rhythm-week">
              <div className="week-grid">
                {dayCells.map((d) => {
                  const cls =
                    "week-cell" +
                    (d.isDeep ? " is-deep" : "") +
                    (d.idle ? " week-cell--idle" : d.hasData ? "" : " week-cell--no-data") +
                    (d.isToday ? " week-cell--today" : "");
                  const style = d.hasData ? { background: durationColorVar(d.level) } : undefined;
                  const tip = d.hasData
                    ? `${weekdayLabelOf(d.dayMs)} · ${fmtDuration(d.foregroundMs)}`
                    : d.idle
                      ? `${weekdayLabelOf(d.dayMs)} · 无输入`
                      : `${weekdayLabelOf(d.dayMs)} · 无数据`;
                  return (
                    <Tooltip key={d.dayMs} content={tip}>
                      <button type="button" className={cls} style={style} onClick={() => goToDay(d.dayMs)}>
                        {d.label && <span className="week-cell-num">{d.label}</span>}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
              <div className="week-labels">
                {dayCells.map((d) => (
                  <span key={d.dayMs} className="week-label">{WEEKDAY_LABELS[mondayIndex(d.dayMs)]}</span>
                ))}
              </div>
            </div>
            {rhythmLegend}
          </>
        )}

        {viewKind === "month" && (
          <>
            {/* 单行 31 格（随当月天数），1fr 平分容器宽度；格子约 22-26px，不再为了撑满而放大。
               下方每 5 天一个刻度（1/5/10/15/20/25/30），与格子共用同一份列模板保证对齐。 */}
            <div className="month-grid" style={{ gridTemplateColumns: `repeat(${dayCells.length}, 1fr)` }}>
              {dayCells.map((d) => {
                const cls =
                  "month-cell" +
                  (d.future
                    ? " month-cell--future"
                    : d.idle
                      ? " month-cell--idle"
                      : d.hasData
                        ? ""
                        : " month-cell--no-data") +
                  (d.isToday ? " month-cell--today" : "");
                const style = d.hasData ? { background: durationColorVar(d.level) } : undefined;
                const tip = d.hasData
                  ? `${dateLabelOf(d.dayMs)} · ${fmtDuration(d.foregroundMs)}`
                  : d.future
                    ? `${dateLabelOf(d.dayMs)} · 未到来`
                    : d.idle
                      ? `${dateLabelOf(d.dayMs)} · 无输入`
                      : `${dateLabelOf(d.dayMs)} · 无数据`;
                return (
                  <Tooltip key={d.dayMs} content={tip}>
                    <button type="button" className={cls} style={style} onClick={() => goToDay(d.dayMs)} />
                  </Tooltip>
                );
              })}
            </div>
            <div className="month-ticks" style={{ gridTemplateColumns: `repeat(${dayCells.length}, 1fr)` }}>
              {dayCells.map((d) => {
                const dom = new Date(d.dayMs).getDate();
                if (dom !== 1 && dom % 5 !== 0) return null;
                return (
                  <span key={d.dayMs} className="month-tick" style={{ gridColumn: dom }}>
                    {dom}
                  </span>
                );
              })}
            </div>
            {rhythmLegend}
          </>
        )}

        {isEmpty && <p className="overview-empty-note">{noDataReason(appId, appName)}</p>}
      </section>
    </PageShell>
  );
}
