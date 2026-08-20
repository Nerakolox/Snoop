/**
 * 单条 App 泳道 —— 左侧 App 名图标 + 右侧色块轨道。
 * 位置/可见性/样式计算由父组件通过 props 传入的函数完成，
 * 子组件只负责渲染。
 */

import type { RefObject } from "react";
import AppIcon from "../AppIcon";
import type { AppLane, TimeBlock } from "../../analytics";
import type { HoveredBlock } from "./TimelineTooltip";
import type { TimeScale } from "../../hooks/useTimeScale";
import Tooltip from "../shared/Tooltip";

type SwimLaneProps = {
  lane: AppLane;
  scale: TimeScale;
  /** 轨道 DOM ref —— 主组件用它做视口 rect 测量，用于滚轮缩放和拖拽 */
  trackRef: RefObject<HTMLDivElement | null>;
  onHoverBlock: (hovered: HoveredBlock | null) => void;
  /** 存在全局 App 筛选且本泳道不是被选中的那个时为 true */
  dimmed?: boolean;
  onBlockClick: (e: React.MouseEvent, bundleId: string, appName: string, block: TimeBlock) => void;
  onBlockKeyDown: (e: React.KeyboardEvent, bundleId: string, appName: string, block: TimeBlock) => void;
};

export default function SwimLane({
  lane,
  scale,
  trackRef,
  onHoverBlock,
  dimmed,
  onBlockClick,
  onBlockKeyDown,
}: SwimLaneProps) {
  return (
    <div className={`swimlane-row${dimmed ? " swimlane-row--dim" : ""}`}>
      <div className="swimlane-label">
        <AppIcon
          bundleId={lane.app_bundle_id}
          appName={lane.app_name}
          size={16}
        />
        <Tooltip content={lane.app_name}>
          <span className="swimlane-app-name">{lane.app_name}</span>
        </Tooltip>
      </div>
      <div ref={trackRef} className="swimlane-track">
        {lane.blocks.filter((b) => scale.isVisible(b.start_ms, b.end_ms)).map((block, i) => (
          <div
            key={i}
            className="swimlane-block"
            role="button"
            tabIndex={0}
            style={{
              ...scale.blockStyle(block.start_ms, block.end_ms),
              background: lane.color,
            }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onHoverBlock({
                app: lane.app_name,
                bundleId: lane.app_bundle_id,
                block,
                anchorX: rect.left + rect.width / 2,
                anchorY: rect.top,
              });
            }}
            onMouseLeave={() => onHoverBlock(null)}
            onClick={(e) => onBlockClick(e, lane.app_bundle_id, lane.app_name, block)}
            onKeyDown={(e) => onBlockKeyDown(e, lane.app_bundle_id, lane.app_name, block)}
          />
        ))}
      </div>
    </div>
  );
}
