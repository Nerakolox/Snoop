/**
 * 报告摘要 —— 周报 / 月报展开视图，沿用日报的 Editorial Report 布局。
 * 日报由 DaySummary 独立渲染。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type {
  AppSnap,
  CategorySnap,
  CategoryHalfShift,
  MonthlyReport,
  ReportSnapshot,
  ReportView,
  WeeklyReport,
} from "./types";
import { formatDuration } from "../utils/format";
import {
  deltaLabel,
  formatSleepMin,
  monthLabel,
  weekRangeLabel,
} from "./format";
import { renderQuips } from "./markup";
import type { ResolvedIconMap } from "./icons";
import DaySummary from "./DaySummary";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import "./report-summary.css";
import "./day-summary.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";
const WEEK_TICKS = ["一", "二", "三", "四", "五", "六", "日"];

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
  categories, deltaById, showDelta,
}: {
  categories: CategorySnap[];
  deltaById?: Map<string, number>;
  showDelta?: boolean;
}) {
  const shown = categories.filter((c) => c.active_ms > 0);
  if (shown.length === 0) return <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-3)" }}>无数据</p>;
  return (
    <div className="rs-cats">
      <div className="rs-cats-bar">
        {shown.map((c) => (
          <div key={c.id} className="rs-cats-seg"
            style={{ width: `${c.share_pct}%`, background: c.color }}
            title={`${c.name} ${c.share_pct.toFixed(0)}%`} />
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

function SummaryApps({ apps, icons }: { apps: AppSnap[]; icons: ResolvedIconMap | null }) {
  if (apps.length === 0) return <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-3)" }}>无数据</p>;
  const max = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="ds-apps">
      {apps.slice(0, 5).map((a) => (
        <div key={a.bundle_id} className="ds-app">
          <SummaryIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
          <span className="ds-app-name">{a.name}</span>
          <div className="ds-app-track">
            <div className="ds-app-fill" style={{ width: `${(a.active_ms / max) * 100}%` }} />
          </div>
          <span className="ds-app-dur">{formatDuration(a.active_ms)}</span>
          <span className="ds-app-pct">{Math.round(a.share_pct)}%</span>
        </div>
      ))}
    </div>
  );
}

function MiniBars({ cells, ticks }: { cells: { active_ms: number }[]; ticks?: string[] }) {
  const max = Math.max(...cells.map((c) => c.active_ms), 1);
  return (
    <div className="rs-bars-wrap">
      <div className="rs-bars">
        {cells.map((c, i) => (
          <div key={i} className="rs-bars-col">
            <div className="rs-bars-fill"
              style={{ height: `${Math.max((c.active_ms / max) * 100, c.active_ms > 0 ? 6 : 0)}%` }} />
          </div>
        ))}
      </div>
      {ticks && (
        <div className="rs-bars-ticks">
          {ticks.map((t, i) => <div key={i} className="rs-bars-tick">{t}</div>)}
        </div>
      )}
    </div>
  );
}

function HalfShift({ shifts, snapshot }: { shifts: CategoryHalfShift[]; snapshot: ReportSnapshot }) {
  if (shifts.length === 0) return null;
  const nameById = new Map(snapshot.categories.map((c) => [c.id, c.name]));
  const colorById = new Map(snapshot.categories.map((c) => [c.id, c.color]));
  return (
    <div className="rs-halfshift">
      {shifts.slice(0, 4).map((h) => (
        <div key={h.category} className="rs-halfshift-row">
          <span className="rs-halfshift-swatch" style={{ background: colorById.get(h.category) ?? "#999" }} />
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

function Narrative({ narrative }: { narrative: string | null }) {
  if (!narrative) return null;
  const lines = narrative.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const gridClass = `ds-obs-grid${lines.length === 1 ? " ds-obs-grid--single" : ""}`;
  return (
    <div className={gridClass}>
      {lines.map((line, i) => (
        <div key={i} className="ds-obs-item">{renderQuips(line, "summary")}</div>
      ))}
    </div>
  );
}

/* ── 周报标题 ─────────────────────────────────────────────────────────────── */
function WeekHeadline({ d }: { d: WeeklyReport }) {
  const avgMin = Math.round(d.avg_daily_active_ms / 60000);
  const hasDelta = d.baseline.baseline_sufficient;
  const delta = d.baseline.daily_delta_pct;
  if (d.days_with_data <= 2) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本周记录天数<span className="ds-headline-accent">较少</span>，</span>
      <span className="ds-headline-line">数据仅供参考。</span>
    </div>
  );
  if (hasDelta && delta >= 20) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本周活跃时长</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">明显高于</span>近期均值。</span>
    </div>
  );
  if (hasDelta && delta <= -20) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本周活跃时长</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">低于</span>近期均值。</span>
    </div>
  );
  if (avgMin >= 480) return (
    <div className="ds-headline">
      <span className="ds-headline-line">这周的日均活跃</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">相当充实</span>。</span>
    </div>
  );
  return (
    <div className="ds-headline">
      <span className="ds-headline-line">本周活动概览</span>
    </div>
  );
}

