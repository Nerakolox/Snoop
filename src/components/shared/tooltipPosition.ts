/** 悬浮提示定位：以 anchor 点为中心横向居中，默认显示在上方，
 * 空间不够则翻到下方；最终 clamp 进视口，离边缘至少留 TOOLTIP_GAP。
 * TimelineTooltip / KeyCountTooltip / Tooltip 共用同一套算法。 */

export const TOOLTIP_GAP = 8;

export function positionTooltip(
  el: HTMLElement,
  anchorX: number,
  anchorY: number,
  offset: number
): { left: number; top: number } {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const W = window.innerWidth;
  const H = window.innerHeight;

  let left = anchorX - w / 2;
  left = Math.max(TOOLTIP_GAP, Math.min(W - w - TOOLTIP_GAP, left));

  let top = anchorY - offset - h;
  if (top < TOOLTIP_GAP) top = anchorY + offset;
  top = Math.max(TOOLTIP_GAP, Math.min(H - h - TOOLTIP_GAP, top));

  return { left, top };
}
