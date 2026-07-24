/**
 * 键盘热力图面板 —— KLE 键盘渲染 + 光学缩放。
 * 1U 固定为 KEY_UNIT，容器放不下时才等比缩放（缩到 MIN_SCALE 为止，
 * 再窄则由 .kle-viewport 横向滚动）。
 */

import { useEffect, useRef, useState } from "react";
import KLEKeyboard from "../KLEKeyboard";
import type { KLEKey } from "../../kleParser";
import { KEY_UNIT, MIN_SCALE, SCALER_PAD_X } from "../../layouts/metrics";

type KeyboardPanelProps = {
  kleKeys: KLEKey[];
  kleKeyCounts: Record<string, number>;
  allKeyCounts: number[];
  maxX: number;
  maxY: number;
};

/** 抵消 Math.round(layoutWidth * scale) 的上舍入，防止 1px 溢出触发滚动条。
 *  基准已改为 viewport.clientWidth（17px 滚动条占位已扣除），故只需 1px。 */
const SCROLLBAR_RESERVE = 1;
/** scale 量化步长：只保留百分位，消除亚像素连续变化 */
const SCALE_STEP = 0.01;
/** 死区阈值：新旧 scale 差小于此值不 setState，防震荡最后一道保险 */
const SCALE_EPSILON = 0.005;

export default function KeyboardPanel({
  kleKeys,
  kleKeyCounts,
  allKeyCounts,
  maxX,
  maxY,
}: KeyboardPanelProps) {
  // 观测对象是 .kle-viewport 本身，读 clientWidth —— 它已扣除 padding、border
  // 与 scrollbar-gutter: stable 恒定预留的滚动条占位，正是内容真正可用的宽度。
  // gutter 恒定预留，滚动条出现/消失不改变 clientWidth，故不会重新引入震荡。
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [needsScroll, setNeedsScroll] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => {
      // rAF 合并：同一帧内多次触发只处理最后一次
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (maxX <= 0) return;
        // clientWidth 已扣除滚动条占位（scrollbar-gutter: stable 恒定预留）。
        // 再扣 SCROLLBAR_RESERVE(1) 吸收 round 上舍入，扣 2*SCALER_PAD_X 让出
        // scaler 的水平内边距（这 16px 只在此处扣一次）。
        const usable = vp.clientWidth - SCROLLBAR_RESERVE - SCALER_PAD_X * 2;
        const raw = usable / (maxX * KEY_UNIT);
        const clamped = Math.min(1, Math.max(MIN_SCALE, raw));
        // Math.floor 只向下取整，保证量化后内容宽必定 ≤ 可用宽，永不溢出。
        // +1e-9 吸收浮点表示误差（如 1/0.01=99.999…），不破坏「≤」保证。
        const quantized = Math.floor(clamped / SCALE_STEP + 1e-9) * SCALE_STEP;

        // 直接判据：缩放后内容宽 > 可用宽才需滚动（正常缩放区间因向下量化必为假）。
        const scaledWidth = Math.round(maxX * KEY_UNIT * quantized);
        const needScroll = scaledWidth > usable;

        setScale((prev) =>
          Math.abs(quantized - prev) < SCALE_EPSILON ? prev : quantized
        );
        setNeedsScroll((prev) => (prev === needScroll ? prev : needScroll));
      });
    });
    ro.observe(vp);
    return () => {
      ro.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [maxX]);

  return (
    <div className="kb-keyboard-section" ref={containerRef}>
      <KLEKeyboard
        keys={kleKeys}
        keyCounts={kleKeyCounts}
        allCounts={allKeyCounts}
        maxX={maxX}
        maxY={maxY}
        scale={scale}
        scrollable={needsScroll}
        viewportRef={viewportRef}
      />
    </div>
  );
}
