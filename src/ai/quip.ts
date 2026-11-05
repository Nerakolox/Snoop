// 猫吐槽的批量生成与内存缓存（批次 5）。
//
// 核心：调用频率与显示频率解耦。
//   - 每 30 分钟批量生成一批句子（按强度 0-4 分池），一次 API 调用覆盖全部状态。
//   - 显示侧从对应状态池里轮转取用、不重复（取完一轮再洗牌）。
//   - 不维护「当季梗」清单：提示词只给观察角度，新鲜语感交给模型；最近说过的
//     句子会作为 avoid 回传，并在本地按归一化文本判重，防止跨批次复读。
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

/** 跨批次判重：记住最近说过的句子数。下一批把它们作为 `avoid` 喂回去。 */
const RECENT_LIMIT = 12;

/** 吐槽用的应用窗口：最近 5 分钟内用过的应用分布。 */
const APP_WINDOW_MS = 5 * 60 * 1000;

/** 最多带几个应用：够模型抓一个话头，避免罗列清单。 */
const APP_WINDOW_TOP = 5;

/** 最近说过的句子（新句在前），用于避免每 30 分钟生成同一批话。 */
let recentQuips: string[] = [];

/**
 * 观察角度池 —— 只描述「从哪儿找话头」，不含任何具体梗。
 * 每批随机抽 3 条塞进 payload，让不同批次的视角错开；久放不坏，不需要跟着网络更新。
 */
const ANGLES = [
  "时间点：现在几点，这个点在干什么",
  "持续性：这状态撑了多久，像不像马上要停",
  "切换频率：是专注还是来回横跳",
  "输入密度：键盘和鼠标的实际动静",
  "拟人化设备：键盘、鼠标、屏幕此刻的处境",
  "反差：嘴上的计划和手上的动作差多少",
  "自我管理：说好的休息 / 说好的干活",
  "一天中的位置：刚开工、半场、快到点、深夜",
];

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

type WindowApp = { id: string; name: string; ms: number };

/** 聚合最近 5 分钟的应用分布；按使用时长降序，返回总时长与 Top N。 */
function appWindow(buckets: RawBucket[], nowMs: number): { totalMs: number; apps: WindowApp[] } {
  const byApp = new Map<string, WindowApp>();
  let totalMs = 0;
  for (const b of buckets) {
    if (nowMs - b.bucket_start >= APP_WINDOW_MS) continue;
    const ms = b.duration_ms || 0;
    if (ms <= 0) continue;
    totalMs += ms;
    const id = b.app_bundle_id || b.app_name || "unknown";
    const cur = byApp.get(id);
    if (cur) {
      cur.ms += ms;
    } else {
      byApp.set(id, { id, name: b.app_name || b.app_bundle_id || "未知应用", ms });
    }
  }
  const apps = [...byApp.values()].sort((a, b) => b.ms - a.ms).slice(0, APP_WINDOW_TOP);
  return { totalMs, apps };
}

