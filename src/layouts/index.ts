/**
 * 键盘配列注册中心
 * - 内置配列：构建期通过 import.meta.glob 内联到 JS bundle，打包后无需运行时 fetch。
 * - 自定义配列：由用户从 KLE JSON 导入，存于 localStorage。
 */

import { parseKLE, type KLEKey } from "../kleParser";

export type LayoutSource = "builtin" | "custom";

export type LayoutEntry = {
  id: string;
  name: string;
  source: LayoutSource;
  /** 原始 KLE JSON 数组 */
  data: any[];
};

// ---- 内置配列（eager 内联） -------------------------------------------------

// Vite 会在构建期把匹配到的 JSON 全部当作模块加载并打进 bundle。
const BUILTIN_MODULES = import.meta.glob("../assets/keyboards/*.json", {
  eager: true,
  import: "default",
}) as Record<string, any>;

const BUILTIN_NAME_MAP: Record<string, string> = {
  "40": "40%",
  "60": "60%",
  "68": "68%",
  "84": "75%",
  "87": "TKL",
  "98": "98%",
  "104": "100%",
  "apple-wireless": "Apple",
};

/** 内置配列的稳定展示顺序 */
const BUILTIN_ORDER = ["40", "60", "68", "84", "87", "98", "104", "apple-wireless"];

function fileIdFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.json$/i, "");
}

const BUILTIN_ENTRIES: LayoutEntry[] = Object.entries(BUILTIN_MODULES)
  .map(([path, data]) => {
    const id = fileIdFromPath(path);
    return {
      id,
      name: BUILTIN_NAME_MAP[id] || id,
      source: "builtin" as const,
      data,
    };
  })
  .sort((a, b) => {
    const ia = BUILTIN_ORDER.indexOf(a.id);
    const ib = BUILTIN_ORDER.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.id.localeCompare(b.id);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

export function getBuiltinLayouts(): LayoutEntry[] {
  return BUILTIN_ENTRIES.slice();
}

// ---- 自定义配列（localStorage 持久化） --------------------------------------

const CUSTOM_STORAGE_KEY = "snoop-custom-layouts";
const CUSTOM_ID_PREFIX = "custom:";

type CustomLayoutRecord = {
  id: string;
  name: string;
  data: any[];
};

function readCustomRaw(): CustomLayoutRecord[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is CustomLayoutRecord =>
        r && typeof r.id === "string" && typeof r.name === "string" && Array.isArray(r.data)
    );
  } catch {
    return [];
  }
}

function writeCustomRaw(records: CustomLayoutRecord[]): void {
  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(records));
}

export function getCustomLayouts(): LayoutEntry[] {
  return readCustomRaw().map((r) => ({
    id: r.id,
    name: r.name,
    source: "custom" as const,
    data: r.data,
  }));
}

export function getAllLayouts(): LayoutEntry[] {
  return [...BUILTIN_ENTRIES, ...getCustomLayouts()];
}

export function getLayoutById(id: string): LayoutEntry | undefined {
  return getAllLayouts().find((l) => l.id === id);
}

/**
 * 校验一段任意 JSON 是否可作为 KLE 配列：必须能解析出至少一个键。
 */
export function validateKleJson(json: unknown): { ok: true; keys: KLEKey[] } | { ok: false; reason: string } {
  if (!Array.isArray(json)) {
    return { ok: false, reason: "KLE 文件顶层必须是数组" };
  }
  try {
    // KLE 允许首元素是全局元数据对象，只需其余项都是行数组或对象。
    const rows = json.filter((r) => Array.isArray(r));
    if (rows.length === 0) {
      return { ok: false, reason: "未找到任何键行" };
    }
    const keys = parseKLE(json as any[]);
    if (keys.length === 0) {
      return { ok: false, reason: "解析后没有可显示的键位" };
    }
    return { ok: true, keys };
  } catch (e) {
    return { ok: false, reason: `解析失败：${(e as Error).message ?? e}` };
  }
}

function makeCustomId(): string {
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 保存一个新的自定义配列。
 * 返回新记录的 id；若 name 与现有自定义配列重复，会自动追加序号。
 */
export function addCustomLayout(name: string, data: any[]): LayoutEntry {
  const records = readCustomRaw();
  const finalName = uniqueName(name.trim() || "自定义配列", records.map((r) => r.name));
  const record: CustomLayoutRecord = { id: makeCustomId(), name: finalName, data };
  records.push(record);
  writeCustomRaw(records);
  return { id: record.id, name: record.name, source: "custom", data: record.data };
}

export function removeCustomLayout(id: string): void {
  const next = readCustomRaw().filter((r) => r.id !== id);
  writeCustomRaw(next);
}

export function isCustomLayoutId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 9999; i++) {
    const cand = `${base} (${i})`;
    if (!existing.includes(cand)) return cand;
  }
  return `${base} (${Date.now()})`;
}

// ---- 选中状态 --------------------------------------------------------------

const LAYOUT_STORAGE_KEY = "snoop-kle-layout";
const DEFAULT_LAYOUT_ID = "104";

export function getSavedLayoutId(): string {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (saved && getLayoutById(saved)) return saved;
  return DEFAULT_LAYOUT_ID;
}

export function saveLayoutId(id: string): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, id);
}
