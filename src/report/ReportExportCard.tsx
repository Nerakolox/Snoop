/**
 * 报告导出成图（批次 7）—— 独立导出版式，非应用内卡片放大。
 *
 * 与 Report.tsx 的详情卡是**两套版式**：详情卡是给自己看的密集清单，导出卡是分享给别人
 * 扫一眼的「低密度」海报。共用 `formatDuration` / 分类色板 / 小日期助手 / 字母兜底图标视觉，
 * 但条形一律 accent 单色（不复用时间线的暖色强度轴），时长口径在文案里标清。
 *
 * 竖版 1080×1920 放全模块，方版 1080×1350 只留「核心叙事 + 一张主视觉 + 一个分类占比」。
 * 所有图片资源（Snoop 图标 / 二维码 `?inline`、app 图标 data URI）都是 data URI，保证
 * foreignObject → canvas 不被污染。
 */

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
import { formatDuration } from "../utils/format";
import { CATEGORY_COLOR, CATEGORY_LABEL } from "../ai/categories";
import { DOW_LABELS, dateLabel, formatSleepMin, monthLabel, weekRangeLabel } from "./format";
import { EXPORT_SIZES, type ExportSize } from "./export";
import snoopIconInline from "../assets/snoop-icon-64.png?inline";
import qrInline from "../assets/qr-official.png?inline";

/** 已解析的 app 图标：bundleId → base64（无图标为 null）。由 ExportDialog 预取后传入。 */
export type ResolvedIconMap = Map<string, string | null>;

const SNOOP_BUNDLE_ID = "org.feedra.snoop";

/** 方版叙事按字符截断（约 2 行）。line-clamp 在 foreignObject 里保真度不可靠，用字符兜底。 */
const NARRATIVE_CLAMP = 108;

function clampText(text: string): string {
  return text.length > NARRATIVE_CLAMP ? `${text.slice(0, NARRATIVE_CLAMP)}…` : text;
}

/** 字母兜底图标的主题色，与 AppIcon.tsx 的 colorFromName 算法一致。 */
function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

function ExportIcon({
  bundleId,
  name,
  icons,
}: {
  bundleId: string;
  name: string;
  icons: ResolvedIconMap;
}) {
  if (bundleId === SNOOP_BUNDLE_ID) {
    return <img className="export-app-icon" src={snoopIconInline} alt="" />;
  }
  const data = icons.get(bundleId);
  if (data) {
    return <img className="export-app-icon" src={`data:image/png;base64,${data}`} alt="" />;
  }
  const letter = (name.charAt(0) || "?").toUpperCase();
  return (
    <div className="export-app-icon--fallback" style={{ backgroundColor: colorFromName(name) }}>
      {letter}
    </div>
  );
}

