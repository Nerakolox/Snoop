/**
 * 单键详情 —— 点键盘上某个键后显示：总次数、24 时段分布、跨应用 Top 3。
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
import AppIcon from "../AppIcon";

type KeyDetailPanelProps = {
  /** KLE 键标签，null = 未选中 */
  label: string | null;
  /** 该标签对应的 rdev key_code，label 非空但查不到映射时为 null */
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

  if (!label) {
    return (
      <div className="kb-subsection">
        <h3 className="kb-subsection-title">单键详情</h3>
        <p className="kb-key-detail-hint">点键盘上任意一个键，查看它的使用细节</p>
      </div>
    );
  }

  return (
    <div className="kb-subsection">
      <h3 className="kb-subsection-title">
        {label}
        {merged && <span className="kb-key-detail-note"> · 左右合并计数</span>}
      </h3>

      <div className="kb-key-detail-total">{totalCount.toLocaleString()} 次</div>

      <div className="kb-key-detail-hours" role="img" aria-label="24 小时按压分布">
        {hourCounts.map((c, h) => (
          <div key={h} className="kb-key-detail-hour" title={`${h}:00 · ${c} 次`}>
            <div
              className="kb-key-detail-hour-bar"
              style={{ height: `${(c / maxHour) * 100}%` }}
            />
          </div>
        ))}
      </div>

      <div className="kb-key-detail-apps">
        <div className="kb-key-detail-apps-title">
          跨应用 Top 3<span className="kb-key-detail-note"> · 不受应用筛选影响</span>
        </div>
        {loading ? (
          <p className="kb-key-detail-hint">加载中...</p>
        ) : topApps.length === 0 ? (
          <p className="kb-key-detail-hint">这个键在此范围内没有记录</p>
        ) : (
          <ul className="kb-key-detail-app-list">
            {topApps.map((a) => (
              <li key={a.app_bundle_id} className="kb-key-detail-app-row">
                <AppIcon bundleId={a.app_bundle_id} appName={a.app_name} size={16} />
                <span className="kb-key-detail-app-name">{a.app_name || a.app_bundle_id}</span>
                <div className="kb-key-detail-app-bar">
                  <div
                    className="kb-key-detail-app-bar-fill"
                    style={{ width: `${(a.count / maxAppCount) * 100}%` }}
                  />
                </div>
                <span className="kb-key-detail-app-count">{a.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
