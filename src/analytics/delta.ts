/**
 * 环比判定的单一真源。DeltaBadge 渲染它，文案生成也读它，
 * 避免「徽章说新增、文案说 +95%」这类同页自相矛盾。
 * 单位一律是分钟，与 DeltaBadge 的既有契约一致。
 */

/** 环比百分比封顶：超过此值一律显示 "999%+"，避免分母极小时把布局撑破 */
export const MAX_DELTA_PCT = 999;
/** 变化幅度在此比例以内视为持平 */
export const FLAT_RATIO = 0.025;

export type DeltaVerdict =
  | { kind: "na" } // 当期基期都不足基数，无从比较
  | { kind: "new" } // 基期不足、当期够 → 视为新增
  | { kind: "flat" }
  | { kind: "up"; pct: number; capped: boolean }
  | { kind: "down"; pct: number; capped: boolean };

export function computeDelta(
  current: number,
  previous: number,
  baseThreshold: number
): DeltaVerdict {
  if (current < baseThreshold && previous < baseThreshold) return { kind: "na" };
  if (previous < baseThreshold) return { kind: "new" };

  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < FLAT_RATIO) return { kind: "flat" };

  const pct = Math.abs(ratio) * 100;
  const capped = pct > MAX_DELTA_PCT;
  return current > previous
    ? { kind: "up", pct, capped }
    : { kind: "down", pct, capped };
}
