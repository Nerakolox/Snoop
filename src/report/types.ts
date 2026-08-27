// 报告页前端类型 —— 与后端 `src-tauri/src/report/*` 的 serde 序列化对齐（snake_case）。

export interface AppRank {
  name: string;
  bundle_id: string;
  active_ms: number;
  share_pct: number;
}

export interface CategoryShare {
  category: string;
  active_ms: number;
  share_pct: number;
}

export interface HourCell {
  hour: number;
  active_ms: number;
}

export interface FocusSegment {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

export interface Compare7d {
  avg_active_ms: number;
  avg_switch_count: number;
  active_delta_pct: number;
  switch_delta_pct: number;
}

export interface AppRef {
  name: string;
  bundle_id: string;
}

export interface DailyReport {
  date: string;
  active_ms: number;
  foreground_ms: number;
  switch_count: number;
  span_start_ms: number;
  span_end_ms: number;
  top_apps: AppRank[];
  categories: CategoryShare[];
  hourly: HourCell[];
  peak_hour: number;
  longest_focus: FocusSegment;
  vs_7d: Compare7d;
  new_apps: AppRef[];
}

export interface ReportMeta {
  report_date: string;
  report_type: string;
  status: "ok" | "too_little";
  generated_at_ms: number;
  active_ms: number;
  foreground_ms: number;
  narrative_source: string | null;
}

export type ReportKind = "day" | "week" | "month";

// ── 生成时快照 ────────────────────────────────────────────────────────────────
//
// 报告是快照，视图是实时。分类的显示名与配色**只能**从 snapshot 读，
// 绝不能拿 `category` id 再去 `categories/store` 查——那是实时状态，
// 改名改色就会改写历史报告。概览页与规律页则相反，继续实时查。
// 快照的构造与写入全在后端（`src-tauri/src/report/snapshot.rs`）。

/** 快照里的一个分类：id 之外的一切都是生成那一刻的值。 */
export interface CategorySnap {
  id: string;
  /** 生成时的显示名。分类被改名或永久删除后，这里仍是当时那个名字。 */
  name: string;
  /** 生成时解析后的最终色值，可直接作为 CSS 颜色使用（hex 或字面量 oklch()）。 */
  color: string;
  active_ms: number;
  share_pct: number;
}

/** 快照里的一个 App，分类归属一并冻结。 */
export interface AppSnap {
  bundle_id: string;
  name: string;
  active_ms: number;
  share_pct: number;
  category_id: string;
  category_name: string;
}

export interface ReportSnapshot {
  categories: CategorySnap[];
  apps: AppSnap[];
}

export type ReportView =
  | { report_type: "day"; status: "ok" | "too_little"; data: DailyReport; narrative: string | null; narrative_source: string | null; snapshot: ReportSnapshot }
  | { report_type: "week"; status: "ok" | "too_little"; data: WeeklyReport; narrative: string | null; narrative_source: string | null; snapshot: ReportSnapshot }
  | { report_type: "month"; status: "ok" | "too_little"; data: MonthlyReport; narrative: string | null; narrative_source: string | null; snapshot: ReportSnapshot };

// ── 周报 ──────────────────────────────────────────────────────────────────

export interface Baseline4w {
  from_date: string;
  to_date: string;
  weeks_counted: number;
  days_with_data: number;
  avg_daily_active_ms: number;
  avg_weekly_active_ms: number;
  daily_delta_pct: number;
  baseline_sufficient: boolean;
}

export interface DayCell {
  date: string;
  dow: number; // 0=周一 … 6=周日
  active_ms: number;
  foreground_ms: number;
}

export interface CategoryDelta {
  category: string;
  active_ms: number;
  share_pct: number;
  baseline_share_pct: number;
  share_delta_pp: number;
}

export interface RhythmDay {
  date: string;
  start_min: number | null;
  end_min: number | null;
  active_ms: number;
  overnight: boolean;
  overnight_end_min: number | null;
  counted: boolean;
}

export interface RhythmSummary {
  days_counted: number;
  avg_start_min: number | null;
  avg_end_min: number | null;
  baseline_days_counted: number;
  baseline_avg_start_min: number | null;
  baseline_avg_end_min: number | null;
  start_delta_min: number | null;
  end_delta_min: number | null;
  overnight_days: number;
}

export interface WeekdayWeekend {
  weekday_days: number;
  weekend_days: number;
  weekday_avg_active_ms: number;
  weekend_avg_active_ms: number;
}

export interface GoneApp {
  name: string;
  bundle_id: string;
  baseline_active_ms: number;
  baseline_weeks: number;
}

export interface WeeklyReport {
  week_start: string;
  week_end: string;
  active_ms: number;
  foreground_ms: number;
  days_with_data: number;
  avg_daily_active_ms: number;
  baseline: Baseline4w;
  days: DayCell[];
  max_day: string | null;
  min_day: string | null;
  categories: CategoryDelta[];
  rhythm: RhythmDay[];
  rhythm_summary: RhythmSummary;
  weekday_weekend: WeekdayWeekend;
  top_apps: AppRank[];
  new_apps: AppRef[];
  gone_apps: GoneApp[];
}

// ── 月报 ──────────────────────────────────────────────────────────────────

export interface PrevMonth {
  month_start: string;
  active_ms: number;
  days_with_data: number;
  avg_daily_active_ms: number;
  daily_delta_pct: number;
}

export interface MonthWeek {
  week_start: string;
  clip_from: string;
  clip_to: string;
  days_in_month: number;
  days_with_data: number;
  partial: boolean;
  active_ms: number;
  avg_daily_active_ms: number;
  categories: CategoryShare[];
}

export interface CategoryHalfShift {
  category: string;
  first_half_share_pct: number;
  second_half_share_pct: number;
  delta_pp: number;
}

export interface MonthlyReport {
  month_start: string;
  month_end: string;
  active_ms: number;
  foreground_ms: number;
  days_with_data: number;
  avg_daily_active_ms: number;
  prev_month: PrevMonth;
  weeks: MonthWeek[];
  half_shift: CategoryHalfShift[];
  max_day: DayCell | null;
  min_day: DayCell | null;
  days: DayCell[];
  categories: CategoryShare[];
  top_apps: AppRank[];
  new_apps: AppRef[];
}
