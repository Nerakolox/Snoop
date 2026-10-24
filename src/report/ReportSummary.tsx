/**
 * 报告摘要 —— 展开报告时的紧凑摘要（双栏：左摘要 + 右 190px 海报缩略图）。
 *
 * 新增：分类色条 + 图例（含周报 pp 差）、应用时长、带刻度迷你形状条、
 * 日报专项（活跃区间/最活跃时段/最长专注）、周报专项（作息均值/工作日vs周末）、
 * 月报专项（上半月 vs 下半月）。完整海报仍只在灯箱与导出时出现。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import type {
  AppSnap,
  CategorySnap,
  DailyReport,
  WeeklyReport,
  ReportSnapshot,
  ReportView,
} from "./types";
import { formatDuration } from "../utils/format";
import {
  BASELINE_MIN_DAILY_MS,
  dateLabel,
  deltaLabel,
  formatSleepMin,
  monthLabel,
  weekRangeLabel,
} from "./format";
import { renderQuips } from "./markup";
import type { ResolvedIconMap } from "./icons";
import ReportCard from "./ReportCard";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import "./report-summary.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";
const THUMB_SCALE = 0.19;

const KIND_CN: Record<ReportView["report_type"], string> = {
  day: "日报", week: "周报", month: "月报",
};

/** 日报 24h 刻度：只在 0/6/12/18/23 位打标签。 */
const DAY_TICKS = Array.from({ length: 24 }, (_, i) =>
  i === 0 ? "0" : i === 6 ? "6" : i === 12 ? "12" : i === 18 ? "18" : i === 23 ? "24" : "",
);
const WEEK_TICKS = ["一", "二", "三", "四", "五", "六", "日"];

