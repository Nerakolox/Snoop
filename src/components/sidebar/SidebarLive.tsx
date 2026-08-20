/**
 * 侧栏底部常驻实时区 —— LIVE，不受任何页面的范围/App 筛选影响。
 * 固定读"今天"的全量桶（appId=null），故意不跟随全局的 kind/anchor/appId。
 * 唯一从全局取的是 today（当日基准），这样跨过午夜时它会自动翻到新的一天。
 */

import { useEffect, useMemo, useState } from "react";
import {
  computeIntensity,
  moodLabelOf,
  pickCatQuip,
  RECENT_ACTIVITY_WINDOW_MS,
  type Intensity,
} from "../../analytics";
import { useRangeData } from "../../data/useRangeData";
import { useToday } from "../../store/context";
import Tooltip from "../shared/Tooltip";

export default function SidebarLive() {
  const today = useToday();
  const { buckets: allBuckets, refetch } = useRangeData("day", today, null);

  useEffect(() => {
    const timer = setInterval(() => refetch(), 30_000);
    return () => clearInterval(timer);
  }, [refetch]);

  const status = useMemo(() => {
    const nowTs = Date.now();
    const recent = allBuckets.filter((b) => nowTs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS);
    if (recent.length === 0) {
      return { appName: "", intensity: 0 as Intensity };
    }
    const byApp = new Map<string, number>();
    for (const b of recent) {
      const key = b.app_name || b.app_bundle_id;
      byApp.set(key, (byApp.get(key) || 0) + (b.duration_ms || 0));
    }
    const dominant = [...byApp.entries()].sort((a, b) => b[1] - a[1])[0];
    return { appName: dominant[0], intensity: computeIntensity(recent) };
  }, [allBuckets]);

  const [rerollTick, setRerollTick] = useState(0);
  const quip = useMemo(
    () => pickCatQuip(status.intensity, status.appName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status.intensity, status.appName, rerollTick]
  );

  return (
    <div className="sidebar-live">
      <div className="sidebar-live-top">
        <div className="sidebar-live-status">
          <span className={`sidebar-live-dot sidebar-live-dot--${status.intensity}`} aria-hidden />
          <span className="sidebar-live-label">{moodLabelOf(status.intensity)}</span>
        </div>
        <span className="sidebar-live-badge">LIVE · 不随范围变</span>
      </div>
      <Tooltip content="点击换一句">
        <button
          type="button"
          className="sidebar-live-quip"
          onClick={() => setRerollTick((t) => t + 1)}
        >
          {quip}
        </button>
      </Tooltip>
    </div>
  );
}
