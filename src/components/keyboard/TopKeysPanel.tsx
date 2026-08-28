/**
 * Top 按键排行 —— 展示筛选后数据中出现次数最多的按键。
 */

import { useMemo } from "react";
import { intensityVar, bucketByPercentile } from "../../analytics";
import { displayLabelByCode } from "../../keyboardLayout";

type TopKeysPanelProps = {
  /** W3C code → 按压次数（已按当前筛选聚合过） */
  keyCounts: Record<string, number>;
  /** 所有键的按压次数数组，用于分位数分档 */
  allKeyCounts: number[];
  title: string;
};

export default function TopKeysPanel({
  keyCounts,
  allKeyCounts,
  title,
}: TopKeysPanelProps) {
  const topKeys = useMemo(() => {
    return Object.entries(keyCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([code, n]) => ({ code, n }));
  }, [keyCounts]);

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
          const name = displayLabelByCode(k.code);
          return (
            <div key={k.code} className="topkey-row">
              <div className="topkey-name">{name}</div>
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
