// 猫吐槽的批量生成与内存缓存（批次 5）。
//
// 核心：调用频率与显示频率解耦。
//   - 每 30 分钟批量生成一批句子（按强度 0-4 分池），一次 API 调用覆盖全部状态。
//   - 显示侧从对应状态池里轮转取用、不重复（取完一轮再洗牌）。
//   - 缓存只在内存里，不落库；应用重启后重新生成。
//
// 降级契约（与 useAI 同源）：AI 未配置 / 功能关闭 / tier 不足 / 请求失败 →
// 信封层返回 ok=false，本模块静默返回 null，由调用方（SidebarLive）回落到
// `pickCatQuip` 模板。绝不抛错、绝不留空、绝不标注「AI 生成」。

import { useSyncExternalStore } from "react";
import {
  computeIntensity,
  RECENT_ACTIVITY_WINDOW_MS,
  type Intensity,
} from "../analytics";
import type { RawBucket } from "../data/types";
import { callAi } from "./client";

/** 已注册功能 id（T1，见后端 FEATURE_REGISTRY）。 */
const FEATURE_ID = "ai.cat-quip";

/** 批量生成的固定周期。 */
const BATCH_TTL_MS = 30 * 60 * 1000;

/** 单句上限（字）。超长丢弃，防 AI 输出长段落。 */
const MAX_QUIP_CHARS = 30;

/** 全部强度档。缓存/校验/输出都以这 5 档为键。 */
const INTENSITIES: readonly Intensity[] = [0, 1, 2, 3, 4];

/** 每档的句子池。 */
type QuipPools = Partial<Record<Intensity, string[]>>;

/** 内存缓存：池 + 上次尝试时刻 + 每档轮转游标。 */
let pools: QuipPools = {};
let lastAttemptAtMs = 0;
const cursors: Partial<Record<Intensity, number>> = {};

/** 进行中的批量生成（去重，避免并发重复打 API）。 */
let inflight: Promise<void> | null = null;

// ── 订阅（供 useQuipVersion 感知「缓存已更新」）────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

/** 订阅缓存版本，缓存更新时触发组件重渲染。 */
export function useQuipVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

// ── 纯计算：批次输入（全部聚合数字，无应用名）────────────────────────────

/** 有输入桶判定 —— 与报告口径一致：纯鼠标位移不算活跃。 */
function isActive(b: RawBucket): boolean {
  return (
    (b.key_total || 0) > 0 ||
    (b.mouse_left || 0) > 0 ||
    (b.mouse_right || 0) > 0 ||
    (b.mouse_middle || 0) > 0 ||
    (b.mouse_back || 0) > 0 ||
    (b.mouse_forward || 0) > 0 ||
    (b.scroll_dist || 0) > 0
  );
}

/** 今日活跃分钟（有输入桶时长）。 */
function activeMinutes(buckets: RawBucket[]): number {
  let ms = 0;
  for (const b of buckets) {
    if (isActive(b)) ms += b.duration_ms || 0;
  }
  return Math.round(ms / 60_000);
}

/** 应用切换次数 = 相邻桶 bundle_id 变化的次数（桶已按 bucket_start 升序）。 */
function switchCount(buckets: RawBucket[]): number {
  let n = 0;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i - 1].app_bundle_id !== buckets[i].app_bundle_id) n += 1;
  }
  return n;
}

/** 构造 T3 形状 payload。无 `apps`：纯聚合数字，信封层原样透传（T1 安全）。 */
function buildPayload(buckets: RawBucket[], nowMs: number): unknown {
  const recent = buckets.filter((b) => nowMs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS);
  return {
    system_prompt: SYSTEM_PROMPT,
    facts: {
      states: INTENSITIES,
      today: {
        active_minutes: activeMinutes(buckets),
        switch_count: switchCount(buckets),
      },
      current_intensity: computeIntensity(recent),
      hour: new Date(nowMs).getHours(),
    },
  };
}

