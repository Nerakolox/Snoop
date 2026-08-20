import {
  createContext, useCallback, useContext, useMemo, useReducer,
  type ReactNode,
} from "react";
import type { NavKey } from "../components/Sidebar";
import { DAY_MS, formatAnchor, parseAnchor } from "../data/ranges";
import { useDayRollover } from "../hooks/useDayRollover";

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

/** 每个页面支持的时间粒度。数组顺序即降级优先级（取第一个可用的）。 */
export const PAGE_KIND_CAP: Record<NavKey, RangeKind[]> = {
  overview:      ["day", "week", "month"],
  timeline:      ["day"],
  input:         ["day", "week", "month"],
  patterns:      ["week", "month"],
  ai:            ["day", "week", "month"],
  settings:      ["day", "week", "month"],
  dev:           ["day", "week", "month"],
  "keymap-test": ["day", "week", "month"],
};

const HISTORY_MAX = 20;

/** 含该日的那一周的周一。周日算作上一周的第 7 天，与 ranges.ts 的 thisWeekRange 一致。 */
function startOfWeekAnchor(anchor: string): string {
  const d = parseAnchor(anchor);
  const dow = d.getDay();                         // 周日=0
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return formatAnchor(d);
}

/** 含该日的那个月的 1 号。 */
function startOfMonthAnchor(anchor: string): string {
  const d = parseAnchor(anchor);
  return formatAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** anchor 自身是否已符合该粒度的起点约定；不符合则修正。 */
export function normalizeAnchor(kind: RangeKind, anchor: string): string {
  if (kind === "week")  return startOfWeekAnchor(anchor);
  if (kind === "month") return startOfMonthAnchor(anchor);
  return anchor;                                  // day：anchor 即起点
}

/**
 * 把 anchor 规范化为「目标粒度的区间起点」。
 * 粒度变粗：取包含该日的周一 / 月首日。
 * 粒度变细：区间内含今天则取今天，否则取区间首日 —— 这条规则
 *          在 Batch 2（月历下钻）和 Batch 3（adaptKind 降级）都要用。
 *
 * ⚠️ `today` 必填且**没有默认值**，这是刻意的：全局当日基准只有一个来源
 *    （store 的 `today`，见 useToday）。给它默认成 `new Date()` 就等于
 *    允许调用方各自读时钟，跨日错位的老毛病会立刻复发。
 */
export function reanchor(
  fromKind: RangeKind,
  fromAnchor: string,
  toKind: RangeKind,
  today: string
): string {
  if (toKind === "week")  return startOfWeekAnchor(fromAnchor);
  if (toKind === "month") return startOfMonthAnchor(fromAnchor);

  // toKind === 'day'
  const start = parseAnchor(normalizeAnchor(fromKind, fromAnchor));
  const end =
    fromKind === "day"   ? new Date(start.getTime() + DAY_MS)
  : fromKind === "week"  ? new Date(start.getTime() + 7 * DAY_MS)
  :                        new Date(start.getFullYear(), start.getMonth() + 1, 1);

  const t = parseAnchor(today).getTime();
  return t >= start.getTime() && t < end.getTime() ? today : formatAnchor(start);
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
  today: string
): AdaptedRange {
  const cap = PAGE_KIND_CAP[page] ?? (["day", "week", "month"] as RangeKind[]);
  if (cap.includes(s.kind)) {
    return { kind: s.kind, anchor: s.anchor, note: null };
  }
  const target = cap[0];
  return {
    kind: target,
    anchor: reanchor(s.kind, s.anchor, target, today),
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
  | { t: "BACK" }
  | { t: "DAY_ROLLOVER"; today: string };

interface Store {
  cur: ContextState;
  stack: ContextState[];
  /**
   * 全局当日基准 'YYYY-MM-DD'，整个应用「今天是哪一天」的唯一真源。
   *
   * ⚠️ 刻意放在 Store 层而**不是** ContextState 里：ContextState 会在
   *    NAVIGATE 时被压进 stack、BACK 时整体还原。基准若在其中，按一次
   *    「返回」就会把它还原成压栈那一刻的旧值 —— 正是要修的那个 bug。
   */
  today: string;
}

function reducer(s: Store, a: Action): Store {
  const cur = s.cur;

  switch (a.t) {
    case "SET_KIND": {
      if (a.kind === cur.kind) return s;
      return {
        ...s,
        cur: { ...cur, kind: a.kind, anchor: reanchor(cur.kind, cur.anchor, a.kind, s.today) },
      };
    }
    case "SET_ANCHOR":
      return { ...s, cur: { ...cur, anchor: normalizeAnchor(cur.kind, a.anchor) } };

    case "STEP_ANCHOR":
      return { ...s, cur: { ...cur, anchor: shiftAnchor(cur.kind, cur.anchor, a.dir) } };
    case "GO_TODAY":
      return {
        ...s,
        cur: { ...cur, anchor: normalizeAnchor(cur.kind, s.today) },
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
        next.anchor = reanchor(cur.kind, cur.anchor, a.patch.kind, s.today);
      }
      const stack = [...s.stack, cur].slice(-HISTORY_MAX);
      // ⚠️ 必须展开 ...s：漏了会把 today 丢成 undefined，
      //    下一次 DAY_ROLLOVER 就会在 parseAnchor(undefined) 处崩。
      return { ...s, cur: next, stack };
    }
    case "BACK": {
      if (s.stack.length === 0) return s;
      const stack = s.stack.slice(0, -1);
      // 同上。today 保留**当前**值而非栈里的——基准本来就不进历史栈。
      return { ...s, cur: s.stack[s.stack.length - 1], stack };
    }

    /**
     * 跨日推进。由 useDayRollover 的午夜定时器 / 焦点 / 可见性三个触发器派发，
     * 幂等：同一天重复派发直接返回原 state（React 会 bail out 不重渲染），
     * 所以任何触发器可以任意次数重复调用。
     *
     * 判据一个表达式覆盖三种粒度，无需 switch(kind)——normalizeAnchor 已经
     * 编码了各粒度的区间起点：
     *   day   8/21→8/22：'8/21'→'8/22' 变了 → 推进
     *   week  周内跨日： '8/17'→'8/17' 没变 → 不动
     *   week  周日→周一：'8/17'→'8/24' 变了 → 推进
     *   month 月内跨日： '8/01'→'8/01' 没变 → 不动
     * 用户停在历史区间时 wasCurrent 为 false，一律不动。
     * 休眠跨多天后唤醒会直接算出当天，一次跳到位。
     *
     * 不压栈：时钟跳变不是导航动作，用户不该能按「返回」回到午夜前的昨天。
     */
    case "DAY_ROLLOVER": {
      if (a.today === s.today) return s;
      const wasCurrent = cur.anchor === normalizeAnchor(cur.kind, s.today);
      const nextAnchor = normalizeAnchor(cur.kind, a.today);
      if (!wasCurrent || nextAnchor === cur.anchor) {
        // 基准前进，anchor 不动。cur 引用保持不变，依赖 cur 的组件不重渲染。
        return { ...s, today: a.today };
      }
      return { ...s, today: a.today, cur: { ...cur, anchor: nextAnchor } };
    }
  }
}

const StateCtx = createContext<ContextState | null>(null);
const ActionsCtx = createContext<Actions | null>(null);
const StackCtx = createContext<number>(0);   // 栈深，供返回按钮判断 disabled
const TodayCtx = createContext<string | null>(null);   // 全局当日基准

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
  const [store, dispatch] = useReducer(reducer, undefined, () => {
    // 全应用唯一的启动种子：一次读钟，同时种 today 和 anchor。
    const today = formatAnchor(new Date());
    return {
      cur: {
        page: "overview" as NavKey,
        kind: "day" as RangeKind,
        anchor: today,
        appId: null,
        focusHour: null,
        selectedKey: null,
      },
      stack: [],
      today,
    };
  });

  // 午夜 / 焦点 / 可见性三个触发器共用这一个函数，不存在第二份跨日逻辑。
  const syncToday = useCallback(
    () => dispatch({ t: "DAY_ROLLOVER", today: formatAnchor(new Date()) }),
    []
  );
  useDayRollover(syncToday);

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
        <TodayCtx.Provider value={store.today}>
          <StateCtx.Provider value={store.cur}>{children}</StateCtx.Provider>
        </TodayCtx.Provider>
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

/**
 * 全局当日基准 'YYYY-MM-DD'。
 *
 * **这是页面判断「今天是哪一天」的唯一入口。** 不要在组件里写
 * `new Date()` / `formatAnchor(new Date())` 自己算——那正是跨日错位的成因：
 * 冻结型（useMemo 空依赖）和实时型两种写法会在午夜后给出互相矛盾的答案。
 *
 * 返回值只在日历日翻页时变化，所以依赖它的 useMemo 全天稳定。
 */
export function useToday(): string {
  const v = useContext(TodayCtx);
  if (!v) throw new Error("useToday 必须在 ContextProvider 内使用");
  return v;
}
