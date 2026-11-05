/**
 * 杂志版式的事实文案层 —— 所有「可以被数据算出来」的句子都从这里出。
 *
 * 分工：
 *   - 这里是**事实与结构**：标题兜底、导语、时间书签、图注、比较句。
 *   - AI 负责编辑层文案（封面标题、导语、刊头短句、栏目标题、各节标题、图表小标题、
 *     拉引句、旁批、结尾注），存在 `detail.ai_copy`；缺失的槽位逐项回落到这里的模板。
 *   - 图表自己算比例，不再从这里拿数，避免同一份数字两处口径。
 *
 * 时间格式与报告其它地方保持一致：时长用 `formatDurationCompact`（「3 小时 35 分」），
 * 日期一律走 `parseAnchor`，禁止 `new Date("YYYY-MM-DD")`。
 */

import type {
  AiCopy,
  CategorySnap,
  DailyReport,
  DayCell,
  ReportKind,
  ReportView,
} from "../types";
import { formatDurationCompact } from "../../utils/format";
import { DOW_LABELS, formatSleepMin } from "../format";
import { parseAnchor } from "../../data/ranges";

const EN_MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const EN_DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const CN_DOW = ["日", "一", "二", "三", "四", "五", "六"];

export function splitDuration(ms: number): { h: number; m: number } {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

/** 大数字旁的「时 / 分」两段。整小时不显示「0 分」。 */
export function bigTimeParts(ms: number): { value: string; unit: string }[] {
  const { h, m } = splitDuration(ms);
  if (h === 0) return [{ value: String(m), unit: "分" }];
  if (m === 0) return [{ value: String(h), unit: "时" }];
  return [
    { value: String(h), unit: "时" },
    { value: String(m).padStart(2, "0"), unit: "分" },
  ];
}

/** epoch ms → 本地 HH:MM。只读时分，不做日期字符串解析。 */
export function clockFromMs(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 两个 epoch ms 的跨度：整小时省掉「0 分」。 */
export function spanText(ms: number): string {
  return formatDurationCompact(Math.max(0, ms));
}

export function dateParts(date: string): { y: number; m: number; d: number; dow: number } {
  const d = parseAnchor(date);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), dow: d.getDay() };
}

/** 「11 月 04 日 · 星期三」。 */
export function cnDate(date: string): string {
  const { y, m, d, dow } = dateParts(date);
  return `${y} 年 ${String(m).padStart(2, "0")} 月 ${String(d).padStart(2, "0")} 日 · 星期${CN_DOW[dow]}`;
}

/** 「NOV. 04 / WEDNESDAY」。 */
export function enDate(date: string): string {
  const { m, d, dow } = dateParts(date);
  return `${EN_MONTHS[m - 1]}. ${String(d).padStart(2, "0")} / ${EN_DOW[dow]}`;
}

