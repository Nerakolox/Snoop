/**
 * 鼠标热力卡片 —— 从筛选后的桶数据聚合按键次数、滚轮、移动距离并渲染。
 */

import { useMemo } from "react";
import { MOUSE_PIXELS_PER_METER, intensityVar, bucketSimple } from "../../analytics";
import type { RawBucket } from "../../data";

type MousePanelProps = {
  /** 已按当前筛选过的桶列表 */
  buckets: RawBucket[];
};

export default function MousePanel({ buckets }: MousePanelProps) {
  const mouseData = useMemo(() => {
    let left = 0;
    let right = 0;
    let middle = 0;
    let back = 0;
    let forward = 0;
    let moveDist = 0;
    let scrollDist = 0;
    for (const b of buckets) {
      left += b.mouse_left || 0;
      right += b.mouse_right || 0;
      middle += b.mouse_middle || 0;
      back += b.mouse_back || 0;
      forward += b.mouse_forward || 0;
      moveDist += b.mouse_move_dist || 0;
      scrollDist += b.scroll_dist || 0;
    }
    const meters = moveDist / MOUSE_PIXELS_PER_METER;
    const travelKm =
      meters >= 1000 ? Number((meters / 1000).toFixed(1)) : Number((meters / 1000).toFixed(2));
    return {
      left,
      right,
      middle,
      back,
      forward,
      wheel: middle + Math.round(scrollDist / 100),
      travelKm,
    };
  }, [buckets]);

  const maxMouse = Math.max(
    mouseData.left,
    mouseData.right,
    mouseData.wheel,
    mouseData.back,
    mouseData.forward,
    1
  );

  return (
    <div className="kb-subsection">
      <h3 className="kb-subsection-title">鼠标</h3>
      <div className="mouse-card">
        <div className="mouse-shape" aria-hidden>
          <div
            className="mouse-btn mouse-btn--left"
            style={{
              background: intensityVar(bucketSimple(mouseData.left, maxMouse)),
            }}
            title={`左键 · ${mouseData.left.toLocaleString()} 次`}
          />
          <div
            className="mouse-btn mouse-btn--right"
            style={{
              background: intensityVar(bucketSimple(mouseData.right, maxMouse)),
            }}
            title={`右键 · ${mouseData.right.toLocaleString()} 次`}
          />
          <div
            className="mouse-wheel"
            style={{
              background: intensityVar(bucketSimple(mouseData.wheel, maxMouse)),
            }}
            title={`滚轮 · ${mouseData.wheel.toLocaleString()}`}
          />
          {(mouseData.back > 0 || mouseData.forward > 0) && (
            <>
              <div
                className="mouse-side mouse-side--back"
                style={{
                  background: intensityVar(bucketSimple(mouseData.back, maxMouse)),
                }}
                title={`后退侧键 · ${mouseData.back.toLocaleString()} 次`}
              />
              <div
                className="mouse-side mouse-side--forward"
                style={{
                  background: intensityVar(bucketSimple(mouseData.forward, maxMouse)),
                }}
                title={`前进侧键 · ${mouseData.forward.toLocaleString()} 次`}
              />
            </>
          )}
        </div>
        <dl className="mouse-stats">
          <div className="mouse-stat">
            <dt>左键</dt>
            <dd>{mouseData.left.toLocaleString()}</dd>
          </div>
          <div className="mouse-stat">
            <dt>右键</dt>
            <dd>{mouseData.right.toLocaleString()}</dd>
          </div>
          <div className="mouse-stat">
            <dt>滚轮</dt>
            <dd>{mouseData.wheel.toLocaleString()}</dd>
          </div>
          {(mouseData.back > 0 || mouseData.forward > 0) && (
            <div className="mouse-stat">
              <dt>侧键</dt>
              <dd>{(mouseData.back + mouseData.forward).toLocaleString()}</dd>
            </div>
          )}
          <div className="mouse-stat">
            <dt>移动</dt>
            <dd>
              {mouseData.travelKm}
              <span className="mouse-stat-unit">公里</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
