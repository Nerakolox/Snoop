/**
 * 报告杂志版式 —— 应用内详情、海报灯箱、导出成图三处共用的**同一张纸**。
 *
 * 结构照抄 `Snoop-demos/报告页面-261109` 的三份样稿：报头 → 封面标题 → 三个编号栏目，
 * 日报 / 周刊 / 月刊共用同一套骨架，只换正文模块。
 *
 * 三条硬约定：
 *   1. 纸张恒为浅色（`--rs-paper`），不跟随应用深色主题；发给别人看的图不该是深色。
 *   2. 版式不靠 media / container query，而是由 ResizeObserver 算出 `data-layout`
 *      （wide / mid / narrow）写回根节点 —— foreignObject 导出时媒体查询不可靠。
 *   3. 所有颜色 / 字号 / 间距都走 `.rsheet` 内的 token，且 `sheet.css` 无外部依赖，
 *      `?inline` 塞进导出 SVG 后仍能独立渲染。
 *
 * 文字分工见 `copy.ts`：事实句由数据算，毒舌旁批与标题由 AI 给（历史报告走兜底）。
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppRank, DailyReport, ReportView, WeeklyReport } from "../types";
import { formatDurationCompact } from "../../utils/format";
import { DOW_LABELS, formatSleepMin } from "../format";
import { renderNarrativeLine } from "../markup";
import type { ResolvedIconMap } from "../icons";
import {
  annotationFor,
  asideHeadingFor,
  bigTimeParts,
  chartHeadFor,
  clockFromMs,
  closingFor,
  comparisonFor,
  dailyFocus,
  dailyTimebook,
  dateParts,
  eveningShare,
  headlineFor,
  hourRangeMs,
  introFor,
  issueLeft,
  issueRightFor,
  kindMeta,
  nightMarks,
  pickBusiestDay,
  pickQuietestDay,
  pullQuoteFor,
  sectionHeadingFor,
  sectionTitleFor,
  spanText,
  topCategory,
  weeklyNightSummary,
} from "./copy";
import {
  CategoryBars,
  CategoryDeltaBars,
  HourlyChart,
  MonthCalendar,
  NightDots,
  ShiftBars,
  WeekBars,
  WeekTrend,
} from "./charts";
import snoopIconInline from "../../assets/snoop-icon-64.png?inline";
import "./sheet.css";

const SNOOP_BUNDLE_ID = "org.feedra.snoop";

type Layout = "wide" | "mid" | "narrow";

/** 应用条 / 排行只需要这几个字段，日报快照与周报 derived 列表都能复用。 */
type StripApp = {
  bundle_id: string;
  name: string;
  active_ms: number;
  category_name?: string;
};

