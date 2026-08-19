/**
 * Top 按键排行 —— 展示筛选后数据中出现次数最多的按键。
 */

import { useMemo } from "react";
import { intensityVar, bucketByPercentile } from "../../analytics";
import { getDisplayLabel } from "../../kleParser";

type TopKeysPanelProps = {
  /** KLE 键标签 → 按压次数（已按当前筛选聚合过） */
  kleKeyCounts: Record<string, number>;
  /** 所有键的按压次数数组，用于分位数分档 */
  allKeyCounts: number[];
  title: string;
};

export default function TopKeysPanel({
  kleKeyCounts,
  allKeyCounts,
  title,
}: TopKeysPanelProps) {
  const topKeys = useMemo(() => {
    return Object.entries(kleKeyCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, n]) => ({ label, n }));
  }, [kleKeyCounts]);

  return (
    <div className="kb-aux-block">
      <h3 className="kb-aux-title">{title}</h3>
      <div className="topkey-list">
        {topKeys.length === 0 && (
          <div className="kb-aux-empty">
            这段范围还没有按键记录，换个时间范围或清除应用筛选试试
          </div>
        )}
        {topKeys.map((k) => {
          const pct = topKeys[0] ? (k.n / topKeys[0].n) * 100 : 0;
          const level = bucketByPercentile(k.n, allKeyCounts);
          const displayLabel = getDisplayLabel(k.label);
          return (
            <div key={k.label} className="topkey-row">
              <div className="topkey-name">{displayLabel}</div>
              <div className="topkey-track">
                <div
                  className="topkey-fill"
                  style={{ width: `${pct}%`, background: intensityVar(level) }}
                />
              </div>
              <div className="topkey-count">{k.n.toLocaleString()}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
