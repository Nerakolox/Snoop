/**
 * 导出成图对话框（批次 7）—— 预览 + 选尺寸 + 保存。
 *
 * 预览与导出走**同一个** <ReportExportCard>（foreignObject 方案的优势：所见即所得）。
 * 预览把固定 1080×H 的卡片用 transform:scale 缩到 300px 宽展示；保存时取卡片根节点
 * 的 outerHTML 交给 captureNodeAsPng 生成真 1080×H PNG，预览缩放不影响导出像素。
 *
 * 图标在打开对话框时一次性预解析（Promise.all(get_app_icon)），保存按钮等图标就绪后才可用，
 * 避免把字母兜底块截进成品图。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../components/shared/Toast";
import type { ReportView } from "./types";
import { EXPORT_SIZES, bytesToBase64, captureNodeAsPng, type ExportSize } from "./export";
import { saveReportPng } from "./client";
import ReportExportCard, { type ResolvedIconMap } from "./ReportExportCard";
import "./export.css";
import exportCss from "./export.css?inline";

const PREVIEW_W = 300;

const KIND_CN: Record<ReportView["report_type"], string> = {
  day: "日报",
  week: "周报",
  month: "月报",
};

/** 各报的规范化周期日期，作为建议文件名的日期段。 */
function canonicalDate(detail: ReportView): string {
  if (detail.report_type === "day") return detail.data.date;
  if (detail.report_type === "week") return detail.data.week_start;
  return detail.data.month_start;
}

/** 收集报告里出现过的所有 app bundleId（top / 新增 / 消失），用于预解析图标。 */
function collectBundleIds(detail: ReportView): string[] {
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

export default function ExportDialog({
  detail,
  onClose,
}: {
  detail: ReportView;
  onClose: () => void;
}) {
  const toast = useToast();
  const [size, setSize] = useState<ExportSize>("vertical");
  const [icons, setIcons] = useState<ResolvedIconMap | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  const { width, height } = EXPORT_SIZES[size];
  const scale = PREVIEW_W / width;

  async function handleSave() {
    const root = cardRef.current?.querySelector<HTMLElement>(".report-export");
    if (!root) return;
    setCapturing(true);
    setError(null);
    try {
      const bytes = await captureNodeAsPng(root, width, height, exportCss);
      const name = `snoop-${KIND_CN[detail.report_type]}-${canonicalDate(detail)}.png`;
      const savedPath = await saveReportPng(bytesToBase64(bytes), name);
      if (savedPath) {
        toast.show({ message: `已保存：${savedPath}` });
        onClose();
      }
      // savedPath === null → 用户在系统保存框里取消了，留在对话框里不动。
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  }

  // 用 portal 挂到 document.body，position:fixed 相对真实视口定位（同设置页开发模式确认弹窗），
  // 不受 .page-layer 的 transform 包含块影响，居中即视口居中、不会跑到标题栏/侧栏外。
  return createPortal(
    <div className="export-dialog-overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog__head">
          <h3>导出成图</h3>
          <button type="button" className="export-dialog__close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="export-dialog__sizes">
          {(Object.keys(EXPORT_SIZES) as ExportSize[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`export-dialog__size${size === s ? " is-active" : ""}`}
              onClick={() => setSize(s)}
            >
              {EXPORT_SIZES[s].label}
            </button>
          ))}
        </div>

        <div
          className="export-dialog__preview"
          style={{ height: Math.round(height * scale) }}
        >
          {icons ? (
            <div className="export-dialog__scaled" style={{ transform: `scale(${scale})` }}>
              <div ref={cardRef}>
                <ReportExportCard detail={detail} size={size} icons={icons} />
              </div>
            </div>
          ) : (
            <div className="export-dialog__loading">正在准备应用图标…</div>
          )}
        </div>

        {error && <p className="export-dialog__error">{error}</p>}

        <div className="export-dialog__actions">
          <button type="button" className="export-dialog__cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="export-dialog__save"
            onClick={handleSave}
            disabled={capturing || !icons}
          >
            {capturing ? "生成中…" : "保存 PNG"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
