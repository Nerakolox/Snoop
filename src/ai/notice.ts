// 「留意」（批次 8）—— 检测今天和近 7 天基线明显不同的使用节奏，说一句中性事实。
//
// 设计原则「描述，不评判」：只陈述观察到的数字，绝不给建议、催促、评判。
// 措辞模板刻意避开「熬夜 / 过度 / 异常 / 警告」这类带价值判断的词；若某条规则的
// 措辞不可避免地带判断，宁可砍掉这条规则。
//
// 架构：检测 100% 本机、纯函数，与 AI 无关；AI 只负责把已确认的事实改写成一两句自然的话。
// AI 全关 / 未配置 / tier 不足 / 请求失败 → 措辞回落本地模板，检测照常（降级契约，与
// `quip.ts` 同源）。
//
// 持久化：localStorage（与 dev_mode / page_transition / ai master 同源，每天一条不必建表）。
//   - `snoop.notice.shown`          → { date, rule }，当天已展示就不再重复。
//   - `snoop.notice.disabled_rules` → string[]，被禁用的单条规则。

import { useEffect, useState } from "react";
import { computeIntensity, daysWithDataOf, isActiveBucket } from "../analytics";
import type { RawBucket } from "../data/types";
import { fetchBucketsInRange } from "../data/client";
import { formatAnchor, parseAnchor } from "../data/ranges";
import { useToday } from "../store/context";
import { callAi, getAiConfig } from "./client";

/** 已注册功能 id（T1，见后端 FEATURE_REGISTRY）。default_enabled=false（默认关）。 */
const FEATURE_ID = "ai.notice";

/** 单句上限（字）。超长丢弃，防 AI 输出长段落。 */
const MAX_NOTICE_CHARS = 40;

// ── 阈值常量（集中一处，便于日后调） ────────────────────────────────────────────

/** 基线窗口长度：近 N 个完整自然日（不含今天）。 */
const BASELINE_DAYS = 7;
/** 基线最少有记录天数：不足则整个功能静默，什么都不出。 */
const MIN_BASELINE_DAYS = 4;

/** 凌晨窗口的结束小时（[0, 6) 算凌晨）。 */
const LATE_NIGHT_END_HOUR = 6;
/** R1 凌晨活跃：绝对下限（分钟）。 */
const LATE_NIGHT_MIN_ACTIVE_MIN = 20;
/** R1 凌晨活跃：相对基线倍率。 */
const LATE_NIGHT_RATIO = 1.5;

/** R2 强度偏高：今天至少活跃多少分钟才值得比。 */
const INTENSITY_MIN_ACTIVE_MIN = 30;
/** R2 强度偏高：今天强度至少这一档。 */
const INTENSITY_MIN_TIER = 3;
/** R2 强度偏高：且比基线高至少这一档差。 */
const INTENSITY_DELTA = 1;

/** 专注段间隙阈值：相邻活跃桶超过这个墙钟间隔即断段（与 report/common.rs 的 FOCUS_GAP_MS 一致）。 */
const FOCUS_GAP_MS = 5 * 60 * 1000;
/** R3 连续专注：绝对下限（分钟）。 */
const FOCUS_MIN_MIN = 90;
/** R3 连续专注：相对基线最长段倍率。 */
const FOCUS_RATIO = 1.5;

// ── 规则元数据（AISettings 分规则开关也消费它） ────────────────────────────────

export type NoticeRuleId = "late_night" | "intensity_spike" | "long_focus";

export interface NoticeRuleDef {
  id: NoticeRuleId;
  label: string;
  description: string;
}

/** 三条规则，均为聚合口径（无应用名，T1 安全）。 */
export const NOTICE_RULES: readonly NoticeRuleDef[] = [
  { id: "late_night", label: "凌晨活跃", description: "凌晨 0–6 点的活跃时长明显高于最近一周同期" },
  { id: "intensity_spike", label: "强度偏高", description: "今天平均输入强度明显高于最近一周" },
  { id: "long_focus", label: "连续专注", description: "今天有一段明显更长的连续专注" },
];

// ── 纯计算（脱离 React / Tauri 可直接调用，供手动验证） ─────────────────────────

