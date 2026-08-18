import {
  createContext, useContext, useMemo, useReducer,
  type ReactNode,
} from "react";
import type { NavKey } from "../components/Sidebar";
import { DAY_MS, formatAnchor, parseAnchor } from "../data/ranges";

export type RangeKind = "day" | "week" | "month";

export interface ContextState {
  page: NavKey;
  kind: RangeKind;
  anchor: string;              // 'YYYY-MM-DD'，语义见 ranges.ts
  appId: string | null;        // null = 全部应用
  focusHour: number | null;    // 时间线定位，仅 timeline 消费
  selectedKey: string | null;  // 单键下钻，仅 input 消费
}

export const KIND_LABEL: Record<RangeKind, string> = {
  day: "日", week: "周", month: "月",
};

/**
 * 每个页面支持的时间粒度。数组顺序即降级优先级（取第一个可用的）。
 *
 * ⚠️ key 用的是**当前的 NavKey 取值**。Batch 1 不改页面命名，
 * 'keyboard' → 'input'、'insights' → 'patterns' 的改名在 Batch 4 / 5 做，
 * 到时候连同这里一起改。现在写 'input' 会直接查不到。
 */
export const PAGE_KIND_CAP: Record<NavKey, RangeKind[]> = {
  overview:      ["day", "week", "month"],
  timeline:      ["day"],
  keyboard:      ["day", "week", "month"],
  insights:      ["week", "month"],
  settings:      ["day", "week", "month"],
  dev:           ["day", "week", "month"],
  "keymap-test": ["day", "week", "month"],
};

const HISTORY_MAX = 20;

/**
 * 把 anchor 规范化为「目标粒度的区间起点」。
 * 粒度变粗：取包含该日的周一 / 月首日。
 * 粒度变细：区间内含今天则取今天，否则取区间首日 —— 这条规则
 *          在 Batch 2（月历下钻）和 Batch 3（adaptKind 降级）都要用。
 */
export function reanchor(
  fromKind: RangeKind,
  fromAnchor: string,
  toKind: RangeKind,
  now: Date = new Date()
): string {
  const d = parseAnchor(fromAnchor);

  if (toKind === "week") {
    // 周日算作上一周的第 7 天，与 ranges.ts 的 thisWeekRange 保持一致
    const dow = d.getDay();                       // 周日=0
    const offset = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - offset);
    return formatAnchor(d);
  }

  if (toKind === "month") {
    return formatAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
  }

  // toKind === 'day'
  const start = parseAnchor(normalizeAnchor(fromKind, fromAnchor));
  const end =
    fromKind === "day"   ? new Date(start.getTime() + DAY_MS)
  : fromKind === "week"  ? new Date(start.getTime() + 7 * DAY_MS)
  :                        new Date(start.getFullYear(), start.getMonth() + 1, 1);

  const todayStr = formatAnchor(now);
  const t = parseAnchor(todayStr).getTime();
  return t >= start.getTime() && t < end.getTime() ? todayStr : formatAnchor(start);
}

/** anchor 自身是否已符合该粒度的起点约定；不符合则修正。 */
export function normalizeAnchor(kind: RangeKind, anchor: string): string {
  if (kind === "day") return anchor;
  return reanchor("day", anchor, kind);
}

/** anchor 按当前粒度前后位移。dir=-1 上一个区间，dir=1 下一个。 */
export function shiftAnchor(kind: RangeKind, anchor: string, dir: 1 | -1): string {
  const d = parseAnchor(anchor);
  if (kind === "day")   d.setDate(d.getDate() + dir);
  if (kind === "week")  d.setDate(d.getDate() + 7 * dir);
  if (kind === "month") d.setMonth(d.getMonth() + dir);   // 不要 +30 天
  return formatAnchor(d);
}

export interface AdaptedRange {
  kind: RangeKind;
  anchor: string;
  /** 发生降级时的人类可读说明；未降级为 null */
  note: string | null;
}

/**
 * 页面读取时间粒度的唯一入口。
 *
 * ⚠️ 这是**读取时投影**，页面消费返回值即可，
 *    绝对不要把结果写回全局 state（不要在 useEffect 里 setKind）。
 *    否则「概览(月) → 时间线(降级为日) → 返回」回到概览会变成日，
 *    用户会觉得应用把他的选择吃掉了。
 */
export function adaptKind(
  page: NavKey,
  s: Pick<ContextState, "kind" | "anchor">,
  now: Date = new Date()
): AdaptedRange {
  const cap = PAGE_KIND_CAP[page] ?? (["day", "week", "month"] as RangeKind[]);
  if (cap.includes(s.kind)) {
    return { kind: s.kind, anchor: s.anchor, note: null };
  }
  const target = cap[0];
  return {
    kind: target,
    anchor: reanchor(s.kind, s.anchor, target, now),
    note: `「${KIND_LABEL[s.kind]}」视图在此页不可用，已映射为「${KIND_LABEL[target]}」`,
  };
}

