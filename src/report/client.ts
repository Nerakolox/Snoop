// 报告命令的薄封装 —— 全部走后端 Rust 侧 invoke。

import { invoke } from "@tauri-apps/api/core";
import type { ReportMeta, ReportView } from "./types";

/** 全部已生成报告（含「记录太少」），按日期降序。 */
export function getReportList(): Promise<ReportMeta[]> {
  return invoke<ReportMeta[]>("get_report_list");
}

/** 取某日期的完整报告（含叙事）。无行返回 null。 */
export function getReport(reportDate: string): Promise<ReportView | null> {
  return invoke<ReportView | null>("get_report", { reportDate });
}

/** 手动重新生成某日期报告。 */
export function regenerateReport(reportDate: string): Promise<ReportView> {
  return invoke<ReportView>("regenerate_report", { reportDate });
}
