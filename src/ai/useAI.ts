// AI 功能的通用降级契约 hook（Task 5）。
//
// 契约要点：
//   - 每个 AI 功能都必须提供一个 T0 本地模板（不调 AI，纯本地生成）。
//   - 无论「未配置 / 用户关闭 / tier 不足 / 请求失败 / 超时」，一律静默降级到
//     该模板：不弹错误框、不留空态、UI 保持一致。
//   - 降级只能靠一个非侵入的小标记（`source === "template"`）让用户可察觉，
//     但绝不打断体验。
//
// 本 hook 永不 throw：后端 `call_ai` 已经把所有失败折叠成 `ok=false` 的
// `AiCallResult`（信封层单点保证），这里再兜一层「invoke 本身异常」的极端情况。

import { useCallback, useEffect, useRef, useState } from "react";
import { callAi } from "./client";

/** 内容来源：loading=请求中，ai=真实返回，template=本地 T0 降级。 */
export type AiSource = "loading" | "ai" | "template";

export interface UseAIResult {
  /** 最终展示的内容（AI 正文，或本地模板产物）。加载中为 null。 */
  content: string | null;
  /** 内容来源，用于非侵入小标记（如一个「本地」徽标）。 */
  source: AiSource;
  /** 降级原因（日志 / 调试用，不是错误弹窗文案）。 */
  reason: string | null;
  /** 数据变化后手动重跑。 */
  refresh: () => void;
}

/**
 * 落实现「静默降级 T0」契约的通用 hook。
 *
 * @param featureId  已注册的功能 id（见后端 FEATURE_REGISTRY）。
 * @param buildPayload 构造**完整 T3 形状**的 payload 函数；信封层会按用户层级
 *                     单点裁剪，功能自身无需也不应去判断层级。
 * @param template    T0 本地模板函数：AI 不可用时用它生成同样形状的文案。
 * @param jsonMode    是否要求 JSON 输出（传给 response_format）。
 *
 * 用法示例（占位，演示「单发 + T0 模板」的通用用法）：
 * ```tsx
 * function ExampleFeature() {
 *   const { content, source } = useAI(
 *     "ai.<你的功能-id>",
 *     () => ({ today: { keys: 1200, top_apps: [] } }),  // 完整 T3 形状
 *     () => "本地兜底文案。",                            // T0 本地模板
 *   );
 *   if (content == null) return null;                    // 加载中，不渲染空态
 *   return (
 *     <div className="example-feature">
 *       {content}
 *       {source === "template" && <span className="ai-local-badge">本地</span>}
 *     </div>
 *   );
 * }
 * ```
 *
 * 注意：`ai.cat-quip`（猫吐槽）已由 `src/ai/quip.ts` 独立实现（30 分钟批量生成 +
 * 内存缓存，不经过本 hook）。需要批量/缓存语义照 `quip.ts`，单发语义才照这里。
 *
 * 结构化功能（AI 返回 JSON）同理：模板函数返回一段同 schema 的 JSON 字符串，
 * 调用方对 `content` 与 `template()` 产物走同一条解析路径即可。
 */
export function useAI(
  featureId: string,
  buildPayload: () => unknown,
  template: () => string,
  jsonMode = false,
): UseAIResult {
  const [content, setContent] = useState<string | null>(null);
  const [source, setSource] = useState<AiSource>("loading");
  const [reason, setReason] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const seq = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const id = ++seq.current;
    let cancelled = false;

    setSource("loading");
    setReason(null);

    (async () => {
      let result;
      try {
        result = await callAi(featureId, buildPayload(), jsonMode);
      } catch (e) {
        // invoke 本身失败（理论上信封层已折叠，这里兜底）
        result = { ok: false, tier: "T0", content: null, reason: String(e) };
      }
      if (cancelled || id !== seq.current) return;

      if (result.ok && result.content != null) {
        setContent(result.content);
        setSource("ai");
        setReason(null);
      } else {
        setContent(template());
        setSource("template");
        setReason(result.reason ?? "降级到本地模板");
      }
    })();

    return () => {
      cancelled = true;
    };
    // buildPayload / template 每次渲染都会重建，不能进依赖（否则死循环）；
    // 数据变化时由调用方显式 refresh()。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, jsonMode, nonce]);

  return { content, source, reason, refresh };
}
