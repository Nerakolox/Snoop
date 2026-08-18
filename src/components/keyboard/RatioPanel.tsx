/**
 * 键鼠比 —— 点击数 ÷ 按键数，衡量这段范围内偏鼠标还是偏键盘。
 * 数据直接从已筛选的 buckets 聚合，不需要新接口。
 */

import { useMemo } from "react";
import type { RawBucket } from "../../data";

type RatioPanelProps = {
  /** 已按当前筛选过的桶列表 */
  buckets: RawBucket[];
};

/**
 * 比值在不同 App 间跨度约 60 倍（终端类 ~0.03，播放器类 ~1.7），线性映射会把
 * 大半应用挤在最左端，必须走对数。ratio <= 0 时 log10 会是 -Infinity，先行
 * 短路成 0，避免 NaN% 渗进 style。
 */
function ratioToSliderPos(ratio: number): number {
  if (ratio <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.log10(ratio) + 1.6) / 2.2));
}

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
  const label = ratio > 0.25 ? "鼠标型" : ratio < 0.08 ? "键盘型" : "均衡型";

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
