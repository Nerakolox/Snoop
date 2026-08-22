/**
 * 报告摘要 —— 展开报告时的「为屏幕重排的紧凑摘要」。
 *
 * 与海报(<ReportCard>)并存：海报只出现在右栏缩略图 / 灯箱 / 导出三处，
 * 摘要是另一套布局，专为日常翻看而设计（目标一屏内看完），不复用海报版式。
 * 右栏缩略图把 1000px 海报 scale(0.19) 缩到 ~190px，底部白渐变示意「还有更多」，
 * 点击打开灯箱（灯箱 / 导出见 Lightbox.tsx / ExportDialog.tsx）。
 *
 * 摘要内容按报型各表：日 = 24h 形状 + 近 7 天对比；周 = 7 天条形 + vs 前 4 周；
 * 月 = 按周走势 + vs 上月。应用 Top 5 只列图标 + 名称 + 百分比（不放时长条）。
 */

import type { ReactNode } from "react";
import type { ReportView } from "./types";
import { formatDuration } from "../utils/format";
import { dateLabel, monthLabel, weekRangeLabel } from "./format";
import type { ResolvedIconMap } from "./icons";
import ReportCard from "./ReportCard";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import "./report-summary.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";
/** 缩略图缩放比：1000px 海报 × 0.19 = 190px，与右栏固定宽一致。 */
const THUMB_SCALE = 0.19;

const KIND_CN: Record<ReportView["report_type"], string> = {
  day: "日报",
  week: "周报",
  month: "月报",
};

/** 各报的规范化日期标题。 */
function dateText(detail: ReportView): string {
  if (detail.report_type === "day") return dateLabel(detail.data.date);
  if (detail.report_type === "week") return weekRangeLabel(detail.data.week_start);
  return monthLabel(detail.data.month_start);
}

/** 字母兜底图标的主题色，与 AppIcon.tsx / ReportCard.tsx 的 colorFromName 算法一致。 */
function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

/** 摘要里紧凑的 app 图标（20px，比海报的 48px 小）。 */
function SummaryIcon({
  bundleId,
  name,
  icons,
}: {
  bundleId: string;
  name: string;
  icons: ResolvedIconMap | null;
}) {
  if (bundleId === SNOOP_BUNDLE_ID) {
    return <img className="report-summary__app-icon" src={snoopIconInline} alt="" />;
  }
  const data = icons?.get(bundleId);
  if (data) {
    return <img className="report-summary__app-icon" src={`data:image/png;base64,${data}`} alt="" />;
  }
  const letter = (name.charAt(0) || "?").toUpperCase();
  return (
    <span
      className="report-summary__app-icon report-summary__app-icon--fallback"
      style={{ backgroundColor: colorFromName(name) }}
    >
      {letter}
    </span>
  );
}

/** 应用 Top 5：紧凑行（图标 + 名称 + 百分比），不放时长条。 */
function SummaryApps({
  apps,
  icons,
}: {
  apps: { name: string; bundle_id: string; share_pct: number }[];
  icons: ResolvedIconMap | null;
}) {
  if (apps.length === 0) return <p className="report-summary__empty">无数据</p>;
  return (
    <div className="report-summary__apps">
      {apps.slice(0, 5).map((a) => (
        <div key={a.bundle_id} className="report-summary__app">
          <SummaryIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
          <span className="report-summary__app-name">{a.name}</span>
          <span className="report-summary__app-pct">{Math.round(a.share_pct)}%</span>
        </div>
      ))}
    </div>
  );
}

