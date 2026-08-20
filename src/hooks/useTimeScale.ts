import { useMemo } from "react";
import { timeToVirt, virtToTime, type Segment } from "../analytics";

export interface TimeScale {
  toPct(virt: number): number;
  timeToPct(t: number): number;
  pctToTime(pct: number): number;
  blockStyle(startMs: number, endMs: number): { left: string; width: string };
  bandStyle(virtStart: number, virtEnd: number): { left: string; width: string };
  isVisible(startMs: number, endMs: number): boolean;
  /** 视口每 1% 宽度对应的虚拟毫秒数，供 Task 4 的 LOD 判据使用 */
  msPerPct: number;
}

export function useTimeScale(
  segments: Segment[],
  viewRange: { start: number; end: number }
): TimeScale {
  return useMemo(() => {
    const viewSpan = viewRange.end - viewRange.start;

    const toPct = (virt: number): number => {
      if (viewSpan <= 0) return 0;
      return ((virt - viewRange.start) / viewSpan) * 100;
    };
    const timeToPct = (t: number): number => toPct(timeToVirt(t, segments));
    const pctToTime = (pct: number): number =>
      virtToTime(viewRange.start + (pct / 100) * viewSpan, segments);

    // 注意：min-width 0.3% 下限原样保留（Task 4 会替换它，本步不要动）
    const blockStyle = (startMs: number, endMs: number) => {
      const vs = timeToVirt(startMs, segments);
      const ve = timeToVirt(endMs, segments);
      const left = toPct(vs);
      const width = Math.max(toPct(ve) - left, 0.3);
      return { left: `${left}%`, width: `${width}%` };
    };
    const bandStyle = (virtStart: number, virtEnd: number) => {
      const left = toPct(virtStart);
      const width = toPct(virtEnd) - left;
      return { left: `${left}%`, width: `${width}%` };
    };
    const isVisible = (startMs: number, endMs: number): boolean => {
      const vs = timeToVirt(startMs, segments);
      const ve = timeToVirt(endMs, segments);
      return ve >= viewRange.start && vs <= viewRange.end;
    };

    return {
      toPct, timeToPct, pctToTime, blockStyle, bandStyle, isVisible,
      msPerPct: viewSpan / 100,
    };
  }, [segments, viewRange.start, viewRange.end]);
}
