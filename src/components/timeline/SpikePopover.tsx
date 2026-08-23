import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { positionTooltip } from "../shared/tooltipPosition";

export type SpikePopoverAnchor = {
  /** 突变发生的小时（0–23），用于标题「HH:00 突变」 */
  hour: number;
  /** 猫吐槽正文 */
  text: string;
  /** 标记的 viewport 中心 x 坐标 */
  anchorX: number;
  /** 标记的 viewport 顶部 y 坐标 */
  anchorY: number;
};

type Props = {
  anchor: SpikePopoverAnchor;
  onClose: () => void;
};

const OFFSET = 10;

/** 突变标记气泡 —— Portal 到 document.body，position: fixed，贴标记下方弹出，
 * 上下/左右碰边自动翻转 + clamp 进视口。标题在气泡内，不是浮在外面的独立标签。 */
export default function SpikePopover({ anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.addEventListener("scroll", onClose, { capture: true });
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", onClose, { capture: true });
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const { left, top } = positionTooltip(
      tip,
      anchor.anchorX,
      anchor.anchorY,
      OFFSET,
      { placement: "bottom" }
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className="swimlane-spike-popover"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="swimlane-spike-popover-title">
        {String(anchor.hour).padStart(2, "0")}:00 突变
      </div>
      <div className="swimlane-spike-popover-body">{anchor.text}</div>
    </div>,
    document.body
  );
}
