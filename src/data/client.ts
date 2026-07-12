/**
 * 数据访问层 —— 对 Tauri `invoke` 的薄封装。
 * 本层只负责"取数"：拼参数、调 command、直返原始数据。
 * 任何业务加工（合并会话、区域分类、强度分档等）都交给 analytics 层做。
 *
 * 为什么保留 snake_case 参数名：Tauri 会把 JS 传入的对象键
 * 转成 Rust 侧参数名，我们直接沿用 snake_case 就无需在两端各写一遍映射。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  RawAppRank,
  RawBucket,
  RawHourBucket,
  RawKeyDetail,
  TimeRange,
} from "./types";

// ---- 全量查询（兼容旧 Dev 页 & 快速排查） -----------------------------------

export function fetchAllBuckets(): Promise<RawBucket[]> {
  return invoke<RawBucket[]>("get_buckets");
}

export function fetchKeyDetailsOfBucket(bucketId: number): Promise<RawKeyDetail[]> {
  return invoke<RawKeyDetail[]>("get_key_details", { bucketId });
}

export function fetchTodayKeyTotal(): Promise<number> {
  return invoke<number>("get_today_key_total");
}

export function fetchAllAppRanking(): Promise<RawAppRank[]> {
  return invoke<RawAppRank[]>("get_app_ranking");
}

// ---- 范围查询（页面对接会走这一组） ------------------------------------------

export function fetchBucketsInRange(range: TimeRange): Promise<RawBucket[]> {
  return invoke<RawBucket[]>("get_buckets_in_range", {
    startMs: range.start_ms,
    endMs: range.end_ms,
  });
}

export function fetchKeyDetailsInRange(range: TimeRange): Promise<RawKeyDetail[]> {
  return invoke<RawKeyDetail[]>("get_key_details_in_range", {
    startMs: range.start_ms,
    endMs: range.end_ms,
  });
}

export function fetchAppRankingInRange(range: TimeRange): Promise<RawAppRank[]> {
  return invoke<RawAppRank[]>("get_app_ranking_in_range", {
    startMs: range.start_ms,
    endMs: range.end_ms,
  });
}

export function fetchHourlyActivity(range: TimeRange): Promise<RawHourBucket[]> {
  return invoke<RawHourBucket[]>("get_hourly_activity", {
    startMs: range.start_ms,
    endMs: range.end_ms,
  });
}
