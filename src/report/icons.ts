// 报告卡片的 app 图标解析 —— 应用内详情卡与导出成图共用同一套。
//
// 导出成图走 foreignObject → canvas，图标必须是 data URI 且必须在截图前就绪，
// 所以两种场景都走「先 collectBundleIds → Promise.all(get_app_icon) → ResolvedIconMap」，
// 再由卡片同步渲染 <img src="data:..."> 或字母兜底块。应用内不再用 AppIcon 的
// 组件内异步自解析，保证两种场景渲染的是同一棵树。
//
// `useReportIcons` 在图标未就绪时返回 null，卡片用字母兜底占位；就绪后重渲染，
// 应用内表现为图标陆续「补上」。导出对话框则以此为信号，就绪后才允许保存。

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ReportView } from "./types";

/** 已解析的 app 图标：bundleId → base64（无图标为 null）。 */
export type ResolvedIconMap = Map<string, string | null>;

/** 收集报告里出现过的所有 app bundleId（top / 新增 / 消失），用于预解析图标。 */
export function collectBundleIds(detail: ReportView): string[] {
  const ids = new Set<string>();
  const push = (list: { bundle_id: string }[]) => list.forEach((x) => ids.add(x.bundle_id));
  if (detail.report_type === "week") {
    push(detail.data.top_apps);
    push(detail.data.new_apps);
    push(detail.data.gone_apps);
  } else {
    push(detail.data.top_apps);
    push(detail.data.new_apps);
  }
  return [...ids];
}

/** 预解析一份报告的所有 app 图标。未就绪返回 null。 */
export function useReportIcons(detail: ReportView | null): ResolvedIconMap | null {
  const [icons, setIcons] = useState<ResolvedIconMap | null>(null);

  useEffect(() => {
    if (!detail) return;
    let alive = true;
    const ids = collectBundleIds(detail);
    Promise.all(
      ids.map((id) => invoke<string | null>("get_app_icon", { bundleId: id }).catch(() => null)),
    ).then((results) => {
      if (!alive) return;
      const map: ResolvedIconMap = new Map();
      ids.forEach((id, i) => map.set(id, results[i]));
      setIcons(map);
    });
    return () => {
      alive = false;
    };
  }, [detail]);

  return icons;
}
