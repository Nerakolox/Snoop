/**
 * DaySummary — Editorial Report 布局，仅用于日报展开视图。
 * 周报 / 月报继续由 ReportSummary 渲染。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type { CategorySnap, AppSnap, DailyReport, ReportView } from "./types";
import { formatDuration } from "../utils/format";
import { BASELINE_MIN_DAILY_MS, dateLabel, deltaLabel } from "./format";
import { renderQuips } from "./markup";
import type { ResolvedIconMap } from "./icons";
import ReportCard from "./ReportCard";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import "./day-summary.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";
const CIRCUMFERENCE = 2 * Math.PI * 36;

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`;
}

/** 从真实数据推断标题，key phrase 用紫色 span 强调。 */
function Headline({ d }: { d: DailyReport }) {
  const activeMin = Math.round(d.active_ms / 60000);
  const switchPerHour = activeMin > 0 ? (d.switch_count / activeMin) * 60 : 0;
  const focusMin = Math.round(d.longest_focus.duration_ms / 60000);

  if (activeMin < 60) return (
    <div className="ds-headline">
      <span className="ds-headline-line">今天的活动时间</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">相当短暂</span>。</span>
    </div>
  );
  if (switchPerHour > 250) return (
    <div className="ds-headline">
      <span className="ds-headline-line">今天窗口切换非常频繁，</span>
      <span className="ds-headline-line">注意力<span className="ds-headline-accent">持续被打断</span>。</span>
    </div>
  );
  if (switchPerHour > 150 && activeMin < 180) return (
    <div className="ds-headline">
      <span className="ds-headline-line">工作时间不长，</span>
      <span className="ds-headline-line">但窗口切换<span className="ds-headline-accent">相当频繁</span>。</span>
    </div>
  );
  if (focusMin >= 90) return (
    <div className="ds-headline">
      <span className="ds-headline-line">今天有一段<span className="ds-headline-accent">深度专注</span>，</span>
      <span className="ds-headline-line">持续了 {focusMin} 分钟。</span>
    </div>
  );
  if (activeMin >= 480) return (
    <div className="ds-headline">
      <span className="ds-headline-line">今天的活跃时间</span>
      <span className="ds-headline-line"><span className="ds-headline-accent">相当充足</span>。</span>
    </div>
  );
  return (
    <div className="ds-headline">
      <span className="ds-headline-line">今日活动概览</span>
    </div>
  );
}

function AppIcon({ bundleId, name, icons, size = 20 }: {
  bundleId: string; name: string; icons: ResolvedIconMap | null; size?: number;
}) {
  if (bundleId === SNOOP_BUNDLE_ID)
    return <img className="ds-app-icon" src={snoopIconInline} alt="" style={{ width: size, height: size }} />;
  const data = icons?.get(bundleId);
  if (data)
    return <img className="ds-app-icon" src={`data:image/png;base64,${data}`} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="ds-app-icon ds-app-icon--fallback"
      style={{ width: size, height: size, backgroundColor: colorFromName(name), fontSize: size * 0.55 }}>
      {(name.charAt(0) || "?").toUpperCase()}
    </span>
  );
}

