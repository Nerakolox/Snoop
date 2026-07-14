/**
 * 键盘热力图面板 —— KLE 键盘渲染 + 自适应 unitSize。
 * 内部通过 ResizeObserver 根据容器宽度和键盘 x 轴总跨度动态调整 unitSize。
 */

import { useEffect, useRef, useState } from "react";
import KLEKeyboard from "../KLEKeyboard";
import type { KLEKey } from "../../kleParser";

type KeyboardPanelProps = {
  kleKeys: KLEKey[];
  kleKeyCounts: Record<string, number>;
  allKeyCounts: number[];
};

export default function KeyboardPanel({
  kleKeys,
  kleKeyCounts,
  allKeyCounts,
}: KeyboardPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [unitSize, setUnitSize] = useState(48);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (kleKeys.length === 0) return;
      const maxX = Math.max(...kleKeys.map((k) => k.x + k.w));
      const computed = Math.floor(w / maxX);
      setUnitSize(Math.min(Math.max(computed, 28), 56));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [kleKeys]);

  return (
    <div className="kb-keyboard-section" ref={containerRef}>
      <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
        <KLEKeyboard
          keys={kleKeys}
          keyCounts={kleKeyCounts}
          allCounts={allKeyCounts}
          unitSize={unitSize}
        />
      </div>
    </div>
  );
}