function dateText(detail: ReportView): string {
  if (detail.report_type === "day") return dateLabel(detail.data.date);
  if (detail.report_type === "week") return weekRangeLabel(detail.data.week_start);
  return monthLabel(detail.data.month_start);
}

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`;
}

function SummaryIcon({
  bundleId, name, icons, size = 20,
}: {
  bundleId: string; name: string; icons: ResolvedIconMap | null; size?: number;
}) {
  if (bundleId === SNOOP_BUNDLE_ID) {
    return <img className="rs-app-icon" src={snoopIconInline} alt="" style={{ width: size, height: size }} />;
  }
  const data = icons?.get(bundleId);
  if (data) {
    return <img className="rs-app-icon" src={`data:image/png;base64,${data}`} alt="" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="rs-app-icon rs-app-icon--fallback"
      style={{ width: size, height: size, backgroundColor: colorFromName(name), fontSize: size * 0.55 }}
    >
      {(name.charAt(0) || "?").toUpperCase()}
    </span>
  );
}

/** 分类色条 + 图例（可选 pp 差，用于周报）。 */
function SummaryCategories({
  categories,
  deltaById,
  showDelta,
}: {
  categories: CategorySnap[];
  deltaById?: Map<string, number>;
  showDelta?: boolean;
}) {
  const shown = categories.filter((c) => c.active_ms > 0);
  if (shown.length === 0) return <p className="rs-empty">无数据</p>;
  return (
    <div className="rs-cats">
      <div className="rs-cats-bar">
        {shown.map((c) => (
          <div
            key={c.id}
            className="rs-cats-seg"
            style={{ width: `${c.share_pct}%`, background: c.color }}
            title={`${c.name} ${c.share_pct.toFixed(0)}%`}
          />
        ))}
      </div>
      <div className="rs-cats-legend">
        {shown.map((c) => {
          const delta = deltaById?.get(c.id);
          return (
            <div key={c.id} className="rs-cats-row">
              <span className="rs-cats-swatch" style={{ background: c.color }} />
              <span className="rs-cats-name">{c.name}</span>
              <span className="rs-cats-pct">{c.share_pct.toFixed(0)}%</span>
              {showDelta && delta != null && (
                <span className={`rs-cats-delta ${delta >= 0 ? "rs-cats-delta--up" : "rs-cats-delta--dn"}`}>
                  {delta >= 0 ? "↑" : "↓"}{Math.abs(delta).toFixed(1)}pp
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 应用列表：图标 + 名称 + 时长 + 百分比。 */
function SummaryApps({
  apps, icons,
}: {
  apps: AppSnap[]; icons: ResolvedIconMap | null;
}) {
  if (apps.length === 0) return <p className="rs-empty">无数据</p>;
  const max = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="rs-apps">
      {apps.slice(0, 5).map((a) => (
        <div key={a.bundle_id} className="rs-app">
          <SummaryIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
          <span className="rs-app-name">{a.name}</span>
          <div className="rs-app-track">
            <div className="rs-app-fill" style={{ width: `${(a.active_ms / max) * 100}%` }} />
          </div>
          <span className="rs-app-dur">{formatDuration(a.active_ms)}</span>
          <span className="rs-app-pct">{Math.round(a.share_pct)}%</span>
        </div>
      ))}
    </div>
  );
}

/** 带刻度的迷你条形。ticks 与 cells 等长，非空字符串打刻度标签。 */
function MiniBars({
  cells, ticks,
}: {
  cells: { active_ms: number }[]; ticks?: string[];
}) {
  const max = Math.max(...cells.map((c) => c.active_ms), 1);
  return (
    <div className="rs-bars-wrap">
      <div className="rs-bars">
        {cells.map((c, i) => (
          <div key={i} className="rs-bars-col">
            <div
              className="rs-bars-fill"
              style={{ height: `${Math.max((c.active_ms / max) * 100, c.active_ms > 0 ? 6 : 0)}%` }}
            />
          </div>
        ))}
      </div>
      {ticks && (
        <div className="rs-bars-ticks">
          {ticks.map((t, i) => (
            <div key={i} className="rs-bars-tick">{t}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Narrative({ detail }: { detail: ReportView }) {
  if (!detail.narrative) return null;
  return <div className="rs-narrative">{renderQuips(detail.narrative, "summary")}</div>;
}

/** 日报专项：活跃区间 / 最活跃小时 / 最长专注。 */
function DayExtras({ d }: { d: DailyReport }) {
  const spanMs = d.span_end_ms - d.span_start_ms;
  const spanStr = spanMs > 0 ? formatDuration(spanMs) : null;
  const focusMin = Math.round(d.longest_focus.duration_ms / 60000);
  return (
    <div className="rs-extras">
      {spanStr && (
        <div className="rs-extra">
          <span className="rs-extra-label">活跃区间</span>
          <span className="rs-extra-val">{spanStr}</span>
        </div>
      )}
      <div className="rs-extra">
        <span className="rs-extra-label">最活跃时段</span>
        <span className="rs-extra-val">{d.peak_hour}:00 – {d.peak_hour + 1}:00</span>
      </div>
      {focusMin > 0 && (
        <div className="rs-extra">
          <span className="rs-extra-label">最长专注</span>
          <span className="rs-extra-val">{focusMin} 分钟</span>
        </div>
      )}
    </div>
  );
}

/** 周报专项：作息均值 + 工作日 vs 周末。 */
function WeekExtras({ d }: { d: WeeklyReport }) {
  const s = d.rhythm_summary;
  const ww = d.weekday_weekend;
  return (
    <div className="rs-extras">
      {s.days_counted >= 2 && s.avg_start_min != null && s.avg_end_min != null && (
        <div className="rs-extra">
          <span className="rs-extra-label">平均作息</span>
          <span className="rs-extra-val">
            {formatSleepMin(s.avg_start_min)} 开工 · {formatSleepMin(s.avg_end_min)} 停下
          </span>
        </div>
      )}
      {(ww.weekday_days > 0 || ww.weekend_days > 0) && (
        <div className="rs-extra">
          <span className="rs-extra-label">工作日/周末</span>
          <span className="rs-extra-val">
            {ww.weekday_days > 0 ? `工作日 ${formatDuration(ww.weekday_avg_active_ms)}` : "工作日无记录"}
            {" · "}
            {ww.weekend_days > 0 ? `周末 ${formatDuration(ww.weekend_avg_active_ms)}` : "周末无记录"}
          </span>
        </div>
      )}
    </div>
  );
}

/** 月报专项：上半月 vs 下半月（取前 4 条）。 */
function MonthHalfShift({
  shifts, snapshot,
}: {
  shifts: import("./types").CategoryHalfShift[];
  snapshot: ReportSnapshot;
}) {
  if (shifts.length === 0) return null;
  const nameById = new Map(snapshot.categories.map((c) => [c.id, c.name]));
  const colorById = new Map(snapshot.categories.map((c) => [c.id, c.color]));
  return (
    <div className="rs-halfshift">
      {shifts.slice(0, 4).map((h) => (
        <div key={h.category} className="rs-halfshift-row">
          <span
            className="rs-halfshift-swatch"
            style={{ background: colorById.get(h.category) ?? "#999" }}
          />
          <span className="rs-halfshift-name">{nameById.get(h.category) ?? h.category}</span>
          <span className="rs-halfshift-vals">
            {h.first_half_share_pct.toFixed(0)}% → {h.second_half_share_pct.toFixed(0)}%
          </span>
          <span className={`rs-halfshift-delta ${h.delta_pp >= 0 ? "rs-cats-delta--up" : "rs-cats-delta--dn"}`}>
            {h.delta_pp >= 0 ? "↑" : "↓"}{Math.abs(h.delta_pp).toFixed(1)}pp
          </span>
        </div>
      ))}
    </div>
  );
}

/** 三报各自的主体内容区。 */
function DayMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "day" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  return (
    <>
      <div className="rs-hero">
        <div className="rs-hero-label">活跃时长</div>
        <div className="rs-hero-num">{formatDuration(d.active_ms)}</div>
        <div className="rs-hero-sub">
          前台 {formatDuration(d.foreground_ms)} · 切换 {d.switch_count} 次
          {d.vs_7d.avg_active_ms >= BASELINE_MIN_DAILY_MS && (
            <> · 近 7 天 {deltaLabel(d.vs_7d.active_delta_pct)}</>
          )}
        </div>
      </div>
      <DayExtras d={d} />
      <Narrative detail={detail} />
      <div className="rs-section">
        <div className="rs-section-title">分类</div>
        <SummaryCategories categories={detail.snapshot.categories} />
      </div>
      <div className="rs-cols2">
        <div className="rs-section">
          <div className="rs-section-title">应用 Top 5</div>
          <SummaryApps apps={detail.snapshot.apps} icons={icons} />
        </div>
        <div className="rs-section">
          <div className="rs-section-title">24 小时节奏</div>
          <MiniBars cells={d.hourly} ticks={DAY_TICKS} />
        </div>
      </div>
    </>
  );
}

function WeekMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "week" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  const deltaById = new Map(d.categories.map((c) => [c.category, c.share_delta_pp]));
  return (
    <>
      <div className="rs-hero">
        <div className="rs-hero-label">活跃时长</div>
        <div className="rs-hero-num">{formatDuration(d.active_ms)}</div>
        <div className="rs-hero-sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 前台 {formatDuration(d.foreground_ms)}
          {d.baseline.baseline_sufficient && (
            <> · vs 前 4 周 {deltaLabel(d.baseline.daily_delta_pct)}</>
          )}
        </div>
      </div>
      <WeekExtras d={d} />
      <Narrative detail={detail} />
      <div className="rs-section">
        <div className="rs-section-title">分类{d.baseline.baseline_sufficient ? <span className="rs-section-note">含 vs 前 4 周 pp 差</span> : null}</div>
        <SummaryCategories
          categories={detail.snapshot.categories}
          deltaById={deltaById}
          showDelta={d.baseline.baseline_sufficient}
        />
      </div>
      <div className="rs-cols2">
        <div className="rs-section">
          <div className="rs-section-title">应用 Top 5</div>
          <SummaryApps apps={detail.snapshot.apps} icons={icons} />
        </div>
        <div className="rs-section">
          <div className="rs-section-title">这一周</div>
          <MiniBars cells={d.days} ticks={WEEK_TICKS} />
        </div>
      </div>
    </>
  );
}

function MonthMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "month" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  return (
    <>
      <div className="rs-hero">
        <div className="rs-hero-label">活跃时长</div>
        <div className="rs-hero-num">{formatDuration(d.active_ms)}</div>
        <div className="rs-hero-sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 有记录 {d.days_with_data} 天
          {d.prev_month.avg_daily_active_ms > 0 && (
            <> · vs 上月 {deltaLabel(d.prev_month.daily_delta_pct)}</>
          )}
        </div>
      </div>
      <Narrative detail={detail} />
      <div className="rs-section">
        <div className="rs-section-title">分类</div>
        <SummaryCategories categories={detail.snapshot.categories} />
      </div>
      <div className="rs-cols2">
        <div className="rs-section">
          <div className="rs-section-title">应用 Top 5</div>
          <SummaryApps apps={detail.snapshot.apps} icons={icons} />
        </div>
        <div className="rs-section">
          <div className="rs-section-title">按周走势</div>
          <MiniBars cells={d.weeks} />
        </div>
      </div>
      {d.half_shift.length > 0 && (
        <div className="rs-section">
          <div className="rs-section-title">上半月 vs 下半月</div>
          <MonthHalfShift shifts={d.half_shift} snapshot={detail.snapshot} />
        </div>
      )}
    </>
  );
}

export default function ReportSummary({
  detail, icons, onRegenerate, regenerating, onExport, onOpenLightbox, onCollapse,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onExport: () => void;
  onOpenLightbox: () => void;
  onCollapse: () => void;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);

  return (
    <div className="report-summary">
      <button type="button" className="rs-header" onClick={onCollapse} title="收起">
        <span className="rs-headline">
          <span className="rs-date">{dateText(detail)}</span>
          <span className="rs-kind">{KIND_CN[detail.report_type]}</span>
        </span>
        <span className="rs-collapse">收起 ↑</span>
      </button>

      <div className="rs-grid">
        <div className="rs-main">
          {detail.report_type === "week" ? (
            <WeekMain detail={detail} icons={icons} />
          ) : detail.report_type === "month" ? (
            <MonthMain detail={detail} icons={icons} />
          ) : (
            <DayMain detail={detail} icons={icons} />
          )}
        </div>

        <aside className="rs-side">
          <div
            className="rs-thumb"
            role="button"
            tabIndex={0}
            onClick={onOpenLightbox}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenLightbox();
              }
            }}
            aria-label="打开海报"
          >
            <div
              className="rs-thumb-scaled"
              style={{ transform: `translateX(-50%) scale(${THUMB_SCALE})` }}
            >
              <ReportCard detail={detail} icons={icons} showFooter />
            </div>
            <span className="rs-thumb-fade" aria-hidden />
          </div>

          <div className="rs-actions">
            {detail.status === "ok" && (
              <button type="button" className="rs-export" onClick={onExport}>
                导出成图
              </button>
            )}
            <button
              type="button"
              className="rs-regen"
              onClick={() => setConfirmRegen(true)}
              disabled={regenerating}
              title="用当前的分类设置重算这份报告"
            >
              {regenerating ? "重新生成中…" : "按当前分类重新生成"}
            </button>
          </div>
        </aside>
      </div>

      {confirmRegen &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setConfirmRegen(false)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <h3>按当前分类重新生成</h3>
              </div>
              <p className="dev-confirm-desc">
                这份报告现在显示的是<b>生成那一刻</b>的分类名称与配色。重新生成会用
                <b>当前</b>的分类设置重算，并覆盖原有的分类结果与这段吐槽文案。
                <br />
                覆盖后不可撤销。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setConfirmRegen(false)}>
                  取消
                </button>
                <button
                  className="setting-btn setting-btn-primary"
                  onClick={() => {
                    setConfirmRegen(false);
                    onRegenerate();
                  }}
                >
                  重新生成
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