/** 环形图：把分类按占比画成 SVG donut，中心显示最大分类名+百分比。 */
function DonutChart({ categories }: { categories: CategorySnap[] }) {
  const shown = categories.filter(c => c.active_ms > 0);
  if (shown.length === 0) return <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-3)" }}>无数据</p>;
  const top = shown[0];
  let offset = 0;
  const segments = shown.map(c => {
    const dash = (c.share_pct / 100) * CIRCUMFERENCE;
    const gap = CIRCUMFERENCE - dash;
    const seg = { ...c, dash, gap, offset };
    offset += dash;
    return seg;
  });
  return (
    <div className="ds-donut-wrap">
      <svg className="ds-donut-svg" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="36" fill="none" stroke="var(--color-surface-2)" strokeWidth="10" />
        {segments.map(s => (
          <circle key={s.id} cx="48" cy="48" r="36" fill="none"
            stroke={s.color} strokeWidth="10"
            strokeDasharray={`${s.dash} ${s.gap}`}
            strokeDashoffset={-s.offset}
            transform="rotate(-90 48 48)" />
        ))}
        <text x="48" y="44" textAnchor="middle" className="ds-donut-center-label">{top.name}</text>
        <text x="48" y="58" textAnchor="middle" className="ds-donut-center-pct">{top.share_pct.toFixed(0)}%</text>
      </svg>
      <div className="ds-donut-legend">
        {shown.map(c => (
          <div key={c.id} className="ds-donut-row">
            <span className="ds-donut-swatch" style={{ background: c.color }} />
            <span className="ds-donut-name">{c.name}</span>
            <span className="ds-donut-pct">{c.share_pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Apps({ apps, icons }: { apps: AppSnap[]; icons: ResolvedIconMap | null }) {
  if (apps.length === 0) return <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-3)" }}>无数据</p>;
  const max = Math.max(...apps.map(a => a.active_ms), 1);
  return (
    <div className="ds-apps">
      {apps.slice(0, 5).map(a => (
        <div key={a.bundle_id} className="ds-app">
          <AppIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
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

const DAY_TICKS = Array.from({ length: 24 }, (_, i) =>
  i === 0 ? "0" : i === 6 ? "6" : i === 12 ? "12" : i === 18 ? "18" : i === 23 ? "24" : "",
);

function Timeline({ d }: { d: DailyReport }) {
  const max = Math.max(...d.hourly.map(h => h.active_ms), 1);
  return (
    <>
      <div className="ds-timeline-bars">
        {d.hourly.map((h, i) => (
          <div key={i} className="ds-timeline-col">
            <div className="ds-timeline-fill"
              style={{ height: `${Math.max((h.active_ms / max) * 100, h.active_ms > 0 ? 8 : 0)}%` }} />
          </div>
        ))}
      </div>
      <div className="ds-timeline-ticks">
        {DAY_TICKS.map((t, i) => <div key={i} className="ds-timeline-tick">{t}</div>)}
      </div>
    </>
  );
}

function Observations({ detail }: { detail: Extract<ReportView, { report_type: "day" }> }) {
  if (!detail.narrative) return null;
  const lines = detail.narrative.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const gridClass = `ds-obs-grid${lines.length === 1 ? " ds-obs-grid--single" : ""}`;
  return (
    <div className={gridClass}>
      {lines.map((line, i) => (
        <div key={i} className="ds-obs-item">
          {renderQuips(line, "summary")}
        </div>
      ))}
    </div>
  );
}

const THUMB_SCALE = 0.19;

export default function DaySummary({
  detail, icons, onRegenerate, regenerating, onExport, onOpenLightbox, onCollapse,
}: {
  detail: Extract<ReportView, { report_type: "day" }>;
  icons: ResolvedIconMap | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onExport: () => void;
  onOpenLightbox: () => void;
  onCollapse: () => void;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const d = detail.data;
  const focusMin = Math.round(d.longest_focus.duration_ms / 60000);

  return (
    <div className="ds-shell">
      {/* ── Header ── */}
      <div className="ds-header">
        <div className="ds-header-top">
          <span className="ds-header-label">DAILY ACTIVITY / {dateLabel(d.date)}</span>
          <div className="ds-header-actions">
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onOpenLightbox}>预览海报 ↗</button>
            )}
            {detail.status === "ok" && (
              <button type="button" className="ds-header-export" onClick={onExport}>导出今日报告 ↗</button>
            )}
            <button
              type="button"
              className="ds-collapse-btn"
              onClick={() => setConfirmRegen(true)}
              disabled={regenerating}
              title="用当前的分类设置重算这份报告"
            >
              {regenerating ? "重新生成中…" : "重新生成"}
            </button>
            <span className="ds-header-sep" aria-hidden>·</span>
            <button type="button" className="ds-collapse-btn" onClick={onCollapse}>收起 ↑</button>
          </div>
        </div>

        <Headline d={d} />

        <div className="ds-kpis">
          <div className="ds-kpi ds-kpi--primary">
            <span className="ds-kpi-label">活跃时长</span>
            <span className="ds-kpi-val">{formatDuration(d.active_ms)}</span>
            {d.vs_7d.avg_active_ms >= BASELINE_MIN_DAILY_MS && (
              <span className="ds-kpi-sub">近 7 天 {deltaLabel(d.vs_7d.active_delta_pct)}</span>
            )}
          </div>
          <div className="ds-kpi">
            <span className="ds-kpi-label">窗口切换</span>
            <span className="ds-kpi-val">{d.switch_count} 次</span>
          </div>
          {focusMin > 0 && (
            <div className="ds-kpi">
              <span className="ds-kpi-label">最长专注</span>
              <span className="ds-kpi-val">{focusMin} 分钟</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="ds-body">
        {/* 01 Timeline */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-id">01 / TIMELINE</span>
            <span className="ds-section-q">活动集中在哪些时段？</span>
          </div>
          <Timeline d={d} />
        </div>

        {/* 02+03 Categories & Applications */}
        <div className="ds-grid2">
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">02 / CATEGORIES</span>
              <span className="ds-section-q">时间花在什么事情上？</span>
            </div>
            <DonutChart categories={detail.snapshot.categories} />
          </div>
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">03 / APPLICATIONS</span>
              <span className="ds-section-q">最常使用的应用</span>
            </div>
            <Apps apps={detail.snapshot.apps} icons={icons} />
          </div>
        </div>

        {/* 04 Observations */}
        {detail.narrative && (
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-id">04 / OBSERVATIONS</span>
              <span className="ds-section-q">两个值得留意的细节</span>
            </div>
            <Observations detail={detail} />
          </div>
        )}

        {/* Footer */}
        <div className="ds-footer">
          <span className="ds-footer-left">SNOOP / DAILY RECORD</span>
          <span className="ds-footer-right">{dateLabel(d.date)}</span>
        </div>
      </div>

      {/* Regen confirm dialog */}
      {confirmRegen && createPortal(
        <div className="dev-confirm-overlay" onClick={() => setConfirmRegen(false)}>
          <div className="dev-confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="dev-confirm-header"><h3>按当前分类重新生成</h3></div>
            <p className="dev-confirm-desc">
              这份报告现在显示的是<b>生成那一刻</b>的分类名称与配色。重新生成会用
              <b>当前</b>的分类设置重算，并覆盖原有的分类结果与这段吐槽文案。
              <br />覆盖后不可撤销。
            </p>
            <div className="dev-confirm-actions">
              <button className="setting-btn" onClick={() => setConfirmRegen(false)}>取消</button>
              <button className="setting-btn setting-btn-primary" onClick={() => { setConfirmRegen(false); onRegenerate(); }}>
                重新生成
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Lightbox preview (thumbnail not shown inline, opens on lightbox trigger) */}
      <div style={{ display: "none" }}>
        <div style={{ transform: `scale(${THUMB_SCALE})`, transformOrigin: "top left" }}>
          <ReportCard detail={detail} icons={icons} showFooter />
        </div>
      </div>
    </div>
  );
}
