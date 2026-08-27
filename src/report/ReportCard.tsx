/**
 * 报告卡片（海报）—— 应用内缩略图、灯箱、「导出成图」三处共用的**同一份**版式。
 *
 * 版式只有这一份真源：固定 1000px 宽、高度按内容自适应。`showFooter` 控制是否渲染
 * footer（Snoop 品牌 + 域名 + 二维码），三处都渲染完整海报。收起交互不再在卡片内
 * （见 ReportSummary 的头部），本组件只负责「海报」本身。
 *
 * 版式规范（见 report-card.css 的 `--rc-*` token）：
 *   - 固定 1000px 宽，高度按内容自适应（不锁比例、不裁切）
 *   - 左右边距 70px、模块间距 52px、模块标题到内容 18px
 *   - 字号 5 档：大数字 / 模块标题 / 吐槽正文 / 数据行 / 辅助（数字一律 mono）
 *   - 顶部是 T4「数据条」：大数字 + 活跃/前台堆叠条 + 吐槽框
 *   - footer 整条品牌紫，与顶部紫色大数字首尾呼应
 *   - 固定浅色（发给别人看的图不该是深色），应用内也保持同一张浅色「报告纸」
 *
 * 海报内时长一律用 `formatDurationCompact`（单位「分」），应用内其它页面保持「分钟」。
 * 所有图片资源（Snoop 图标 / 二维码 `?inline`、app 图标 data URI）都是 data URI，
 * 保证 foreignObject → canvas 不被污染。
 */

import { memo } from "react";
import type { ReactNode } from "react";
import type {
  AppRank,
  CategoryDelta,
  CategoryHalfShift,
  CategoryShare,
  DayCell,
  HourCell,
  MonthWeek,
  ReportView,
  RhythmDay,
  RhythmSummary,
} from "./types";
import { formatDurationCompact, formatSharePct } from "../utils/format";
// 报告里存的是分类 id，显示名与分类色都从分类表实时读（历史冻结另有工单，此处不涉及）。
// 取色用 fillHexOf 而不是应用内的 fillOf：海报样式是 report-card.css?inline 塞进
// <foreignObject> 独立渲染的，读不到主文档 token，`oklch(var(--cat-l) …)` 在那里解析不出来。
import { fillHexOf, labelOf as categoryLabel } from "../categories/store";
import { BASELINE_MIN_DAILY_MS, DOW_LABELS, dateLabel, deltaLabel, formatSleepMin, monthLabel, weekRangeLabel } from "./format";
import { EXPORT_WIDTH } from "./export";
import { renderQuips } from "./markup";
import type { ResolvedIconMap } from "./icons";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import qrInline from "../assets/qr-official.png?inline";
import "./report-card.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";

/** 字母兜底图标的主题色，与 AppIcon.tsx 的 colorFromName 算法一致。 */
function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

function ReportIcon({
  bundleId,
  name,
  icons,
}: {
  bundleId: string;
  name: string;
  icons: ResolvedIconMap | null;
}) {
  if (bundleId === SNOOP_BUNDLE_ID) {
    return <img className="report-card__app-icon" src={snoopIconInline} alt="" />;
  }
  const data = icons?.get(bundleId);
  if (data) {
    return <img className="report-card__app-icon" src={`data:image/png;base64,${data}`} alt="" />;
  }
  const letter = (name.charAt(0) || "?").toUpperCase();
  return (
    <div className="report-card__app-icon report-card__app-icon--fallback" style={{ backgroundColor: colorFromName(name) }}>
      {letter}
    </div>
  );
}

// ── 顶部区（T4 数据条）──────────────────────────────────────────────────────

const KIND_BADGE: Record<ReportView["report_type"], string> = {
  day: "日报",
  week: "周报",
  month: "月报",
};

/** 标题行右端的对比槽：充足时中性色 ↑↓，不足时「记录时间还不够」。 */
function HeadDelta({ prefix, pct }: { prefix: string; pct: number }) {
  return (
    <span className="report-card__head-compare">
      {prefix} {deltaLabel(pct)}
    </span>
  );
}

function HeadPending({ text }: { text: string }) {
  return (
    <span className="report-card__head-compare report-card__head-compare--pending">{text}</span>
  );
}

/**
 * 三报共用的 T4 头部：标题行（日期 + 徽章 + 右端对比槽）→ 大数字 + 说明 →
 * 活跃/前台堆叠条 → 图例。堆叠条深紫段 = 有输入，浅紫段 = 前台无输入。
 */