/** 迷你条形：一天的 24h 形状 / 一周 7 天 / 一月的按周走势，高约 30px。 */
function MiniBars({ cells }: { cells: { active_ms: number }[] }) {
  const max = Math.max(...cells.map((c) => c.active_ms), 1);
  return (
    <div className="report-summary__bars">
      {cells.map((c, i) => (
        <div key={i} className="report-summary__bars-col">
          <div
            className="report-summary__bars-fill"
            style={{ height: `${Math.max((c.active_ms / max) * 100, c.active_ms > 0 ? 8 : 0)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function DeltaText({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(0)}%
    </>
  );
}

/** AI 吐槽段 + 来源徽章（应用内正文字号，行高 1.75）。 */
function Narrative({ detail }: { detail: ReportView }) {
  if (!detail.narrative) return null;
  return (
    <p className="report-summary__narrative">
      {detail.narrative}
      {detail.narrative_source && (
        <span className="report-summary__narrative-source">
          {detail.narrative_source === "ai" ? "由 AI 生成" : "本地模板"}
        </span>
      )}
    </p>
  );
}

/** 底部双栏：左应用 Top 5、右「一天的形状 + 和平时比」。 */
function MainCols({
  title,
  apps,
  icons,
  bars,
  compare,
}: {
  title: string;
  apps: { name: string; bundle_id: string; share_pct: number }[];
  icons: ResolvedIconMap | null;
  bars: { active_ms: number }[];
  compare: ReactNode;
}) {
  return (
    <div className="report-summary__cols">
      <section className="report-summary__col">
        <h5 className="report-summary__col-title">应用 Top 5</h5>
        <SummaryApps apps={apps} icons={icons} />
      </section>
      <section className="report-summary__col">
        <h5 className="report-summary__col-title">{title}</h5>
        <MiniBars cells={bars} />
        {compare}
      </section>
    </div>
  );
}

function DayMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "day" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  return (
    <>
      <div className="report-summary__active-label">活跃时长</div>
      <div className="report-summary__active">{formatDuration(d.active_ms)}</div>
      <div className="report-summary__sub">
        前台 {formatDuration(d.foreground_ms)} · 切换 {d.switch_count} 次
      </div>
      <Narrative detail={detail} />
      <MainCols
        title="一天的形状"
        apps={d.top_apps}
        icons={icons}
        bars={d.hourly}
        compare={
          d.vs_7d.avg_active_ms > 0 ? (
            <p className="report-summary__compare">
              近 7 天：活跃 <DeltaText pct={d.vs_7d.active_delta_pct} /> · 切换{" "}
              <DeltaText pct={d.vs_7d.switch_delta_pct} />
            </p>
          ) : null
        }
      />
    </>
  );
}

function WeekMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "week" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  return (
    <>
      <div className="report-summary__active-label">活跃时长</div>
      <div className="report-summary__active">{formatDuration(d.active_ms)}</div>
      <div className="report-summary__sub">
        日均 {formatDuration(d.avg_daily_active_ms)} · 前台 {formatDuration(d.foreground_ms)}
      </div>
      <Narrative detail={detail} />
      <MainCols
        title="这一周"
        apps={d.top_apps}
        icons={icons}
        bars={d.days}
        compare={
          d.baseline.avg_daily_active_ms > 0 ? (
            <p className="report-summary__compare">
              vs 前 4 周：日均 <DeltaText pct={d.baseline.daily_delta_pct} />
            </p>
          ) : null
        }
      />
    </>
  );
}

function MonthMain({ detail, icons }: { detail: Extract<ReportView, { report_type: "month" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  return (
    <>
      <div className="report-summary__active-label">活跃时长</div>
      <div className="report-summary__active">{formatDuration(d.active_ms)}</div>
      <div className="report-summary__sub">
        日均 {formatDuration(d.avg_daily_active_ms)} · 前台 {formatDuration(d.foreground_ms)} · 有记录{" "}
        {d.days_with_data} 天
      </div>
      <Narrative detail={detail} />
      <MainCols
        title="按周走势"
        apps={d.top_apps}
        icons={icons}
        bars={d.weeks}
        compare={
          d.prev_month.avg_daily_active_ms > 0 ? (
            <p className="report-summary__compare">
              vs 上月：日均 <DeltaText pct={d.prev_month.daily_delta_pct} />
            </p>
          ) : null
        }
      />
    </>
  );
}

export default function ReportSummary({
  detail,
  icons,
  onRegenerate,
  regenerating,
  onExport,
  onOpenLightbox,
  onCollapse,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onExport: () => void;
  onOpenLightbox: () => void;
  onCollapse: () => void;
}) {
  return (
    <div className="report-summary">
      <button type="button" className="report-summary__header" onClick={onCollapse} title="收起">
        <span className="report-summary__headline">
          <span className="report-summary__date">{dateText(detail)}</span>
          <span className="report-summary__kind">{KIND_CN[detail.report_type]}</span>
        </span>
        <span className="report-summary__collapse">收起 ↑</span>
      </button>

      <div className="report-summary__grid">
        <div className="report-summary__main">
          {detail.report_type === "week" ? (
            <WeekMain detail={detail} icons={icons} />
          ) : detail.report_type === "month" ? (
            <MonthMain detail={detail} icons={icons} />
          ) : (
            <DayMain detail={detail} icons={icons} />
          )}
        </div>

        <aside className="report-summary__side">
          <button
            type="button"
            className="report-summary__thumb"
            onClick={onOpenLightbox}
            aria-label="打开海报"
          >
            <div
              className="report-summary__thumb-scaled"
              style={{ transform: `translateX(-50%) scale(${THUMB_SCALE})` }}
            >
              <ReportCard detail={detail} icons={icons} showFooter />
            </div>
            <span className="report-summary__thumb-fade" aria-hidden />
          </button>

          <div className="report-summary__actions">
            {detail.status === "ok" && (
              <button type="button" className="report-summary__export" onClick={onExport}>
                导出成图
              </button>
            )}
            <button
              type="button"
              className="report-summary__regen"
              onClick={onRegenerate}
              disabled={regenerating}
            >
              {regenerating ? "重新生成中…" : "重新生成"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
