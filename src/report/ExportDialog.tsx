/**
 * 导出成图对话框 —— 预览 + 保存。
 *
 * 预览与导出走**同一个** <ReportCard>（foreignObject 方案的优势：所见即所得）。
 * 卡片固定 1000px 宽、高度按内容自适应；预览把卡片用 transform:scale 缩到 300px 宽展示，
 * 保存时取卡片根节点的 offsetWidth/offsetHeight 作为 canvas 尺寸，生成真 1000×H PNG，
 * 预览缩放不影响导出像素。
 *
 * 图标用 useReportIcons 在打开对话框时一次性预解析（Promise.all(get_app_icon)），
 * 就绪后才渲染卡片、才允许保存，避免把字母兜底块截进成品图。
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../components/shared/Toast";
import type { ReportView } from "./types";
import { EXPORT_WIDTH, bytesToBase64, captureNodeAsPng } from "./export";
import { saveReportPng } from "./client";
import { useReportIcons } from "./icons";
import ReportCard from "./ReportCard";
import reportCardCss from "./report-card.css?inline";

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

export default function ExportDialog({
  detail,
  onClose,
}: {
  detail: ReportView;
  onClose: () => void;
}) {
  const toast = useToast();
  const icons = useReportIcons(detail);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardH, setCardH] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const scale = PREVIEW_W / EXPORT_WIDTH;

  // 卡片高度按内容自适应，预览容器高度要跟着实测高度走（transform:scale 不改 offsetHeight，
  // 所以取的是未缩放的布局高度，再乘 scale 换算成预览里的展示高度）。
  useLayoutEffect(() => {
    if (!icons) return;
    const el = cardRef.current?.querySelector<HTMLElement>(".report-card");
    if (el) setCardH(el.offsetHeight);
  }, [icons, detail]);

  async function handleSave() {
    const root = cardRef.current?.querySelector<HTMLElement>(".report-card");
    if (!root) return;
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    setCapturing(true);
    setError(null);
    try {
      const bytes = await captureNodeAsPng(root, width, height, reportCardCss);
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

        <div
          className="export-dialog__preview"
          style={{ height: Math.round(cardH * scale) }}
        >
          {icons ? (
            <div className="export-dialog__scaled" style={{ transform: `scale(${scale})` }}>
              <div ref={cardRef}>
                <ReportCard detail={detail} icons={icons} showFooter />
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
