import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

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
  if (delta > 0) {
    return (
      <span className="ins-delta ins-delta--up" title={`较上周 +${delta}%`}>
        <ArrowUpRight size={12} />
        <span className="ins-delta-num">{delta}%</span>
      </span>
    );
  }
  return (
    <span className="ins-delta ins-delta--down" title={`较上周 ${delta}%`}>
      <ArrowDownRight size={12} />
      <span className="ins-delta-num">{Math.abs(delta)}%</span>
    </span>
  );
}
