/**
 * 时间线色块 hover tooltip —— 边界翻转定位。
 * 位置由 hoveredBlock.x/y 提供（相对 pageRef），本组件负责在挂载后
 * 测量自身尺寸并做边界修正。
 */

import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import AppIcon from "../AppIcon";
import { formatTime, formatDuration } from "../../utils/format";
import type { TimeBlock } from "../../analytics";

export type HoveredBlock = {
  app: string;
  bundleId: string;
  block: TimeBlock;
  x: number;
  y: number;
};

type TimelineTooltipProps = {
  hoveredBlock: HoveredBlock;
  /** 页面容器 ref，用于计算 tooltip 的边界翻转 */
  pageRef: RefObject<HTMLDivElement | null>;
};

export default function TimelineTooltip({ hoveredBlock, pageRef }: TimelineTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!tooltipRef.current || !pageRef.current) return;
    const tip = tooltipRef.current;
    const rect = tip.getBoundingClientRect();
    const container = pageRef.current.getBoundingClientRect();
    const tipW = tip.offsetWidth;

    let dx = 0;
    if (rect.right > container.right - 8) {
      // 右侧空间不足：翻转到光标左侧
      dx = -tipW / 2;
      // 翻转后仍超出左边界则直接 clamp
      if (rect.left - tipW / 2 < container.left + 8) {
        dx = container.left + 8 - rect.left;
      }
    } else if (rect.left < container.left + 8) {
      dx = container.left + 8 - rect.left;
    }

    let dy = 0;
    if (rect.top < container.top + 8) dy = container.top + 8 - rect.top;
    if (rect.bottom > container.bottom - 8) dy = container.bottom - 8 - rect.bottom;

    tip.style.transform = `translate(calc(-50% + ${dx}px), calc(-100% + ${dy}px))`;
    tip.style.visibility = "visible";
  }, [hoveredBlock, pageRef]);

  return (
    <div
      ref={tooltipRef}
      className="swimlane-tooltip"
      style={{ left: hoveredBlock.x, top: hoveredBlock.y - 8, visibility: "hidden" }}
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
    </div>
  );
}