// ── 校验与洗牌 ─────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 解析并校验 AI 返回的 JSON。未知键丢组、超长/空句丢句、某档 0 句则该档缺失。 */
function parseQuips(content: string): QuipPools {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const out: QuipPools = {};
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const intensity = INTENSITIES.find((i) => String(i) === key);
    if (intensity === undefined) continue; // 状态键不在已知枚举内 → 丢弃该组
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;

    const valid: string[] = [];
    for (const item of arr) {
      if (typeof item !== "string") continue;
      const s = item.trim();
      if (s.length === 0 || s.length > MAX_QUIP_CHARS) continue; // 超长 → 丢弃该句
      valid.push(s);
    }
    if (valid.length > 0) out[intensity] = shuffle(valid);
  }
  return out;
}

// ── 批量生成 ───────────────────────────────────────────────────────────────

/**
 * 触发（或复用）一次批量生成。内部按 30 分钟 TTL + inflight 去重，
 * 大多数调用都是 no-op。成功则刷新缓存并通知订阅者；失败静默保持现状。
 */
export function ensureQuipCache(buckets: RawBucket[]): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastAttemptAtMs < BATCH_TTL_MS) {
    return inflight ?? Promise.resolve();
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const result = await callAi(FEATURE_ID, buildPayload(buckets, nowMs), true);
      lastAttemptAtMs = Date.now();
      if (result.ok && result.content != null) {
        const parsed = parseQuips(result.content);
        if (Object.keys(parsed).length > 0) {
          pools = parsed;
          bump();
        }
      }
    } catch {
      // invoke 本身异常（信封层已折叠，这里兜底）：静默，模板兜底。
      lastAttemptAtMs = Date.now();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 从缓存轮转取一句。无缓存 / 该档缺失时返回 null，调用方回落模板。 */
export function getQuip(intensity: Intensity): string | null {
  const pool = pools[intensity];
  if (!pool || pool.length === 0) return null;
  const cursor = cursors[intensity] ?? 0;
  const quip = pool[cursor % pool.length];
  cursors[intensity] = cursor + 1;
  return quip;
}

// ── Prompt（Task 3 会在此基础上校准人设与语气）────────────────────────────

const SYSTEM_PROMPT = [
  "你是 Snoop 里的一只猫，陪着用户工作。",
  "",
  "用户消息里是一份当日数据（JSON）：",
  "- states：需要生成文案的状态键（\"0\"~\"4\"）",
  "- today.active_minutes：今日活跃分钟数",
  "- today.switch_count：今日应用切换次数",
  "- current_intensity：用户此刻所处的状态",
  "- hour：当前小时（0~23）",
  "",
  "状态键含义：",
  "- \"0\" = 挂机中（长时间无输入，人可能不在电脑前）",
  "- \"1\" = 摸鱼中（偶尔动一下，浏览/聊天带点交互）",
  "- \"2\" = 正常节奏（稳定输入）",
  "- \"3\" = 专注中（正常写代码/写文档）",
  "- \"4\" = 爆肝中（密集打字，峰值）",
  "",
  "要求：",
  "- 每个状态写 2~3 句，每句 30 字以内（含标点）。",
  "- 口语化，可以偶尔用「喵」，但不要每句都用。",
  "- 观察当下的状态本身，不总结、不回顾、不建议。",
  "- 语气：陪伴、轻调侃、克制，像熟稔的朋友随口搭话，不做绩效报告。",
  "- 五个状态的调性要一致：既不要冷冰冰的数据播报，也不要浮夸的表演。",
  "",
  "语气参照（只看调性，不要照抄，也不要出现应用名）：",
  "- 挂机：「静悄悄的，去哪了喵？」",
  "- 摸鱼：「节奏挺悠闲嘛，喝杯茶？喵～」",
  "- 正常：「节奏不错，保持住喵～」",
  "- 专注：「认真工作的样子，真帅喵～」",
  "- 爆肝：「冲冲冲！但别忘了喝水和眨眼喵～」",
  "",
  "禁止：",
  "- 说教、给建议、催促（如「该休息了」「专注一点」）。",
  "- 评判效率（如「效率低」「浪费时间」「不够专注」）。",
  "- 把「无输入的时间」说成负面（那可能是在开会、读文档、思考）。",
  "- 提到任何具体应用名。",
  "- 卖惨、过度撒娇、颜文字刷屏。",
  "",
  "只输出一个 JSON 对象，键为 \"0\"~\"4\"，值为字符串数组。不要输出 JSON 以外的任何文字。",
].join("\n");
