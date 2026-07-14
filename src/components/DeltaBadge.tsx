import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/** 环比百分比封顶：超过此值一律显示 "999%+"，避免分母极小时的百分比爆炸把布局撑破 */
const MAX_DELTA_PCT = 999;

export default function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) {
    return (
      <span className="ins-delta ins-delta--new" title="上周未使用">
        <span className="ins-delta-num">新</span>
      </span>
    );
  }
  if (delta === 0) {
    return (
      <span className="ins-delta ins-delta--flat" title="与上周持平">
        <Minus size={12} />
        <span className="ins-delta-num">持平</span>
      </span>
    );
  }

  const abs = Math.abs(delta);
  const capped = abs > MAX_DELTA_PCT;
  const numText = capped ? `${MAX_DELTA_PCT}%+` : `${abs}%`;

  if (delta > 0) {
    const title = capped
      ? `较上周 +${abs}%（已封顶显示 ${MAX_DELTA_PCT}%+）`
      : `较上周 +${abs}%`;
    return (
      <span className="ins-delta ins-delta--up" title={title}>
        <ArrowUpRight size={12} />
        <span className="ins-delta-num">{numText}</span>
      </span>
    );
  }

  const title = capped
    ? `较上周 -${abs}%（已封顶显示 ${MAX_DELTA_PCT}%+）`
    : `较上周 -${abs}%`;
  return (
    <span className="ins-delta ins-delta--down" title={title}>
      <ArrowDownRight size={12} />
      <span className="ins-delta-num">{numText}</span>
    </span>
  );
}
