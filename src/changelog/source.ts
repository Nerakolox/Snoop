/**
 * 更新日志的数据源。三级兜底，优先级从高到低：
 *
 *   1. 云端 `changelog.json`（公开读 OSS，和 latest.json 同一个桶）
 *   2. localStorage 里的上一次成功结果
 *   3. 打包进包体的种子文件 `changelog.json`
 *
 * 之所以要第 2 级：这个弹窗是「随手点开看看」的场景，不该有转圈。缓存命中就
 * 先渲染，同时后台再拉一次，拿到新的再换——用户感知不到网络。
 *
 * 之所以要第 3 级：断网、OSS 挂了、公司网络拦了，弹窗也必须有内容。种子文件
 * 每次发版随包更新，最坏情况下用户看到的是自己这一版之前的完整历史。
 *
 * 解析全程防御式：云端文件可能被手写坏、可能被将来版本加了字段，任何一个
 * 坏条目都不该让整份日志变空白。未知字段直接忽略，未知条目类型归到 other。
 */

import { useSyncExternalStore } from "react";
import type {
  ChangeKind,
  ChangelogFile,
  ChangeNote,
  ChangelogLink,
  Release,
} from "./types";
import { compareVersions } from "./version";
import seed from "./changelog.json";

/**
 * 云端地址。桶与 `src-tauri/src/updater.rs` 的 `UPDATE_BASE_URL` 是同一个，
 * 那边以 `format!("{}/latest.json", ...)` 拼接，两边改地址时必须一起改。
 * 不为了一个 URL 加一条 Rust 命令——那会让「改 Bucket」变成改两个文件的命令。
 */
const CHANGELOG_URL = "https://snoop.cn-nb1.rains3.com/changelog.json";

/** 缓存键带 v1：将来加破坏性字段时升版本，老缓存自然失效而不是被误读。 */
const CACHE_KEY = "snoop.changelog.v1";
const SEEN_KEY = "snoop.changelog.seen";
const FETCH_TIMEOUT_MS = 8000;

export type ChangelogSource = "remote" | "cache" | "bundled";

export interface ChangelogSnapshot {
  data: ChangelogFile;
  source: ChangelogSource;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

const KNOWN_KINDS: ChangeKind[] = ["feat", "fix", "improve", "breaking", "other"];

function asKind(v: unknown): ChangeKind {
  return typeof v === "string" && (KNOWN_KINDS as string[]).includes(v)
    ? (v as ChangeKind)
    : "other";
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function parseNote(raw: unknown): ChangeNote | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = asString(o.text);
  if (!text) return null; // 没有正文的条目没有意义，丢掉
  const detail = asString(o.detail);
  return { kind: asKind(o.kind), text, ...(detail ? { detail } : {}) };
}

function parseLink(raw: unknown): ChangelogLink | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = asString(o.label);
  const url = asString(o.url);
  // 只放行 https：这是从网络来的内容，不该有能力把用户送到 file:// 或 javascript:
  if (!label || !url || !/^https:\/\//i.test(url)) return null;
  return { label, url };
}

function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const version = asString(o.version);
  const date = asString(o.date);
  if (!version || !date) return null; // 版本与日期是时间线骨架，缺一不可

  const notes = Array.isArray(o.notes)
    ? o.notes.map(parseNote).filter((n): n is ChangeNote => n !== null)
    : [];
  const links = Array.isArray(o.links)
    ? o.links.map(parseLink).filter((l): l is ChangelogLink => l !== null)
    : [];
  const tagline = asString(o.tagline);

  return {
    version,
    date,
    notes,
    ...(tagline ? { tagline } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}

/**
 * 把任意 JSON 收成 ChangelogFile。无法识别的部分被静默丢弃，
 * 版本号倒序排列（云端文件按什么顺序写都不影响渲染）。
 */
export function normalizeChangelog(raw: unknown): ChangelogFile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.releases)) return null;

  const releases = o.releases
    .map(parseRelease)
    .filter((r): r is Release => r !== null)
    .sort((a, b) => compareVersions(b.version, a.version));

  if (releases.length === 0) return null;

  const updatedAt = asString(o.updated_at);
  const schema = typeof o.schema === "number" ? o.schema : 1;
  return { schema, releases, ...(updatedAt ? { updated_at: updatedAt } : {}) };
}

// ─── 缓存 ────────────────────────────────────────────────────────────────────

function readCache(): ChangelogFile | null {
  try {
    const text = localStorage.getItem(CACHE_KEY);
    if (!text) return null;
    return normalizeChangelog(JSON.parse(text));
  } catch {
    return null;
  }
}

function writeCache(data: ChangelogFile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // 配额满 / 隐私模式：缓存写不进去不影响本次展示，下次照常走网络
  }
}

const BUNDLED: ChangelogFile =
  normalizeChangelog(seed) ?? { schema: 1, releases: [] };