// ── 小部件 ──────────────────────────────────────────────────────────────────

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`;
}

function AppIcon({
  bundleId,
  name,
  icons,
  small,
}: {
  bundleId: string;
  name: string;
  icons: ResolvedIconMap | null;
  small?: boolean;
}) {
  const cls = `rs-icon${small ? " rs-icon--small" : ""}`;
  if (bundleId === SNOOP_BUNDLE_ID) {
    return <img className={cls} src={snoopIconInline} alt="" />;
  }
  const data = icons?.get(bundleId);
  if (data) {
    return <img className={cls} src={`data:image/png;base64,${data}`} alt="" />;
  }
  return (
    <span className={`${cls} rs-icon--fallback`} style={{ background: colorFromName(name) }}>
      {(name.charAt(0) || "?").toUpperCase()}
    </span>
  );
}

function SectionLabel({ num, title, en }: { num: string; title: string; en: string }) {
  return (
    <div className="rs-section-label">
      <span className="rs-section-label__num">{num}</span>
      <span>{title}</span>
      <small>{en}</small>
    </div>
  );
}

function Annotation({
  children,
  signature,
  className = "",
}: {
  children: ReactNode;
  signature: string;
  className?: string;
}) {
  return (
    <div className={`rs-annotation ${className}`.trim()}>
      {children}
      <span className="rs-signature">{signature}</span>
    </div>
  );
}

function Quip({ text }: { text: string }) {
  return <>{renderNarrativeLine(text)}</>;
}

/** AI 标题可能带 `\n`：逐行渲染，行间换行；每行仍支持 `{{em:}}` / `{{n:}}`。 */
function HeadingText({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {renderNarrativeLine(line)}
        </span>
      ))}
    </>
  );
}

/** 标题尾句自动上紫色强调：取最后 2–6 个字（连同句末标点）。 */
function Headline({ text }: { text: string }) {
  const m = /^([\s\S]*?)([^，。！？；：、]{2,6}[。！？]?)$/.exec(text);
  if (!m || !m[1]) return <>{text}</>;
  return (
    <>
      {m[1]}
      <em>{m[2]}</em>
    </>
  );
}

function BigTime({ ms }: { ms: number }) {
  return (
    <div className="rs-big-time">
      {bigTimeParts(ms).map((p) => (
        <span key={p.unit} className="rs-big-time__part">
          <strong>{p.value}</strong>
          <span>{p.unit}</span>
        </span>
      ))}
    </div>
  );
}

function Footnotes({
  firstHead,
  firstBody,
  chips,
  secondHead,
  secondBody,
}: {
  firstHead: string;
  firstBody: ReactNode;
  chips?: string[];
  secondHead: string;
  secondBody: ReactNode;
}) {
  return (
    <section className="rs-footnotes" aria-label="本页边栏">
      <div>
        <div className="rs-footnote-head">{firstHead}</div>
        <p>{firstBody}</p>
        {chips && chips.length > 0 && (
          <div className="rs-new-apps">
            {chips.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="rs-footnote-head">{secondHead}</div>
        <p>{secondBody}</p>
      </div>
    </section>
  );
}

// ── 报头 / 封面 ──────────────────────────────────────────────────────────────

function Masthead({ detail }: { detail: ReportView }) {
  const meta = kindMeta(detail);
  return (
    <header className="rs-masthead">
      <div className="rs-masthead__top">
        <div className="rs-brand">
          Snoop<i />
          <span>{meta.brandSub}</span>
        </div>
        <div className="rs-edition">{meta.edition}</div>
      </div>
      <div className="rs-issue-line">
        <span>{issueLeft(detail)}</span>
        <span>{issueRightFor(detail)}</span>
      </div>
    </header>
  );
}

function Hero({
  detail,
  activeLabel,
  mini,
}: {
  detail: ReportView;
  activeLabel: string;
  mini: { value: string; label: string }[];
}) {
  const cmp = comparisonFor(detail);
  return (
    <section className="rs-hero">
      <div className="rs-hero__main">
        <p className="rs-eyebrow">{kindMeta(detail).eyebrow}</p>
        <h1>
          <Headline text={headlineFor(detail)} />
        </h1>
        <p className="rs-intro">{renderNarrativeLine(introFor(detail))}</p>
      </div>
      <aside className="rs-hero-stat">
        <div className="rs-stat-label">{activeLabel}</div>
        <BigTime ms={detail.data.active_ms} />
        <div className="rs-comparison">
          <strong>{cmp.text}</strong>
          <br />
          {cmp.note}
        </div>
        <div className="rs-mini-stats">
          {mini.map((m) => (
            <div key={m.label}>
              <b>{m.value}</b>
              <span>{m.label}</span>
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}

// ── 日报 ────────────────────────────────────────────────────────────────────

function DaySheet({ detail, icons }: { detail: Extract<ReportView, { report_type: "day" }>; icons: ResolvedIconMap | null }) {
  const d: DailyReport = detail.data;
  const title01 = sectionTitleFor(detail, "01");
  const title02 = sectionTitleFor(detail, "02");
  const title03 = sectionTitleFor(detail, "03");
  const h01 = sectionHeadingFor(detail, "01");
  const h02 = sectionHeadingFor(detail, "02");
  const h03 = sectionHeadingFor(detail, "03");
  const asideHead = asideHeadingFor(detail);
  const ann01 = annotationFor(detail, "01");
  const ann02 = annotationFor(detail, "02");
  const ann03 = annotationFor(detail, "03");
  const pullQuote = pullQuoteFor(detail);
  const closing = closingFor(detail);
  const peakMs = d.hourly.find((h) => h.hour === d.peak_hour)?.active_ms ?? 0;
  const eveningMs = hourRangeMs(d, 18, 24);
  const evening = eveningShare(d);
  const focus = dailyFocus(d);
  const topCat = topCategory(detail);
  const topApp = d.top_apps[0] ?? null;
  const top3Share = d.top_apps.slice(0, 3).reduce((s, a) => s + a.share_pct, 0);
  const switchAvg = d.vs_7d.avg_switch_count;
  const switchDiff = switchAvg > 0 ? d.switch_count - switchAvg : 0;
  const switchPct = Math.abs(Math.round(d.vs_7d.switch_delta_pct));

  return (
    <>
      <Masthead detail={detail} />
      <Hero
        detail={detail}
        activeLabel="今日输入活跃"
        mini={[
          { value: `${String(d.peak_hour).padStart(2, "0")}:00`, label: "峰值小时" },
          { value: `${d.switch_count} 次`, label: "应用切换" },
        ]}
      />

      <SectionLabel num="01" title={title01} en="THE DAY TAKES SHAPE" />
      <div className="rs-rhythm">
        <figure className="rs-hourly-figure">
          <HourlyChart d={d} eveningPct={evening} lead={chartHeadFor(detail, "hourly")} />
          <figcaption className="rs-chart-caption">
            {`18:00—24:00 累计 ${formatDurationCompact(eveningMs)}；${String(d.peak_hour).padStart(2, "0")}:00—${String(
              (d.peak_hour + 1) % 24,
            ).padStart(2, "0")}:00 是今天输入最密集的一小时。`}
          </figcaption>
        </figure>
        <aside className="rs-note">
          <h2>
            {h01 ? (
              <HeadingText lines={h01} />
            ) : d.peak_hour >= 18 ? (
              <>
                白天是铺垫，
                <br />
                晚上才真正开场。
              </>
            ) : (
              <>
                今天的重心，
                <br />
                落在白天。
              </>
            )}
          </h2>
          <p>
            {String(d.peak_hour).padStart(2, "0")} 点这一小时累计{" "}
            <strong>{formatDurationCompact(peakMs)}</strong>，晚间合计{" "}
            <strong>{formatDurationCompact(eveningMs)}</strong>，占全天的{" "}
            <strong>{Math.round(evening * 100)}%</strong>。
          </p>
          <p>{`首条记录 ${clockFromMs(d.span_start_ms)}，末条 ${clockFromMs(d.span_end_ms)}，跨度 ${spanText(
            d.span_end_ms - d.span_start_ms,
          )}。`}</p>
        </aside>
      </div>

      {/* 旁批跨整行：右栏只有 225px，长句会被挤成窄条；放在两栏之后正好填满图表下方的留白。 */}
      <Annotation signature="— SNOOP 旁批" className="rs-annotation--wide">
        <Quip text={ann01} />
      </Annotation>

      <div className="rs-timebook">
        {dailyTimebook(d).map((t) => (
          <article key={t.time}>
            <time>{t.time}</time>
            <h3>{t.title}</h3>
            <p>{t.text}</p>
          </article>
        ))}
      </div>

      <div className="rs-pullquote rs-daily-pull">
        <div className="rs-ratio">
          {focus.minutes}
          <small>分</small>
        </div>
        <p>
          {focus.start}—{focus.end}，
          <br />
          {pullQuote ? (
            <HeadingText lines={pullQuote.split("\n")} />
          ) : (
            "今天最长的一段连续活动。"
          )}
        </p>
        <p className="rs-explain">
          相邻输入间隙不超过 5 分钟，跨应用也会合并。它描述连续活动的跨度，不把这段时间直接判定为「深度专注」。
        </p>
      </div>

      <SectionLabel num="02" title={title02} en="A LITTLE MORE CONVERSATION" />
      <div className="rs-distribution">
        <article className="rs-story">
          <div className="rs-kicker">
            时间去向 / {topCat ? `${topCat.name}占比 ${Math.round(topCat.share_pct)}%` : "暂无分类"}
          </div>
          <h2>
            {h02 ? (
              <HeadingText lines={h02} />
            ) : topCat ? (
              <>
                今天最多的时间，
                <br />
                给了{topCat.name}。
              </>
            ) : (
              <>
                今天的电脑，
                <br />
                没有特别偏爱谁。
              </>
            )}
          </h2>
          <p>
            {topApp ? (
              <>
                <strong>
                  {topApp.name} 占了 {formatDurationCompact(topApp.active_ms)}
                </strong>
                ，是今天输入活跃最多的应用。
              </>
            ) : (
              "今天没有留下应用记录。"
            )}
            {d.top_apps[1] ? ` 紧随其后的是 ${d.top_apps[1].name}。` : ""}
          </p>
          <p>
            前三项合计约 <span className="rs-inline-number">{Math.round(top3Share)}%</span>
            。剩下的时间，才轮到其他应用和零碎操作。
          </p>
          <Annotation signature="— SNOOP 旁批">
            <Quip text={ann02} />
          </Annotation>
        </article>
        <figure className="rs-cat-figure">
          <div className="rs-cat-controls">
            <span>输入活跃分配</span>
            <span className="rs-toggle-static">按占比</span>
          </div>
          <CategoryBars categories={detail.snapshot.categories} />
          <figcaption className="rs-chart-caption rs-cat-caption">
            一条线索，两个视角：分类回答在做什么，
            <br />
            应用则留下更具体的名字。
          </figcaption>
        </figure>
      </div>

      <AppStrip apps={detail.snapshot.apps.slice(0, 3)} icons={icons} label={<>今天常驻的<br />三个名字</>} />

      <SectionLabel num="03" title={title03} en="BETWEEN APPS" />
      <div className="rs-night rs-day-quiet">
        <article>
          <h2>
            {h03 ? (
              <HeadingText lines={h03} />
            ) : switchDiff <= 0 ? (
              <>
                切来切去，
                <br />
                但比平时少了一点。
              </>
            ) : (
              <>
                切来切去，
                <br />
                比平时还勤快。
              </>
            )}
          </h2>
          <p>
            今天记录到 <strong>{d.switch_count} 次应用切换</strong>
            {switchAvg > 0 ? (
              <>
                ，比前七天日均的 {Math.round(switchAvg)} 次
                {switchDiff <= 0 ? "少" : "多"}约 {switchPct}%。
              </>
            ) : (
              "，前七天的基线还不够。"
            )}
            总活跃时长 {switchDiff <= 0 ? "基本没变" : "也没有明显变短"}，切换次数却
            {switchDiff <= 0 ? "下降了" : "上升了"}。
          </p>
          <p>这能说明今天的切换次数，但还不足以判断效率高低。聊天、查资料与远程操作，本来就可能需要往返。</p>
          {switchAvg > 0 && (
            <div className="rs-session-line">
              <span>前七天日均 {Math.round(switchAvg)} 次</span>
              <i />
              <span>今天 {d.switch_count} 次</span>
            </div>
          )}
        </article>
        <aside className="rs-night-aside">
          <div className="rs-moon" aria-hidden="true">↔</div>
          <h3>
            {asideHead ? (
              <HeadingText lines={asideHead} />
            ) : switchAvg > 0 ? (
              <>
                {switchDiff <= 0 ? "少" : "多"}切了 {Math.abs(Math.round(switchDiff))} 次。
                <br />
                值得我少念两句。
              </>
            ) : (
              <>
                今天的安静，
                <br />
                是相对你平时而言。
              </>
            )}
          </h3>
          <p>
            <Quip text={ann03} />
          </p>
          <span className="rs-signature">SNOOP / 今日旁注</span>
        </aside>
      </div>

      <Footnotes
        firstHead="新面孔 / FIRST SEEN"
        firstBody={
          d.new_apps.length > 0
            ? `今天记录到了 ${d.new_apps.length} 个近 30 天没出现的应用。它们是新装的，还是终于想起来打开的，只有你知道。`
            : "今天没有出现久违的新面孔。熟悉的那些，继续按时到场。"
        }
        chips={d.new_apps.map((a) => a.name)}
        secondHead="今天的句号 / LAST LINE"
        secondBody={
          <>
            {`总时长 ${formatDurationCompact(d.active_ms)}，晚间占 ${Math.round(
              evening * 100,
            )}%，${topCat?.name ?? "分类"}排在第一位。今天的形状，大概就是这样。`}
            {closing ? (
              <>
                <br />
                <HeadingText lines={closing.split("\n")} />
              </>
            ) : null}
          </>
        }
      />
      <Method>
        {`自然日为 00:00—24:00；输入活跃为有按键、点击或滚动的采样桶时长累计。全天逐小时合计 ${formatDurationCompact(
          d.active_ms,
        )}。应用切换与前七天日均对比；连续活动允许最多 5 分钟输入间隙、允许跨应用，${focus.minutes} 分钟是起止跨度。首末记录跨度不是前台时长、活跃时长或睡眠判断。`}
      </Method>
    </>
  );
}

function AppStrip({
  apps,
  icons,
  label,
}: {
  apps: StripApp[];
  icons: ResolvedIconMap | null;
  label: ReactNode;
}) {
  if (apps.length === 0) return null;
  return (
    <div className="rs-apps-strip">
      <span className="rs-apps-strip__label">{label}</span>
      {apps.map((a) => (
        <div key={a.bundle_id} className="rs-small-app">
          <AppIcon bundleId={a.bundle_id} name={a.name} icons={icons} small />
          <div>
            <b>{a.name}</b>
            <small>
              {formatDurationCompact(a.active_ms)}
              {a.category_name ? ` · ${a.category_name}` : ""}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 周报 ────────────────────────────────────────────────────────────────────

function WeekSheet({ detail, icons }: { detail: Extract<ReportView, { report_type: "week" }>; icons: ResolvedIconMap | null }) {
  const d: WeeklyReport = detail.data;
  const title01 = sectionTitleFor(detail, "01");
  const title02 = sectionTitleFor(detail, "02");
  const title03 = sectionTitleFor(detail, "03");
  const h01 = sectionHeadingFor(detail, "01");
  const h02 = sectionHeadingFor(detail, "02");
  const h03 = sectionHeadingFor(detail, "03");
  const asideHead = asideHeadingFor(detail);
  const ann01 = annotationFor(detail, "01");
  const ann03 = annotationFor(detail, "03");
  const pullQuote = pullQuoteFor(detail);
  const closing = closingFor(detail);
  const days = d.days ?? [];
  const busy = pickBusiestDay(days);
  const quiet = pickQuietestDay(days);
  const maxDay = days.find((x) => x.date === d.max_day) ?? busy;
  const weekendMs = days.filter((x) => x.dow >= 5).reduce((s, x) => s + x.active_ms, 0);
  const weekendPct = d.active_ms > 0 ? (weekendMs / d.active_ms) * 100 : 0;
  const ww = d.weekday_weekend;
  const mult =
    ww.weekday_avg_active_ms > 0 ? ww.weekend_avg_active_ms / ww.weekday_avg_active_ms : 0;
  const barMax = Math.max(ww.weekday_avg_active_ms, ww.weekend_avg_active_ms, 1);
  const [showBaseline, setShowBaseline] = useState(true);
  const deltaById = useMemo(
    () => new Map(d.categories.map((c) => [c.category, c.share_delta_pp])),
    [d.categories],
  );
  const nameOf = (id: string) =>
    detail.snapshot.categories.find((c) => c.id === id)?.name ?? id;
  const biggest = [...d.categories].sort(
    (a, b) => Math.abs(b.share_delta_pp) - Math.abs(a.share_delta_pp),
  )[0];
  const second = [...d.categories].sort(
    (a, b) => Math.abs(b.share_delta_pp) - Math.abs(a.share_delta_pp),
  )[1];
  const topApp = d.top_apps[0] ?? null;
  const latest = latestEnd(d);
  const catByBundle = new Map(detail.snapshot.apps.map((a) => [a.bundle_id, a.category_name]));
  const strip = d.top_apps.slice(1, 4).map((a) => ({
    ...a,
    category_name: catByBundle.get(a.bundle_id) ?? "",
  }));

  return (
    <>
      <Masthead detail={detail} />
      <Hero
        detail={detail}
        activeLabel="本周输入活跃"
        mini={[
          { value: formatDurationCompact(d.avg_daily_active_ms), label: "日均活跃" },
          { value: `${d.days_with_data} / ${days.length || 7}`, label: "有记录天数" },
        ]}
      />

      <SectionLabel num="01" title={title01} en="THE SHAPE OF YOUR WEEK" />
      <div className="rs-rhythm">
        <figure>
          <div className="rs-chart-heading">
            <span>{chartHeadFor(detail, "week")}</span>
            <small>输入活跃时长 / 小时</small>
          </div>
          <WeekBars days={days} maxDay={maxDay} />
          <figcaption className="rs-chart-caption">
            {maxDay
              ? `${DOW_LABELS[maxDay.dow]}达到 ${formatDurationCompact(maxDay.active_ms)}；`
              : ""}
            {`周末两天合计 ${formatDurationCompact(weekendMs)}，占全周的 ${weekendPct.toFixed(1)}%。`}
          </figcaption>
        </figure>
        <aside className="rs-note">
          <h2>
            {h01 ? (
              <HeadingText lines={h01} />
            ) : busy ? (
              <>
                最热闹的那一天，
                <br />
                落在{DOW_LABELS[busy.dow]}。
              </>
            ) : (
              <>
                这一周，
                <br />
                记录得断断续续。
              </>
            )}
          </h2>
          <p>
            {busy && quiet ? (
              <>
                {DOW_LABELS[quiet.dow]}只有 <strong>{formatDurationCompact(quiet.active_ms)}</strong>，
                {DOW_LABELS[busy.dow]}则升到了 <strong>{formatDurationCompact(busy.active_ms)}</strong>。
                七天里有 {d.days_with_data} 天留下了记录。
              </>
            ) : (
              "这一周的有效记录不多，先看个大概。"
            )}
          </p>
          <Annotation signature="— SNOOP 旁批">
            <Quip text={ann01} />
          </Annotation>
        </aside>
      </div>

      <div className="rs-pullquote">
        <div className="rs-ratio">
          {mult > 0 ? mult.toFixed(1) : "—"}
          <small>倍</small>
        </div>
        <p>
          {pullQuote ? (
            <HeadingText lines={pullQuote.split("\n")} />
          ) : (
            <>
              周末的每一天，
              <br />
              抵得上{mult >= 1 ? "几个" : "不到一个"}工作日。
            </>
          )}
        </p>
        <div className="rs-mini-comparison">
          <div className="rs-compare-row">
            <span>工作日</span>
            <div className="rs-compare-track">
              <i style={{ width: `${(ww.weekday_avg_active_ms / barMax) * 100}%` }} />
            </div>
            <b>{ww.weekday_days > 0 ? shortDuration(ww.weekday_avg_active_ms) : "—"}</b>
          </div>
          <div className="rs-compare-row">
            <span>周末</span>
            <div className="rs-compare-track">
              <i style={{ width: `${(ww.weekend_avg_active_ms / barMax) * 100}%` }} />
            </div>
            <b>{ww.weekend_days > 0 ? shortDuration(ww.weekend_avg_active_ms) : "—"}</b>
          </div>
          <div className="rs-compare-note">按各自有活跃的天数计算日均</div>
        </div>
      </div>

      <SectionLabel num="02" title={title02} en="LESS PLAY, MORE CONVERSATION" />
      <div className="rs-distribution">
        <article className="rs-story">
          <div className="rs-kicker">
            本周变化 / {biggest ? `${signedPp(biggest.share_delta_pp)} 个百分点` : "暂无对比"}
          </div>
          <h2>
            {h02 ? (
              <HeadingText lines={h02} />
            ) : biggest ? (
              <>
                {nameOf(biggest.category)}，
                <br />
                {biggest.share_delta_pp >= 0 ? "开始占更多位置。" : "让出了一点位置。"}
              </>
            ) : (
              <>
                这一周的时间，
                <br />
                分配得比较平均。
              </>
            )}
          </h2>
          <p>
            {biggest ? (
              <>
                {nameOf(biggest.category)}占比从过去四周的{" "}
                <strong>{Math.round(Math.max(0, biggest.share_pct - biggest.share_delta_pp))}%</strong>{" "}
                变成本周的 <span className="rs-inline-number">{Math.round(biggest.share_pct)}%</span>
                。
                {second
                  ? ` 与此同时，${nameOf(second.category)}的变化也值得看一眼。`
                  : ""}
              </>
            ) : (
              "这一周的分类记录还不够做同比。"
            )}
          </p>
          <p>单看某一天，未必能留意到这些差异。把整周放在一起，时间分配的变化才更清楚。</p>
          {topApp && (
            <div className="rs-app-fact">
              <AppIcon bundleId={topApp.bundle_id} name={topApp.name} icons={icons} />
              <div>
                <b>{topApp.name}</b>
                <small>本周使用最多的应用</small>
              </div>
              <div className="rs-app-fact__time">{shortDuration(topApp.active_ms)}</div>
            </div>
          )}
        </article>
        <figure className="rs-cat-figure">
          <div className="rs-cat-controls">
            <span>本周时间分配</span>
            <button
              type="button"
              className="rs-toggle"
              aria-pressed={showBaseline}
              onClick={() => setShowBaseline((v) => !v)}
            >
              对比前四周
            </button>
          </div>
          <CategoryDeltaBars
            categories={detail.snapshot.categories}
            deltas={deltaById}
            showBaseline={showBaseline}
          />
          <figcaption className="rs-chart-key">
            <span>
              <i className="rs-key-solid" />
              本周占比
            </span>
            <span className="rs-baseline-key">
              <i className="rs-key-line" />
              前四周占比
            </span>
            <span className="rs-baseline-key">右侧为百分点变化</span>
          </figcaption>
          <p className="rs-chart-caption rs-cat-caption">
            分类回答在做什么，应用则留下更具体的名字。
          </p>
        </figure>
      </div>

      <AppStrip apps={strip} icons={icons} label={<>另外一些<br />熟悉的面孔</>} />

      <SectionLabel num="03" title={title03} en="AFTER HOURS" />
      <div className="rs-night">
        <article>
          <h2>
            {h03 ? (
              <HeadingText lines={h03} />
            ) : latest ? (
              <>
                {latest.dow}的最后一次输入，
                <br />
                {latest.label.startsWith("次日") ? `已经是${latest.label}。` : `停在 ${latest.label}。`}
              </>
            ) : (
              <>
                这一周，
                <br />
                没有熬到很晚。
              </>
            )}
          </h2>
          <p className="rs-lede">{weeklyNightSummary(detail)}</p>
          <div className="rs-night-chart">
            <div className="rs-night-legend">
              <span>每天最后一次输入</span>
              <span>上早下晚 · 22:00—03:00</span>
            </div>
            <NightDots marks={nightMarks(detail)} />
          </div>
          <p className="rs-chart-caption">这里只记录电脑上的最后活动，不把它当作你的入睡时间。</p>
        </article>
        <aside className="rs-night-aside">
          <div className="rs-moon" aria-hidden="true">☾</div>
          <h3>
            {asideHead ? (
              <HeadingText lines={asideHead} />
            ) : (
              <>
                「再玩一局」
                <br />
                没有标准时长。
              </>
            )}
          </h3>
          <p>
            <Quip text={ann03} />
          </p>
          <span className="rs-signature">SNOOP / 深夜值班笔记</span>
        </aside>
      </div>

      <Footnotes
        firstHead="新面孔 / FIRST SEEN"
        firstBody={
          d.new_apps.length > 0
            ? `这周记录到了 ${d.new_apps.length} 个前四周没有出现的应用。它们是新装的，还是终于想起来打开的，只有你知道。`
            : "这周没有出现前四周没见过的应用。熟悉的面孔继续按时到场。"
        }
        chips={d.new_apps.map((a) => a.name)}
        secondHead="一周后，再看 / EDITOR'S NOTE"
        secondBody={
          <>
            这一周，{biggest ? `${nameOf(biggest.category)}的份额${biggest.share_delta_pp >= 0 ? "扩大" : "缩小"}` : "各类占比"}，
            {weekendPct >= 40 ? "周末的浓度依旧很高" : "周末并没有比工作日更重"}。下一周值得留意的，是这种分配会继续，还是只属于这七天。
            {closing ? (
              <>
                <br />
                <HeadingText lines={closing.split("\n")} />
              </>
            ) : null}
          </>
        }
      />
      <Method>
        {`输入活跃时长为检测到按键、鼠标点击或滚动的采样桶时长之和，不等同于屏幕使用时长或专注时长。本周共 ${formatDurationCompact(
          d.active_ms,
        )}，日均 ${formatDurationCompact(d.avg_daily_active_ms)}。分类基线使用前四周汇总占比；百分比四舍五入显示。作息日使用凌晨 4 点日界，次日凌晨的记录计入前一天；此处只展示最后活动时间。`}
      </Method>
    </>
  );
}

/** 本周最晚的一条结束记录（凌晨 4 点前的算作次日）。 */
function latestEnd(d: WeeklyReport): { dow: string; label: string; minute: number } | null {
  let best: { dow: string; label: string; minute: number } | null = null;
  d.rhythm.forEach((r, i) => {
    if (r.active_ms <= 0 || r.end_min == null) return;
    const minute = r.end_min < 240 ? r.end_min + 1440 : r.end_min;
    if (!best || minute > best.minute) {
      best = {
        dow: DOW_LABELS[i],
        label: formatSleepMin(r.end_min < 240 ? r.end_min + 1440 : r.end_min),
        minute,
      };
    }
  });
  return best;
}

function signedPp(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`;
}

