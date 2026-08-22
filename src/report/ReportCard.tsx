/**
 * 报告卡片（海报）—— 应用内缩略图、灯箱、「导出成图」三处共用的**同一份**版式。
 *
 * 版式只有这一份真源：固定 1000px 宽、高度按内容自适应。`showFooter` 控制是否渲染
 * footer（Snoop 品牌 + 域名 + 二维码），三处都渲染完整海报。收起交互不再在卡片内
 * （见 ReportSummary 的头部），本组件只负责「海报」本身。
 *
 * 版式规范（见 report-card.css 的 `--rc-*` token）：
 *   - 固定 1000px 宽，高度按内容自适应（不锁比例、不裁切）
 *   - 左右边距 66px、模块间距 46px、模块内元素间距 16px
 *   - 字号 5 档：大数字 / 模块标题 / 正文 / 数值 / 辅助（数字一律 mono）
 *   - footer 整条品牌紫，与顶部紫色大数字首尾呼应
 *   - 固定浅色（发给别人看的图不该是深色），应用内也保持同一张浅色「报告纸」
 *
 * 所有图片资源（Snoop 图标 / 二维码 `?inline`、app 图标 data URI）都是 data URI，
 * 保证 foreignObject → canvas 不被污染。
 */

import { memo } from "react";
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
import { formatDuration, formatSharePct } from "../utils/format";
import { CATEGORY_LABEL, shareColorLight } from "../ai/categories";
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
            <span>{formatDuration(a.active_ms)}</span>
            <span className="report-card__app-pct">{a.share_pct.toFixed(0)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportCategoryStack({ categories }: { categories: CategoryShare[] }) {
  const shown = categories.filter((c) => c.active_ms > 0);
  if (shown.length === 0) return <p className="report-card__empty">无数据</p>;
  return (
    <>
      <div className="report-card__cat-stack">
        {shown.map((c, i) => (
          <div
            key={c.category}
            className="report-card__cat-seg"
            style={{ width: `${c.share_pct}%`, background: shareColorLight(i) }}
          />
        ))}
      </div>
      <div className="report-card__cat-legend">
        {shown.map((c, i) => (
          <div key={c.category} className="report-card__cat-row">
            <span
              className="report-card__cat-swatch"
              style={{ background: shareColorLight(i) }}
            />
            <span className="report-card__cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
            <span className="report-card__cat-time">{formatDuration(c.active_ms)}</span>
            <span className="report-card__cat-pct">{formatSharePct(c.share_pct)}</span>
          </div>
        ))}
      </div>
    </>
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
  return (
    <div className="report-card__cat-legend">
      {shown.map((c, i) => (
        <div key={c.category} className="report-card__cat-row">
          <span
            className="report-card__cat-swatch"
            style={{ background: shareColorLight(i) }}
          />
          <span className="report-card__cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
          <span className="report-card__cat-time">{formatDuration(c.active_ms)}</span>
          <span className="report-card__cat-pct">{formatSharePct(c.share_pct)}</span>
          {showDelta && (
            <span className="report-card__cat-delta">
              {c.share_delta_pp >= 0 ? "↑" : "↓"}
              {Math.abs(c.share_delta_pp).toFixed(1)}pp
            </span>
          )}
        </div>
      ))}
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
        {days.map((d) => (
          <div key={d.date} className="report-card__bars-col">
            <div className="report-card__bars-track report-card__bars-track--week">
              <div
                className={`report-card__bars-fill${d.date === maxDay ? " report-card__bars-fill--max" : ""}`}
                style={{ height: `${Math.max((d.active_ms / max) * 100, 2)}%` }}
              />
            </div>
            <span className="report-card__bars-day">{DOW_LABELS[d.dow]}</span>
          </div>
        ))}
      </div>
      {maxDay && minDay && (
        <p className="report-card__bars-legend">
          最高 {dateLabel(maxDay)} · 最低 {dateLabel(minDay)}
        </p>
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

function ReportSleep({ days, summary }: { days: RhythmDay[]; summary: RhythmSummary }) {
  return (
    <>
      <div className="report-card__sleep">
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
            <div key={d.date} className="report-card__sleep-row">
              <span className="report-card__sleep-day">{DOW_LABELS[i]}</span>
              <span className="report-card__sleep-times">
                {start} → {end}
              </span>
              {!d.counted && d.active_ms > 0 && (
                <span className="report-card__sleep-note">未计入均值</span>
              )}
            </div>
          );
        })}
      </div>
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
          <span className="report-card__halfshift-name">{CATEGORY_LABEL[h.category] ?? h.category}</span>
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

function ReportDelta({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="report-card__compare-item">
      <span className="report-card__compare-label">{label}</span>
      <span className="report-card__compare-value">{deltaLabel(pct)}</span>
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
  return (
    <>
      <div className="report-card__head">
        <div className="report-card__head-title">{dateLabel(d.date)}</div>
        <div className="report-card__head-label">活跃时长（有输入）</div>
        <div className="report-card__head-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card__head-sub">
          前台时长 {formatDuration(d.foreground_ms)} · 切换 {d.switch_count} 次
        </div>
      </div>

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

      {d.vs_7d.avg_active_ms > 0 && (
        <section className="report-card__section">
          <h4 className="report-card__section-title">近 7 天对比</h4>
          {d.vs_7d.avg_active_ms >= BASELINE_MIN_DAILY_MS ? (
            <div className="report-card__head-delta">
              <ReportDelta label="活跃时长" pct={d.vs_7d.active_delta_pct} />
              <ReportDelta label="切换次数" pct={d.vs_7d.switch_delta_pct} />
            </div>
          ) : (
            <p className="report-card__baseline-pending">记录时间还不够，过几天再来对比</p>
          )}
        </section>
      )}
    </>
  );
}

function WeekBody({ detail, icons }: BodyProps) {
  const d = (detail as Extract<ReportView, { report_type: "week" }>).data;
  return (
    <>
      <div className="report-card__head">
        <div className="report-card__head-title">{weekRangeLabel(d.week_start)}</div>
        <div className="report-card__head-label">活跃时长（有输入）</div>
        <div className="report-card__head-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card__head-sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 前台时长{" "}
          {formatDuration(d.foreground_ms)}
        </div>
        {d.baseline.baseline_sufficient ? (
          <div className="report-card__head-delta">
            <ReportDelta label="vs 前 4 周日均" pct={d.baseline.daily_delta_pct} />
          </div>
        ) : (
          <p className="report-card__baseline-pending">记录时间还不够，下周开始对比</p>
        )}
      </div>

      <ReportNarrative text={detail.narrative} />

      <section className="report-card__section">
        <h4 className="report-card__section-title">这一周</h4>
        <ReportWeekBars days={d.days} maxDay={d.max_day} minDay={d.min_day} />
      </section>

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

      <section className="report-card__section">
        <h4 className="report-card__section-title">应用 Top 5</h4>
        <ReportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
        <ReportAppChange label="本周新出现" names={d.new_apps.map((a) => a.name)} />
        <ReportAppChange label="本周消失" names={d.gone_apps.map((a) => a.name)} />
      </section>

      <section className="report-card__section">
        <h4 className="report-card__section-title">工作日 vs 周末</h4>
        <div className="report-card__weekend">
          <span>工作日日均 {formatDuration(d.weekday_weekend.weekday_avg_active_ms)}</span>
          <span>周末日均 {formatDuration(d.weekday_weekend.weekend_avg_active_ms)}</span>
        </div>
      </section>
    </>
  );
}

function MonthBody({ detail, icons }: BodyProps) {
  const d = (detail as Extract<ReportView, { report_type: "month" }>).data;
  return (
    <>
      <div className="report-card__head">
        <div className="report-card__head-title">{monthLabel(d.month_start)}</div>
        <div className="report-card__head-label">活跃时长（有输入）</div>
        <div className="report-card__head-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card__head-sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 前台时长{" "}
          {formatDuration(d.foreground_ms)} · 有记录 {d.days_with_data} 天
        </div>
        {d.prev_month.avg_daily_active_ms > 0 && (
          <div className="report-card__head-delta">
            <ReportDelta label="vs 上月日均" pct={d.prev_month.daily_delta_pct} />
          </div>
        )}
      </div>

      <ReportNarrative text={detail.narrative} />

      <section className="report-card__section">
        <h4 className="report-card__section-title">按周走势</h4>
        <ReportMonthWeeks weeks={d.weeks} />
      </section>

      {d.half_shift.length > 0 && (
        <section className="report-card__section">
          <h4 className="report-card__section-title">上半月 vs 下半月</h4>
          <ReportHalfShift shifts={d.half_shift} />
        </section>
      )}

      {d.max_day && d.min_day && (
        <section className="report-card__section">
          <h4 className="report-card__section-title">峰值日</h4>
          <div className="report-card__weekend">
            <span>
              最活跃 {dateLabel(d.max_day.date)} · {formatDuration(d.max_day.active_ms)}
            </span>
            <span>
              最安静 {dateLabel(d.min_day.date)} · {formatDuration(d.min_day.active_ms)}
            </span>
          </div>
        </section>
      )}

      <section className="report-card__section">
        <h4 className="report-card__section-title">
          分类占比<span className="report-card__section-note">按活跃时长统计</span>
        </h4>
        <ReportCategoryStack categories={d.categories} />
      </section>

      <section className="report-card__section">
        <h4 className="report-card__section-title">应用 Top 5</h4>
        <ReportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
        <ReportAppChange label="整月新增" names={d.new_apps.map((a) => a.name)} />
      </section>
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