export function narrativeLines(detail: ReportView): string[] {
  return (detail.narrative ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── 日报 ────────────────────────────────────────────────────────────────────

export function hourlyTotal(d: DailyReport): number {
  return d.hourly.reduce((s, h) => s + h.active_ms, 0);
}

/** [from, to) 小时的活跃合计。 */
export function hourRangeMs(d: DailyReport, from: number, to: number): number {
  return d.hourly
    .filter((h) => h.hour >= from && h.hour < to)
    .reduce((s, h) => s + h.active_ms, 0);
}

export function eveningShare(d: DailyReport): number {
  const total = hourlyTotal(d);
  return total > 0 ? hourRangeMs(d, 18, 24) / total : 0;
}

export function topCategory(detail: ReportView): CategorySnap | null {
  return detail.snapshot.categories.find((c) => c.active_ms > 0) ?? null;
}

function topCategoryShare(detail: ReportView): string {
  const c = topCategory(detail);
  return c ? `${Math.round(c.share_pct)}%` : "0%";
}

export function fallbackDailyHeadline(detail: Extract<ReportView, { report_type: "day" }>): string {
  const d = detail.data;
  const { h } = splitDuration(d.active_ms);
  const cat = topCategory(detail);
  const evening = eveningShare(d);
  const switchesPerHour =
    d.active_ms > 0 ? d.switch_count / (d.active_ms / 3_600_000) : 0;

  if (d.active_ms < 30 * 60_000) return "这一天，电脑开得很轻";
  if (evening >= 0.55) return "白天慢慢来，晚上才真正开场";
  if (switchesPerHour > 220) return "一直在切，就是没停下来";
  if (cat && cat.share_pct >= 35) return `今天，${cat.name}占了上风`;
  if (h >= 6) return "今天的电脑，几乎没歇过";
  return "今天过得，不算太偏";
}

export function dailyIntro(detail: Extract<ReportView, { report_type: "day" }>): string {
  const d = detail.data;
  const cat = topCategory(detail);
  const app = detail.snapshot.apps[0];
  const evening = eveningShare(d);
  const lines: string[] = [];
  lines.push(
    `全天输入活跃 ${formatDurationCompact(d.active_ms)}，${d.peak_hour}:00 是最忙的一小时。`,
  );
  if (evening >= 0.5) {
    lines.push(`其中 ${Math.round(evening * 100)}% 落在 18 点之后，白天更像在铺垫。`);
  } else {
    lines.push(`晚间只占了 ${Math.round(evening * 100)}%，这一天主要在白天展开。`);
  }
  if (cat) {
    lines.push(
      `最常待的地方是${cat.name}${app ? `，${app.name} 留下了 ${formatDurationCompact(app.active_ms)}` : ""}。`,
    );
  }
  return lines.join("");
}

/** 三条时间书签：第一条 / 峰值 / 最后一条。 */
export function dailyTimebook(d: DailyReport): { time: string; title: string; text: string }[] {
  const first = clockFromMs(d.span_start_ms);
  const last = clockFromMs(d.span_end_ms);
  const peak = d.hourly.find((h) => h.hour === d.peak_hour)?.active_ms ?? 0;
  const nextHour = (d.peak_hour + 1) % 24;
  const next = d.hourly.find((h) => h.hour === nextHour)?.active_ms ?? 0;
  const morning = hourRangeMs(d, 6, 12);
  const afternoon = hourRangeMs(d, 12, 18);
  const dayPart =
    morning >= afternoon
      ? `上午到中午累计 ${formatDurationCompact(morning)}`
      : `下午累计 ${formatDurationCompact(afternoon)}`;
  return [
    {
      time: first,
      title: "一天，从这里留下痕迹。",
      text: `第一条记录出现在 ${first}。${dayPart}，开场相当克制。`,
    },
    {
      time: `${String(d.peak_hour).padStart(2, "0")}:00`,
      title: "真正的主场，在高峰之后。",
      text: `这一小时累计 ${formatDurationCompact(peak)}。紧接着的 ${String(nextHour).padStart(2, "0")} 点，又贡献了 ${formatDurationCompact(next)}。`,
    },
    {
      time: last,
      title: "今天的记录，到这里收笔。",
      text: `最后一条记录停在 ${last}。首末记录相距 ${spanText(d.span_end_ms - d.span_start_ms)}，活动并没有填满整段时间。`,
    },
  ];
}

export function dailyFocus(d: DailyReport): { minutes: number; start: string; end: string } {
  const minutes = Math.round(d.longest_focus.duration_ms / 60_000);
  return {
    minutes,
    start: clockFromMs(d.longest_focus.start_ms),
    end: clockFromMs(d.longest_focus.end_ms),
  };
}

/** 峰值前方的累计活跃，用作「一天从这里开始」的注脚。 */
export function beforePeakMs(d: DailyReport): number {
  return d.hourly.filter((h) => h.hour < d.peak_hour).reduce((s, h) => s + h.active_ms, 0);
}

// ── 周报 ────────────────────────────────────────────────────────────────────

export function weekendShare(days: DayCell[]): number {
  const total = days.reduce((s, d) => s + d.active_ms, 0);
  const weekend = days.filter((d) => d.dow >= 5).reduce((s, d) => s + d.active_ms, 0);
  return total > 0 ? weekend / total : 0;
}

export function fallbackWeeklyHeadline(
  detail: Extract<ReportView, { report_type: "week" }>,
): string {
  const d = detail.data;
  const weekend = weekendShare(d.days);
  const delta = d.baseline.baseline_sufficient ? d.baseline.daily_delta_pct : 0;
  if (d.days_with_data <= 2) return "这一周，记录得断断续续";
  if (weekend >= 0.45) return "周末，才是你的主场";
  if (delta <= -20) return "这周收着过，也算一种节奏";
  if (d.gone_apps.length > 0) return `${d.gone_apps[0].name}，悄悄退场了`;
  return "一周七天，各有各的样子";
}

export function weeklyIntro(detail: Extract<ReportView, { report_type: "week" }>): string {
  const d = detail.data;
  const weekend = weekendShare(d.days);
  const busy = pickBusiestDay(d.days);
  const quiet = pickQuietestDay(d.days);
  const lines: string[] = [];
  lines.push(
    `这一周累计 ${formatDurationCompact(d.active_ms)}，日均 ${formatDurationCompact(d.avg_daily_active_ms)}。`,
  );
  if (weekend >= 0.4) {
    lines.push(`周末两天贡献了全周的 ${Math.round(weekend * 100)}%，工作日的电脑时间收得很紧。`);
  } else {
    lines.push(`周末只占全周的 ${Math.round(weekend * 100)}%，节奏主要落在工作日。`);
  }
  if (busy && quiet) {
    lines.push(
      `${DOW_LABELS[busy.dow]}最忙，${DOW_LABELS[quiet.dow]}最安静；七天里有 ${d.days_with_data} 天留下了记录。`,
    );
  }
  return lines.join("");
}

export function pickBusiestDay(days: DayCell[]): DayCell | null {
  const withData = days.filter((d) => d.active_ms > 0);
  return withData.length > 0
    ? withData.reduce((a, b) => (b.active_ms > a.active_ms ? b : a))
    : null;
}

export function pickQuietestDay(days: DayCell[]): DayCell | null {
  const withData = days.filter((d) => d.active_ms > 0);
  return withData.length > 0
    ? withData.reduce((a, b) => (b.active_ms < a.active_ms ? b : a))
    : null;
}

/** 每个有记录的天：最后一次活动的横坐标（22:00 → 03:00 的 300 分钟窗口）。 */
export function nightMarks(detail: Extract<ReportView, { report_type: "week" }>): {
  dow: string;
  label: string;
  pos: number;
  weekend: boolean;
  overnight: boolean;
}[] {
  return detail.data.rhythm
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.active_ms > 0 && r.end_min != null)
    .map(({ r, i }) => {
      const raw = r.end_min ?? 0;
      // 凌晨 4 点前算作「延续到第二天」。
      const minute = raw < 240 ? raw + 1440 : raw;
      const pos = Math.min(100, Math.max(0, ((minute - 1320) / 300) * 100));
      return {
        dow: DOW_LABELS[i],
        label: formatSleepMin(raw),
        pos,
        weekend: i >= 5,
        overnight: r.overnight,
      };
    });
}

export function weeklyNightSummary(
  detail: Extract<ReportView, { report_type: "week" }>,
): string {
  const s = detail.data.rhythm_summary;
  const parts: string[] = [];
  if (s.overnight_days > 0) {
    parts.push(`按凌晨 4 点划分作息日，本周有 ${s.overnight_days} 天拖到了午夜之后。`);
  }
  if (s.avg_end_min != null) {
    parts.push(`平均结束时间 ${formatSleepMin(s.avg_end_min)}`);
    if (s.end_delta_min != null) {
      parts.push(
        s.end_delta_min >= 0
          ? `，比前四周晚 ${s.end_delta_min} 分钟。`
          : `，比前四周早 ${-s.end_delta_min} 分钟。`,
      );
    } else {
      parts.push("。");
    }
  }
  if (parts.length === 0) parts.push("这一周没有足够完整的作息记录。");
  return parts.join("");
}

// ── 月报 ────────────────────────────────────────────────────────────────────

export function fallbackMonthlyHeadline(
  detail: Extract<ReportView, { report_type: "month" }>,
): string {
  const d = detail.data;
  if (d.days_with_data <= 5) return "这个月，记录得稀稀落落";
  if (d.half_shift.length > 0 && Math.abs(d.half_shift[0].delta_pp) >= 5) {
    return "月初月末，不是同一个你";
  }
  if (d.new_apps.length > 0) return "新的工具，开始有出场时间了";
  if (d.prev_month.avg_daily_active_ms > 0 && d.prev_month.daily_delta_pct >= 25) {
    return "这个月，电脑时间明显变长了";
  }
  return "这个月，重心在悄悄挪动";
}

export function monthlyIntro(detail: Extract<ReportView, { report_type: "month" }>): string {
  const d = detail.data;
  const lines: string[] = [];
  lines.push(
    `这个月累计 ${formatDurationCompact(d.active_ms)}，日均 ${formatDurationCompact(d.avg_daily_active_ms)}，${d.days_with_data} 天都有记录。`,
  );
  if (d.prev_month.avg_daily_active_ms > 0) {
    const pct = Math.abs(Math.round(d.prev_month.daily_delta_pct));
    lines.push(
      d.prev_month.daily_delta_pct >= 0
        ? `日均比上月高 ${pct}%。`
        : `日均比上月低 ${pct}%。`,
    );
  }
  const shift = d.half_shift[0];
  if (shift) {
    const name = categoryName(detail, shift.category);
    lines.push(
      `${name}的占比从上半月的 ${Math.round(shift.first_half_share_pct)}% 变成下半月的 ${Math.round(shift.second_half_share_pct)}%。`,
    );
  }
  return lines.join("");
}

export function categoryName(detail: ReportView, id: string): string {
  return detail.snapshot.categories.find((c) => c.id === id)?.name ?? id;
}

export function categoryColor(detail: ReportView, id: string): string {
  return detail.snapshot.categories.find((c) => c.id === id)?.color ?? "#6c5ce7";
}

/** 月历格子的日期偏移（周一起始）。 */
export function monthOffset(monthStart: string): number {
  const d = parseAnchor(monthStart);
  return (new Date(d.getFullYear(), d.getMonth(), 1).getDay() + 6) % 7;
}

export function maxDayOf(days: DayCell[]): DayCell | null {
  const withData = days.filter((d) => d.active_ms > 0);
  return withData.length > 0
    ? withData.reduce((a, b) => (b.active_ms > a.active_ms ? b : a))
    : null;
}

export function minDayOf(days: DayCell[]): DayCell | null {
  const withData = days.filter((d) => d.active_ms > 0);
  return withData.length > 0
    ? withData.reduce((a, b) => (b.active_ms < a.active_ms ? b : a))
    : null;
}

export function monthlyNightSummary(detail: Extract<ReportView, { report_type: "month" }>): string {
  const d = detail.data;
  const shift = d.half_shift[0];
  if (!shift) return "这个月没有足够的两段数据来做前后对比。";
  const name = categoryName(detail, shift.category);
  return `${name}是上下半月变化最大的一项：从 ${Math.round(shift.first_half_share_pct)}% 到 ${Math.round(shift.second_half_share_pct)}%。`;
}

// ── 通用 ────────────────────────────────────────────────────────────────────

export function kindMeta(detail: ReportView): {
  badge: string;
  edition: string;
  brandSub: string;
  eyebrow: string;
  issueRight: string;
  footer: string;
} {
  if (detail.report_type === "day") {
    return {
      badge: "日报",
      edition: enDate(detail.data.date),
      brandSub: "日报",
      eyebrow: "A DAY, IN CHAPTERS",
      issueRight: "一天之内，也有起承转合。",
      footer: "DAILY EDITION",
    };
  }
  if (detail.report_type === "week") {
    const d = detail.data;
    const start = parseAnchor(d.week_start);
    const week = Math.ceil(
      ((start.getTime() - new Date(start.getFullYear(), 0, 1).getTime()) / 86_400_000 + 1) / 7,
    );
    return {
      badge: "周刊",
      edition: `VOL. ${String(Math.max(1, week)).padStart(3, "0")} / ${start.getFullYear()}`,
      brandSub: "周刊",
      eyebrow: "THE WEEK IN REVIEW",
      issueRight: "一周七天，有迹可循。",
      footer: "WEEKLY EDITION",
    };
  }
  const d = detail.data;
  const start = parseAnchor(d.month_start);
  return {
    badge: "月刊",
    edition: `${EN_MONTHS[start.getMonth()]} / ${start.getFullYear()}`,
    brandSub: "月刊",
    eyebrow: "THIRTY-ONE DAYS, ONE STORY",
    issueRight: "三十一天，慢慢换了重心。",
    footer: "MONTHLY EDITION",
  };
}

export function issueLeft(detail: ReportView): string {
  if (detail.report_type === "day") return cnDate(detail.data.date);
  if (detail.report_type === "week") {
    const d = detail.data;
    return `${cnDate(d.week_start).replace(/ · .*$/, "")} — ${weekEndCn(d.week_end)}`;
  }
  const d = detail.data;
  return `${cnDate(d.month_start).replace(/ · .*$/, "")} — ${monthEndCn(d.month_end)}`;
}

function weekEndCn(weekEnd: string): string {
  const { m, d } = dateParts(weekEnd);
  return `${m} 月 ${String(d).padStart(2, "0")} 日`;
}

function monthEndCn(monthEnd: string): string {
  const { m, d } = dateParts(monthEnd);
  return `${m} 月 ${String(d).padStart(2, "0")} 日`;
}

export function headlineFor(detail: ReportView): string {
  const aiHeadline = aiText(copyOf(detail)?.headline);
  if (aiHeadline) return aiHeadline;
  if (detail.headline && detail.headline.trim()) return detail.headline.trim();
  if (detail.report_type === "day") return fallbackDailyHeadline(detail);
  if (detail.report_type === "week") return fallbackWeeklyHeadline(detail);
  return fallbackMonthlyHeadline(detail);
}

export function comparisonFor(detail: ReportView): { text: string; note: string } {
  if (detail.report_type === "day") {
    const d = detail.data;
    if (d.vs_7d.avg_active_ms <= 0) return { text: "没有足够的前七天基线", note: "再记录几天就能对比。" };
    const pct = Math.abs(Math.round(d.vs_7d.active_delta_pct));
    return {
      text:
        d.vs_7d.active_delta_pct >= 0
          ? `较前七天日均 ↑ ${pct}%`
          : `较前七天日均 ↓ ${pct}%`,
      note: d.vs_7d.active_delta_pct >= 0 ? "总量比平时多了一点。" : "总量比平时少了一点。",
    };
  }
  if (detail.report_type === "week") {
    const d = detail.data;
    if (!d.baseline.baseline_sufficient) {
      return { text: "前四周的记录还不够", note: "下周开始才能对比。" };
    }
    const pct = Math.abs(Math.round(d.baseline.daily_delta_pct));
    return {
      text:
        d.baseline.daily_delta_pct >= 0
          ? `日均较前四周 ↑ ${pct}%`
          : `日均较前四周 ↓ ${pct}%`,
      note: d.baseline.daily_delta_pct >= 0 ? "比平时，稍微放开了一点。" : "比平时，稍微收敛了一点。",
    };
  }
  const d = detail.data;
  if (d.prev_month.avg_daily_active_ms <= 0) {
    return { text: "没有上月的基线", note: "下个月开始就能对比。" };
  }
  const pct = Math.abs(Math.round(d.prev_month.daily_delta_pct));
  return {
    text:
      d.prev_month.daily_delta_pct >= 0
        ? `日均较上月 ↑ ${pct}%`
        : `日均较上月 ↓ ${pct}%`,
    note: d.prev_month.daily_delta_pct >= 0 ? "这个月，电脑时间变长了。" : "这个月，时间收了一点。",
  };
}

export function introFor(detail: ReportView): string {
  const deck = aiText(copyOf(detail)?.deck);
  if (deck) return deck;
  if (detail.report_type === "day") return dailyIntro(detail);
  if (detail.report_type === "week") return weeklyIntro(detail);
  return monthlyIntro(detail);
}

// ── AI 编辑层取值 ────────────────────────────────────────────────────────────
//
// 规则：`copyOf === null`（旧行 / AI 完全失败）保持旧行为，旁批按 `narrativeLines`
// 下标取；`copyOf !== null` 的**新行**不再用 `narrativeLines` 补缺，缺失字段直接走
// 静态模板——派生 quips 可能缺项，按下标补会造成旁批错位。

/** 只认 version=2 且类型对得上的编辑层文案。坏数据一律当作没有。 */
export function copyOf(detail: ReportView): AiCopy | null {
  const copy = detail.ai_copy;
  if (!copy || copy.version !== 2) return null;
  if (copy.report_type !== detail.report_type) return null;
  return copy;
}

/** 防御坏数据：只有非空字符串才算 AI 文案。 */
function aiText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export type SectionId = "01" | "02" | "03";
export type ChartHeadKey = "hourly" | "week" | "calendar" | "trend";

const SECTION_TITLES: Record<ReportKind, Record<SectionId, string>> = {
  day: {
    "01": "一天的起伏",
    "02": "今天，在忙什么",
    "03": "一个值得留意的小变化",
  },
  week: {
    "01": "一周的节奏",
    "02": "时间的去向",
    "03": "夜里，还有下文",
  },
  month: {
    "01": "三十一天的浓淡",
    "02": "变化，发生在中途",
    "03": "这个月的常驻角色",
  },
};

export function issueRightFor(detail: ReportView): string {
  const ai = aiText(copyOf(detail)?.issue_right);
  return ai ?? kindMeta(detail).issueRight;
}

export function sectionTitleFor(detail: ReportView, id: SectionId): string {
  const ai = aiText(copyOf(detail)?.sections?.[id]?.title);
  return ai ?? SECTION_TITLES[detail.report_type][id];
}

/** 各节主标题：AI 值按 `\n` 拆成行；没有就返回 null，保留版式里按数据分支的 JSX。 */
export function sectionHeadingFor(detail: ReportView, id: SectionId): string[] | null {
  return splitHeading(copyOf(detail)?.sections?.[id]?.heading);
}

/** 03 侧栏标题：同上。 */
export function asideHeadingFor(detail: ReportView): string[] | null {
  return splitHeading(copyOf(detail)?.sections?.["03"]?.aside_heading);
}

function splitHeading(text: unknown): string[] | null {
  const plain = aiText(text);
  if (!plain) return null;
  const lines = plain
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

function defaultAnnotation(detail: ReportView, id: SectionId): string {
  if (detail.report_type === "day") {
    return {
      "01": "白天散着来，晚上才肯集中。",
      "02": "你今天最稳定的工作流，可能是「收到，我看看」。",
      "03": "绝对值嘛……我先不展开了。",
    }[id];
  }
  if (detail.report_type === "week") {
    return id === "01"
      ? "你的电脑好像也实行双休，只是休的是周一到周五。"
      : "至于最后那句「马上睡」，我没有录音。";
  }
  return id === "01" ? "同一台电脑，有时像工位，有时像包月网吧。" : monthlyNightSummary(detail);
}

/**
 * 某一节的旁批。
 *
 * 旧行按 `narrativeLines` 下标取（日报 0/1/2，周月第 0/1 条）；
 * 新行只认 `sections[id].aside`，缺失就走静态模板。
 */
export function annotationFor(detail: ReportView, id: SectionId): string {
  const copy = copyOf(detail);
  if (copy) {
    const aside = aiText(copy.sections?.[id]?.aside);
    if (aside) return aside;
    return defaultAnnotation(detail, id);
  }

  const lines = narrativeLines(detail);
  const index =
    detail.report_type === "day"
      ? id === "01"
        ? 0
        : id === "02"
          ? 1
          : 2
      : id === "01"
        ? 0
        : id === "03"
          ? 1
          : -1;
  if (index >= 0 && lines[index]) return lines[index];
  return defaultAnnotation(detail, id);
}

export function chartHeadFor(detail: ReportView, key: ChartHeadKey): string {
  const ai = aiText(copyOf(detail)?.chart_heads?.[key]);
  return ai ?? fallbackChartHead(detail, key);
}

function fallbackChartHead(detail: ReportView, key: ChartHeadKey): string {
  if (key === "hourly" && detail.report_type === "day") {
    const evening = eveningShare(detail.data);
    if (evening >= 0.5) return "白天慢慢来，晚上连成片。";
    if (evening <= 0.35) return "白天是主场，晚上收得早。";
    return "一天铺得比较平。";
  }

  if (key === "week" && detail.report_type === "week") {
    const ww = detail.data.weekday_weekend;
    if (ww.weekday_days === 0 || ww.weekend_days === 0 || ww.weekday_avg_active_ms <= 0) {
      return "一周的起伏，没有偏科。";
    }
    const ratio = ww.weekend_avg_active_ms / ww.weekday_avg_active_ms;
    if (ratio >= 1.1) return "五天铺垫，两天放开。";
    if (ratio <= 0.9) return "工作日更满，周末反而轻。";
    return "一周的起伏，没有偏科。";
  }

  if (key === "calendar" && detail.report_type === "month") {
    const max = maxDayOf(detail.data.days);
    const min = minDayOf(detail.data.days);
    if (max && min && min.active_ms > 0 && max.active_ms / min.active_ms >= 2.5) {
      return "有的日子轻，有的日子很满。";
    }
    return "这个月的每天，起伏不大。";
  }

  if (key === "trend" && detail.report_type === "month") {
    const full = detail.data.weeks.filter((w) => !w.partial);
    if (full.length >= 2 && full[0].avg_daily_active_ms > 0) {
      const delta =
        (full[full.length - 1].avg_daily_active_ms - full[0].avg_daily_active_ms) /
        full[0].avg_daily_active_ms;
      if (delta >= 0.1) return "月末，比月初重了一点。";
      if (delta <= -0.1) return "月末，稍微收了一点。";
    }
    return "按周看，暂时没有明显方向。";
  }

  return "这一页，先看个大概。";
}

/** 拉引句里由 AI 写的那一部分；null 时保留版式原来的事实句。 */
export function pullQuoteFor(detail: ReportView): string | null {
  return aiText(copyOf(detail)?.pull_quote);
}

/**
 * 页脚结尾注。
 *
 * 日报旧行没有这一槽位（返回 null）；周/月旧行的第 3 条旁批正好是结尾注。
 */
export function closingFor(detail: ReportView): string | null {
  const copy = copyOf(detail);
  if (copy) {
    return aiText(copy.closing);
  }
  if (detail.report_type === "day") return null;
  return narrativeLines(detail)[2] ?? null;
}

export { topCategoryShare };
