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

export default function KeyboardPanel({
  kleKeys,
  kleKeyCounts,
  allKeyCounts,
  maxX,
  maxY,
}: KeyboardPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (maxX <= 0) return;
      const containerWidth = entry.contentRect.width;
      const layoutWidth = maxX * KEY_UNIT;
      const rawScale = containerWidth / layoutWidth;
      setScale(Math.min(Math.max(rawScale, MIN_SCALE), 1));
    });
    ro.observe(el);
    return () => ro.disconnect();
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
      />
    </div>
  );
}
