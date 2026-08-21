/**
 * 报告 —— 历史日报 / 周报 / 月报时间轴。
 * 顶部筛选（全部 / 日 / 周 / 月）+ 跳到指定日期；下方三种报混排，按日期倒序，
 * 点开在卡片原位展开详情。导出成图是批次 4b，本批只让详情卡固定宽度 + 最小高度、
 * 高度可往下长，结构上支持导出。
 *
 * 三种报回答三个问题：日报讲叙事、周报讲对比（7 天条形 + 作息偏差）、月报讲趋势
 * （按周走势 + 上下半月分类变化 + weekday×小时热力网格）。
 */

import { useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import AppIcon from "../components/AppIcon";
import Tooltip from "../components/shared/Tooltip";
import { useToast } from "../components/shared/Toast";
import { CATEGORY_COLOR, CATEGORY_LABEL } from "../ai/categories";
import { formatDuration } from "../utils/format";
import { getReport, getReportList, regenerateReport } from "../report/client";
import type {
  AppRank,
  AppRef,
  CategoryDelta,
  CategoryShare,
  GoneApp,
  ReportMeta,
  ReportView,
} from "../report/types";
import { fetchHourlyActivity, fetchHourlyHeartbeats } from "../data/client";
import { aggregateDowHourGrid, type DowHourCell } from "../analytics/aggregate";
import { parseAnchor, toMs } from "../data/ranges";

type Filter = "all" | "day" | "week" | "month";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "day", label: "日" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];

const DOW_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 'YYYY-MM-DD' → 「M月D日」。 */
function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  if (!m || !d) return date;
  return `${m}月${d}日`;
}

/** '2026-08-01' → 「2026年8月」。 */
function monthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  if (!y || !m) return monthStart;
  return `${y}年${m}月`;
}

/** 周报标题：`week_start` 的「M月D日」– 6 天后的「M月D日」。禁止 new Date("YYYY-MM-DD")。 */
function weekRangeLabel(weekStart: string): string {
  const start = parseAnchor(weekStart);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return `${dateLabel(weekStart)} – ${dateLabel(
    `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(
      end.getDate(),
    ).padStart(2, "0")}`,
  )}`;
}

/** 距自然日 00:00 的分钟数 → 可读时刻。≥1440 显示「次日 HH:MM」。 */
function formatSleepMin(min: number): string {
  const day = Math.floor(min / 1440);
  const rem = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, "0");
  const mm = String(rem % 60).padStart(2, "0");
  return day > 0 ? `次日 ${hh}:${mm}` : `${hh}:${mm}`;
}

function reportKey(type: string, date: string): string {
  return `${type}:${date}`;
}

