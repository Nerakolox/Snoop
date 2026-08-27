// 分类目录的前端单一真源。
//
// 页面（概览、报告、分类页）不各自 invoke 一遍 `list_categories`，而是共用这一份
// 快照 + 订阅。理由有两个：
//   1. 显示名要**实时**跟随分类表。分类改名后，概览的占比图例、分类页的下拉、
//      报告的分类行必须同时变——各自缓存一份必然漂移。
//   2. 分类表一变就得连带作废按分类聚合出来的缓存（含猫吐槽）。作废动作放在
//      写入口这一处，比散在每个调用点可靠。

import { useEffect, useSyncExternalStore } from "react";
import { invalidateQuipCache } from "../ai/quip";
import { listCategories } from "./client";
import type { CategoryRow } from "./types";

let snapshot: CategoryRow[] | null = null;
let inflight: Promise<void> | null = null;
let version = 0;

const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 当前快照；尚未加载时为 null（组件按「加载中」处理）。 */
export function getCategories(): CategoryRow[] | null {
  return snapshot;
}

function getVersion(): number {
  return version;
}

/** 订阅分类表版本号，表一变依赖它的组件就重渲染。 */
export function useCategoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

/** 拉一次分类表（并发调用会合流到同一个请求）。 */
export function loadCategories(force = false): Promise<void> {
  if (!force && snapshot !== null) return Promise.resolve();
  if (inflight) return inflight;
  inflight = listCategories()
    .then((rows) => {
      snapshot = rows;
      emit();
    })
    .catch((e) => {
      console.error("加载分类表失败", e);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 分类表已变更：重拉快照，并作废所有按分类聚合的缓存。
 *
 * **每一个写分类表的地方都必须走这里**（新建 / 改名 / 改色 / 归档 / 恢复 /
 * 永久删除 / 排序 / 改某个 App 的归类 / 批量分类 / 撤销批次）。漏一处，页面上
 * 就会留着按旧分类算出来的结论。
 */
export function invalidateCategories(): Promise<void> {
  invalidateQuipCache();
  return loadCategories(true);
}

/**
 * 分类 id → 显示名。
 *
 * 查不到有两种情况，都退回 id 本身而不是留空：分类刚被永久删除（历史报告里
 * 还留着它的 id），或快照还没加载完。
 */
export function labelOf(id: string): string {
  return snapshot?.find((c) => c.id === id)?.name ?? id;
}

/** 分类 id → 分类记录（含已归档）。 */
export function categoryById(id: string): CategoryRow | undefined {
  return snapshot?.find((c) => c.id === id);
}

/**
 * 已加载的分类快照 + 版本订阅。组件用这个 hook 就能在分类表变化时自动重渲染。
 * 首次调用会触发一次加载。
 */
export function useCategories(): CategoryRow[] | null {
  useCategoryVersion();
  useEffect(() => {
    void loadCategories();
  }, []);
  return snapshot;
}