function shortDuration(ms: number): string {
  const total = Math.floor(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

// ── 月报 ────────────────────────────────────────────────────────────────────

function MonthSheet({ detail, icons }: { detail: Extract<ReportView, { report_type: "month" }>; icons: ResolvedIconMap | null }) {
  const d = detail.data;
  const title01 = sectionTitleFor(detail, "01");
  const title02 = sectionTitleFor(detail, "02");
  const title03 = sectionTitleFor(detail, "03");
  const h01 = sectionHeadingFor(detail, "01");
  const h02 = sectionHeadingFor(detail, "02");
  const h03 = sectionHeadingFor(detail, "03");
  const asideHead = asideHeadingFor(detail);
  const ann01 = annotationFor(detail, "01");
  const ann03 = annotationFor(detail, "03");
  const pullQuote = pullQuoteFor(detail);
  const closing = closingFor(detail);
  const days = d.days ?? [];
  const maxDay = d.max_day;
  const minDay = d.min_day;
  const nameOf = (id: string) =>
    detail.snapshot.categories.find((c) => c.id === id)?.name ?? id;
  const shifts = [...d.half_shift].sort(
    (a, b) => Math.abs(b.delta_pp) - Math.abs(a.delta_pp),
  );
  const shift = shifts[0];
  const secondShift = shifts[1];
  const gapMs =
    maxDay && minDay ? Math.max(0, maxDay.active_ms - minDay.active_ms) : 0;
  const cats = detail.snapshot.categories.filter((c) => c.active_ms > 0);
  const summaryLines = buildCategorySummary(cats);
  const topApp = d.top_apps[0] ?? null;

  return (
    <>
      <Masthead detail={detail} />
      <Hero
        detail={detail}
        activeLabel="本月输入活跃"
        mini={[
          { value: formatDurationCompact(d.avg_daily_active_ms), label: "日均活跃" },
          { value: `${d.days_with_data} / ${days.length || 30}`, label: "有记录天数" },
        ]}
      />

      <SectionLabel num="01" title={title01} en="A MONTH AT A GLANCE" />
      <div className="rs-month-layout">
        <figure>
          <div className="rs-chart-heading rs-month-heading">
            <span>{chartHeadFor(detail, "calendar")}</span>
            <small>点击日期查看时长</small>
          </div>
          <MonthCalendar days={days} />
        </figure>
        <aside className="rs-note rs-monthly-note">
          <h2>
            {h01 ? (
              <HeadingText lines={h01} />
            ) : maxDay ? (
              <>
                最浓的一格，
                <br />
                落在 {dateParts(maxDay.date).d} 号。
              </>
            ) : (
              <>
                这个月，
                <br />
                没有特别浓的一格。
              </>
            )}
          </h2>
          {maxDay && (
            <div className="rs-note-number">
              {bigTimeParts(maxDay.active_ms).map((p) => (
                <span key={p.unit}>
                  {p.value}
                  <small>{p.unit}</small>
                </span>
              ))}
            </div>
          )}
          <p>
            {maxDay && minDay ? (
              <>
                这一天是本月的最高点。最轻的 {dateParts(minDay.date).d} 号只有{" "}
                <strong>{formatDurationCompact(minDay.active_ms)}</strong>，两者相差{" "}
                {formatDurationCompact(gapMs)}。
              </>
            ) : (
              "这个月的逐日记录还不够完整。"
            )}
          </p>
          <p>
            {d.days_with_data >= days.length && days.length > 0
              ? "整月没有缺失记录。这里浅色的一天，也是真正记录到的轻量一天。"
              : `整月有 ${days.length - d.days_with_data} 天没有记录，浅色格子可能是缺失，而不是轻量。`}
          </p>
          <Annotation signature="— SNOOP 月度旁批">
            <Quip text={ann01} />
          </Annotation>
        </aside>
      </div>

      <div className="rs-full-trend">
        <div>
          <h3>
            <HeadingText lines={chartHeadFor(detail, "trend").split("\n")} />
          </h3>
          <p>
            按周分组的日均输入活跃。
            <br />
            首尾周仅计算本月内日期。
          </p>
        </div>
        <WeekTrend weeks={d.weeks} />
      </div>

      <SectionLabel num="02" title={title02} en="THE SECOND HALF FEELS DIFFERENT" />
      <div className="rs-shift-layout">
        <figure>
          <ShiftBars shifts={d.half_shift} nameOf={nameOf} />
          <figcaption className="rs-chart-key">
            <span>○ 上半月</span>
            <span className="rs-key-accent">● 下半月</span>
            <span>横向位置使用统一刻度</span>
          </figcaption>
        </figure>
        <article className="rs-story">
          <div className="rs-kicker">
            最大的变化 / {shift ? `${nameOf(shift.category)} ${signedPp(shift.delta_pp)} 个百分点` : "暂无对比"}
          </div>
          <h2>
            {h02 ? (
              <HeadingText lines={h02} />
            ) : shift ? (
              <>
                {nameOf(shift.category)}
                {shift.delta_pp < 0 ? "没有退场，" : "开始占位，"}
                <br />
                {shift.delta_pp < 0 ? "只是让出了位置。" : "时间分配有了新的重心。"}
              </>
            ) : (
              <>
                前后两半，
                <br />
                还没有明显差别。
              </>
            )}
          </h2>
          <p>
            {shift ? (
              <>
                {nameOf(shift.category)}从上半月的{" "}
                <strong>{Math.round(shift.first_half_share_pct)}%</strong> 变成下半月的{" "}
                <strong>{Math.round(shift.second_half_share_pct)}%</strong>。
                {secondShift
                  ? ` 与此同时，${nameOf(secondShift.category)}的变化排在第二。`
                  : ""}
              </>
            ) : (
              "这个月的前后两段，没有足够数据做对比。"
            )}
          </p>
          <p>单看某一天，未必能留意到这些差异。把前后两半放在一起，时间分配的变化才更清楚。</p>
        </article>
      </div>

      <div className="rs-pullquote rs-month-pull">
        <div className="rs-ratio">
          {shift ? Math.abs(shift.delta_pp).toFixed(0) : "—"}
          <small>pp</small>
        </div>
        <p>
          {shift ? `${nameOf(shift.category)}占比变化的幅度。` : "前后两半的占比变化。"}
          <br />
          {pullQuote ? (
            <HeadingText lines={pullQuote.split("\n")} />
          ) : (
            "时间的配方，开始有点不同。"
          )}
        </p>
        <p className="rs-explain">
          这里比较的是占比，单位是百分点。
          <br />
          下列数据来自月内两段各自的总量，报告不会直接拿两段总量判断习惯变化。
        </p>
      </div>

      <SectionLabel num="03" title={title03} en="THE APPS THAT STAYED" />
      <div className="rs-night">
        <article>
          <h2>
            {h03 ? (
              <HeadingText lines={h03} />
            ) : topApp ? (
              <>
                第一名是 {topApp.name}。
                <br />
                有意思的是它身后。
              </>
            ) : (
              <>
                这个月，
                <br />
                没有常驻角色。
              </>
            )}
          </h2>
          <p>
            {topApp ? (
              <>
                {topApp.name}留下了 <strong>{formatDurationCompact(topApp.active_ms)}</strong>，约占全月的{" "}
                {Math.round(topApp.share_pct)}%。
                {d.top_apps[1]
                  ? `${d.top_apps[1].name}与${d.top_apps[2]?.name ?? "其他应用"}也占据了相当一部分时间。`
                  : ""}
              </>
            ) : (
              "这个月没有足够完整的应用记录。"
            )}
          </p>
          <AppRanking apps={d.top_apps.slice(0, 5)} icons={icons} />
          <p className="rs-app-caption">主要应用的输入活跃时长；占比均以全月全部应用为分母。</p>
        </article>
        <aside className="rs-night-aside">
          <div className="rs-moon" aria-hidden="true">↗</div>
          <h3>
            {asideHead ? (
              <HeadingText lines={asideHead} />
            ) : d.new_apps.length > 0 ? (
              <>
                新的工具，
                <br />
                开始有出场时间了。
              </>
            ) : (
              <>
                熟悉的名字，
                <br />
                继续占据版面。
              </>
            )}
          </h3>
          <p>
            <Quip text={ann03} />
          </p>
          <div className="rs-summary-lines">
            {summaryLines.map((l, i) => (
              <div key={i}>
                <span>{l.label}</span>
                <b>{l.value}</b>
              </div>
            ))}
          </div>
          <span className="rs-signature">SNOOP / 月末观察</span>
        </aside>
      </div>

      <Footnotes
        firstHead="九十天里未见的新面孔 / FIRST SEEN"
        firstBody={
          d.new_apps.length > 0
            ? `本月有 ${d.new_apps.length} 个应用留下了记录。这里的「新」，只表示此前 90 天没有出现。`
            : "本月没有出现此前 90 天未记录过的应用。"
        }
        chips={d.new_apps.map((a) => a.name)}
        secondHead="留给下个月 / NEXT CHAPTER"
        secondBody={
          <>
            这个月的总量与分配都已经写在这里。新的工具会留下来，还是只是一次短暂试用，下个月的记录会接着写。
            {closing ? (
              <>
                <br />
                <HeadingText lines={closing.split("\n")} />
              </>
            ) : null}
          </>
        }
      />
      <Method>
        {`本月共 ${formatDurationCompact(d.active_ms)}，日均 ${formatDurationCompact(
          d.avg_daily_active_ms,
        )}，有记录 ${d.days_with_data} 天。分类占比按整月输入活跃总量计算。半月对比按上下半月各自的总量计算，展示值取整。折线按周一为周首分组，首尾周裁剪到本月，使用各组有活跃天数的日均。输入活跃不等同于屏幕使用时长或专注时长，应用名称与类别均为报告生成时的快照。`}
      </Method>
    </>
  );
}

function AppRanking({ apps, icons }: { apps: AppRank[]; icons: ResolvedIconMap | null }) {
  if (apps.length === 0) return <p className="rs-empty">没有应用记录。</p>;
  const max = Math.max(...apps.map((a) => a.active_ms), 1);
  return (
    <div className="rs-app-ranking">
      {apps.map((a, i) => (
        <div key={a.bundle_id} className="rs-rank-row">
          <span>{String(i + 1).padStart(2, "0")}</span>
          <span className="rs-rank-name">
            <AppIcon bundleId={a.bundle_id} name={a.name} icons={icons} small />
            <span className="rs-rank-label">{a.name}</span>
          </span>
          <div className="rs-rank-track">
            <i style={{ width: `${(a.active_ms / max) * 100}%` }} />
          </div>
          <b>{shortDuration(a.active_ms)}</b>
        </div>
      ))}
    </div>
  );
}

/** 月报旁注底部的三类汇总：第一、第二三、其余。 */
function buildCategorySummary(cats: { name: string; share_pct: number }[]): {
  label: string;
  value: string;
}[] {
  if (cats.length === 0) return [];
  const lines: { label: string; value: string }[] = [];
  lines.push({ label: cats[0].name, value: `${Math.round(cats[0].share_pct)}%` });
  if (cats.length >= 3) {
    lines.push({
      label: `${cats[1].name}与${cats[2].name}`,
      value: `${Math.round(cats[1].share_pct + cats[2].share_pct)}%`,
    });
  }
  const rest = cats.slice(3);
  if (rest.length > 0) {
    lines.push({
      label: rest.length === 1 ? rest[0].name : `${rest[0].name}等 ${rest.length} 类`,
      value: `${Math.round(rest.reduce((s, c) => s + c.share_pct, 0))}%`,
    });
  }
  return lines;
}

function Method({ children }: { children: ReactNode }) {
  return (
    <details className="rs-method">
      <summary>关于这份报告的数据与统计口径</summary>
      <p>{children}</p>
    </details>
  );
}

function Footer({ detail }: { detail: ReportView }) {
  return (
    <footer className="rs-footer">
      <strong>Snoop.</strong>
      <span className="rs-footer__tagline">你过你的日子，我记我的笔记。</span>
      <span className="rs-footer__meta">
        {kindMeta(detail).footer} &nbsp;/&nbsp; snoop.duskbit.dev
      </span>
    </footer>
  );
}

// ── 根组件 ──────────────────────────────────────────────────────────────────

function ReportSheet({
  detail,
  icons,
  width,
  showFooter = true,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  /** 固定宽度（灯箱 / 导出）。不传则按容器宽度自适应。 */
  width?: number;
  showFooter?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("wide");

  useEffect(() => {
    if (width) return;
    const el = rootRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      setLayout(w >= 860 ? "wide" : w >= 640 ? "mid" : "narrow");
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div
      ref={rootRef}
      className="rsheet"
      data-layout={width ? "wide" : layout}
      style={width ? { width } : undefined}
    >
      {detail.report_type === "day" ? (
        <DaySheet detail={detail} icons={icons} />
      ) : detail.report_type === "week" ? (
        <WeekSheet detail={detail} icons={icons} />
      ) : (
        <MonthSheet detail={detail} icons={icons} />
      )}
      {showFooter && <Footer detail={detail} />}
    </div>
  );
}

// 灯箱缩放 / 拖拽会频繁改 Lightbox 自己的 state；纸张 props 不变时跳过整棵树的重渲染。
export default memo(ReportSheet);
