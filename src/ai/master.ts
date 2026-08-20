// 「AI 功能」总开关的前端薄封装。
//
// 真正的持久化与拦截都在后端：`enabled` 存 `ai_config.json`，信封层
// （`envelope::call_ai`）据此把一切 AI 调用退回 T0。前端只负责三件事：
//   1. 读当前值（供侧栏显示/隐藏「AI」入口、App 层做「停在 AI 页时关开关」跳回）；
//   2. 写当前值（设置页开关）；
//   3. 跨组件广播（CustomEvent），让侧栏/页面即时响应，不各自再拉一遍。
//
// 遵循本项目已有的 dev_mode / page_transition 同款「localStorage + 事件」同步思路，
// 只是这里落库走后端而非 localStorage（因为后端必须独立知道开关状态）。

import { useCallback, useEffect, useState } from "react";
import { getAiConfig, saveAiConfig } from "./client";

const EVENT = "ai-enabled-change";

// 内存缓存：避免每个组件各自 invoke。启动后首次读取即缓存，后续开关变化靠广播。
let cached: boolean | null = null;
let loading: Promise<boolean> | null = null;

/** 读总开关当前值（带内存缓存，仅首次真正 invoke）。 */
export function loadAiEnabled(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (!loading) {
    loading = getAiConfig()
      .then((c) => {
        cached = c.enabled;
        return cached;
      })
      .catch(() => false)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 写总开关：读最新配置 → 改 enabled 字段 → 落库 → 广播。 */
export async function setAiEnabled(v: boolean): Promise<void> {
  const cfg = await getAiConfig();
  const { has_key: _hk, ...rest } = cfg;
  await saveAiConfig({ ...rest, enabled: v });
  cached = v;
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: v }));
}

/** 订阅开关变化，返回退订函数。 */
export function onAiEnabledChange(cb: (v: boolean) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** 总开关的 React hook：`[enabled, setEnabled]`。 */
export function useAiEnabled(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    loadAiEnabled().then((v) => {
      if (alive) setEnabledState(v);
    });
    const off = onAiEnabledChange((v) => setEnabledState(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    void setAiEnabled(v);
  }, []);

  return [enabled, setEnabled];
}