function ReportHead({
  title,
  badge,
  compare,
  activeMs,
  foregroundMs,
  sub,
}: {
  title: string;
  badge: string;
  compare: ReactNode;
  activeMs: number;
  foregroundMs: number;
  sub: string;
}) {
  const idleMs = Math.max(0, foregroundMs - activeMs);
  const total = Math.max(foregroundMs, 1);
  const activePct = Math.min(100, (activeMs / total) * 100);
  const idlePct = Math.min(100, (idleMs / total) * 100);
  return (
    <div className="report-card__head">
      <div className="report-card__head-top">
        <div className="report-card__head-identity">
          <span className="report-card__head-title">{title}</span>
          <span className="report-card__head-badge">{badge}</span>
        </div>
        {compare}
      </div>

      <div className="report-card__head-hero">
        <div className="report-card__head-active">{formatDurationCompact(activeMs)}</div>
        <div className="report-card__head-meta">
          <span className="report-card__head-label">活跃时长（有键鼠输入）</span>
          <span className="report-card__head-sub">{sub}</span>
        </div>
      </div>

      <div className="report-card__head-bar">
        <div className="report-card__head-stack">
          {activeMs > 0 && (
            <div className="report-card__head-stack-active" style={{ width: `${activePct}%` }} />
          )}
          {idleMs > 0 && (
            <div className="report-card__head-stack-idle" style={{ width: `${idlePct}%` }} />
          )}
        </div>
        <div className="report-card__head-legend">
          <span className="report-card__head-legend-item">
            <span className="report-card__head-dot report-card__head-dot--active" />
            有输入 <span className="report-card__head-legend-num">{formatDurationCompact(activeMs)}</span>
          </span>
          <span className="report-card__head-legend-item">
            <span className="report-card__head-dot report-card__head-dot--idle" />
            前台无输入{" "}
            <span className="report-card__head-legend-num">{formatDurationCompact(idleMs)}</span>
          </span>
          <span className="report-card__head-legend-total">
            前台合计{" "}
            <span className="report-card__head-legend-num">{formatDurationCompact(foregroundMs)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ReportAppBars({ apps, icons }: { apps: AppRank[]; icons: ResolvedIconMap | null }) {
  if (apps.length === 0) return <p className="report-card__empty">无数据</p>;
  const max = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="report-card__apps">
      {apps.map((a) => (
        <div key={a.bundle_id} className="report-card__app-row">
          <ReportIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
          <div className="report-card__app-name">
            <span>{a.name}</span>
          </div>
          <div className="report-card__app-track">
            <div
              className="report-card__app-fill"
              style={{ width: `${(a.active_ms / max) * 100}%` }}
            />
          </div>
          <div className="report-card__app-meta">
            <span>{formatDurationCompact(a.active_ms)}</span>
            <span className="report-card__app-pct">{a.share_pct.toFixed(0)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 极小类别（<1 分钟）合并成一行尾注：`文档、其他 2 类均不足 1 分钟，合计 <0.1%`。 */
function categoryTinyNote(
  categories: { category: string; active_ms: number; share_pct: number }[],
): string | null {
  const tiny = categories.filter((c) => c.active_ms > 0 && c.active_ms < 60_000);
  if (tiny.length === 0) return null;
  const names = tiny.map((c) => categoryLabel(c.category)).join("、");
  const share = tiny.reduce((s, c) => s + c.share_pct, 0);
  return `${names} ${tiny.length} 类均不足 1 分钟，合计 ${formatSharePct(share)}`;
}

function ReportCategoryStack({ categories }: { categories: CategoryShare[] }) {
  const shown = categories.filter((c) => c.active_ms > 0);
  if (shown.length === 0) return <p className="report-card__empty">无数据</p>;
  const tinyNote = categoryTinyNote(shown);
  return (
    <div className="report-card__cat">
      <div className="report-card__cat-stack">
        {shown.map((c) => (
          <div
            key={c.category}
            className="report-card__cat-seg"
            style={{ width: `${c.share_pct}%`, background: fillHexOf(c.category) }}
          />
        ))}
      </div>
      <div className="report-card__cat-legend">
        {shown.map((c) =>
          c.active_ms >= 60_000 ? (
            <div key={c.category} className="report-card__cat-row">
              <span
                className="report-card__cat-swatch"
                style={{ background: fillHexOf(c.category) }}
              />
              <span className="report-card__cat-label">{categoryLabel(c.category)}</span>
              <span className="report-card__cat-time">{formatDurationCompact(c.active_ms)}</span>
              <span className="report-card__cat-pct">{formatSharePct(c.share_pct)}</span>
            </div>
          ) : null,
        )}
        {tinyNote && <p className="report-card__cat-note">{tinyNote}</p>}
      </div>
    </div>
  );
}

function ReportCategoryDeltaBars({
  categories,
  showDelta,
}: {
  categories: CategoryDelta[];
  showDelta: boolean;
}) {
  const shown = categories.filter((c) => c.active_ms > 0);
  if (shown.length === 0) return <p className="report-card__empty">无数据</p>;
  const tinyNote = categoryTinyNote(shown);
  return (
    <div className="report-card__cat-legend">
      {shown.map((c) =>
        c.active_ms >= 60_000 ? (
          <div key={c.category} className="report-card__cat-row">
            <span
              className="report-card__cat-swatch"
              style={{ background: fillHexOf(c.category) }}
            />
            <span className="report-card__cat-label">{categoryLabel(c.category)}</span>
            <span className="report-card__cat-time">{formatDurationCompact(c.active_ms)}</span>
            <span className="report-card__cat-pct">{formatSharePct(c.share_pct)}</span>
            {showDelta && (
              <span className="report-card__cat-delta">
                {c.share_delta_pp >= 0 ? "↑" : "↓"}
                {Math.abs(c.share_delta_pp).toFixed(1)}pp
              </span>
            )}
          </div>
        ) : null,
      )}
      {tinyNote && <p className="report-card__cat-note">{tinyNote}</p>}
    </div>
  );
}

function ReportRhythm({ hourly }: { hourly: HourCell[] }) {
  const max = Math.max(...hourly.map((h) => h.active_ms), 1);
  return (
    <>
      <div className="report-card__rhythm">
        {hourly.map((h) => (
          <div key={h.hour} className="report-card__rhythm-col">
            <div
              className="report-card__rhythm-bar"
              style={{
                height: `${Math.max((h.active_ms / max) * 100, h.active_ms > 0 ? 2 : 0)}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="report-card__rhythm-scale">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </>
  );
}

function ReportWeekBars({
  days,
  maxDay,
  minDay,
}: {
  days: DayCell[];
  maxDay: string | null;
  minDay: string | null;
}) {
  const max = Math.max(...days.map((d) => d.active_ms), 1);
  return (
    <>
      <div className="report-card__bars">
        {days.map((d) => {
          const hasData = d.active_ms > 0;
          return (
            <div key={d.date} className="report-card__bars-col">
              <div className="report-card__bars-track report-card__bars-track--week">
                {hasData ? (
                  <>
                    <span className="report-card__bars-value">
                      {formatDurationCompact(d.active_ms)}
                    </span>
                    <div
                      className={`report-card__bars-fill${
                        d.date === maxDay ? " report-card__bars-fill--max" : ""
                      }`}
                      style={{ height: `${Math.max((d.active_ms / max) * 100, 2)}%` }}
                    />
                  </>
                ) : (
                  <>
                    <span className="report-card__bars-value report-card__bars-value--empty">—</span>
                    <div className="report-card__bars-empty" />
                  </>
                )}
              </div>
              <span className={`report-card__bars-day${hasData ? "" : " report-card__bars-day--empty"}`}>
                {DOW_LABELS[d.dow]}
              </span>
            </div>
          );
        })}
      </div>
      {maxDay && minDay && (
        <div className="report-card__bars-legend">
          <p className="report-card__bars-legend-line">
            最高 {dateLabel(maxDay)} · 最低 {dateLabel(minDay)}
          </p>
          <p className="report-card__bars-legend-note">（仅统计有记录的天）</p>
        </div>
      )}
    </>
  );
}

function ReportMonthWeeks({ weeks }: { weeks: MonthWeek[] }) {
  const max = Math.max(...weeks.map((w) => w.active_ms), 1);
  return (
    <div className="report-card__bars">
      {weeks.map((w) => (
        <div key={w.week_start} className="report-card__bars-col">
          <div className="report-card__bars-track report-card__bars-track--month">
            <div
              className="report-card__bars-fill"
              style={{ height: `${Math.max((w.active_ms / max) * 100, 2)}%` }}
            />
          </div>
          {w.partial ? (
            <span className="report-card__bars-day">{w.days_in_month}天</span>
          ) : (
            <span className="report-card__bars-day"> </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 本月节奏：整月逐日单行网格（N 格 1fr 平分，随当月天数）。有记录 → 品牌紫细条
 * （最长一天深紫），无记录 → 极淡虚线空框；底部 1/5/10/… 日号刻度。
 * 下方图例「最活跃 / 最安静」只从有记录的天里选（`max_day`/`min_day` 已在后端筛过）。
 * 旧库报告没有 `days` 字段，传空数组则整块显示「无数据」。
 */
function ReportMonthRhythm({
  days,
  maxDay,
  minDay,
}: {
  days: DayCell[];
  maxDay: DayCell | null;
  minDay: DayCell | null;
}) {
  if (days.length === 0) return <p className="report-card__empty">无数据</p>;
  const max = Math.max(...days.map((d) => d.active_ms), 1);
  const maxDate = maxDay?.date ?? null;
  return (
    <div className="report-card__monthrhythm">
      <div
        className="report-card__monthrhythm-grid"
        style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
      >
        {days.map((d) => {
          const hasData = d.active_ms > 0;
          const dom = Number(d.date.slice(8, 10));
          const isMax = d.date === maxDate;
          return (
            <div key={d.date} className="report-card__monthrhythm-col">
              <div className="report-card__monthrhythm-track">
                {hasData ? (
                  <div
                    className={`report-card__monthrhythm-fill${
                      isMax ? " report-card__monthrhythm-fill--max" : ""
                    }`}
                    style={{ height: `${Math.max((d.active_ms / max) * 100, 6)}%` }}
                  />
                ) : (
                  <div className="report-card__monthrhythm-empty" />
                )}
              </div>
              {dom === 1 || dom % 5 === 0 ? (
                <span className="report-card__monthrhythm-tick">{dom}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      {maxDay && minDay && (
        <div className="report-card__bars-legend">
          <p className="report-card__bars-legend-line">
            最活跃 {dateLabel(maxDay.date)} · 最安静 {dateLabel(minDay.date)}
          </p>
          <p className="report-card__bars-legend-note">（仅在有记录的天里选）</p>
        </div>
      )}
    </div>
  );
}

/** 「次日 HH:MM」里的「次日」缩成 0.84em 小前缀，不与时刻同字号。 */
function SleepTime({ text }: { text: string }) {
  const idx = text.indexOf("次日 ");
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="report-card__sleep-nextday">次日</span>
      {text.slice(idx + 2)}
    </>
  );
}

function ReportSleep({ days, summary }: { days: RhythmDay[]; summary: RhythmSummary }) {
  // 只列有记录的天（active_ms > 0），「– → –」这类空行不再占位；
  // 无记录的天收拢成一句「周X、周Y无记录」。
  const withData = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.active_ms > 0);
  const noDataLabels = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.active_ms === 0)
    .map(({ i }) => DOW_LABELS[i]);

  return (
    <>
      <div className="report-card__sleep">
        {withData.map(({ d, i }) => {
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
            <div key={d.date} className="report-card__sleep-row">
              <span className="report-card__sleep-day">{DOW_LABELS[i]}</span>
              <span className="report-card__sleep-times">
                <SleepTime text={start} /> → <SleepTime text={end} />
              </span>
              {!d.counted && d.active_ms > 0 && (
                <span className="report-card__sleep-note">未计入均值</span>
              )}
            </div>
          );
        })}
      </div>
      {noDataLabels.length > 0 && (
        <p className="report-card__sleep-empty">{noDataLabels.join("、")}无记录</p>
      )}
      <p className="report-card__sleep-avg">
        平均 {formatSleepMin(summary.avg_start_min ?? 0)} 开工、
        {formatSleepMin(summary.avg_end_min ?? 0)} 停下（基于 {summary.days_counted} 天）
        {summary.end_delta_min != null && (
          <>
            {" "}
            · 比平时
            {summary.end_delta_min >= 0
              ? `晚 ${summary.end_delta_min} 分`
              : `早 ${-summary.end_delta_min} 分`}
          </>
        )}
      </p>
    </>
  );
}

function ReportHalfShift({ shifts }: { shifts: CategoryHalfShift[] }) {
  return (
    <div className="report-card__halfshift">
      {shifts.slice(0, 5).map((h) => (
        <div key={h.category} className="report-card__halfshift-row">
          <span className="report-card__halfshift-name">{categoryLabel(h.category)}</span>
          <span className="report-card__halfshift-values">
            {h.first_half_share_pct.toFixed(0)}% → {h.second_half_share_pct.toFixed(0)}%
          </span>
          <span className="report-card__halfshift-delta">
            {h.delta_pp >= 0 ? "↑" : "↓"}
            {Math.abs(h.delta_pp).toFixed(1)}pp
          </span>
        </div>
      ))}
    </div>
  );
}

function ReportNarrative({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="report-card__narrative">{renderQuips(text, "card")}</div>;
}

function ReportAppChange({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="report-card__app-change">
      <span className="report-card__app-change-label">{label}</span>
      <span>{names.join(" · ")}</span>
    </div>
  );
}

function ReportFooter() {
  return (
    <div className="report-card__footer">
      <div className="report-card__footer-brand">
        <span className="report-card__footer-icon">
          <img src={snoopIconInline} alt="" />
        </span>
        <span className="report-card__footer-brand-text">
          <span className="report-card__footer-name">Snoop</span>
          <span className="report-card__footer-tagline">安静地记录你的一天</span>
        </span>
      </div>
      <div className="report-card__footer-link">
        <span className="report-card__footer-url">snoop.feedra.org</span>
        <span className="report-card__footer-qr">
          <img src={qrInline} alt="snoop.feedra.org" />
        </span>
      </div>
    </div>
  );
}

// ── 三报主体 ───────────────────────────────────────────────────────────────

type BodyProps = {
  detail: ReportView;
  icons: ResolvedIconMap | null;
};

function DayBody({ detail, icons }: BodyProps) {
  const d = (detail as Extract<ReportView, { report_type: "day" }>).data;
  const compare =
    d.vs_7d.avg_active_ms > 0 ? (
      d.vs_7d.avg_active_ms >= BASELINE_MIN_DAILY_MS ? (
        <HeadDelta prefix="近 7 天" pct={d.vs_7d.active_delta_pct} />
      ) : (
        <HeadPending text="记录时间还不够，过几天再来对比" />
      )
    ) : null;
  return (
    <>
      <ReportHead
        title={dateLabel(d.date)}
        badge={KIND_BADGE.day}
        compare={compare}
        activeMs={d.active_ms}
        foregroundMs={d.foreground_ms}
        sub={`切换 ${d.switch_count} 次`}
      />

      <ReportNarrative text={detail.narrative} />

      <section className="report-card__section">
        <h4 className="report-card__section-title">
          分类占比<span className="report-card__section-note">按活跃时长统计</span>
        </h4>
        <ReportCategoryStack categories={d.categories} />
      </section>

      <section className="report-card__section">
        <h4 className="report-card__section-title">应用 Top 5</h4>
        <ReportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
      </section>

      <section className="report-card__section">
        <h4 className="report-card__section-title">24 小时节奏</h4>
        <ReportRhythm hourly={d.hourly} />
      </section>
    </>
  );
}

/** 工作日/周末日均文案：无记录 → 「无记录」；有记录一律标「基于 N 天」。 */
function weekdayWeekendLabel(kind: string, days: number, avgMs: number): string {
  if (days === 0) return `${kind}无记录`;
  return `${kind}日均 ${formatDurationCompact(avgMs)}（基于 ${days} 天）`;
}

function WeekBody({ detail, icons }: BodyProps) {
  const d = (detail as Extract<ReportView, { report_type: "week" }>).data;
  const compare = d.baseline.baseline_sufficient ? (
    <HeadDelta prefix="vs 前 4 周日均" pct={d.baseline.daily_delta_pct} />
  ) : (
    <HeadPending text="记录时间还不够，下周开始对比" />
  );
  return (
    <>
      <ReportHead
        title={weekRangeLabel(d.week_start)}
        badge={KIND_BADGE.week}
        compare={compare}
        activeMs={d.active_ms}
        foregroundMs={d.foreground_ms}
        sub={`日均 ${formatDurationCompact(d.avg_daily_active_ms)}`}
      />

      <ReportNarrative text={detail.narrative} />

      <section className="report-card__section">
        <h4 className="report-card__section-title">这一周</h4>
        <ReportWeekBars days={d.days} maxDay={d.max_day} minDay={d.min_day} />
      </section>

      <div className="report-card__cols">
        {d.rhythm_summary.days_counted >= 3 && (
          <section className="report-card__section">
            <h4 className="report-card__section-title">作息</h4>
            <ReportSleep days={d.rhythm} summary={d.rhythm_summary} />
          </section>
        )}
        <section className="report-card__section">
          <h4 className="report-card__section-title">
            分类占比
            <span className="report-card__section-note">
              {d.baseline.baseline_sufficient ? "vs 前 4 周 · 按活跃时长统计" : "按活跃时长统计"}
            </span>
          </h4>
          <ReportCategoryDeltaBars
            categories={d.categories}
            showDelta={d.baseline.baseline_sufficient}
          />
        </section>
      </div>

      <section className="report-card__section">
        <h4 className="report-card__section-title">应用 Top 5</h4>
        <ReportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
      </section>

      <div className="report-card__cols">
        <section className="report-card__section">
          <h4 className="report-card__section-title">应用变动</h4>
          <ReportAppChange label="本周新出现" names={d.new_apps.map((a) => a.name)} />
          <ReportAppChange label="本周消失" names={d.gone_apps.map((a) => a.name)} />
        </section>
        <section className="report-card__section">
          <h4 className="report-card__section-title">工作日 vs 周末</h4>
          <div className="report-card__weekend">
            <span className="report-card__weekend-item">
              {weekdayWeekendLabel("工作日", d.weekday_weekend.weekday_days, d.weekday_weekend.weekday_avg_active_ms)}
            </span>
            <span className="report-card__weekend-item">
              {weekdayWeekendLabel("周末", d.weekday_weekend.weekend_days, d.weekday_weekend.weekend_avg_active_ms)}
            </span>
          </div>
        </section>
      </div>
    </>
  );
}

function MonthBody({ detail, icons }: BodyProps) {
  const d = (detail as Extract<ReportView, { report_type: "month" }>).data;
  const days = d.days ?? [];
  const compare =
    d.prev_month.avg_daily_active_ms > 0 ? (
      <HeadDelta prefix="vs 上月日均" pct={d.prev_month.daily_delta_pct} />
    ) : null;
  return (
    <>
      <ReportHead
        title={monthLabel(d.month_start)}
        badge={KIND_BADGE.month}
        compare={compare}
        activeMs={d.active_ms}
        foregroundMs={d.foreground_ms}
        sub={`日均 ${formatDurationCompact(d.avg_daily_active_ms)} · 有记录 ${d.days_with_data} 天`}
      />

      <ReportNarrative text={detail.narrative} />

      <section className="report-card__section">
        <h4 className="report-card__section-title">本月节奏</h4>
        <ReportMonthRhythm days={days} maxDay={d.max_day} minDay={d.min_day} />
      </section>

      <div className="report-card__cols">
        <section className="report-card__section">
          <h4 className="report-card__section-title">按周趋势</h4>
          <ReportMonthWeeks weeks={d.weeks} />
        </section>
        <section className="report-card__section">
          <h4 className="report-card__section-title">
            分类占比<span className="report-card__section-note">按活跃时长统计</span>
          </h4>
          <ReportCategoryStack categories={d.categories} />
        </section>
      </div>

      <section className="report-card__section">
        <h4 className="report-card__section-title">应用 Top 10</h4>
        <ReportAppBars apps={d.top_apps} icons={icons} />
      </section>

      <div className="report-card__cols">
        <section className="report-card__section">
          <h4 className="report-card__section-title">整月新增</h4>
          {d.new_apps.length > 0 ? (
            <div className="report-card__app-change">
              <span>{d.new_apps.map((a) => a.name).join(" · ")}</span>
            </div>
          ) : (
            <p className="report-card__empty">无数据</p>
          )}
        </section>
        <section className="report-card__section">
          <h4 className="report-card__section-title">上半月 vs 下半月</h4>
          {d.half_shift.length > 0 ? (
            <ReportHalfShift shifts={d.half_shift} />
          ) : (
            <p className="report-card__empty">无数据</p>
          )}
        </section>
      </div>
    </>
  );
}

function ReportCard({
  detail,
  icons,
  showFooter = false,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  showFooter?: boolean;
}) {
  return (
    <div className="report-card" style={{ width: EXPORT_WIDTH }}>
      <div className="report-card__body">
        {detail.report_type === "week" ? (
          <WeekBody detail={detail} icons={icons} />
        ) : detail.report_type === "month" ? (
          <MonthBody detail={detail} icons={icons} />
        ) : (
          <DayBody detail={detail} icons={icons} />
        )}
      </div>
      {showFooter && <ReportFooter />}
    </div>
  );
}

// memo：灯箱缩放/平移只改 .lightbox__scaled 的 transform，props 不变时跳过整棵海报 DOM 的重渲染。
export default memo(ReportCard);
