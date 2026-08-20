import { DAY_MS, formatAnchor, parseAnchor } from "../data/ranges";
import { normalizeAnchor, type RangeKind } from "../store/context";

/** 顶栏 anchor 导航与概览页头共用的范围文案：今天 / 昨天 / 具体日期 / 本周 / 区间 / 本月 / 年月。 */
export function anchorLabel(kind: RangeKind, anchor: string, now: Date): string {
  const today = formatAnchor(now);

  if (kind === "day") {
    if (anchor === today) return "今天";
    const yesterday = formatAnchor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    if (anchor === yesterday) return "昨天";
    const d = parseAnchor(anchor);
    return d.getFullYear() === now.getFullYear()
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  if (kind === "week") {
    if (anchor === normalizeAnchor("week", today)) return "本周";
    const start = parseAnchor(anchor);
    const end = new Date(start.getTime() + 6 * DAY_MS);
    return `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
  }

  // month
  if (anchor === normalizeAnchor("month", today)) return "本月";
  const d = parseAnchor(anchor);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    const s = Math.round(ms / 1000);
    return s < 1 ? "<1 秒" : `${s} 秒`;
  }
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export function fmtHours(h: number): string {
  return Number.isInteger(h) ? `${h}` : h.toFixed(1);
}

