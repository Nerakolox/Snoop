/**
 * 键帽击键数 tooltip —— Portal 挂 document.body，position: fixed，用光标坐标定位。
 * 脱离 .kle-keyboard 的 transform: scale，低 scale 配列下不再随键缩小到不可读。
 * 定位/翻转/clamp 沿用 Timeline 页 tooltip（TimelineTooltip）的模式。
 */

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type KeyCountAnchor = {
  /** 键帽标签（已 getDisplayLabel 处理） */
  label: string;
  count: number;
  /** 光标 viewport 坐标 */
  x: number;
  y: number;
};

type Props = { anchor: KeyCountAnchor };

const GAP = 8;
const OFFSET = 12;

export default function KeyCountTooltip({ anchor }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // 默认居中于光标上方；碰上边则翻到下方；再左右/上下 clamp 进视口。
    let left = anchor.x - tipW / 2;
    left = Math.max(GAP, Math.min(W - tipW - GAP, left));

    let top = anchor.y - OFFSET - tipH;
    if (top < GAP) top = anchor.y + OFFSET;
    top = Math.max(GAP, Math.min(H - tipH - GAP, top));

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
