export function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function startOfWeek(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  const dow = result.getDay();
  const offsetToMonday = dow === 0 ? 6 : dow - 1;
  result.setDate(result.getDate() - offsetToMonday);
  return result;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatPeriodLabel(
  d: Date,
  mode: "day" | "week",
  isCurrentPeriod: boolean
): string {
  if (isCurrentPeriod) {
    return mode === "day" ? "今天" : "本周";
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  if (mode === "day") {
    const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${year}-${month}-${date} ${days[d.getDay()]}`;
  } else {
    const weekStart = startOfWeek(d);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
    const endMonth = String(weekEnd.getMonth() + 1).padStart(2, "0");
    const endDate = String(weekEnd.getDate()).padStart(2, "0");
    return `${month}-${date} ~ ${endMonth}-${endDate}`;
  }
}
