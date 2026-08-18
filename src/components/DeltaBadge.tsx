import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/** 环比百分比封顶：超过此值一律显示 "999%+"，避免分母极小时的百分比爆炸把布局撑破 */
const MAX_DELTA_PCT = 999;
/** 变化幅度在此比例以内视为持平 */
const FLAT_RATIO = 0.025;

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

export default function DeltaBadge({ current, previous, vsLabel, baseThreshold }: DeltaBadgeProps) {
  if (current < baseThreshold && previous < baseThreshold) {
    return (
      <span className="ins-delta ins-delta--na" title={`基期不足 ${baseThreshold} 分钟`}>
        <span className="ins-delta-num">—</span>
      </span>
    );
  }

  if (previous < baseThreshold && current >= baseThreshold) {
    return (
      <span className="ins-delta ins-delta--new" title={`基期不足 ${baseThreshold} 分钟，视为新增`}>
        <span className="ins-delta-num">新</span>
      </span>
    );
  }

  const ratio = (current - previous) / previous;

  if (Math.abs(ratio) < FLAT_RATIO) {
    return (
      <span className="ins-delta ins-delta--flat" title={`${vsLabel}基本持平`}>
        <Minus size={12} />
        <span className="ins-delta-num">持平 {vsLabel}</span>
      </span>
    );
  }

  const pct = Math.abs(ratio) * 100;
  const capped = pct > MAX_DELTA_PCT;
  const numText = capped ? `${MAX_DELTA_PCT}%+` : `${pct.toFixed(1)}%`;

  if (current > previous) {
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