function ExportAppBars({ apps, icons }: { apps: AppRank[]; icons: ResolvedIconMap }) {
  if (apps.length === 0) return <p className="export-empty">无数据</p>;
  const max = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="export-apps">
      {apps.map((a) => (
        <div key={a.bundle_id} className="export-app-row">
          <ExportIcon bundleId={a.bundle_id} name={a.name} icons={icons} />
          <div className="export-app-name">
            <span>{a.name}</span>
          </div>
          <div className="export-app-track">
            <div
              className="export-app-fill"
              style={{ width: `${(a.active_ms / max) * 100}%` }}
            />
          </div>
          <div className="export-app-meta">
            <span>{formatDuration(a.active_ms)}</span>
            <span className="export-app-pct">{a.share_pct.toFixed(0)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ExportCategoryStack({ categories }: { categories: CategoryShare[] }) {
  if (categories.length === 0) return <p className="export-empty">无数据</p>;
  return (
    <>
      <div className="export-cat-stack">
        {categories.map((c) => (
          <div
            key={c.category}
            className="export-cat-seg"
            style={{ width: `${c.share_pct}%`, background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
          />
        ))}
      </div>
      <div className="export-cat-legend">
        {categories.map((c) => (
          <div key={c.category} className="export-cat-row">
            <span
              className="export-cat-swatch"
              style={{ background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
            />
            <span className="export-cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
            <span className="export-cat-time">{formatDuration(c.active_ms)}</span>
            <span className="export-cat-pct">{c.share_pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}

function ExportCategoryDeltaBars({ categories }: { categories: CategoryDelta[] }) {
  if (categories.length === 0) return <p className="export-empty">无数据</p>;
  return (
    <div className="export-cat-legend">
      {categories.map((c) => (
        <div key={c.category} className="export-cat-row">
          <span
            className="export-cat-swatch"
            style={{ background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
          />
          <span className="export-cat-label">{CATEGORY_LABEL[c.category] ?? c.category}</span>
          <span className="export-cat-time">{formatDuration(c.active_ms)}</span>
          <span className="export-cat-pct">{c.share_pct.toFixed(0)}%</span>
          <span className="export-cat-delta">
            {c.share_delta_pp >= 0 ? "↑" : "↓"}
            {Math.abs(c.share_delta_pp).toFixed(1)}pp
          </span>
        </div>
      ))}
    </div>
  );
}

function ExportRhythm({ hourly }: { hourly: HourCell[] }) {
  const max = Math.max(...hourly.map((h) => h.active_ms), 1);
  return (
    <>
      <div className="export-rhythm">
        {hourly.map((h) => (
          <div key={h.hour} className="export-rhythm-col">
            <div
              className="export-rhythm-bar"
              style={{
                height: `${Math.max((h.active_ms / max) * 100, h.active_ms > 0 ? 2 : 0)}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="export-rhythm-scale">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </>
  );
}

function ExportWeekBars({
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
      <div className="export-bars">
        {days.map((d) => (
          <div key={d.date} className="export-bars-col">
            <div className="export-bars-track export-bars-track--week">
              <div
                className={`export-bars-fill${d.date === maxDay ? " export-bars-fill--max" : ""}`}
                style={{ height: `${Math.max((d.active_ms / max) * 100, 2)}%` }}
              />
            </div>
            <span className="export-bars-day">{DOW_LABELS[d.dow]}</span>
          </div>
        ))}
      </div>
      {maxDay && minDay && (
        <p className="export-bars-legend">
          最高 {dateLabel(maxDay)} · 最低 {dateLabel(minDay)}
        </p>
      )}
    </>
  );
}

function ExportMonthWeeks({ weeks }: { weeks: MonthWeek[] }) {
  const max = Math.max(...weeks.map((w) => w.active_ms), 1);
  return (
    <div className="export-bars">
      {weeks.map((w) => (
        <div key={w.week_start} className="export-bars-col">
          <div className="export-bars-track export-bars-track--month">
            <div
              className="export-bars-fill"
              style={{ height: `${Math.max((w.active_ms / max) * 100, 2)}%` }}
            />
          </div>
          {w.partial ? (
            <span className="export-bars-day">{w.days_in_month}天</span>
          ) : (
            <span className="export-bars-day"> </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ExportSleep({ days, summary }: { days: RhythmDay[]; summary: RhythmSummary }) {
  return (
    <>
      <div className="export-sleep">
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
            <div key={d.date} className="export-sleep-row">
              <span className="export-sleep-day">{DOW_LABELS[i]}</span>
              <span className="export-sleep-times">
                {start} → {end}
              </span>
              {!d.counted && d.active_ms > 0 && (
                <span className="export-sleep-note">未计入均值</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="export-sleep-avg">
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

function ExportHalfShift({ shifts }: { shifts: CategoryHalfShift[] }) {
  return (
    <div className="export-halfshift">
      {shifts.slice(0, 5).map((h) => (
        <div key={h.category} className="export-halfshift-row">
          <span className="export-halfshift-name">{CATEGORY_LABEL[h.category] ?? h.category}</span>
          <span className="export-halfshift-values">
            {h.first_half_share_pct.toFixed(0)}% → {h.second_half_share_pct.toFixed(0)}%
          </span>
          <span className="export-halfshift-delta">
            {h.delta_pp >= 0 ? "↑" : "↓"}
            {Math.abs(h.delta_pp).toFixed(1)}pp
          </span>
        </div>
      ))}
    </div>
  );
}

function ExportDelta({ label, pct }: { label: string; pct: number }) {
  const up = pct >= 0;
  return (
    <div className="export-compare-item">
      <span className="export-compare-label">{label}</span>
      <span className="export-compare-value">
        {up ? "↑" : "↓"} {Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  );
}

function ExportNarrative({
  text,
  source,
  clamp,
}: {
  text: string | null;
  source: string | null;
  clamp?: boolean;
}) {
  if (!text) return null;
  const shown = clamp ? clampText(text) : text;
  return (
    <p className="export-narrative">
      {shown}
      {source && (
        <span className="export-narrative__source">
          {source === "ai" ? "由 AI 生成" : "本地模板"}
        </span>
      )}
    </p>
  );
}

function ExportAppChange({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="export-app-change">
      <span className="export-app-change-label">{label}</span>
      <span>{names.join(" · ")}</span>
    </div>
  );
}

function ExportFooter() {
  return (
    <div className="report-export__footer">
      <div className="export-footer__brand">
        <img className="export-footer__brand-icon" src={snoopIconInline} alt="Snoop" />
        <span className="export-footer__brand-name">Snoop</span>
      </div>
      <div className="export-footer__link">
        <span className="export-footer__url">snoop.feedra.org</span>
        <img className="export-footer__qr" src={qrInline} alt="snoop.feedra.org" />
      </div>
    </div>
  );
}

// ── 三报主体 ───────────────────────────────────────────────────────────────

type BodyProps<T> = {
  detail: T;
  size: ExportSize;
  icons: ResolvedIconMap;
};

function DayBody({
  detail,
  size,
  icons,
}: BodyProps<Extract<ReportView, { report_type: "day" }>>) {
  const d = detail.data;
  const square = size === "square";
  return (
    <>
      <div className="export-head">
        <div className="export-head__title">{dateLabel(d.date)}</div>
        <div className="export-head__label">活跃时长（有输入）</div>
        <div className="export-head__active">{formatDuration(d.active_ms)}</div>
        <div className="export-head__sub">
          前台时长 {formatDuration(d.foreground_ms)} · 切换 {d.switch_count} 次
        </div>
      </div>

      <ExportNarrative text={detail.narrative} source={detail.narrative_source} clamp={square} />

      <section className="export-section">
        <h4 className="export-section__title">
          分类占比<span className="export-section__note">按活跃时长统计</span>
        </h4>
        <ExportCategoryStack categories={d.categories} />
      </section>

      {square ? (
        <section className="export-section">
          <h4 className="export-section__title">应用 Top 3</h4>
          <ExportAppBars apps={d.top_apps.slice(0, 3)} icons={icons} />
        </section>
      ) : (
        <>
          <section className="export-section">
            <h4 className="export-section__title">应用 Top 5</h4>
            <ExportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
          </section>

          <section className="export-section">
            <h4 className="export-section__title">24 小时节奏</h4>
            <ExportRhythm hourly={d.hourly} />
          </section>

          {d.vs_7d.avg_active_ms > 0 && (
            <section className="export-section">
              <h4 className="export-section__title">近 7 天对比</h4>
              <div className="export-head__delta">
                <ExportDelta label="活跃时长" pct={d.vs_7d.active_delta_pct} />
                <ExportDelta label="切换次数" pct={d.vs_7d.switch_delta_pct} />
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function WeekBody({
  detail,
  size,
  icons,
}: BodyProps<Extract<ReportView, { report_type: "week" }>>) {
  const d = detail.data;
  const square = size === "square";
  return (
    <>
      <div className="export-head">
        <div className="export-head__title">{weekRangeLabel(d.week_start)}</div>
        <div className="export-head__label">活跃时长（有输入）</div>
        <div className="export-head__active">{formatDuration(d.active_ms)}</div>
        <div className="export-head__sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 前台时长{" "}
          {formatDuration(d.foreground_ms)}
        </div>
        {!square && d.baseline.avg_daily_active_ms > 0 && (
          <div className="export-head__delta">
            <ExportDelta label="vs 前 4 周日均" pct={d.baseline.daily_delta_pct} />
          </div>
        )}
      </div>

      <ExportNarrative text={detail.narrative} source={detail.narrative_source} clamp={square} />

      <section className="export-section">
        <h4 className="export-section__title">这一周</h4>
        <ExportWeekBars days={d.days} maxDay={d.max_day} minDay={d.min_day} />
      </section>

      {square ? (
        <section className="export-section">
          <h4 className="export-section__title">
            分类 Top 4<span className="export-section__note">按活跃时长统计</span>
          </h4>
          <ExportCategoryDeltaBars categories={d.categories.slice(0, 4)} />
        </section>
      ) : (
        <>
          {d.rhythm_summary.days_counted >= 3 && (
            <section className="export-section">
              <h4 className="export-section__title">作息</h4>
              <ExportSleep days={d.rhythm} summary={d.rhythm_summary} />
            </section>
          )}

          <section className="export-section">
            <h4 className="export-section__title">
              分类占比<span className="export-section__note">vs 前 4 周 · 按活跃时长统计</span>
            </h4>
            <ExportCategoryDeltaBars categories={d.categories} />
          </section>

          <section className="export-section">
            <h4 className="export-section__title">应用 Top 5</h4>
            <ExportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
            <ExportAppChange label="本周新出现" names={d.new_apps.map((a) => a.name)} />
            <ExportAppChange label="本周消失" names={d.gone_apps.map((a) => a.name)} />
          </section>

          <section className="export-section">
            <h4 className="export-section__title">工作日 vs 周末</h4>
            <div className="export-weekend">
              <span>工作日日均 {formatDuration(d.weekday_weekend.weekday_avg_active_ms)}</span>
              <span>周末日均 {formatDuration(d.weekday_weekend.weekend_avg_active_ms)}</span>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function MonthBody({
  detail,
  size,
  icons,
}: BodyProps<Extract<ReportView, { report_type: "month" }>>) {
  const d = detail.data;
  const square = size === "square";
  return (
    <>
      <div className="export-head">
        <div className="export-head__title">{monthLabel(d.month_start)}</div>
        <div className="export-head__label">活跃时长（有输入）</div>
        <div className="export-head__active">{formatDuration(d.active_ms)}</div>
        <div className="export-head__sub">
          日均 {formatDuration(d.avg_daily_active_ms)} · 前台时长{" "}
          {formatDuration(d.foreground_ms)} · 有记录 {d.days_with_data} 天
        </div>
        {!square && d.prev_month.avg_daily_active_ms > 0 && (
          <div className="export-head__delta">
            <ExportDelta label="vs 上月日均" pct={d.prev_month.daily_delta_pct} />
          </div>
        )}
      </div>

      <ExportNarrative text={detail.narrative} source={detail.narrative_source} clamp={square} />

      <section className="export-section">
        <h4 className="export-section__title">按周走势</h4>
        <ExportMonthWeeks weeks={d.weeks} />
      </section>

      {square ? (
        <section className="export-section">
          <h4 className="export-section__title">
            分类占比<span className="export-section__note">按活跃时长统计</span>
          </h4>
          <ExportCategoryStack categories={d.categories} />
        </section>
      ) : (
        <>
          {d.half_shift.length > 0 && (
            <section className="export-section">
              <h4 className="export-section__title">上半月 vs 下半月</h4>
              <ExportHalfShift shifts={d.half_shift} />
            </section>
          )}

          {d.max_day && d.min_day && (
            <section className="export-section">
              <h4 className="export-section__title">峰值日</h4>
              <div className="export-weekend">
                <span>
                  最活跃 {dateLabel(d.max_day.date)} · {formatDuration(d.max_day.active_ms)}
                </span>
                <span>
                  最安静 {dateLabel(d.min_day.date)} · {formatDuration(d.min_day.active_ms)}
                </span>
              </div>
            </section>
          )}

          <section className="export-section">
            <h4 className="export-section__title">
              分类占比<span className="export-section__note">按活跃时长统计</span>
            </h4>
            <ExportCategoryStack categories={d.categories} />
          </section>

          <section className="export-section">
            <h4 className="export-section__title">应用 Top 5</h4>
            <ExportAppBars apps={d.top_apps.slice(0, 5)} icons={icons} />
            <ExportAppChange label="整月新增" names={d.new_apps.map((a) => a.name)} />
          </section>
        </>
      )}
    </>
  );
}

export default function ReportExportCard({
  detail,
  size,
  icons,
}: {
  detail: ReportView;
  size: ExportSize;
  icons: ResolvedIconMap;
}) {
  const { width, height } = EXPORT_SIZES[size];
  const sizeClass = size === "vertical" ? "report-export--vertical" : "report-export--square";
  return (
    <div className={`report-export ${sizeClass}`} style={{ width, height }}>
      <div className="report-export__main">
        {detail.report_type === "week" ? (
          <WeekBody
            detail={detail as Extract<ReportView, { report_type: "week" }>}
            size={size}
            icons={icons}
          />
        ) : detail.report_type === "month" ? (
          <MonthBody
            detail={detail as Extract<ReportView, { report_type: "month" }>}
            size={size}
            icons={icons}
          />
        ) : (
          <DayBody
            detail={detail as Extract<ReportView, { report_type: "day" }>}
            size={size}
            icons={icons}
          />
        )}
      </div>
      <ExportFooter />
    </div>
  );
}