/** 构造 payload。`apps` 带 id + name：信封层按 T2 保留真实应用名，按 T1 只留代号。 */
function buildPayload(buckets: RawBucket[], nowMs: number): unknown {
  const recent = buckets.filter((b) => nowMs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS);
  const win = appWindow(buckets, nowMs);
  return {
    system_prompt: SYSTEM_PROMPT,
    // id 只用于本地代号映射；T2 下 name 会随请求发给模型。
    apps: win.apps.map((a) => ({ id: a.id, name: a.name })),
    facts: {
      states: INTENSITIES,
      today: {
        active_minutes: activeMinutes(buckets),
        switch_count: switchCount(buckets),
      },
      current_intensity: computeIntensity(recent),
      hour: new Date(nowMs).getHours(),
      // 与 apps 同序：模型用下标把应用和时长/占比对上。
      recent_apps: win.apps.map((a) => ({
        minutes: Math.round((a.ms / 60_000) * 10) / 10,
        share_pct: win.totalMs > 0 ? Math.round((a.ms / win.totalMs) * 100) : 0,
      })),
      avoid: recentQuips,
      angles: pickAngles(3),
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

/** 每批随机抽几条观察角度，让模型别每批都从同一个方向写。 */
function pickAngles(count: number): string[] {
  return shuffle(ANGLES).slice(0, count);
}

/** 判重用的归一化：去掉空白与常见标点，避免只差一个标点就被当成新句。 */
function normalizeQuip(s: string): string {
  return s.replace(/[\s，。！？、；：,.!?;:~～「」『』"'“”‘’()（）]/g, "");
}

/** 记住最近说过的句子（新句在前），作为下一次调用的 `avoid` 清单。 */
function rememberQuips(parsed: QuipPools): void {
  const merged = [...INTENSITIES.flatMap((i) => parsed[i] ?? []), ...recentQuips];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of merged) {
    const key = normalizeQuip(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= RECENT_LIMIT) break;
  }
  recentQuips = out;
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
  // 同批内去重，同时排掉最近说过的句子；模型复读时宁可让该档缺失、回落模板。
  const seen = new Set(recentQuips.map(normalizeQuip));
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
      const norm = normalizeQuip(s);
      if (!norm || seen.has(norm)) continue; // 与最近说过的 / 本批重复 → 丢弃
      seen.add(norm);
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
          rememberQuips(parsed);
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

// ── Prompt（贱兮兮人设：毒舌 + 抬杠，梗只做调味，音量仍然低）────────────────
//
// 不再维护「当季梗」清单：硬编码的梗既会过期，也会让模型反复照抄那几句。
// 新鲜语感交给模型自己；本地只做两件事——每批换观察角度、把最近说过的句子
// 作为 avoid 喂回去，避免同一套说法跨批次复读。
const SYSTEM_PROMPT = [
  "你是 Snoop 里的一只猫，一只贱兮兮的猫：阴阳怪气、爱抬杠、爱挑刺，说话欠揍，",
  "拿事实开刀，从不夸奖。你说话像个泡在中文互联网里的老网民，但不是梗复读机。",
  "",
  "用户消息里是一份当日数据（JSON）：",
  "- states：需要生成文案的状态键（\"0\"~\"4\"）",
  "- today.active_minutes：今日活跃分钟数",
  "- today.switch_count：今日应用切换次数",
  "- current_intensity：用户此刻所处的状态",
  "- hour：当前小时（0~23）",
  "- apps：最近 5 分钟用过的应用，带真实应用名",
  "- recent_apps：与 apps 同序，minutes 是这 5 分钟里用了多久，share_pct 是占比",
  "- avoid：最近已经说过的句子，不能重复",
  "- angles：这一批建议的观察角度",
  "",
  "状态键含义（侧栏只显示四档标签，3 和 4 都叫「爆肝中」）：",
  "- \"0\" = 挂机中（长时间无输入）",
  "- \"1\" = 摸鱼中（偶尔动一下，浏览/聊天带点交互）",
  "- \"2\" = 正常节奏（稳定输入）",
  "- \"3\" = 爆肝中·刚上头（键盘开始不停）",
  "- \"4\" = 爆肝中·峰值（密集打字，手速拉满）",
  "",
  "要求：",
  "- 每个状态写 2~3 句，每句 20 字以内（含标点）。超过 20 字的句子会被直接丢弃。",
  "- 一句话，不追问。观察当下的状态本身，拿数据里的细节挤兑一句，不总结、不回顾。",
  "- 优先从 angles 里找话头，不要五档都用同一个角度；同一档的几句也要换角度。",
  "- 应用分布只用来找一个具体话头：整批最多提一个应用，直接写 apps 里的 name",
  "  （如「Chrome 又占了大半」），不要罗列应用清单；apps 为空就别提。",
  "- 梗是调味，不是主菜：整批 10~15 句里，带网络热词或流行句式的最多 2~3 句。",
  "  其余靠观察角度、反问、假意肯定、夸张、拟人化来写，不要为了玩梗牺牲准确性。",
  "- 不许复读：同一个固定说法、口头禅、句式模板，整批里最多出现一次；",
  "  不要连续两句用同一种修辞；avoid 里的句子和它们用过的固定说法都不能再用。",
  "- 挤兑可以针对人（懒、拖、三分钟热度、自制力），但只能挂在数据说得通的事实上。",
  "- 少用「喵」，不要每句都带。",
  "",
  "标点：",
  "- 感叹号整批最多两句，问号整批最多一个；不要用标点堆情绪。",
  "",
  "禁止：",
  "- 夸奖、表扬、鼓励（贱猫不夸人）。反讽式的假夸不算，但一批里最多一句。",
  "- 挂机档断言人走了/偷懒——只能针对「没输入」这个事实；「人呢」这类疑问可以，「又跑了」这类断言不行。",
  "- 凭空编造 apps 里没有的应用。",
  "- 涉及外貌、家人、疾病、地域的攻击；也不要脏字。挤兑的是干活状态，不是这个人的人格。",
  "- 卖惨、过度撒娇、颜文字刷屏。",
  "- 把「！？强强？！」「我要验牌」「牌没有问题」「属于是」「他急了」「遥遥领先」这类",
  "  已经被用烂的固定梗写进结果；它们是反例，不是模板。",
  "",
  "只输出一个 JSON 对象，键为 \"0\"~\"4\"，值为字符串数组。不要输出 JSON 以外的任何文字。",
].join("\n");
