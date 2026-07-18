import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import AppIcon from "../AppIcon";
import { formatTime, formatDuration } from "../../utils/format";
import type { TimeBlock } from "../../analytics";

export type HoveredBlock = {
  app: string;
  bundleId: string;
  block: TimeBlock;
  /** viewport center-x of the hovered block */
  anchorX: number;
  /** viewport top-y of the hovered block */
  anchorY: number;
};

type TimelineTooltipProps = {
  hoveredBlock: HoveredBlock;
  onClose: () => void;
};

const GAP = 8;
const OFFSET = 8;

export default function TimelineTooltip({ hoveredBlock, onClose }: TimelineTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.addEventListener("scroll", onClose, { capture: true });
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", onClose, { capture: true });
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    if (!tip) return;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;

    let left = hoveredBlock.anchorX - tipW / 2;
    left = Math.max(GAP, Math.min(W - tipW - GAP, left));

    let top = hoveredBlock.anchorY - OFFSET - tipH;
    if (top < GAP) top = hoveredBlock.anchorY + OFFSET;
    top = Math.max(GAP, Math.min(H - tipH - GAP, top));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }, [hoveredBlock]);

  return createPortal(
    <div
      ref={tooltipRef}
      className="swimlane-tooltip"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="swimlane-tooltip-app">
        <AppIcon bundleId={hoveredBlock.bundleId} appName={hoveredBlock.app} size={16} />
        {hoveredBlock.app}
      </div>
      <div className="swimlane-tooltip-time">
        {formatTime(hoveredBlock.block.start_ms)} –{" "}
        {formatTime(hoveredBlock.block.end_ms)}
      </div>
      <div className="swimlane-tooltip-duration">
        {formatDuration(hoveredBlock.block.duration_ms)}
      </div>
      <div className="swimlane-tooltip-intensity">
        强度 {hoveredBlock.block.intensity}
      </div>
    </div>,
    document.body
  );
}
