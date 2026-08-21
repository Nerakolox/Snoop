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

export interface ReportView {
  data: DailyReport;
  narrative: string | null;
  narrative_source: string | null;
}