export default function Report() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<{ type: ReportMeta["report_type"]; date: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<ReportView | null>(null);
  const [jumpDate, setJumpDate] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    getReportList()
      .then((r) => {
        if (alive) setReports(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    getReport(selected.date, selected.type as import("../report/types").ReportKind)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [selected]);

  const filtered = useMemo(
    () => reports.filter((r) => filter === "all" || r.report_type === filter),
    [reports, filter],
  );

  function openReport(type: ReportMeta["report_type"], date: string) {
    setSelected({ type, date });
  }

  async function handleRegenerate() {
    if (!selected) return;
    setRegenerating(true);
    try {
      const v = await regenerateReport(
        selected.date,
        selected.type as import("../report/types").ReportKind,
      );
      setDetail(v);
      setReports(await getReportList());
      toast.show({ message: "已重新生成" });
    } catch (e) {
      console.error(e);
      toast.show({ message: "重新生成失败" });
    } finally {
      setRegenerating(false);
    }
  }

  function handleJump() {
    if (!jumpDate) return;
    // 跳转默认落在日报（日期选择器给的是一天）。
    setSelected({ type: "day", date: jumpDate });
  }

  return (
    <PageShell className="report-page" header={<ReportHeader />}>
      <div className="report-toolbar">
        <div className="report-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`report-filter${filter === f.key ? " is-active" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="report-jump">
          <input
            type="date"
            className="report-jump-input"
            value={jumpDate}
            onChange={(e) => setJumpDate(e.target.value)}
          />
          <button
            type="button"
            className="report-jump-btn"
            onClick={handleJump}
            disabled={!jumpDate}
          >
            跳到日期
          </button>
        </div>
      </div>

      <div className="report-list">
        {filtered.length === 0 && (
          <p className="report-empty">还没有报告，明天回来看看喵～</p>
        )}
        {filtered.map((r) => {
          const key = reportKey(r.report_type, r.report_date);
          if (r.status === "too_little") {
            return (
              <div key={key} className="report-skip-row">
                {rowTitle(r.report_type, r.report_date)} · 记录太少
              </div>
            );
          }
          if (selected && reportKey(selected.type, selected.date) === key) {
            return (
              <div key={key} className="report-expanded">
                <button
                  type="button"
                  className="report-collapse"
                  onClick={() => setSelected(null)}
                >
                  收起 ↑
                </button>
                <ReportDetail
                  detail={detail}
                  onRegenerate={handleRegenerate}
                  regenerating={regenerating}
                />
              </div>
            );
          }
          return (
            <button
              key={key}
              type="button"
              className="report-row"
              onClick={() => openReport(r.report_type, r.report_date)}
            >
              <span className={`report-row-kind report-row-kind--${r.report_type}`}>
                {KIND_LABEL[r.report_type]}
              </span>
              <span className="report-row-date">{rowTitle(r.report_type, r.report_date)}</span>
              <span className="report-row-total">{formatDuration(r.active_ms)}</span>
              <span className="report-row-arrow">›</span>
            </button>
          );
        })}
      </div>
    </PageShell>
  );
}

const KIND_LABEL: Record<ReportMeta["report_type"], string> = {
  day: "日",
  week: "周",
  month: "月",
};

function rowTitle(type: ReportMeta["report_type"], date: string): string {
  if (type === "week") return weekRangeLabel(date);
  if (type === "month") return monthLabel(date);
  return dateLabel(date);
}

function ReportHeader() {
  return (
    <div className="report-header">
      <h1 className="report-header-title">报告</h1>
      <p className="report-header-subtitle">日 · 周 · 月，三种尺度回看自己</p>
    </div>
  );
}

function ReportDetail({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: ReportView | null;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  if (!detail) {
    return <div className="report-card report-card--loading">加载中…</div>;
  }
  if (detail.report_type === "week") {
    return (
      <WeeklyCard
        detail={detail}
        onRegenerate={onRegenerate}
        regenerating={regenerating}
      />
    );
  }
  if (detail.report_type === "month") {
    return (
      <MonthlyCard
        detail={detail}
        onRegenerate={onRegenerate}
        regenerating={regenerating}
      />
    );
  }
  return (
    <DailyCard detail={detail} onRegenerate={onRegenerate} regenerating={regenerating} />
  );
}

/** 叙事来源小标，三种报共用。 */
function Narrative({
  text,
  source,
}: {
  text: string | null;
  source: string | null;
}) {
  if (!text) return null;
  return (
    <p className="report-card-narrative">
      {text}
      {source && (
        <span className="report-card-source">
          {source === "ai" ? "由 AI 生成" : "本地模板"}
        </span>
      )}
    </p>
  );
}

/** 中性箭头增减。正数 = 多 / 高 / 晚，一律不带红绿色彩语义。 */
function Delta({ label, pct }: { label: string; pct: number }) {
  const up = pct >= 0;
  return (
    <div className="report-compare-item">
      <span className="report-compare-label">{label}</span>
      <span className="report-compare-value">
        {up ? "↑" : "↓"} {Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  );
}

function RegenerateButton({
  onRegenerate,
  regenerating,
}: {
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  return (
    <button
      type="button"
      className="report-regen"
      onClick={onRegenerate}
      disabled={regenerating}
    >
      {regenerating ? "重新生成中…" : "重新生成"}
    </button>
  );
}

// ── 日报卡片（沿用 4a，字段不变） ──────────────────────────────────────────

function DailyCard({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: Extract<ReportView, { report_type: "day" }>;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const d = detail.data;
  const maxHourMs = Math.max(...d.hourly.map((h) => h.active_ms), 1);

  return (
    <div className="report-card">
      <div className="report-card-head">
        <div className="report-card-date">{dateLabel(d.date)}</div>
        <div className="report-card-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card-sub">
          活跃时长 {formatDuration(d.active_ms)} · 前台 {formatDuration(d.foreground_ms)}
        </div>
      </div>

      <Narrative text={detail.narrative} source={detail.narrative_source} />

      <section className="report-section">
        <h4 className="report-section-title">应用 Top 5</h4>
        <AppBars apps={d.top_apps} />
      </section>

      <CategoryStack categories={d.categories} />

      <section className="report-section">
        <h4 className="report-section-title">24 小时节奏</h4>
        <div className="report-rhythm">
          {d.hourly.map((h) => (
            <Tooltip key={h.hour} content={`${h.hour}:00 · ${formatDuration(h.active_ms)}`}>
              <div className="report-rhythm-col">
                <div
                  className="report-rhythm-bar"
                  style={{
                    height: `${Math.max((h.active_ms / maxHourMs) * 100, h.active_ms > 0 ? 4 : 0)}%`,
                  }}
                />
              </div>
            </Tooltip>
          ))}
        </div>
        <div className="report-rhythm-scale">
          <span>0</span>
          <span>6</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      </section>

      <section className="report-section">
        <h4 className="report-section-title">近 7 天对比</h4>
        {d.vs_7d.avg_active_ms > 0 ? (
          <div className="report-compare">
            <Delta label="活跃时长" pct={d.vs_7d.active_delta_pct} />
            <Delta label="切换次数" pct={d.vs_7d.switch_delta_pct} />
          </div>
        ) : (
          <p className="report-empty-inline">还没有足够的历史数据对比</p>
        )}
      </section>

      <RegenerateButton onRegenerate={onRegenerate} regenerating={regenerating} />
    </div>
  );
}

// ── 周报卡片 ───────────────────────────────────────────────────────────────

function WeeklyCard({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: Extract<ReportView, { report_type: "week" }>;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const d = detail.data;
  const maxDayMs = Math.max(...d.days.map((x) => x.active_ms), 1);

  return (
    <div className="report-card report-card--weekly">
      <div className="report-card-head">
        <div className="report-card-date">{weekRangeLabel(d.week_start)}</div>
        <div className="report-card-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card-sub">
          活跃时长 {formatDuration(d.active_ms)} · 前台 {formatDuration(d.foreground_ms)} · 日均{" "}
          {formatDuration(d.avg_daily_active_ms)}
        </div>
        {d.baseline.avg_daily_active_ms > 0 && (
          <div className="report-compare">
            <Delta label="vs 前 4 周日均" pct={d.baseline.daily_delta_pct} />
          </div>
        )}
      </div>

      <Narrative text={detail.narrative} source={detail.narrative_source} />

      {/* 7 天条形是周报的主视觉 */}
      <section className="report-section">
        <h4 className="report-section-title">这一周</h4>
        <div className="report-week-bars">
          {d.days.map((day) => (
            <Tooltip
              key={day.date}
              content={`${DOW_LABELS[day.dow]} ${dateLabel(day.date)} · ${formatDuration(
                day.active_ms,
              )}`}
            >
              <div className="report-week-bar-col">
                <div className="report-week-bar-track">
                  <div
                    className={`report-week-bar${
                      d.max_day === day.date ? " report-week-bar--max" : ""
                    }${d.min_day === day.date ? " report-week-bar--min" : ""}`}
                    style={{ height: `${Math.max((day.active_ms / maxDayMs) * 100, 2)}%` }}
                  />
                </div>
                <span className="report-week-bar-day">{DOW_LABELS[day.dow]}</span>
              </div>
            </Tooltip>
          ))}
        </div>
        {d.max_day && d.min_day && (
          <p className="report-week-legend">
            最高 {dateLabel(d.max_day)} · 最低 {dateLabel(d.min_day)}
          </p>
        )}
      </section>

      {/* 作息块：周报独有的价值，要显眼 */}
      <SleepBlock days={d.rhythm} summary={d.rhythm_summary} />

      {/* 分类占比 + 与前 4 周偏差 */}
      <CategoryDeltaBars categories={d.categories} />

      {/* 应用 */}
      <section className="report-section">
        <h4 className="report-section-title">应用 Top 5</h4>
        <AppBars apps={d.top_apps} />
        <AppChangeRow label="本周新出现" apps={d.new_apps} />
        <GoneRow apps={d.gone_apps} />
      </section>

      {/* 工作日 vs 周末 */}
      <section className="report-section">
        <h4 className="report-section-title">工作日 vs 周末</h4>
        <div className="report-weekend">
          <span>工作日日均 {formatDuration(d.weekday_weekend.weekday_avg_active_ms)}</span>
          <span>周末日均 {formatDuration(d.weekday_weekend.weekend_avg_active_ms)}</span>
        </div>
      </section>

      <RegenerateButton onRegenerate={onRegenerate} regenerating={regenerating} />
    </div>
  );
}

function SleepBlock({
  days,
  summary,
}: {
  days: import("../report/types").RhythmDay[];
  summary: import("../report/types").RhythmSummary;
}) {
  if (summary.days_counted < 3) return null;

  return (
    <section className="report-section">
      <h4 className="report-section-title">作息</h4>
      <div className="report-sleep">
        {days.map((d, i) => {
          const start =
            d.start_min != null
              ? formatSleepMin(d.start_min)
              : d.overnight
                ? "（承前）"
                : "—";
          const end =
            d.overnight && d.overnight_end_min != null
              ? `通宵（至 ${formatSleepMin(d.overnight_end_min)}）`
              : d.end_min != null
                ? formatSleepMin(d.end_min)
                : "—";
          return (
            <div
              key={d.date}
              className={`report-sleep-row${
                d.overnight && d.start_min == null ? " report-sleep-row--carried" : ""
              }`}
              title={d.overnight ? `${DOW_LABELS[i]}与相邻日合并为一段，未计入均值` : undefined}
            >
              <span className="report-sleep-day">{DOW_LABELS[i]}</span>
              <span className="report-sleep-times">
                {start} → {end}
              </span>
              {!d.counted && d.active_ms > 0 && (
                <span className="report-sleep-note">未计入均值</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="report-sleep-avg">
        平均 {formatSleepMin(summary.avg_start_min ?? 0)} 开工、
        {formatSleepMin(summary.avg_end_min ?? 0)} 停下（基于 {summary.days_counted} 天）
        {summary.end_delta_min != null && (
          <>
            {" "}
            · 比平时
            {summary.end_delta_min >= 0
              ? `晚 ${summary.end_delta_min} 分`
              : `早 ${-summary.end_delta_min} 分`}
            {summary.baseline_days_counted < 7
              ? `（平时 = 前 4 周的 ${summary.baseline_days_counted} 天）`
              : ""}
          </>
        )}
      </p>
      {summary.overnight_days > 0 && (
        <p className="report-sleep-avg">另有 {summary.overnight_days} 天通宵，未计入均值</p>
      )}
    </section>
  );
}

function CategoryDeltaBars({ categories }: { categories: CategoryDelta[] }) {
  if (categories.length === 0) {
    return (
      <section className="report-section">
        <h4 className="report-section-title">分类占比</h4>
        <p className="report-empty-inline">无数据</p>
      </section>
    );
  }
  return (
    <section className="report-section">
      <h4 className="report-section-title">分类占比（vs 前 4 周）</h4>
      <div className="report-cat-legend">
        {categories.map((c) => (
          <div key={c.category} className="report-cat-row">
            <span
              className="report-cat-swatch"
              style={{ background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
            />
            <span className="report-cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
            <span className="report-cat-time">{formatDuration(c.active_ms)}</span>
            <span className="report-cat-pct">{c.share_pct.toFixed(0)}%</span>
            <span className="report-cat-delta">
              {c.share_delta_pp >= 0 ? "↑" : "↓"}
              {Math.abs(c.share_delta_pp).toFixed(1)}pp
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AppChangeRow({ label, apps }: { label: string; apps: AppRef[] }) {
  if (apps.length === 0) return null;
  return (
    <div className="report-app-change">
      <span className="report-app-change-label">{label}</span>
      <span className="report-app-change-names">{apps.map((a) => a.name).join(" · ")}</span>
    </div>
  );
}

function GoneRow({ apps }: { apps: GoneApp[] }) {
  if (apps.length === 0) return null;
  return (
    <div className="report-app-change">
      <span className="report-app-change-label">本周消失</span>
      <span className="report-app-change-names">
        {apps.map((a) => (
          <Tooltip key={a.bundle_id} content={`前 4 周共 ${formatDuration(a.baseline_active_ms)}`}>
            <span className="report-gone-name">{a.name}</span>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

// ── 月报卡片 ───────────────────────────────────────────────────────────────

function MonthlyCard({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: Extract<ReportView, { report_type: "month" }>;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const d = detail.data;
  const maxWeekMs = Math.max(...d.weeks.map((w) => w.active_ms), 1);

  return (
    <div className="report-card report-card--monthly">
      <div className="report-card-head">
        <div className="report-card-date">{monthLabel(d.month_start)}</div>
        <div className="report-card-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card-sub">
          活跃时长 {formatDuration(d.active_ms)} · 前台 {formatDuration(d.foreground_ms)} · 日均{" "}
          {formatDuration(d.avg_daily_active_ms)} · 有记录 {d.days_with_data} 天
        </div>
        {d.prev_month.avg_daily_active_ms > 0 && (
          <div className="report-compare">
            <Delta label="vs 上月日均" pct={d.prev_month.daily_delta_pct} />
          </div>
        )}
      </div>

      <Narrative text={detail.narrative} source={detail.narrative_source} />

      {/* 按周趋势是月报的主视觉 */}
      <section className="report-section">
        <h4 className="report-section-title">按周走势</h4>
        <div className="report-month-weeks">
          {d.weeks.map((w) => (
            <Tooltip
              key={w.week_start}
              content={`${dateLabel(w.clip_from)}–${dateLabel(w.clip_to)} · ${formatDuration(
                w.active_ms,
              )}${w.partial ? ` · 覆盖 ${w.days_in_month} 天` : ""}`}
            >
              <div className="report-month-week-col">
                <div className="report-month-week-track">
                  <div
                    className={`report-month-week-bar${w.partial ? " report-month-week-bar--partial" : ""}`}
                    style={{ height: `${Math.max((w.active_ms / maxWeekMs) * 100, 2)}%` }}
                  />
                </div>
                {w.partial ? (
                  <span className="report-month-week-label">{w.days_in_month}天</span>
                ) : (
                  <span className="report-month-week-label"> </span>
                )}
              </div>
            </Tooltip>
          ))}
        </div>
      </section>

      {/* 上下半月分类变化 */}
      {d.half_shift.length > 0 && (
        <section className="report-section">
          <h4 className="report-section-title">上半月 vs 下半月</h4>
          <div className="report-halfshift">
            {d.half_shift.slice(0, 5).map((h) => (
              <div key={h.category} className="report-halfshift-row">
                <span className="report-halfshift-name">
                  {CATEGORY_LABEL[h.category] ?? h.category}
                </span>
                <span className="report-halfshift-values">
                  {h.first_half_share_pct.toFixed(0)}% → {h.second_half_share_pct.toFixed(0)}%
                </span>
                <span className="report-halfshift-delta">
                  {h.delta_pp >= 0 ? "↑" : "↓"}
                  {Math.abs(h.delta_pp).toFixed(1)}pp
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 最活跃 / 最安静的一天：只给日期和数字 */}
      {d.max_day && d.min_day && (
        <section className="report-section">
          <h4 className="report-section-title">峰值日</h4>
          <div className="report-weekend">
            <span>最活跃 {dateLabel(d.max_day.date)} · {formatDuration(d.max_day.active_ms)}</span>
            <span>最安静 {dateLabel(d.min_day.date)} · {formatDuration(d.min_day.active_ms)}</span>
          </div>
        </section>
      )}

      {/* weekday × 小时热力网格：复用规律页的聚合函数，渲染用报告自己的配色 */}
      <MonthHeatGrid monthStart={d.month_start} />

      <CategoryStack categories={d.categories} />

      <section className="report-section">
        <h4 className="report-section-title">应用 Top 10</h4>
        <AppBars apps={d.top_apps} />
        <AppChangeRow label="整月新增" apps={d.new_apps} />
      </section>

      <RegenerateButton onRegenerate={onRegenerate} regenerating={regenerating} />
    </div>
  );
}

/**
 * 月报的热力网格。取数与规律页一致（`get_hourly_activity` + `get_hourly_heartbeats`），
 * 复用 `aggregateDowHourGrid`。注意：这张网格用的是规律页的 intensity 口径
 * （含 `mouse_move_dist`），与报告主体的「活跃时长（有输入）」口径不同 ——
 * 这是复用优先于口径纯粹的有意取舍；配色也不用 `intensityVar()`（时间线暖色轴），
 * 改用 accent 单色按档位映射透明度。
 */
function MonthHeatGrid({ monthStart }: { monthStart: string }) {
  const range = useMemo(() => toMs("month", monthStart), [monthStart]);
  const [grid, setGrid] = useState<DowHourCell[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHourlyActivity(range), fetchHourlyHeartbeats(range)])
      .then(([hourly, heartbeatList]) => {
        if (cancelled) return;
        const heartbeatMap = new Map<number, boolean>();
        for (const hb of heartbeatList) {
          heartbeatMap.set(hb.hour_start, hb.has_heartbeat);
        }
        setGrid(aggregateDowHourGrid(hourly, heartbeatMap, range.start_ms, range.end_ms));
      })
      .catch((e) => console.error("月报作息网格获取失败:", e));
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <section className="report-section">
      <h4 className="report-section-title">作息网格（周一 → 周日）</h4>
      {!grid ? (
        <p className="report-empty-inline">加载中…</p>
      ) : (
        <div className="report-grid-wrap">
          <div className="report-grid">
            {grid.map((row, ri) =>
              row.map((cell, ci) => (
                <Tooltip
                  key={`${ri}-${ci}`}
                  content={`${DOW_LABELS[ri]} ${ci}:00 · ${
                    cell.state === "active"
                      ? `强度 ${cell.intensity}`
                      : cell.state === "idle"
                        ? "挂机（无输入）"
                        : "未采集"
                  }`}
                >
                  <div
                    className={`report-grid-cell report-grid-cell--${cell.state}`}
                    style={
                      cell.state === "active"
                        ? { opacity: 0.15 + cell.intensity * 0.2125 }
                        : undefined
                    }
                  />
                </Tooltip>
              )),
            )}
          </div>
        </div>
      )}
      <p className="report-grid-note">网格口径与规律页一致，含纯鼠标位移；主体时长仍按有输入口径。</p>
    </section>
  );
}

// ── 共享小组件 ─────────────────────────────────────────────────────────────

function AppBars({ apps }: { apps: AppRank[] }) {
  if (apps.length === 0) return <p className="report-empty-inline">无数据</p>;
  const maxAppMs = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="report-apps">
      {apps.map((a) => (
        <div key={a.bundle_id} className="report-app-row">
          <div className="report-app-name">
            <AppIcon bundleId={a.bundle_id} appName={a.name} size={16} />
            <span>{a.name}</span>
          </div>
          <div className="report-app-track">
            <div
              className="report-app-fill"
              style={{ width: `${(a.active_ms / maxAppMs) * 100}%` }}
            />
          </div>
          <div className="report-app-time">{formatDuration(a.active_ms)}</div>
          <div className="report-app-pct">{a.share_pct.toFixed(0)}%</div>
        </div>
      ))}
    </div>
  );
}

function CategoryStack({ categories }: { categories: CategoryShare[] }) {
  if (categories.length === 0) {
    return (
      <section className="report-section">
        <h4 className="report-section-title">分类占比</h4>
        <p className="report-empty-inline">无数据</p>
      </section>
    );
  }
  return (
    <section className="report-section">
      <h4 className="report-section-title">分类占比</h4>
      <div className="report-cat-stack">
        {categories.map((c) => (
          <div
            key={c.category}
            className="report-cat-seg"
            style={{
              width: `${c.share_pct}%`,
              background: CATEGORY_COLOR[c.category] ?? "#94a3b8",
            }}
            title={`${CATEGORY_LABEL[c.category] ?? c.category} · ${c.share_pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="report-cat-legend">
        {categories.map((c) => (
          <div key={c.category} className="report-cat-row">
            <span
              className="report-cat-swatch"
              style={{ background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
            />
            <span className="report-cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
            <span className="report-cat-time">{formatDuration(c.active_ms)}</span>
            <span className="report-cat-pct">{c.share_pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </section>
  );
}