/** 本地日 key（零填充，与 ranges.ts::formatAnchor 一致，可直接比较）。 */
function dayKeyOf(ms: number): string {
  return formatAnchor(new Date(ms));
}

/** 活跃分钟（有输入桶时长，四舍五入）。 */
function activeMinutes(buckets: RawBucket[]): number {
  let ms = 0;
  for (const b of buckets) {
    if (isActiveBucket(b)) ms += b.duration_ms || 0;
  }
  return Math.round(ms / 60_000);
}

/** 某天落在 [0, LATE_NIGHT_END_HOUR) 小时窗口内的活跃分钟。 */
function lateNightActiveMinutes(dayBuckets: RawBucket[]): number {
  let ms = 0;
  for (const b of dayBuckets) {
    const h = new Date(b.bucket_start).getHours();
    if (h < LATE_NIGHT_END_HOUR && isActiveBucket(b)) ms += b.duration_ms || 0;
  }
  return Math.round(ms / 60_000);
}

/** 最长连续专注段时长（分钟）。算法与 report/common.rs::longest_focus 同构，入参须按 bucket_start 升序。 */
function longestFocusMin(buckets: RawBucket[]): number {
  const active = buckets.filter((b) => isActiveBucket(b));
  if (active.length === 0) return 0;
  let best = active[0].duration_ms || 0;
  let curStart = active[0].bucket_start;
  let curEnd = active[0].bucket_start + (active[0].duration_ms || 0);
  for (let i = 1; i < active.length; i++) {
    const b = active[i];
    const bEnd = b.bucket_start + (b.duration_ms || 0);
    if (b.bucket_start - curEnd <= FOCUS_GAP_MS) {
      curEnd = Math.max(curEnd, bEnd);
      best = Math.max(best, curEnd - curStart);
    } else {
      curStart = b.bucket_start;
      curEnd = bEnd;
    }
  }
  return Math.round(best / 60_000);
}

