/**
 * 单键详情 —— 点键盘上某个键后，在键盘正下方就地展开的一条横幅：
 * 键名 + 总次数 / 24 时段分布 / 跨应用 Top 3。
 * 未选中键时本组件不渲染（由 Keyboard.tsx 判空），不占任何纵向空间。
 * 跨应用分布走 fetchKeyAppDistribution，接口本身不接 appId，不受应用筛选影响。
 */

import { useEffect, useMemo, useState } from "react";
import {
  fetchKeyAppDistribution,
  fetchKeyHourlyDistribution,
  type RawKeyAppCount,
  type RawKeyHourBucket,
  type TimeRange,
} from "../../data";
import { getDisplayLabel } from "../../kleParser";
import AppIcon from "../AppIcon";
import Tooltip from "../shared/Tooltip";

type KeyDetailPanelProps = {
  /** KLE 键标签 */
  label: string;
  /** 该标签对应的 rdev key_code，查不到映射时为 null */
  rdevCode: string | null;
  /** 当前上下文（range × appId）下的总次数，已含左右合并 */
  totalCount: number;
  /** 是否是左右合并计数的修饰键 */
  merged: boolean;
  range: TimeRange;
  appId: string | null;
};

export default function KeyDetailPanel({
  label,
  rdevCode,
  totalCount,
  merged,
  range,
  appId,
}: KeyDetailPanelProps) {
  const [hourly, setHourly] = useState<RawKeyHourBucket[]>([]);
  const [byApp, setByApp] = useState<RawKeyAppCount[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!rdevCode) {
      setHourly([]);
      setByApp([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [hourlyData, appData] = await Promise.all([
          fetchKeyHourlyDistribution(rdevCode, range, appId ?? undefined),
          fetchKeyAppDistribution(rdevCode, range),
        ]);
        if (cancelled) return;
        setHourly(hourlyData);
        setByApp(appData);
      } catch (e) {
        console.error("单键详情加载失败:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rdevCode, range.start_ms, range.end_ms, appId]);

  const hourCounts = useMemo(() => {
    const arr = new Array(24).fill(0);
    for (const h of hourly) {
      arr[new Date(h.hour_start).getHours()] += h.count;
    }
    return arr;
  }, [hourly]);
  const maxHour = Math.max(1, ...hourCounts);
  const topApps = byApp.slice(0, 3);
  const maxAppCount = topApps.length > 0 ? topApps[0].count : 1;

  return (
    <div className="kb-keydetail">
      {/* ① 键名 + 总数 */}
      <div className="kb-keydetail-head">
        <span className="kb-keydetail-key">{getDisplayLabel(label)}</span>
        <span className="kb-keydetail-total">
          {totalCount.toLocaleString()}
          <span className="kb-keydetail-unit">次</span>
        </span>
        {merged && <span className="kb-keydetail-note">左右合并计数</span>}
      </div>

      {/* ② 24 小时分布 */}
      <div className="kb-keydetail-block">
        <div className="kb-keydetail-block-title">24 小时分布</div>
        <div className="kb-keydetail-hours" role="img" aria-label="24 小时按压分布">
          {hourCounts.map((c, h) => (
            <Tooltip key={h} content={`${h}:00 · ${c} 次`}>
              <div className="kb-keydetail-hour">
                <div
                  className="kb-keydetail-hour-bar"
                  style={{ height: `${(c / maxHour) * 100}%` }}
                />
              </div>
            </Tooltip>
          ))}
        </div>
        <div className="kb-keydetail-hour-ticks" aria-hidden>
          <span>0</span>
          <span>6</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      </div>

      {/* ③ 跨应用 Top 3 */}
      <div className="kb-keydetail-block">
        <div className="kb-keydetail-block-title">
          跨应用 Top 3<span className="kb-keydetail-note"> 不受应用筛选影响</span>
        </div>
        {loading ? (
          <p className="kb-keydetail-hint">加载中…</p>
        ) : topApps.length === 0 ? (
          <p className="kb-keydetail-hint">这个键在此范围内没有记录</p>
        ) : (
          <ul className="kb-keydetail-app-list">
            {topApps.map((a) => (
              <li key={a.app_bundle_id} className="kb-keydetail-app-row">
                <AppIcon bundleId={a.app_bundle_id} appName={a.app_name} size={16} />
                <span className="kb-keydetail-app-name">{a.app_name || a.app_bundle_id}</span>
                <div className="kb-keydetail-app-bar">
                  <div
                    className="kb-keydetail-app-bar-fill"
                    style={{ width: `${(a.count / maxAppCount) * 100}%` }}
                  />
                </div>
                <span className="kb-keydetail-app-count">{a.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
