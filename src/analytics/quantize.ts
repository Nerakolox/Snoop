/**
 * 泳道量化渲染 —— 把一条 lane 的 block 压进等宽虚拟时间格,每格定一个显示档,再 RLE 合并。
 *
 * 与 Task 1 的强度分档是两回事(有意为之,不要"统一"):
 *   - Task 1 产出 block.intensity,是**权威强度**,必须从原始 EPM 经 intensity.ts 的对数分桶得出;
 *   - 这里是把多个**已定档**的 block 压进一个像素格的**显示聚合**,不产生新的权威值。
 *     所以这里允许对已分好的档做"时长加权平均",纯为视觉,不回流进任何数据字段。
 *
 * 网格锚定在虚拟时间轴上(而非视口):quantizeLaneVirtual 对整条虚拟时间轴一次性量化并缓存,
 * 格子边界是虚拟时间的整数倍、与当前视口无关。拖拽平移视口时不重新量化，只用 sliceQuantized
 * 从缓存结果里取落在视口内的段、换算成当前视口下的百分比。只有缩放跨越格宽档位时才应重算。
 */
import type { Segment, TimeBlock } from "./timeline";
import { timeToVirt, virtToTime } from "./timeline";

/** 量化格的显示档:0=挂机(有覆盖但全静默),1-4=活跃。null 表示无覆盖,不输出。 */
export type QuantLevel = 0 | 1 | 2 | 3 | 4;

/** 量化后的一段连续同档区间 —— 锚定在虚拟时间轴上，与视口无关，可跨帧安全缓存。 */
export type VirtQuantizedSegment = {
  /** 该段起始格在虚拟时间轴上的索引 —— 拖拽平移时保持不变，供 React key 使用 */
  startCell: number;
  /** 该段跨越的格数 */
  cellSpan: number;
  startVirt: number;
  endVirt: number;
  level: QuantLevel;
  /** 该段合并后的总活跃时长(真实 ms,供 hover 气泡) */
  activeMs: number;
  /** 该段加权平均强度档(0..4,未做覆盖率衰减的原始平均,供 hover 气泡) */
  avgIntensity: number;
};

/** 换算到当前视口百分比坐标后的渲染段 —— 每帧从 VirtQuantizedSegment[] 切片得出。 */
export type QuantizedSegment = {
  /** 透传自 VirtQuantizedSegment，供 React key 使用（比数组下标稳定） */
  startCell: number;
  startPct: number;
  widthPct: number;
  level: QuantLevel;
  activeMs: number;
  avgIntensity: number;
};

/** 格宽离散档位(虚拟毫秒)。缩放只在这几档间跳变，不连续变化，避免每帧都令缓存失效。 */
const CELL_WIDTH_TIERS_VIRT_MS: Array<{ maxSpanVirt: number; widthVirt: number }> = [
  { maxSpanVirt: 3 * 60 * 60 * 1000, widthVirt: 5_000 },
  { maxSpanVirt: 10 * 60 * 60 * 1000, widthVirt: 30_000 },
  { maxSpanVirt: Infinity, widthVirt: 2 * 60_000 },
];

/** 按当前视口跨度(虚拟毫秒)挑选格宽档位。 */
export function pickCellWidthVirt(viewSpanVirt: number): number {
  for (const tier of CELL_WIDTH_TIERS_VIRT_MS) {
    if (viewSpanVirt <= tier.maxSpanVirt) return tier.widthVirt;
  }
  return CELL_WIDTH_TIERS_VIRT_MS[CELL_WIDTH_TIERS_VIRT_MS.length - 1].widthVirt;
}

/**
 * 对整条虚拟时间轴量化一条 lane 的 block，格子边界锚定在虚拟时间轴的 cellWidthVirt 整数倍上。
 * 结果与视口无关，缓存键应为 (blocks 数据版本, segments, totalVirt, cellWidthVirt)。
 */
