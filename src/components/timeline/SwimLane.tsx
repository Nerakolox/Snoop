/**
 * 单条 App 泳道 —— 左侧 App 名图标 + 右侧色块轨道。
 * 位置/可见性/样式计算由父组件通过 props 传入的函数完成，
 * 子组件只负责渲染。
 */

import type { CSSProperties, RefObject } from "react";
import AppIcon from "../AppIcon";
import type { AppLane, TimeBlock, Tick } from "../../analytics";
import type { HoveredBlock } from "./TimelineTooltip";

type SwimLaneProps = {
  lane: AppLane;
  ticks: Tick[];
  virtToPct: (v: number) => number;
  blockStyle: (block: TimeBlock) => CSSProperties;
  isBlockVisible: (block: TimeBlock) => boolean;
  pageRef: RefObject<HTMLDivElement | null>;
  /** 轨道 DOM ref —— 主组件用它做视口 rect 测量，用于滚轮缩放和拖拽 */
  trackRef: RefObject<HTMLDivElement | null>;
  onHoverBlock: (hovered: HoveredBlock | null) => void;
};

export default function SwimLane({
  lane,
  ticks,
  virtToPct,
  blockStyle,
  isBlockVisible,
  pageRef,
  trackRef,
  onHoverBlock,
}: SwimLaneProps) {
  return (
    <div className="swimlane-row">
      <div className="swimlane-label">
        <AppIcon
          bundleId={lane.app_bundle_id}
          appName={lane.app_name}
          size={16}
        />
        <span className="swimlane-app-name" title={lane.app_name}>
          {lane.app_name}
        </span>
      </div>
      <div ref={trackRef} className="swimlane-track">
        {ticks.map((tk) => (
          <div
            key={tk.time_ms}
            className="swimlane-grid-line"
            style={{ left: `${virtToPct(tk.virt)}%` }}
          />
        ))}
        {lane.blocks.filter(isBlockVisible).map((block, i) => (
          <div
            key={i}
            className="swimlane-block"
            style={{
              ...blockStyle(block),
              background: lane.color,
            }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pageRect = pageRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
              onHoverBlock({
                app: lane.app_name,
                bundleId: lane.app_bundle_id,
                block,
                x: rect.left + rect.width / 2 - pageRect.left,
                y: rect.top - pageRect.top,
              });
            }}
            onMouseLeave={() => onHoverBlock(null)}
          />
        ))}
      </div>
    </div>
  );
}
