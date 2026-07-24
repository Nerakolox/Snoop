/**
 * 键盘热力图面板 —— KLE 键盘渲染 + 光学缩放。
 * 1U 固定为 KEY_UNIT，容器放不下时才等比缩放（缩到 MIN_SCALE 为止，
 * 再窄则由 .kle-viewport 横向滚动）。
 */

import { useEffect, useRef, useState } from "react";
import KLEKeyboard from "../KLEKeyboard";
import type { KLEKey } from "../../kleParser";
import { KEY_UNIT, MIN_SCALE } from "../../layouts/metrics";

type KeyboardPanelProps = {
  kleKeys: KLEKey[];
  kleKeyCounts: Record<string, number>;
  allKeyCounts: number[];
  maxX: number;
  maxY: number;
};

/** 抵消浮点舍入，防止 scale=1 时 1px 溢出触发滚动条 */
const SCROLLBAR_RESERVE = 2;
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
  // 观测对象是 .kb-keyboard-section —— 它自身不滚动（滚动交给内部 .kle-viewport），
  // 宽度不受滚动条出现/消失影响，从而断开 ResizeObserver↔滚动条 的反馈震荡。
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      // rAF 合并：同一帧内多次触发只处理最后一次
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (maxX <= 0) return;
        const entry = entries[entries.length - 1];
        // 读 contentBoxSize（不含 padding/滚动条）；旧环境回退到 contentRect
        const box = Array.isArray(entry.contentBoxSize)
          ? entry.contentBoxSize[0]
          : (entry.contentBoxSize as unknown as ResizeObserverSize | undefined);
        const observedWidth = box ? box.inlineSize : entry.contentRect.width;

        const usable = observedWidth - SCROLLBAR_RESERVE;
        const raw = usable / (maxX * KEY_UNIT);
        const clamped = Math.min(1, Math.max(MIN_SCALE, raw));
        // Math.floor 只向下取整，保证量化后内容宽必定 ≤ 可用宽，永不溢出。
        // +1e-9 吸收浮点表示误差（如 1/0.01=99.999…），不破坏「≤」保证。
        const quantized = Math.floor(clamped / SCALE_STEP + 1e-9) * SCALE_STEP;

        setScale((prev) =>
          Math.abs(quantized - prev) < SCALE_EPSILON ? prev : quantized
        );
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [maxX]);

  // 仅当已缩到下限仍放不下时，才允许 .kle-viewport 横向滚动
  const scrollable = scale <= MIN_SCALE;

  return (
    <div className="kb-keyboard-section" ref={containerRef}>
      <KLEKeyboard
        keys={kleKeys}
        keyCounts={kleKeyCounts}
        allCounts={allKeyCounts}
        maxX={maxX}
        maxY={maxY}
        scale={scale}
        scrollable={scrollable}
      />
    </div>
  );
}