type Action =
  | { t: "SET_KIND"; kind: RangeKind }
  | { t: "SET_ANCHOR"; anchor: string }
  | { t: "STEP_ANCHOR"; dir: 1 | -1 }
  | { t: "GO_TODAY" }
  | { t: "SET_APP"; appId: string | null }
  | { t: "SET_FOCUS_HOUR"; hour: number | null }
  | { t: "SET_SELECTED_KEY"; key: string | null }
  | { t: "NAVIGATE"; patch: Partial<ContextState> }
  | { t: "BACK" };

interface Store {
  cur: ContextState;
  stack: ContextState[];
}

function reducer(s: Store, a: Action): Store {
  const cur = s.cur;

  switch (a.t) {
    case "SET_KIND": {
      if (a.kind === cur.kind) return s;
      return {
        ...s,
        cur: { ...cur, kind: a.kind, anchor: reanchor(cur.kind, cur.anchor, a.kind) },
      };
    }
    case "SET_ANCHOR":
      return { ...s, cur: { ...cur, anchor: normalizeAnchor(cur.kind, a.anchor) } };

    case "STEP_ANCHOR":
      return { ...s, cur: { ...cur, anchor: shiftAnchor(cur.kind, cur.anchor, a.dir) } };
    case "GO_TODAY":
      return {
        ...s,
        cur: { ...cur, anchor: normalizeAnchor(cur.kind, formatAnchor(new Date())) },
      };

    case "SET_APP":
      return { ...s, cur: { ...cur, appId: a.appId } };
    case "SET_FOCUS_HOUR":
      return { ...s, cur: { ...cur, focusHour: a.hour } };
    case "SET_SELECTED_KEY":
      return { ...s, cur: { ...cur, selectedKey: a.key } };

    case "NAVIGATE": {
      const next = { ...cur, ...a.patch };
      // patch 里带了 kind 时同步修正 anchor（除非 patch 自己给了 anchor）
      if (a.patch.kind && !a.patch.anchor) {
        next.anchor = reanchor(cur.kind, cur.anchor, a.patch.kind);
      }
      const stack = [...s.stack, cur].slice(-HISTORY_MAX);
      return { cur: next, stack };
    }
    case "BACK": {
      if (s.stack.length === 0) return s;
      const stack = s.stack.slice(0, -1);
      return { cur: s.stack[s.stack.length - 1], stack };
    }
  }
}

const StateCtx = createContext<ContextState | null>(null);
const ActionsCtx = createContext<Actions | null>(null);
const StackCtx = createContext<number>(0);   // 栈深，供返回按钮判断 disabled

export interface Actions {
  setKind(kind: RangeKind): void;
  setAnchor(anchor: string): void;
  stepAnchor(dir: 1 | -1): void;
  goToday(): void;
  setApp(appId: string | null): void;
  setFocusHour(hour: number | null): void;
  setSelectedKey(key: string | null): void;
  /** 唯一的压栈入口。跨页跳转 / 页面内下钻都走它。 */
  navigate(patch: Partial<ContextState>): void;
  back(): void;
}

export function ContextProvider({ children }: { children: ReactNode }) {
  const [store, dispatch] = useReducer(reducer, undefined, () => ({
    cur: {
      page: "overview" as NavKey,
      kind: "day" as RangeKind,
      anchor: formatAnchor(new Date()),
      appId: null,
      focusHour: null,
      selectedKey: null,
    },
    stack: [],
  }));

  const actions = useMemo<Actions>(() => ({
    setKind:        (kind)   => dispatch({ t: "SET_KIND", kind }),
    setAnchor:      (anchor) => dispatch({ t: "SET_ANCHOR", anchor }),
    stepAnchor:     (dir)    => dispatch({ t: "STEP_ANCHOR", dir }),
    goToday:        ()       => dispatch({ t: "GO_TODAY" }),
    setApp:         (appId)  => dispatch({ t: "SET_APP", appId }),
    setFocusHour:   (hour)   => dispatch({ t: "SET_FOCUS_HOUR", hour }),
    setSelectedKey: (key)    => dispatch({ t: "SET_SELECTED_KEY", key }),
    navigate:       (patch)  => dispatch({ t: "NAVIGATE", patch }),
    back:           ()       => dispatch({ t: "BACK" }),
  }), []);

  return (
    <ActionsCtx.Provider value={actions}>
      <StackCtx.Provider value={store.stack.length}>
        <StateCtx.Provider value={store.cur}>{children}</StateCtx.Provider>
      </StackCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export function useContextState(): ContextState {
  const v = useContext(StateCtx);
  if (!v) throw new Error("useContextState 必须在 ContextProvider 内使用");
  return v;
}
export function useContextActions(): Actions {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error("useContextActions 必须在 ContextProvider 内使用");
  return v;
}
export function useHistoryDepth(): number {
  return useContext(StackCtx);
}
