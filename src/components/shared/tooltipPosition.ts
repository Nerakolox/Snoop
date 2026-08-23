/** 悬浮提示定位：以 anchor 点为中心横向居中，默认显示在上方，
 * 空间不够则翻到下方；最终 clamp 进视口，离边缘至少留 TOOLTIP_GAP。
 * 靠近左右边缘时横向翻转（锚点贴气泡一侧），不再只做居中 clamp。
 * TimelineTooltip / KeyCountTooltip / Tooltip / SpikePopover 共用同一套算法。 */

export const TOOLTIP_GAP = 8;

export type TooltipPlacement = "top" | "bottom";

export function positionTooltip(
  el: HTMLElement,
  anchorX: number,
  anchorY: number,
  offset: number,
  options?: { placement?: TooltipPlacement }
): { left: number; top: number } {
  const placement = options?.placement ?? "top";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const W = window.innerWidth;
  const H = window.innerHeight;

  // 横向：默认 anchor 居中；右侧放不下则锚点贴气泡右缘往左弹，左侧同理往右弹。
  let left = anchorX - w / 2;
  if (left + w > W - TOOLTIP_GAP) {
    left = anchorX - w - offset;
  } else if (left < TOOLTIP_GAP) {
    left = anchorX + offset;
  }
  left = Math.max(TOOLTIP_GAP, Math.min(W - w - TOOLTIP_GAP, left));

  // 纵向：默认在锚点上方，空间不够翻到下方；placement="bottom" 则相反。
  let top: number;
  if (placement === "bottom") {
    top = anchorY + offset;
    if (top + h > H - TOOLTIP_GAP) top = anchorY - offset - h;
  } else {
    top = anchorY - offset - h;
    if (top < TOOLTIP_GAP) top = anchorY + offset;
  }
  top = Math.max(TOOLTIP_GAP, Math.min(H - h - TOOLTIP_GAP, top));

  return { left, top };
}
