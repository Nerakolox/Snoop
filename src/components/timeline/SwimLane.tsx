/**
 * 单条 App 泳道 —— 左侧 App 名图标 + 右侧色块轨道。
 * 位置/可见性/样式计算由父组件通过 props 传入的函数完成，
 * 子组件只负责渲染。
 * 双模式：renderBlocks 为真渲染真实 block；为假渲染量化段（仅 hover，不点击/键盘）。
 */

import { useMemo, type RefObject } from "react";
import AppIcon from "../AppIcon";
import type { AppLane, TimeBlock } from "../../analytics";
import { quantizeLane } from "../../analytics/quantize";
import type { HoverTarget } from "./TimelineTooltip";
import type { TimeScale } from "../../hooks/useTimeScale";
import Tooltip from "../shared/Tooltip";

type SwimLaneProps = {
  lane: AppLane;
  scale: TimeScale;
  /** 轨道 DOM ref —— 主组件用它做视口 rect 测量，用于滚轮缩放和拖拽 */
  trackRef: RefObject<HTMLDivElement | null>;
  onHover: (hovered: HoverTarget | null) => void;
  /** 存在全局 App 筛选且本泳道不是被选中的那个时为 true */
  dimmed?: boolean;
  /** 真：按真实 block 渲染；假：量化渲染 */
  renderBlocks: boolean;
  /** 量化渲染时的像素格数 */
  cellCount: number;
  onBlockClick: (e: React.MouseEvent, bundleId: string, appName: string, block: TimeBlock) => void;
  onBlockKeyDown: (e: React.KeyboardEvent, bundleId: string, appName: string, block: TimeBlock) => void;
};

export default function SwimLane({
  lane,
  scale,
  trackRef,
  onHover,
  dimmed,
  renderBlocks,
  cellCount,
  onBlockClick,
  onBlockKeyDown,
}: SwimLaneProps) {
  const segments = useMemo(
    () => (renderBlocks ? null : quantizeLane(lane.blocks, scale, cellCount)),
    [renderBlocks, lane.blocks, scale, cellCount]
  );

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
        {renderBlocks
          ? lane.blocks.filter((b) => scale.isVisible(b.start_ms, b.end_ms)).map((block, i) => (
              <div
                key={i}
                className="swimlane-block"
                role="button"
                tabIndex={0}
                style={{
                  ...scale.blockStyle(block.start_ms, block.end_ms),
                  background: `var(--intensity-${block.intensity})`,
                }}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onHover({
                    kind: "block",
                    app: lane.app_name,
                    bundleId: lane.app_bundle_id,
                    block,
                    anchorX: rect.left + rect.width / 2,
                    anchorY: rect.top,
                  });
                }}
                onMouseLeave={() => onHover(null)}
                onClick={(e) => onBlockClick(e, lane.app_bundle_id, lane.app_name, block)}
                onKeyDown={(e) => onBlockKeyDown(e, lane.app_bundle_id, lane.app_name, block)}
              />
            ))
          : segments!.map((s, i) => (
              <div
                key={i}
                className={`swimlane-quant-seg${s.level === 0 ? " swimlane-quant-seg--idle" : ""}`}
                style={{
                  left: `${s.startPct}%`,
                  width: `${s.widthPct}%`,
                  background: `var(--intensity-${s.level})`,
                }}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onHover({
                    kind: "segment",
                    app: lane.app_name,
                    bundleId: lane.app_bundle_id,
                    startMs: scale.pctToTime(s.startPct),
                    endMs: scale.pctToTime(s.startPct + s.widthPct),
                    activeMs: s.activeMs,
                    avgIntensity: s.avgIntensity,
                    anchorX: rect.left + rect.width / 2,
                    anchorY: rect.top,
                  });
                }}
                onMouseLeave={() => onHover(null)}
              />
            ))}
      </div>
    </div>
  );
}
