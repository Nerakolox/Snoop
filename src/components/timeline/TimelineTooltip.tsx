import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import AppIcon from "../AppIcon";
import { formatTime, formatDuration } from "../../utils/format";
import type { TimeBlock } from "../../analytics";
import { positionTooltip } from "../shared/tooltipPosition";

export type HoveredBlock = {
  kind: "block";
  app: string;
  bundleId: string;
  block: TimeBlock;
  /** viewport center-x of the hovered block */
  anchorX: number;
  /** viewport top-y of the hovered block */
  anchorY: number;
};

export type HoveredSegment = {
  kind: "segment";
  app: string;
  bundleId: string;
  startMs: number;
  endMs: number;
  activeMs: number;
  avgIntensity: number;
  anchorX: number;
  anchorY: number;
};

export type HoverTarget = HoveredBlock | HoveredSegment;

type TimelineTooltipProps = {
  hovered: HoverTarget;
  onClose: () => void;
};

const OFFSET = 8;

export default function TimelineTooltip({ hovered, onClose }: TimelineTooltipProps) {
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
    const { left, top } = positionTooltip(tip, hovered.anchorX, hovered.anchorY, OFFSET);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }, [hovered]);

  if (hovered.kind === "segment") {
    return createPortal(
      <div
        ref={tooltipRef}
        className="swimlane-tooltip"
        style={{ left: 0, top: 0, visibility: "hidden" }}
      >
        <div className="swimlane-tooltip-app">
          <AppIcon bundleId={hovered.bundleId} appName={hovered.app} size={16} />
          {hovered.app}
        </div>
        <div className="swimlane-tooltip-time">
          {formatTime(hovered.startMs)} – {formatTime(hovered.endMs)}
        </div>
        <div className="swimlane-tooltip-duration">
          活跃 {formatDuration(hovered.activeMs)}
        </div>
        <div className="swimlane-tooltip-intensity">
          平均强度 {hovered.avgIntensity.toFixed(1)}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={tooltipRef}
      className="swimlane-tooltip"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="swimlane-tooltip-app">
        <AppIcon bundleId={hovered.bundleId} appName={hovered.app} size={16} />
        {hovered.app}
      </div>
      <div className="swimlane-tooltip-time">
        {formatTime(hovered.block.start_ms)} –{" "}
        {formatTime(hovered.block.end_ms)}
      </div>
      <div className="swimlane-tooltip-duration">
        {formatDuration(hovered.block.duration_ms)}
      </div>
      <div className="swimlane-tooltip-intensity">
        强度 {hovered.block.intensity}
      </div>
    </div>,
    document.body
  );
}
