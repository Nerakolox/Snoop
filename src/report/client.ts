// 报告命令的薄封装 —— 全部走后端 Rust 侧 invoke。

import { invoke } from "@tauri-apps/api/core";
import type { ReportKind, ReportMeta, ReportView } from "./types";

/** 全部已生成报告（含「记录太少」），按日期降序。 */
export function getReportList(): Promise<ReportMeta[]> {
  return invoke<ReportMeta[]>("get_report_list");
}

/** 取某个报告的完整内容（含叙事）。无行返回 null。 */
export function getReport(reportDate: string, reportType: ReportKind): Promise<ReportView | null> {
  return invoke<ReportView | null>("get_report", { reportDate, reportType });
}

/** 手动重新生成某个报告。 */
export function regenerateReport(reportDate: string, reportType: ReportKind): Promise<ReportView> {
  return invoke<ReportView>("regenerate_report", { reportDate, reportType });
}
