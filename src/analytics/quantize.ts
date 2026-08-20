/**
 * 泳道量化渲染 —— 把一条 lane 的 block 压进 cellCount 个等宽像素格,每格定一个显示档,再 RLE 合并。
 *
 * 与 Task 1 的强度分档是两回事(有意为之,不要"统一"):
 *   - Task 1 产出 block.intensity,是**权威强度**,必须从原始 EPM 经 intensity.ts 的对数分桶得出;
 *   - 这里是把多个**已定档**的 block 压进一个像素格的**显示聚合**,不产生新的权威值。
 *     所以这里允许对已分好的档做"时长加权平均",纯为视觉,不回流进任何数据字段。
 */
import type { TimeBlock } from "./timeline";

/** 量化格的显示档:0=挂机(有覆盖但全静默),1-4=活跃。null 表示无覆盖,不输出。 */
export type QuantLevel = 0 | 1 | 2 | 3 | 4;

/** 量化后的一段连续同档区间。 */
export type QuantizedSegment = {
  startPct: number;
  widthPct: number;
  level: QuantLevel;
  /** 该段合并后的总活跃时长(真实 ms,供 hover 气泡) */
  activeMs: number;
  /** 该段加权平均强度档(0..4,未做覆盖率衰减的原始平均,供 hover 气泡) */
  avgIntensity: number;
};

/** 坐标映射:需要双向(正映 time→pct 用于定位,逆映 pct→time 用于算真实时长)。TimeScale 结构上满足。 */
export type QuantizeCoord = {
  timeToPct(t: number): number;
  pctToTime(pct: number): number;
};

export function quantizeLane(
  blocks: TimeBlock[],
  coord: QuantizeCoord,
  cellCount: number
): QuantizedSegment[] {
  const W = 100 / cellCount;

  // 每个格的真实时间边界(压缩模式下相邻格的真实时长不等)
  const cellStart = new Array<number>(cellCount);
  const cellEnd = new Array<number>(cellCount);
  for (let i = 0; i < cellCount; i++) {
    cellStart[i] = coord.pctToTime(i * W);
    cellEnd[i] = coord.pctToTime((i + 1) * W);
  }

  const activeMs = new Float64Array(cellCount);
  const weighted = new Float64Array(cellCount);

  for (const b of blocks) {
    const p0 = Math.max(0, coord.timeToPct(b.start_ms));
    const p1 = Math.min(100, coord.timeToPct(b.end_ms));
    if (p1 <= p0) continue;
    const i0 = Math.max(0, Math.floor(p0 / W));
    const i1 = Math.min(cellCount - 1, Math.floor((p1 - 1e-9) / W));
    for (let i = i0; i <= i1; i++) {
      const overlap = Math.max(
        0,
        Math.min(b.end_ms, cellEnd[i]) - Math.max(b.start_ms, cellStart[i])
      );
      if (overlap > 0) {
        activeMs[i] += overlap;
        weighted[i] += overlap * b.intensity;
      }
    }
  }

  const segments: QuantizedSegment[] = [];
  let runStart = -1;
  let runLevel: QuantLevel = 0;
  let runActive = 0;
  let runWeighted = 0;

  const flush = (endCell: number) => {
    if (runStart < 0) return;
    segments.push({
      startPct: runStart * W,
      widthPct: (endCell - runStart) * W,
      level: runLevel,
      activeMs: runActive,
      avgIntensity: runActive > 0 ? runWeighted / runActive : 0,
    });
    runStart = -1;
    runActive = 0;
    runWeighted = 0;
  };

  for (let i = 0; i < cellCount; i++) {
    // 定档(修正 B):
    //   activeMs===0 → null(无覆盖,露出轨道底色)
    //   weighted===0 → 0(覆盖到的 block 全是挂机)
    //   否则活跃格下限恒为 1,覆盖率衰减只压档不压成挂机
    let level: QuantLevel | null;
    if (activeMs[i] === 0) {
      level = null;
    } else if (weighted[i] === 0) {
      level = 0;
    } else {
      const avg = weighted[i] / activeMs[i]; // 0..4
      const cellDur = cellEnd[i] - cellStart[i];
      const cov = cellDur > 0 ? Math.min(1, activeMs[i] / cellDur) : 0;
      level = Math.max(1, Math.min(4, Math.round(avg * (0.4 + 0.6 * cov)))) as QuantLevel;
    }

    if (level === null) {
      flush(i);
      continue;
    }
    if (runStart < 0) {
      runStart = i;
      runLevel = level;
      runActive = activeMs[i];
      runWeighted = weighted[i];
    } else if (level === runLevel) {
      runActive += activeMs[i];
      runWeighted += weighted[i];
    } else {
      flush(i);
      runStart = i;
      runLevel = level;
      runActive = activeMs[i];
      runWeighted = weighted[i];
    }
  }
  flush(cellCount);
  return segments;
}
