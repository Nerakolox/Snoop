// 报告页与导出版式共用的小日期/时刻格式化助手。
// 从 Report.tsx 抽出，避免导出卡重复实现；禁止 new Date("YYYY-MM-DD")（见 ranges.ts）。

import { parseAnchor } from "../data/ranges";

export const DOW_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 'YYYY-MM-DD' → 「M月D日」。 */
export function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  if (!m || !d) return date;
  return `${m}月${d}日`;
}

/** '2026-08-01' → 「2026年8月」。 */
export function monthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  if (!y || !m) return monthStart;
  return `${y}年${m}月`;
}

/** 周报标题：`week_start` 的「M月D日」– 6 天后的「M月D日」。禁止 new Date("YYYY-MM-DD")。 */
export function weekRangeLabel(weekStart: string): string {
  const start = parseAnchor(weekStart);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return `${dateLabel(weekStart)} – ${dateLabel(
    `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(
      end.getDate(),
    ).padStart(2, "0")}`,
  )}`;
}

/** 距自然日 00:00 的分钟数 → 可读时刻。≥1440 显示「次日 HH:MM」。 */
export function formatSleepMin(min: number): string {
  const day = Math.floor(min / 1440);
  const rem = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, "0");
  const mm = String(rem % 60).padStart(2, "0");
  return day > 0 ? `次日 ${hh}:${mm}` : `${hh}:${mm}`;
}

/** 对比百分比的展示上限：超过视为「多得离谱」，只显示「远超平时」，不显示具体数字。 */
export const DELTA_CAP_PCT = 300;

/** 「vs 前 4 周」「近 7 天」出百分比的基线门槛：基线日均至少 30 分钟。 */
export const BASELINE_MIN_DAILY_MS = 30 * 60 * 1000;

/** 涨幅/跌幅百分比 → 展示文案。正数超上限 → 「远超平时」；否则「↑ N%」/「↓ N%」。 */
export function deltaLabel(pct: number): string {
  if (pct > DELTA_CAP_PCT) return "远超平时";
  return `${pct >= 0 ? "↑" : "↓"} ${Math.abs(pct).toFixed(0)}%`;
}