/** 按本地日分组（入参须已按 bucket_start 升序，组内即升序）。 */
function groupByLocalDay(buckets: RawBucket[]): Map<string, RawBucket[]> {
  const m = new Map<string, RawBucket[]>();
  for (const b of buckets) {
    const k = dayKeyOf(b.bucket_start);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

/** 近 7 个完整自然日的本地日 key（用 setDate 做日历算术，避开 DST 漂移）。 */
function baselineDayKeys(today: string): string[] {
  const d = parseAnchor(today);
  const keys: string[] = [];
  for (let i = BASELINE_DAYS; i >= 1; i--) {
    const prev = new Date(d);
    prev.setDate(prev.getDate() - i);
    keys.push(formatAnchor(prev));
  }
  return keys;
}

/** 分钟 → 「X 小时」/「X.Y 小时」的中性时长。 */
function fmtHours(min: number): string {
  const h = min / 60;
  if (Number.isInteger(h)) return `${h} 小时`;
  return `${h.toFixed(1)} 小时`;
}

interface NoticeHit {
  rule: NoticeRuleId;
  /** 跨规则「哪个最值得说」的启发式分：量纲不统一是刻意的简化，只做排序用。 */
  severity: number;
  /** 本地模板句（AI 失败时的兜底）。 */
  template: string;
  /** 关键数字，喂给 AI 措辞。 */
  numbers: Record<string, number>;
}

/**
 * 纯检测：返回命中的最强规则，或 null（基线不足 / 无命中）。
 *
 * - `todayBuckets`：今天（本地日）的桶，已按 bucket_start 升序。
 * - `baselineBuckets`：近 7 个完整自然日的桶，已按 bucket_start 升序。
 * - `baselineKeys`：这 7 天的本地日 key（空天补 0，用于求均值 / 最大值）。
 * - `nowHour`：当前本地小时（R1 只在凌晨评估）。
 */
export function detectNotice(
  todayBuckets: RawBucket[],
  baselineBuckets: RawBucket[],
  baselineKeys: string[],
  nowHour: number
): NoticeHit | null {
  // 基线不足：整个功能静默，什么都不出。
  if (daysWithDataOf(baselineBuckets) < MIN_BASELINE_DAYS) return null;

  const hits: NoticeHit[] = [];
  const byDay = groupByLocalDay(baselineBuckets);

  // R1 凌晨活跃：只在凌晨 [0,6) 评估（猫是「现在」留意到，不是事后回看）。
  if (nowHour < LATE_NIGHT_END_HOUR) {
    const nowActive = lateNightActiveMinutes(todayBuckets);
    const baseLateSum = baselineKeys.reduce(
      (sum, k) => sum + lateNightActiveMinutes(byDay.get(k) ?? []),
      0
    );
    const baseAvg = baseLateSum / baselineKeys.length;
    if (nowActive >= LATE_NIGHT_MIN_ACTIVE_MIN && nowActive >= LATE_NIGHT_RATIO * baseAvg) {
      const baseRounded = Math.round(baseAvg);
      hits.push({
        rule: "late_night",
        severity: nowActive / Math.max(baseAvg, 1),
        template: `今天凌晨你活跃了 ${nowActive} 分钟，最近一周同期平均 ${baseRounded} 分钟。`,
        numbers: { today_min: nowActive, baseline_avg_min: baseRounded },
      });
    }
  }

  // R2 强度偏高（只取高侧；低侧可能是开会/阅读/看视频，把无输入说成负面是禁止的）。
  const todayActiveMin = activeMinutes(todayBuckets);
  const todayIntensity = computeIntensity(todayBuckets);
  const baseIntensity = computeIntensity(baselineBuckets);
  if (
    todayActiveMin >= INTENSITY_MIN_ACTIVE_MIN &&
    todayIntensity >= INTENSITY_MIN_TIER &&
    todayIntensity >= baseIntensity + INTENSITY_DELTA
  ) {
    hits.push({
      rule: "intensity_spike",
      severity: todayIntensity - baseIntensity + 1,
      template: `今天平均强度 ${todayIntensity} 档，最近一周平均 ${baseIntensity} 档。`,
      numbers: { today_tier: todayIntensity, baseline_tier: baseIntensity },
    });
  }

  // R3 连续专注。
  const todayLongest = longestFocusMin(todayBuckets);
  const baseLongestMax = baselineKeys.reduce(
    (m, k) => Math.max(m, longestFocusMin(byDay.get(k) ?? [])),
    0
  );
  if (todayLongest >= FOCUS_MIN_MIN && todayLongest >= FOCUS_RATIO * baseLongestMax) {
    hits.push({
      rule: "long_focus",
      severity: todayLongest / Math.max(baseLongestMax, 1),
      template: `今天有一段连续 ${fmtHours(todayLongest)} 没有中断，最近一周最长的是 ${fmtHours(baseLongestMax)}。`,
      numbers: { today_min: todayLongest, baseline_max_min: baseLongestMax },
    });
  }

  if (hits.length === 0) return null;
  hits.sort((a, b) => b.severity - a.severity);
  return hits[0];
}

// ── 措辞（AI 改写 → 失败回落模板） ─────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "你是 Snoop 里的一只猫，陪着用户工作。你留意到今天和最近一周有点不一样，说一句中性的事实。",
  "",
  "用户消息里是一个 JSON：",
  "- rule_id：命中的规则（late_night=凌晨活跃 / intensity_spike=强度偏高 / long_focus=连续专注）",
  "- template：一条已经写好的中性事实句",
  "- numbers：关键数字",
  "",
  "要求：",
  "- 把 template 改写 / 转述成一句自然的、口语化的中性事实，**保留里面的数字**，不增删数字。",
  "- 只陈述观察到的事实，不做任何建议、催促、评判。",
  "- 绝对禁止：说教（如「该休息了」「早点睡」）、价值判断词（熬夜 / 过度 / 异常 / 警告 / 不好）、",
  "  把事实往健康或效率上引申。",
  "- 不提任何应用名、窗口标题。",
  "- 一句话，40 字以内（含标点）。",
  "- 语气：克制、有距离感的陪伴，像熟稔的朋友随口提一句，不做绩效报告。",
  "",
  "只输出这一句话本身，不要加引号、换行、解释或任何前缀。",
].join("\n");

function buildPayload(hit: NoticeHit): unknown {
  return {
    system_prompt: SYSTEM_PROMPT,
    rule_id: hit.rule,
    template: hit.template,
    numbers: hit.numbers,
  };
}

/** 措辞：AI 改写 → 任何失败回落本地模板。绝不抛错、绝不返回空串。 */
async function phraseNotice(hit: NoticeHit): Promise<string> {
  try {
    const result = await callAi(FEATURE_ID, buildPayload(hit), false);
    if (result.ok && result.content) {
      const s = result.content.trim();
      if (s.length > 0 && s.length <= MAX_NOTICE_CHARS) return s;
    }
  } catch {
    // invoke 本身异常（信封层已折叠，这里兜底）：回落模板。
  }
  return hit.template;
}

// ── 持久化 ───────────────────────────────────────────────────────────────────

const STORAGE_SHOWN = "snoop.notice.shown";
const STORAGE_DISABLED = "snoop.notice.disabled_rules";

function readShown(): { date: string; rule: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_SHOWN);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.date === "string" && typeof v?.rule === "string") return v;
  } catch {
    // 忽略损坏的存储。
  }
  return null;
}

