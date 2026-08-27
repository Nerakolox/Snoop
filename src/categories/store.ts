// 分类目录的前端单一真源。
//
// 页面（概览、规律、分类页）不各自 invoke 一遍 `list_categories`，而是共用这一份
// 快照 + 订阅。理由有两个：
//   1. 显示名要**实时**跟随分类表。分类改名后，概览的占比图例、规律页的分类行、
//      分类页的下拉必须同时变——各自缓存一份必然漂移。
//   2. 分类表一变就得连带作废按分类聚合出来的缓存（含猫吐槽）。作废动作放在
//      写入口这一处，比散在每个调用点可靠。
//
// **报告不在此列。** 报告是快照不是视图：一份已生成的报告显示的是生成那一刻的
// 分类名与配色，存在它自己的 `snapshot` 里（`src-tauri/src/report/snapshot.rs`），
// 改名改色一律不影响。报告组件因此不 import 本模块——见 report/ReportCard.tsx。

import { useEffect, useSyncExternalStore } from "react";
import { invalidateQuipCache } from "../ai/quip";
import { listCategories } from "./client";
import { categoryFill } from "./color";
import { ID_UNCATEGORIZED } from "./constants";
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
 * 查不到有两种情况，都退回 id 本身而不是留空：分类刚被永久删除（别处还留着
 * 它的 id），或快照还没加载完。
 */
export function labelOf(id: string): string {
  return snapshot?.find((c) => c.id === id)?.name ?? id;
}

/** 分类 id → 分类记录（含已归档）。 */
export function categoryById(id: string): CategoryRow | undefined {
  return snapshot?.find((c) => c.id === id);
}

/**
 * 分类 id → 可视化填充色（CSS）。**占比条与 chip 圆点的唯一取色入口。**
 *
 * 和 labelOf 一样从快照实时读，所以改完某个分类的颜色，订阅了 useCategories 的
 * 页面下一次渲染就是新色——占比条、chips、就地下拉三处同步变化。
 *
 * 系统分类与查不到的 id 走中性色，判定逻辑在 color.ts 的 categoryFill 里。
 */
export function fillOf(id: string): string {
  return categoryFill(id, categoryById(id));
}

/**
 * 可作为归类目标的分类：未归档，且排除「未分类」（那是状态不是目标）。
 *
 * 分类页的下拉和各数据页的就地改分类下拉共用这一条筛选——两处若各写一遍，
 * 迟早出现「设置里改不了但概览里能改」这种自相矛盾。后端 set_app_category
 * 对归档分类与「未分类」都会直接拒写，这里是与它对齐的前端投影。
 */
export function assignableCategories(rows: CategoryRow[] | null): CategoryRow[] {
  return (rows ?? []).filter((c) => !c.is_archived && c.id !== ID_UNCATEGORIZED);
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
