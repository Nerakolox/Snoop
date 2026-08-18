import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { computeDelta, MAX_DELTA_PCT } from "../analytics/delta";

interface DeltaBadgeProps {
  /** 当期值，单位分钟 */
  current: number;
  /** 基期值，单位分钟 */
  previous: number;
  /** 'vs 上周' | 'vs 上月' | 'vs 昨天'，由调用方给 */
  vsLabel: string;
  /** 基数阈值，单位分钟。日 20 / 周 120 / 月 600 */
  baseThreshold: number;
}

/** 全站唯一的环比展示。判定逻辑在 analytics/delta.ts 的 computeDelta，这里只负责渲染。 */
export default function DeltaBadge({ current, previous, vsLabel, baseThreshold }: DeltaBadgeProps) {
  const verdict = computeDelta(current, previous, baseThreshold);

  if (verdict.kind === "na") {
    return (
      <span className="ins-delta ins-delta--na" title={`基期不足 ${baseThreshold} 分钟`}>
        <span className="ins-delta-num">—</span>
      </span>
    );
  }

  if (verdict.kind === "new") {
    return (
      <span className="ins-delta ins-delta--new" title={`基期不足 ${baseThreshold} 分钟，视为新增`}>
        <span className="ins-delta-num">新</span>
      </span>
    );
  }

  if (verdict.kind === "flat") {
    return (
      <span className="ins-delta ins-delta--flat" title={`${vsLabel}基本持平`}>
        <Minus size={12} />
        <span className="ins-delta-num">持平 {vsLabel}</span>
      </span>
    );
  }

  const { pct, capped } = verdict;
  const numText = capped ? `${MAX_DELTA_PCT}%+` : `${pct.toFixed(1)}%`;

  if (verdict.kind === "up") {
    const title = capped
      ? `${vsLabel} +${pct.toFixed(1)}%（已封顶显示 ${MAX_DELTA_PCT}%+）`
      : `${vsLabel} +${pct.toFixed(1)}%`;
    return (
      <span className="ins-delta ins-delta--up" title={title}>
        <ArrowUpRight size={12} />
        <span className="ins-delta-num">{numText} {vsLabel}</span>
      </span>
    );
  }

  const title = capped
    ? `${vsLabel} -${pct.toFixed(1)}%（已封顶显示 ${MAX_DELTA_PCT}%+）`
    : `${vsLabel} -${pct.toFixed(1)}%`;
  return (
    <span className="ins-delta ins-delta--down" title={title}>
      <ArrowDownRight size={12} />
      <span className="ins-delta-num">{numText} {vsLabel}</span>
    </span>
  );
}
