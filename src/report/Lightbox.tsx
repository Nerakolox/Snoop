/**
 * 报告海报灯箱 —— 自研，不引第三方库。
 *
 * 现成 lightbox 库（PhotoSwipe / viewerjs 等）都为 <img> 设计，海报是 DOM 节点不是图片，
 * 用它们就得先截图再喂进去，每次点开跑一遍 foreignObject 截图管线，慢且可能失败。
 * 自己写只需：全屏遮罩（深色 + backdrop 模糊）、海报居中可纵向滚动、顶栏标题 + 缩放 + 关闭、
 * 缩放范围 0.4–1.4 步进 0.16 默认 0.72、Esc / 点背景关闭。
 *
 * 海报只有 1000px 宽，灯箱里够看，不做拖拽平移 / 滚轮缩放。
 * 缩放同样要处理 height 陷阱：transform:scale 不改布局尺寸，stage 高度按「卡片实测高 × scale」
 * 显式给定（ResizeObserver 跟住图标就绪 / 内容变化）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut, X } from "lucide-react";
import type { ReportView } from "./types";
import type { ResolvedIconMap } from "./icons";
import ReportCard from "./ReportCard";
import { EXPORT_WIDTH } from "./export";
import { dateLabel, monthLabel, weekRangeLabel } from "./format";
import "./lightbox.css";

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.4;
const ZOOM_STEP = 0.16;
const ZOOM_DEFAULT = 0.72;

function lightboxTitle(detail: ReportView): string {
  if (detail.report_type === "day") return `${dateLabel(detail.data.date)} · 日报`;
  if (detail.report_type === "week") return `${weekRangeLabel(detail.data.week_start)} · 周报`;
  return `${monthLabel(detail.data.month_start)} · 月报`;
}

export default function Lightbox({
  detail,
  icons,
  onClose,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(ZOOM_DEFAULT);
  const [cardH, setCardH] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  // 海报高度按内容自适应（图标就绪 / 内容变化会重算），stage 高度 = 实测高 × scale。
  useLayoutEffect(() => {
    const el = cardRef.current?.querySelector<HTMLElement>(".report-card");
    if (!el) return;
    const apply = () => setCardH(el.offsetHeight);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [icons, detail]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function zoomIn() {
    setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2)));
  }
  function zoomOut() {
    setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2)));
  }

  // portal 挂 document.body（同导出对话框）：.page-layer 含 transform 会构成 containing block，
  // fixed 子元素若留在页内会相对主内容区而非视口定位。
  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox__title">{lightboxTitle(detail)}</span>
        <div className="lightbox__controls">
          <button type="button" onClick={zoomOut} disabled={scale <= ZOOM_MIN} aria-label="缩小">
            <ZoomOut size={16} />
          </button>
          <span className="lightbox__zoom">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={scale >= ZOOM_MAX} aria-label="放大">
            <ZoomIn size={16} />
          </button>
          <button type="button" className="lightbox__close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="lightbox__scroll">
        <div
          className="lightbox__stage"
          style={{
            height: Math.round(cardH * scale),
            width: Math.round(EXPORT_WIDTH * scale),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="lightbox__scaled" style={{ transform: `scale(${scale})` }}>
            <div ref={cardRef}>
              <ReportCard detail={detail} icons={icons} showFooter />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