/**
 * 首屏该拿哪份数据。
 *
 * 正常情况下缓存比包体新（缓存可能来自之后发版的云端文件），缓存优先。
 * 但**升级后的第一屏**恰好相反：缓存还是上一版的，包体里却已经带上了
 * 这一版的内容。若一味缓存优先，升级弹窗会拿不到当前版本条目，离线时
 * 甚至整次更新都无声无息。所以按「谁记录的版本更新就用谁」来选。
 */
function pickInitial(): ChangelogSnapshot {
  const cached = readCache();
  if (!cached) return { data: BUNDLED, source: "bundled" };

  const bundledNewest = BUNDLED.releases[0]?.version;
  const cachedNewest = cached.releases[0]?.version;
  if (
    bundledNewest &&
    (!cachedNewest || compareVersions(bundledNewest, cachedNewest) > 0)
  ) {
    return { data: BUNDLED, source: "bundled" };
  }
  return { data: cached, source: "cache" };
}

// ─── 运行时状态 ──────────────────────────────────────────────────────────────

let snapshot: ChangelogSnapshot | null = null;
let inflight: Promise<ChangelogSnapshot> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function setSnapshot(next: ChangelogSnapshot): void {
  snapshot = next;
  emit();
}

async function fetchRemote(): Promise<ChangelogFile> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CHANGELOG_URL, {
      signal: ctrl.signal,
      cache: "no-cache",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeChangelog(await res.json());
    if (!data) throw new Error("内容为空或格式不符");
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 取更新日志。同步部分（缓存/种子）立即返回，网络结果到了再推一次。
 *
 * 并发调用会合流到同一次请求；`force` 用于用户点「重试」。
 */
export function loadChangelog(force = false): Promise<ChangelogSnapshot> {
  if (!force && snapshot) return Promise.resolve(snapshot);
  if (inflight) return inflight;

  // 先用本地的顶着，不等网络。已有 snapshot 时不降级覆盖，避免闪烁。
  if (!snapshot) setSnapshot(pickInitial());

  inflight = fetchRemote()
    .then((data) => {
      // 云端偶尔会比包体还旧（发版后 OSS 尚未刷新）。这时不能拿旧文件
      // 覆盖手里的新内容，否则升级弹窗会突然找不到「当前版本」这一条。
      const remoteNewest = data.releases[0]?.version;
      const localNewest = snapshot?.data.releases[0]?.version;
      const isStale =
        remoteNewest && localNewest && compareVersions(localNewest, remoteNewest) > 0;
      if (!isStale) {
        writeCache(data);
        setSnapshot({ data, source: "remote" });
      }
      return snapshot!;
    })
    .catch((e) => {
      // 失败是常态（离线、OSS 抖动），不打 error 级别日志，避免每次开窗都刷一条
      console.warn("更新日志拉取失败，使用本地内容:", e);
      return snapshot!;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
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

function getSnapshot(): ChangelogSnapshot | null {
  return snapshot;
}

/** 组件用的快照。首次调用触发加载；后续跟着模块状态更新。 */
export function useChangelog(): ChangelogSnapshot | null {
  const v = useSyncExternalStore(subscribe, getVersion);
  void v; // 版本号只是用来触发重渲染，取值本身不用
  return getSnapshot();
}

// ─── 未读标记 ────────────────────────────────────────────────────────────────

/**
 * 是否有一个比「上次看到」更新的版本。
 *
 * 目的只是让入口有个小红点，别做成一套通知系统：没有未读状态机、没有已读回执，
 * 就一个 localStorage 里的版本字符串。用户打开过弹窗就算看过了。
 */
export function hasUnseenRelease(data: ChangelogFile): boolean {
  const newest = data.releases[0];
  if (!newest) return false;
  return hasUnseenVersion(newest.version);
}

/**
 * 指定版本是否比「上次看过」更新（没看过任何版本时也算未读）。
 *
 * 升级弹窗不能直接用 `hasUnseenRelease`：云端日志常常比安装包先上线，
 * 用户在旧版本里点开日志时可能已经看过「将来要装的那一版」，这时比较的
 * 对象应该是**当前运行的版本**，而不是日志里的最新版本。
 */
export function hasUnseenVersion(version: string): boolean {
  const seen = localStorage.getItem(SEEN_KEY);
  if (!seen) return true; // 从没打开过：装好就有一条红点，引导用户点开
  return compareVersions(version, seen) > 0;
}

export function markChangelogSeen(data: ChangelogFile): void {
  const newest = data.releases[0];
  if (!newest) return;
  markVersionSeen(newest.version);
}

/**
 * 把指定版本记为已读。
 *
 * 升级弹窗只展示刚安装的那一版，因此不能沿用「把最新条目标为已读」的写法：
 * 云端日志可能已经提前写了下一版，那样会把用户还没看到的内容一并吞掉。
 * 同时不回退已读水位——用户看过更新的版本后，再标记旧版本不该让红点复活。
 */
export function markVersionSeen(version: string): void {
  if (!version) return;
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen && compareVersions(seen, version) > 0) return;
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // 同上，写不进去只是红点消不掉，不影响功能
  }
}
