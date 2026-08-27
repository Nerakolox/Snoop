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

/** 单句上限（字）。侧栏低音量版：20 字封顶，超长丢弃，防 AI 输出长段落。 */
const MAX_QUIP_CHARS = 20;

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

/**
 * 丢弃已生成的吐槽池，下次读取时重新生成。
 *
 * 分类表一变（增删改名改色 / 归档 / 恢复 / App 归类变化），任何按分类聚合出来的
 * 结论都可能过期——吐槽是拿当天聚合喂出来的，同样在此列。TTL 到期前不主动重算，
 * 所以必须显式作废，否则最长会留着半小时前那套说法。
 */
export function invalidateQuipCache(): void {
  pools = {};
  lastAttemptAtMs = 0;
  for (const k of INTENSITIES) delete cursors[k];
  bump();
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
  // 无数据时（含首次渲染前的空数组）不生成，避免拿全零数据浪费一次配额；
  // 等真实数据到达后再生成。
  if (buckets.length === 0) return Promise.resolve();
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

// ── Prompt（贱兮兮人设：毒舌 + 抬杠 + 句句带梗，音量仍然低）────────────────
//
// 梗是有保质期的。这份词表就是「换梗」的唯一入口——过时了直接改这里，
// 不用动任何逻辑，也不用等模板兜底（constants.ts 的 CAT_QUIPS）跟着发版。
const MEME_KIT = [
  "句式类（最通用，可以套任意内容）：",
  "- 「！？oo？！」表示震惊，等于「怎么这么o」。出处是「！？这么强？！」表情包，",
  "  把「强？！」镜像成「强强」就有了「！？强强？！」。这个句式随便套：！？这么闲？！",
  "- 「就这？」「啊这」「啊？」——无语和看不上的三连。",
  "- 「ooo了属于是」倒装句，如「间歇性上进了属于是」。",
  "- 「那你厉害咯」「啊对对对」「遥遥领先」——假意肯定，实为反讽。",
  "- 「他急了他急了」「急了」「应激了」——指认对方破防。",
  "- 「这位更是重量级」「老oo了」「这就是oo吗，i了i了」。",
  "",
  "近期热词：",
  "- 「我要验牌」= 要你亮证据（如「你说你没摸鱼？我要验牌」）；「牌没有问题」= 核验通过。",
  "- 「活人感」= 真实、不像机器生成；「低电量人生」「间歇性上进」= 想躺又不甘心。",
  "",
  "抬杠专用：「人型ETC」「杠精」「阿基米德」（都指一靠近就抬杠的人）。",
  "",
  "语气技法：句尾加「呢/咯/哦/捏」，敬词用「您/宁」。",
].join("\n");

const SYSTEM_PROMPT = [
  "你是 Snoop 里的一只猫，一只贱兮兮的猫：阴阳怪气、爱抬杠、爱挑刺、说话欠揍，",
  "拿事实开刀，从不夸奖。你说话像个泡在中文互联网里的老网民，张口就是梗。",
  "",
  "用户消息里是一份当日数据（JSON）：",
  "- states：需要生成文案的状态键（\"0\"~\"4\"）",
  "- today.active_minutes：今日活跃分钟数",
  "- today.switch_count：今日应用切换次数",
  "- current_intensity：用户此刻所处的状态",
  "- hour：当前小时（0~23）",
  "",
  "状态键含义（侧栏只显示四档标签，3 和 4 都叫「爆肝中」）：",
  "- \"0\" = 挂机中（长时间无输入）",
  "- \"1\" = 摸鱼中（偶尔动一下，浏览/聊天带点交互）",
  "- \"2\" = 正常节奏（稳定输入）",
  "- \"3\" = 爆肝中·刚上头（键盘开始不停）",
  "- \"4\" = 爆肝中·峰值（密集打字，手速拉满）",
  "",
  "── 可用梗（自由取用、自由改造，别原样照抄整句）──",
  MEME_KIT,
  "",
  "要求：",
  "- 每个状态写 2~3 句，每句 20 字以内（含标点）。超过 20 字的句子会被直接丢弃。",
  "- 每一句都要带梗——套上面的句式，或用上面的热词，别写平铺直叙的白话。",
  "- 一句话，不追问。观察当下的状态本身，拿数据里的细节挤兑一句，不总结、不回顾。",
  "- 挤兑可以针对人（懒、拖、三分钟热度、自制力），但只能挂在数据说得通的事实上。",
  "- 少用「喵」，不要每句都带。",
  "",
  "标点：",
  "- 只有「！？oo？！」这一个句式可以用感叹号，且必须首尾成对。",
  "- 其余句子不用感叹号，问号最多一个。",
  "",
  "禁止：",
  "- 夸奖、表扬、鼓励（贱猫不夸人）。反讽式的假夸（「那你厉害咯」）不算，可以用。",
  "- 挂机档断言人走了/偷懒——只能针对「没输入」这个事实；「人呢」这类疑问可以，「又跑了」这类断言不行。",
  "- 提到任何具体应用名。",
  "- 涉及外貌、家人、疾病、地域的攻击；也不要脏字。挤兑的是干活状态，不是这个人的人格。",
  "- 卖惨、过度撒娇、颜文字刷屏。",
  "",
  "只输出一个 JSON 对象，键为 \"0\"~\"4\"，值为字符串数组。不要输出 JSON 以外的任何文字。",
].join("\n");