function writeShown(value: { date: string; rule: string }): void {
  try {
    localStorage.setItem(STORAGE_SHOWN, JSON.stringify(value));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为不记。
  }
}

/** 读被禁用的规则列表。 */
export function readDisabledNoticeRules(): NoticeRuleId[] {
  try {
    const raw = localStorage.getItem(STORAGE_DISABLED);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is NoticeRuleId => NOTICE_RULES.some((r) => r.id === x));
  } catch {
    // 忽略损坏的存储。
  }
  return [];
}

/** 写被禁用的规则列表（AISettings 分规则开关调用）。 */
export function writeDisabledNoticeRules(rules: NoticeRuleId[]): void {
  try {
    localStorage.setItem(STORAGE_DISABLED, JSON.stringify(rules));
  } catch {
    // 同上，静默。
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * 今天要展示的一句「留意」，或 null（不展示）。
 *
 * 概览页挂载 / 跨日（`useToday` 变化）时按需计算一次，非后台轮询。
 * `active` 表示「当前正在看今天」——概览停在今天（日视图 + 今天）时才计算与记「已展示」，
 * 否则既不计算也不标记，避免用户看历史/周月视图时被今天的一句留意打扰、或白白消耗当天配额。
 * 每天最多一条；命中后立即记「已展示」，当天不再重复。
 */
export function useTodayNotice(active: boolean): string | null {
  const today = useToday();
  const [sentence, setSentence] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    (async () => {
      // 当天已展示过 → 不再重复（同一天二次挂载 / 切页回来都静默）。
      if (readShown()?.date === today) return;

      // 功能总开关：后端 default_enabled=false，用户显式开启后 enabled_features 里才有 true。
      const config = await getAiConfig().catch(() => null);
      if (cancelled || !config) return;
      if ((config.enabled_features[FEATURE_ID] ?? false) !== true) return;

      const disabled = readDisabledNoticeRules();

      // 取数：近 7 天 + 今天，共 8 个自然日（一次调用，周视图量级）。
      const start = parseAnchor(today);
      const rangeStart = new Date(start);
      rangeStart.setDate(rangeStart.getDate() - BASELINE_DAYS);
      const rangeEnd = new Date(start);
      rangeEnd.setDate(rangeEnd.getDate() + 1);
      const all = await fetchBucketsInRange({
        start_ms: rangeStart.getTime(),
        end_ms: rangeEnd.getTime(),
      }).catch(() => [] as RawBucket[]);
      if (cancelled) return;

      const sorted = [...all].sort((a, b) => a.bucket_start - b.bucket_start);
      const todayBuckets = sorted.filter((b) => dayKeyOf(b.bucket_start) === today);
      const baselineBuckets = sorted.filter((b) => dayKeyOf(b.bucket_start) !== today);

      const hit = detectNotice(
        todayBuckets,
        baselineBuckets,
        baselineDayKeys(today),
        new Date().getHours()
      );
      if (!hit || disabled.includes(hit.rule)) return;

      // 记已展示（措辞前就记，AI 失败也不会导致同一天重复触发）。
      writeShown({ date: today, rule: hit.rule });

      const wording = await phraseNotice(hit);
      if (cancelled) return;
      setSentence(wording);
    })();

    return () => {
      cancelled = true;
    };
  }, [today, active]);

  return sentence;
}
