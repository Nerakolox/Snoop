/**
 * 键鼠比 —— 点击数 ÷ 按键数，衡量这段范围内偏鼠标还是偏键盘。
 * 数据直接从已筛选的 buckets 聚合，不需要新接口。
 */

import { useMemo } from "react";
import type { RawBucket } from "../../data";
import { ratioToSliderPos, ratioVerdict } from "../../analytics/keys";

type RatioPanelProps = {
  /** 已按当前筛选过的桶列表 */
  buckets: RawBucket[];
};

export default function RatioPanel({ buckets }: RatioPanelProps) {
  const { clicks, keys } = useMemo(() => {
    let clicks = 0;
    let keys = 0;
    for (const b of buckets) {
      clicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
      keys += b.key_total || 0;
    }
    return { clicks, keys };
  }, [buckets]);

  if (keys === 0) {
    return (
      <div className="kb-subsection">
        <h3 className="kb-subsection-title">键鼠比</h3>
        <p className="kb-key-detail-hint">无按键数据</p>
      </div>
    );
  }

  const ratio = clicks / keys;
  const pos = ratioToSliderPos(ratio);
  const label = ratioVerdict(ratio);

  return (
    <div className="kb-subsection">
      <h3 className="kb-subsection-title">键鼠比</h3>
      <div className="ratio-card">
        <div className="ratio-number">
          {ratio.toFixed(2)}
          <span className="ratio-tag">{label}</span>
        </div>
        <div className="ratio-slider">
          <div className="ratio-slider-track">
            <div className="ratio-slider-thumb" style={{ left: `${pos * 100}%` }} />
          </div>
          <div className="ratio-slider-ends">
            <span>偏键盘</span>
            <span>偏鼠标</span>
          </div>
        </div>
      </div>
    </div>
  );
}
