/**
 * 键帽击键数 tooltip —— Portal 挂 document.body，position: fixed，用光标坐标定位。
 * 脱离 .kle-keyboard 的 transform: scale，低 scale 配列下不再随键缩小到不可读。
 * 定位/翻转/clamp 沿用 Timeline 页 tooltip（TimelineTooltip）的模式。
 */

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { positionTooltip } from "../shared/tooltipPosition";

export type KeyCountAnchor = {
  /** 键帽标签（已 getDisplayLabel 处理） */
  label: string;
  count: number;
  /** 光标 viewport 坐标 */
  x: number;
  y: number;
};

type Props = { anchor: KeyCountAnchor };

const OFFSET = 12;

export default function KeyCountTooltip({ anchor }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const { left, top } = positionTooltip(tip, anchor.x, anchor.y, OFFSET);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className="kle-key-count-tip"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      <span className="kle-key-count-tip-label">{anchor.label}</span>
      <span className="kle-key-count-tip-num">{anchor.count.toLocaleString()} 次</span>
    </div>,
    document.body
  );
}
