/**
 * "全部"聚合条 —— 合并所有 lane 的 block 后走与普通泳道完全相同的量化管线
 * (quantizeLane + 暖色轴)，只做展示，不接 hover/点击(没有单一 App 身份可筛选)。
 * segments 由父组件用同一个 quantizeLane 算出，这里不重复计算。
 */
import type { QuantizedSegment } from "../../analytics/quantize";

type AggregateLaneProps = {
  segments: QuantizedSegment[];
};

export default function AggregateLane({ segments }: AggregateLaneProps) {
  return (
    <div className="swimlane-row swimlane-agg-row">
      <div className="swimlane-label swimlane-label--static">
        <span className="swimlane-app-name">全部</span>
      </div>
      <div className="swimlane-track swimlane-agg-track">
        {segments.map((s, i) => (
          <div
            key={i}
            className={`swimlane-quant-seg swimlane-quant-seg--static${s.level === 0 ? " swimlane-quant-seg--idle" : ""}`}
            style={{
              left: `${s.startPct}%`,
              width: `${s.widthPct}%`,
              background: `var(--intensity-${s.level})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