export function quantizeLaneVirtual(
  blocks: TimeBlock[],
  segments: Segment[],
  totalVirt: number,
  cellWidthVirt: number
): VirtQuantizedSegment[] {
  if (totalVirt <= 0 || cellWidthVirt <= 0) return [];
  const cellCount = Math.max(1, Math.ceil(totalVirt / cellWidthVirt));

  // 每个格的真实时间边界(压缩模式下相邻格的真实时长不等)
  const cellStart = new Array<number>(cellCount);
  const cellEnd = new Array<number>(cellCount);
  const cellStartVirt = new Array<number>(cellCount);
  const cellEndVirt = new Array<number>(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const vs = i * cellWidthVirt;
    const ve = Math.min(totalVirt, (i + 1) * cellWidthVirt);
    cellStartVirt[i] = vs;
    cellEndVirt[i] = ve;
    cellStart[i] = virtToTime(vs, segments);
    cellEnd[i] = virtToTime(ve, segments);
  }

  const activeMs = new Float64Array(cellCount);
  const weighted = new Float64Array(cellCount);

  for (const b of blocks) {
    const v0 = Math.max(0, timeToVirt(b.start_ms, segments));
    const v1 = Math.min(totalVirt, timeToVirt(b.end_ms, segments));
    if (v1 <= v0) continue;
    const i0 = Math.max(0, Math.floor(v0 / cellWidthVirt));
    const i1 = Math.min(cellCount - 1, Math.floor((v1 - 1e-9) / cellWidthVirt));
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

  const result: VirtQuantizedSegment[] = [];
  let runStart = -1;
  let runLevel: QuantLevel = 0;
  let runActive = 0;
  let runWeighted = 0;

  const flush = (endCell: number) => {
    if (runStart < 0) return;
    result.push({
      startCell: runStart,
      cellSpan: endCell - runStart,
      startVirt: cellStartVirt[runStart],
      endVirt: cellEndVirt[endCell - 1],
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
  return result;
}

/**
 * 把锚定在虚拟时间轴上的量化结果切到当前视口，换算成百分比坐标供渲染。
 * 纯位置换算，不重新分档 —— 拖拽平移时同一格颜色恒定，只有位置随 toPct 平移。
 * 视口外的部分不裁剪 pct 范围，交给 `.swimlane-track` 的 overflow:hidden 处理，
 * 与真实 block 的裁剪方式保持一致。
 */
export function sliceQuantized(
  full: VirtQuantizedSegment[],
  viewRange: { start: number; end: number },
  toPct: (virt: number) => number
): QuantizedSegment[] {
  if (viewRange.end <= viewRange.start) return [];
  const result: QuantizedSegment[] = [];
  for (const seg of full) {
    if (seg.endVirt < viewRange.start || seg.startVirt > viewRange.end) continue;
    const left = toPct(seg.startVirt);
    const width = toPct(seg.endVirt) - left;
    if (width <= 0) continue;
    result.push({
      startCell: seg.startCell,
      startPct: left,
      widthPct: width,
      level: seg.level,
      activeMs: seg.activeMs,
      avgIntensity: seg.avgIntensity,
    });
  }
  return result;
}

/** 把 RLE 合并后的 segments 展开回逐格强度数组（长度 cellCount，无覆盖的格记 0）。
 *  供需要"相邻格比较"的场景使用（如聚合条的突变检测），不改变量化本身的定档逻辑。 */
export function segmentsToCellLevels(segments: QuantizedSegment[], cellCount: number): number[] {
  const W = 100 / cellCount;
  const levels = new Array<number>(cellCount).fill(0);
  for (const s of segments) {
    const i0 = Math.round(s.startPct / W);
    const span = Math.max(1, Math.round(s.widthPct / W));
    for (let i = i0; i < i0 + span && i < cellCount; i++) {
      if (i >= 0) levels[i] = s.level;
    }
  }
  return levels;
}
