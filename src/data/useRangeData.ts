/**
 * 单一数据入口：(kind, anchor, appId) → 过滤后的 buckets。
 *
 * 为什么以 buckets 为主源：`get_hourly_activity` 与 `get_app_ranking_in_range`
 * 都不接 app 参数，一旦有 appId 就用不了。`get_buckets_in_range` 返回的每个桶都
 * 带 app_bundle_id，前端过滤是准确的，统一走它避免各页对 appId 支持度不一致。
 *
 * 本文件本批只建立并让其可用，不强制改造现有页面 —— 页面迁移是
 * Batch 2/3/4/5 各自的事。
 */

import { useCallback, useEffect, useState } from "react";
import type { RangeKind } from "../store/context";
import { toMs } from "./ranges";
import { fetchBucketsInRange } from "./client";
import type { RawBucket } from "./types";

/**
 * 进程内缓存，不落盘，上限 12 条，超出丢最早的。
 *
 * 为什么要缓存：`App.tsx` 的 `renderPage` switch 让切页时整棵子树卸载重挂，
 * 所有 useState 回初值。全局 range 提上去后，来回切页会反复重查同一份数据。
 * 数据写入是持续的，所以缓存要能被主动作废：见 `invalidateRangeData()`。
 */
const CACHE_LIMIT = 12;
const cache = new Map<string, RawBucket[]>();

function cacheKey(kind: RangeKind, anchor: string, appId: string | null): string {
  return `${kind}|${anchor}|${appId ?? "*"}`;
}

/** 使所有 useRangeData 的内存缓存整体失效。Overview 的 30 秒轮询、
 *  Settings 的清空数据都要调它，否则会拿到过期快照。 */
export function invalidateRangeData(): void {
  cache.clear();
}

interface UseRangeDataOpts {
  /** 透传给 toMs：区间含当前时刻时把 end 收到 now，只有 Timeline 传 true */
  liveEnd?: boolean;
}

interface UseRangeDataResult {
  buckets: RawBucket[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useRangeData(
  kind: RangeKind,
  anchor: string,
  appId: string | null,
  opts?: UseRangeDataOpts
): UseRangeDataResult {
  const [buckets, setBuckets] = useState<RawBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const liveEnd = opts?.liveEnd;

  useEffect(() => {
    const key = cacheKey(kind, anchor, appId);
    const cached = cache.get(key);
    if (cached) {
      setBuckets(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchBucketsInRange(toMs(kind, anchor, { liveEnd }))
      .then((raw) => {
        if (cancelled) return;
        const filtered = appId === null ? raw : raw.filter((b) => b.app_bundle_id === appId);
        cache.set(key, filtered);
        if (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        setBuckets(filtered);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, anchor, appId, liveEnd, tick]);

  const refetch = useCallback(() => {
    cache.delete(cacheKey(kind, anchor, appId));
    setTick((t) => t + 1);
  }, [kind, anchor, appId]);

  return { buckets, loading, error, refetch };
}