/* ── 月报标题 ─────────────────────────────────────────────────────────────── */
function MonthHeadline({ d }: { d: MonthlyReport }) {
  const hasDelta = d.prev_month.avg_daily_active_ms > 0;
  const delta = d.prev_month.daily_delta_pct;
  if (d.days_with_data <= 5) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本月记录天数<span className="ds-headline-accent">有限</span>，</span>
      <span className="ds-headline-line">数据仅供参考。</span>
    </div>
  );
  if (hasDelta && delta >= 15) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本月活跃时长</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">高于</span>上月。</span>
    </div>
  );
  if (hasDelta && delta <= -15) return (
    <div className="ds-headline">
      <span className="ds-headline-line">本月活跃时长</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">低于</span>上月。</span>
    </div>
  );
  if (d.days_with_data >= 25) return (
    <div className="ds-headline">
      <span className="ds-headline-line">这个月记录<span className="ds-headline-accent">相当完整</span>，</span>
      <span className="ds-headline-line">共 {d.days_with_data} 天有效数据。</span>
    </div>
  );
  return (
    <div className="ds-headline">
      <span className="ds-headline-line">本月活动概览</span>
    </div>
  );
}

/* ── 周报 Editorial 组件 ──────────────────────────────────────────────────── */
function WeekSummary({
  detail, icons, onRegenerate, regenerating, onExport, onOpenLightbox, onCollapse,
}: {
  detail: Extract<ReportView, { report_type: "week" }>;
  icons: ResolvedIconMap | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onExport: () => void;
  onOpenLightbox: () => void;
  onCollapse: () => void;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const d = detail.data;
  const deltaById = new Map(d.categories.map((c) => [c.category, c.share_delta_pp]));

  return (
    <div className="ds-shell">
      {/* ── Header ── */}
      <div className="ds-header">
        <div className="ds-header-top">
          <span className="ds-header-label">WEEKLY ACTIVITY / {weekRangeLabel(d.week_start)}</span>
          <div className="ds-header-actions">
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onOpenLightbox}>预览海报 ↗</button>
            )}
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onExport}>导出周报告 ↗</button>
            )}
            <button type="button" className="ds-collapse-btn"
              onClick={() => setConfirmRegen(true)} disabled={regenerating}
              title="用当前的分类设置重算这份报告">
              {regenerating ? "重新生成中…" : "重新生成"}
            </button>
            <span className="ds-header-sep" aria-hidden>·</span>
            <button type="button" className="ds-collapse-btn" onClick={onCollapse}>收起 ↑</button>
          </div>
        </div>
        <WeekHeadline d={d} />
        <div className="ds-kpis">
          <div className="ds-kpi ds-kpi--primary">
            <span className="ds-kpi-label">活跃时长</span>
            <span className="ds-kpi-val">{formatDuration(d.active_ms)}</span>
            {d.baseline.baseline_sufficient && (
              <span className="ds-kpi-sub">vs 前 4 周 {deltaLabel(d.baseline.daily_delta_pct)}</span>
            )}
          </div>
          <div className="ds-kpi">
            <span className="ds-kpi-label">日均活跃</span>
            <span className="ds-kpi-val">{formatDuration(d.avg_daily_active_ms)}</span>
          </div>
          <div className="ds-kpi">
            <span className="ds-kpi-label">有效天数</span>
            <span className="ds-kpi-val">{d.days_with_data} 天</span>
          </div>
          {d.rhythm_summary.days_counted >= 2 &&
           d.rhythm_summary.avg_start_min != null &&
           d.rhythm_summary.avg_end_min != null && (
            <div className="ds-kpi">
              <span className="ds-kpi-label">平均作息</span>
              <span className="ds-kpi-val">
                {formatSleepMin(d.rhythm_summary.avg_start_min!)} – {formatSleepMin(d.rhythm_summary.avg_end_min!)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="ds-body">
        {/* 01 每日节奏 */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-id">01 / WEEKLY RHYTHM</span>
            <span className="ds-section-q">这一周每天的活跃分布</span>
          </div>
          <MiniBars cells={d.days} ticks={WEEK_TICKS} />
        </div>

        {/* 02+03 分类 & 应用 */}
        <div className="ds-grid2">
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">02 / CATEGORIES</span>
              <span className="ds-section-q">
                时间花在什么事情上{d.baseline.baseline_sufficient ? "（含 vs 前 4 周 pp 差）" : ""}
              </span>
            </div>
            <SummaryCategories
              categories={detail.snapshot.categories}
              deltaById={deltaById}
              showDelta={d.baseline.baseline_sufficient}
            />
          </div>
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">03 / APPLICATIONS</span>
              <span className="ds-section-q">最常使用的应用</span>
            </div>
            <SummaryApps apps={detail.snapshot.apps} icons={icons} />
          </div>
        </div>

        {/* 04 工作日 vs 周末 */}
        {(d.weekday_weekend.weekday_days > 0 || d.weekday_weekend.weekend_days > 0) && (
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">04 / WEEKDAY vs WEEKEND</span>
              <span className="ds-section-q">工作日与周末的活跃差异</span>
            </div>
            <div className="ds-kpis">
              {d.weekday_weekend.weekday_days > 0 && (
                <div className="ds-kpi">
                  <span className="ds-kpi-label">工作日日均</span>
                  <span className="ds-kpi-val">{formatDuration(d.weekday_weekend.weekday_avg_active_ms)}</span>
                  <span className="ds-kpi-sub">{d.weekday_weekend.weekday_days} 天</span>
                </div>
              )}
              {d.weekday_weekend.weekend_days > 0 && (
                <div className="ds-kpi">
                  <span className="ds-kpi-label">周末日均</span>
                  <span className="ds-kpi-val">{formatDuration(d.weekday_weekend.weekend_avg_active_ms)}</span>
                  <span className="ds-kpi-sub">{d.weekday_weekend.weekend_days} 天</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 05 Observations */}
        {detail.narrative && (
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">05 / OBSERVATIONS</span>
              <span className="ds-section-q">值得留意的细节</span>
            </div>
            <Narrative narrative={detail.narrative} />
          </div>
        )}

        <div className="ds-footer">
          <span className="ds-footer-left">SNOOP / WEEKLY RECORD</span>
          <span className="ds-footer-right">{weekRangeLabel(d.week_start)}</span>
        </div>
      </div>

      {confirmRegen && createPortal(
        <div className="dev-confirm-overlay" onClick={() => setConfirmRegen(false)}>
          <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dev-confirm-header"><h3>按当前分类重新生成</h3></div>
            <p className="dev-confirm-desc">
              这份报告现在显示的是<b>生成那一刻</b>的分类名称与配色。重新生成会用
              <b>当前</b>的分类设置重算，并覆盖原有的分类结果与这段吐槽文案。
              <br />覆盖后不可撤销。
            </p>
            <div className="dev-confirm-actions">
              <button className="setting-btn" onClick={() => setConfirmRegen(false)}>取消</button>
              <button className="setting-btn setting-btn-primary"
                onClick={() => { setConfirmRegen(false); onRegenerate(); }}>重新生成</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ── 月报 Editorial 组件 ──────────────────────────────────────────────────── */
function MonthSummary({
  detail, icons, onRegenerate, regenerating, onExport, onOpenLightbox, onCollapse,
}: {
  detail: Extract<ReportView, { report_type: "month" }>;
  icons: ResolvedIconMap | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onExport: () => void;
  onOpenLightbox: () => void;
  onCollapse: () => void;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const d = detail.data;

  return (
    <div className="ds-shell">
      {/* ── Header ── */}
      <div className="ds-header">
        <div className="ds-header-top">
          <span className="ds-header-label">MONTHLY ACTIVITY / {monthLabel(d.month_start)}</span>
          <div className="ds-header-actions">
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onOpenLightbox}>预览海报 ↗</button>
            )}
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onExport}>导出月报告 ↗</button>
            )}
            <button type="button" className="ds-collapse-btn"
              onClick={() => setConfirmRegen(true)} disabled={regenerating}
              title="用当前的分类设置重算这份报告">
              {regenerating ? "重新生成中…" : "重新生成"}
            </button>
            <span className="ds-header-sep" aria-hidden>·</span>
            <button type="button" className="ds-collapse-btn" onClick={onCollapse}>收起 ↑</button>
          </div>
        </div>
        <MonthHeadline d={d} />
        <div className="ds-kpis">
          <div className="ds-kpi ds-kpi--primary">
            <span className="ds-kpi-label">活跃时长</span>
            <span className="ds-kpi-val">{formatDuration(d.active_ms)}</span>
            {d.prev_month.avg_daily_active_ms > 0 && (
              <span className="ds-kpi-sub">vs 上月 {deltaLabel(d.prev_month.daily_delta_pct)}</span>
            )}
          </div>
          <div className="ds-kpi">
            <span className="ds-kpi-label">日均活跃</span>
            <span className="ds-kpi-val">{formatDuration(d.avg_daily_active_ms)}</span>
          </div>
          <div className="ds-kpi">
            <span className="ds-kpi-label">有效天数</span>
            <span className="ds-kpi-val">{d.days_with_data} 天</span>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="ds-body">
        {/* 01 按周走势 */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-id">01 / MONTHLY RHYTHM</span>
            <span className="ds-section-q">按周的活跃走势</span>
          </div>
          <MiniBars cells={d.weeks} />
        </div>

        {/* 02+03 分类 & 应用 */}
        <div className="ds-grid2">
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">02 / CATEGORIES</span>
              <span className="ds-section-q">时间花在什么事情上</span>
            </div>
            <SummaryCategories categories={detail.snapshot.categories} />
          </div>
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">03 / APPLICATIONS</span>
              <span className="ds-section-q">最常使用的应用</span>
            </div>
            <SummaryApps apps={detail.snapshot.apps} icons={icons} />
          </div>
        </div>

        {/* 04 上半月 vs 下半月 */}
        {d.half_shift.length > 0 && (
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">04 / HALF-MONTH SHIFT</span>
              <span className="ds-section-q">上半月 vs 下半月分类变化</span>
            </div>
            <HalfShift shifts={d.half_shift} snapshot={detail.snapshot} />
          </div>
        )}

        {/* 05 Observations */}
        {detail.narrative && (
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">05 / OBSERVATIONS</span>
              <span className="ds-section-q">值得留意的细节</span>
            </div>
            <Narrative narrative={detail.narrative} />
          </div>
        )}

        <div className="ds-footer">
          <span className="ds-footer-left">SNOOP / MONTHLY RECORD</span>
          <span className="ds-footer-right">{monthLabel(d.month_start)}</span>
        </div>
      </div>

      {confirmRegen && createPortal(
        <div className="dev-confirm-overlay" onClick={() => setConfirmRegen(false)}>
          <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dev-confirm-header"><h3>按当前分类重新生成</h3></div>
            <p className="dev-confirm-desc">
              这份报告现在显示的是<b>生成那一刻</b>的分类名称与配色。重新生成会用
              <b>当前</b>的分类设置重算，并覆盖原有的分类结果与这段吐槽文案。
              <br />覆盖后不可撤销。
            </p>
            <div className="dev-confirm-actions">
              <button className="setting-btn" onClick={() => setConfirmRegen(false)}>取消</button>
              <button className="setting-btn setting-btn-primary"
                onClick={() => { setConfirmRegen(false); onRegenerate(); }}>重新生成</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */
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
  if (detail.report_type === "day") {
    return (
      <DaySummary
        detail={detail} icons={icons}
        onRegenerate={onRegenerate} regenerating={regenerating}
        onExport={onExport} onOpenLightbox={onOpenLightbox} onCollapse={onCollapse}
      />
    );
  }
  if (detail.report_type === "week") {
    return (
      <WeekSummary
        detail={detail} icons={icons}
        onRegenerate={onRegenerate} regenerating={regenerating}
        onExport={onExport} onOpenLightbox={onOpenLightbox} onCollapse={onCollapse}
      />
    );
  }
  return (
    <MonthSummary
      detail={detail} icons={icons}
      onRegenerate={onRegenerate} regenerating={regenerating}
      onExport={onExport} onOpenLightbox={onOpenLightbox} onCollapse={onCollapse}
    />
  );
}

