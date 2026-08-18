# Batch 1 · 地基：store + 顶栏 + 共享件 + 数据层

> 执行前先读 `docs/v2-工单-修订版.md` 的「全局约束」一节。
> 本批**不改任何页面的数据渲染**。做完后四个页面表现应与现在完全一致，只是多了一条顶栏，且顶栏的操作暂时不驱动任何页面。
> 开工前：`git commit -m "chore: Batch 1 开工前存档"`

---

## 0 · 本批产出清单

按这个顺序做，每组一个 commit。

| # | 动作 | 文件 |
|---|---|---|
| **C1** | 新建 | `src/store/context.tsx` |
| C1 | 修改 | `src/data/ranges.ts`（新增 `toMs` / `parseAnchor` / `formatAnchor`） |
| C1 | 修改 | `src/main.tsx`（挂 Provider） |
| C1 | 修改 | `src/App.tsx`（page 状态迁入 store，转场逻辑改为响应式） |
| **C2** | 新建 | `src/components/TopBar.tsx`、`src/styles/topbar.css` |
| C2 | 修改 | `src/App.tsx`（渲染 TopBar，删 TitleBar） |
| C2 | 删除 | `src/components/TitleBar.tsx` |
| C2 | 修改 | `src/styles/base.css`（删 `.titlebar*` 与 `--titlebar-height`，`.app-main` 补 `min-height`） |
| **C3** | 新建 | `src/components/shared/ContextChips.tsx`、`Toast.tsx`、`drillable.css` |
| C3 | 重写 | `src/components/DeltaBadge.tsx` |
| C3 | 修改 | `src/pages/Insights.tsx`（迁移唯一调用点，删 `calculateDelta`） |
| **C4** | 新建 | `src/data/useRangeData.ts` |
| C4 | 修改 | `CLAUDE.md`（PageShell 顶距真源的表述） |

---

## 1 · C1：store 与时间语义

### 1.1 背景：为什么 `page` 必须进 store

现状 `src/App.tsx:43`：

```tsx
const [active, setActive] = useState<NavKey>("overview");
const [displayed, setDisplayed] = useState<NavKey>("overview");
const [phase, setPhase] = useState<Phase>("idle");
```

`handleSelect(next)` 里跑一套两段式转场（`FADE_OUT_MS=160` 淡出 → 换页 → 双 rAF → `FADE_IN_MS=280` 淡入）。

视图栈的栈项是 `{page, kind, anchor, appId, focusHour, selectedKey}`，`back()` 必须能把**页面**也恢复回去。如果 `page` 留在 App 的 useState 里，store 改不了它，`back()` 就是残废的。

所以：**`page` 进 store，App 只保留 `displayed` / `phase` 这两个纯动画态**，转场从"点击时触发"改成"监听到 `page` 变化时触发"。

### 1.2 `src/data/ranges.ts` 追加

现有的 `DAY_MS` / `todayRange` / `thisWeekRange` / `dayRangeOf` **全部保留不动**（Dev 页与 Overview 还在用）。在文件末尾追加：

```ts
import type { RangeKind } from "../store/context";

/**
 * anchor 是 'YYYY-MM-DD' 字符串，语义为**本地时区**的某一天。
 *
 * ⚠️ 绝对不要用 `new Date("2026-08-03")` 解析它。
 * 那是 ISO date-only 格式，JS 按 **UTC** 解析，东八区会得到本地时间
 * 2026-08-03T08:00，跨时区/跨夏令时会整体漂一天。必须用下面这个。
 */
export function parseAnchor(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d); // 本地 00:00:00.000
}

/** Date → 'YYYY-MM-DD'（本地）。同样不要用 toISOString()，那是 UTC。 */
export function formatAnchor(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 语义 (kind, anchor) → 后端要的 [start_ms, end_ms)。
 *
 * anchor 的约定：day = 当天；week = 该周周一；month = 该月 1 号。
 * 调用前 anchor 应已被 `normalizeAnchor` 规范化过。
 *
 * opts.liveEnd：区间**包含当前时刻**时，把 end_ms 收到 now。
 *   这是 Timeline 现有的"活范围"语义（原 Timeline.tsx:123），
 *   **只有时间线传 true**，其他页面用完整区间。
 */
export function toMs(
  kind: RangeKind,
  anchor: string,
  opts?: { liveEnd?: boolean },
  now: Date = new Date()
): TimeRange {
  const start = parseAnchor(anchor);
  let end: Date;

  if (kind === "day") {
    end = new Date(start.getTime() + DAY_MS);
  } else if (kind === "week") {
    end = new Date(start.getTime() + 7 * DAY_MS);
  } else {
    // ⚠️ 月份不能用 +30*DAY_MS。必须走 setMonth，让 JS 处理 28/29/30/31 天。
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  }

  let end_ms = end.getTime();
  const nowMs = now.getTime();
  if (opts?.liveEnd && nowMs >= start.getTime() && nowMs < end_ms) {
    end_ms = nowMs;
  }
  return { start_ms: start.getTime(), end_ms };
}
```

> **为什么 week 可以用 `+7 * DAY_MS` 而 month 不行**：现有 `thisWeekRange` 就是这么写的，保持一致。夏令时地区一周会差 1 小时，但项目目标用户在中国（无 DST），且改掉会与现有函数行为不一致。月份长度不等长是硬事实，必须走 `setMonth`。

### 1.3 `src/store/context.tsx`（新建）

> 用 `.tsx` 后缀，因为里面有 JSX（Provider）。

#### 1.3.1 类型与常量

```tsx
import {
  createContext, useContext, useMemo, useReducer, useCallback,
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
```

#### 1.3.2 anchor 规范化（纯函数，导出，后面几批都要复用）

```tsx
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
```

> 注意 `reanchor` 的 `toKind === 'day'` 分支里调用了 `normalizeAnchor`，而 `normalizeAnchor` 又调用 `reanchor`——**这不是无限递归**，因为 `normalizeAnchor` 只在 `kind !== 'day'` 时递归，且传入的 `toKind` 是 week/month，走的是上面两个提前 return 的分支。写完跑一遍下面的自测表确认。

#### 1.3.3 adaptKind

```tsx
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
```

#### 1.3.4 reducer 与 actions

```tsx
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
```

**压栈规则（必须严格遵守，后面几批都依赖它）：**

| 操作 | 是否压栈 | 理由 |
|---|---|---|
| `NAVIGATE`（含侧栏切页、菜单切页、页面内下钻） | **压** | 一次视图跳转 = 一个可返回的落点 |
| `SET_KIND` / `SET_ANCHOR` / `STEP_ANCHOR` / `GO_TODAY` | 不压 | 顶栏上的范围调整不是视图跳转；否则返回键会变成"粒度撤销"，很怪 |
| `SET_APP`（顶栏芯片直接改） | 不压 | 同上 |
| `SET_FOCUS_HOUR` / `SET_SELECTED_KEY`（页面内直接设） | 不压 | 页内状态，用 chips 的叉清除 |

页面内的下钻（如概览点 App 排行行 → 跳时间线并设筛选）**一律走 `NAVIGATE`**，一次原子操作里同时改 page + appId，压一次栈。不要拆成 `setApp()` + `setPage()` 两步——那会压出一个中间态。

```tsx
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

    case "STEP_ANCHOR": {
      const d = parseAnchor(cur.anchor);
      if (cur.kind === "day")   d.setDate(d.getDate() + a.dir);
      if (cur.kind === "week")  d.setDate(d.getDate() + 7 * a.dir);
      if (cur.kind === "month") d.setMonth(d.getMonth() + a.dir);   // 不要 +30 天
      return { ...s, cur: { ...cur, anchor: formatAnchor(d) } };
    }
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
```

#### 1.3.5 两个 Context（这条是性能要求，不是风格偏好）

```tsx
const StateCtx = createContext<ContextState | null>(null);
const ActionsCtx = createContext<Actions | null>(null);
const StackCtx = createContext<number>(0);   // 栈深，供返回按钮判断 disabled
```

**必须拆成两个 Context**，原因：切 kind/anchor 会重渲整棵树，而键盘页的 `ResizeObserver` + RAF 合并缩放逻辑对父级重渲染敏感（历史上抖过）。如果 actions 对象每次渲染都是新引用，所有 `useCallback`/`memo` 依赖它的地方都会失效，放大重渲染。

actions 对象必须 `useMemo(() => ({...}), [])` —— 依赖数组为空，因为里面只调 `dispatch`，而 `dispatch` 的引用 React 保证稳定。

```tsx
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
export function useContextActions(): Actions { /* 同上 */ }
export function useHistoryDepth(): number { return useContext(StackCtx); }
```

**不做持久化。** 刷新回到「今天」。不要往 localStorage 写。

#### 1.3.6 自测表（写完 C1 后手动核对，可以临时写个 `console.table` 跑一遍再删）

以 `now = 2026-08-18（周二）` 为例：

| 输入 | 期望输出 |
|---|---|
| `reanchor('day','2026-08-18','week')` | `'2026-08-17'`（周一） |
| `reanchor('day','2026-08-16','week')` | `'2026-08-10'`（8/16 是周日，归上一周） |
| `reanchor('day','2026-08-18','month')` | `'2026-08-01'` |
| `reanchor('month','2026-08-01','day')` | `'2026-08-18'`（含今天 → 今天） |
| `reanchor('month','2026-07-01','day')` | `'2026-07-01'`（不含今天 → 首日） |
| `reanchor('week','2026-08-17','day')` | `'2026-08-18'` |
| `toMs('month','2026-02-01')` | `end` = 3/1 00:00（不是 2/1+30 天） |
| `toMs('day','2026-08-18',{liveEnd:true})` | `end_ms` ≈ `Date.now()`，不是 8/19 00:00 |
| `toMs('day','2026-08-17',{liveEnd:true})` | `end_ms` = 8/18 00:00（不含 now，不收窄） |
| `parseAnchor('2026-08-03').getDate()` | `3`（若得到 2 或 3 但小时为 8，说明用了 `new Date(str)`） |

### 1.4 `src/main.tsx` 挂 Provider

```tsx
import { ContextProvider } from "./store/context";
// ...
ReactDOM.createRoot(...).render(
  <React.StrictMode>
    <ContextProvider>
      <App />
    </ContextProvider>
  </React.StrictMode>,
);
```

其余（平台标记、右键菜单、主题初始化）**一律不动**。

### 1.5 `src/App.tsx` 改造

#### 保留不动

`FADE_OUT_MS` / `FADE_IN_MS` 两个常量、`renderPage` switch、`Phase` 类型、`transitionEnabled` 的 localStorage 读取与 `page-transition-change` 事件监听、`clearTimers`、`layerClass` / `--page-fade-dur` 的计算、`.app-shell` / `.app-right` / `.app-main` / `.page-layer` 的 JSX 结构。

#### 改动

1. **删掉 `const [active, setActive] = useState<NavKey>("overview")`**，改为 `const { page } = useContextState()`。
2. `displayed` 的初值改成 `page`。
3. **`handleSelect` 拆成两半**：
   - 触发端：`Sidebar` 的 `onSelect` 与 `menu-navigate` 监听都改成调 `actions.navigate({ page: k })`。
   - 执行端：转场逻辑搬进一个 `useEffect`，依赖 `[page]`。
4. `handleSelectRef` **删除**。它当初存在是因为 `listen` 的回调需要拿到最新的 `handleSelect`；现在 `actions` 引用恒定，回调里直接调 `actions.navigate` 即可。
5. `<Sidebar active={active}>` 改成 `active={page}`。

转场 effect 的写法（这是从 `handleSelect` 逐行搬过来的，别自己重新发明）：

```tsx
const { page } = useContextState();
const actions = useContextActions();
const [displayed, setDisplayed] = useState<NavKey>(page);
const [phase, setPhase] = useState<Phase>("idle");

useEffect(() => {
  if (page === displayed) return;

  if (!transitionEnabled) {
    clearTimers();
    setDisplayed(page);
    setPhase("idle");
    return;
  }

  clearTimers();
  setPhase("leaving");                                   // 1) 淡出旧页
  timerRef.current = window.setTimeout(() => {
    setDisplayed(page);                                  // 2) 换页
    setPhase("entering-start");
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = window.requestAnimationFrame(() => {
        setPhase("entering");                            // 3) 双 rAF 后触发 transition
        timerRef.current = window.setTimeout(() => {
          setPhase("idle");
          timerRef.current = null;
        }, FADE_IN_MS);
      });
    });
  }, FADE_OUT_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [page]);
```

> **StrictMode 注意**：`main.tsx` 开了 `React.StrictMode`，开发模式下 effect 会双跑。上面的 `clearTimers()` 已经在开头兜住了重复计时器，但**必须实测**：快速连点侧栏几个页面，不能出现闪一下又回退、或者停在半透明状态。若出现，在 effect 里返回 `clearTimers` 作为 cleanup。
>
> **依赖数组只写 `[page]`**，不要把 `displayed` 加进去——加了会在 `setDisplayed` 后重跑 effect，转场逻辑跑两遍。

#### TopBar 的插入位置

```tsx
<div className="app-right">
  <TopBar />                    {/* 替代原来的 {isWindows && <TitleBar />} */}
  <main className="app-main">
    <div className={layerClass} style={style}>{renderPage(displayed)}</div>
  </main>
</div>
```

TopBar **所有平台都渲染**（不再有 `isWindows &&` 条件）。`const isWindows = ...`（App.tsx:13-14）移进 TopBar.tsx，App.tsx 里删掉。

#### TopBar 用 `page` 还是 `displayed`？

用 **`page`**（即 `active`）。转场总时长 440ms，顶栏立刻响应更跟手。粒度分段的划线状态会比页面内容早 440ms 更新，可接受。

---

## 2 · C2：TopBar 与布局修复

### 2.1 布局修复（先做，独立验证）

`src/styles/base.css:31-38` 现状：

```css
.app-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  ...
}
```

`.app-right` 是 `display:flex; flex-direction:column`，`.app-main` 作为它的 flex 子项，默认 `min-height: auto` —— 被内容撑开后 `overflow:auto` 永远不触发。**这是当前滚轮翻不了页的根因。** 加一行：

```css
.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;     /* ← 新增。flex 子项默认 min-height:auto，被内容撑开后 overflow 永不生效 */
  overflow: auto;
  ...
}
```

`.app-shell` 是 `flex-direction: row`，`.app-right` 已有 `min-width: 0`，`.sidebar` 是 `flex: 0 0 var(--sidebar-width)` 定宽——**横向没有同类问题，不用改**。项目里没有用 grid 做外层布局，原工单提到的 `minmax(0,1fr)` **本项目不适用，跳过**。

**这一步做完先单独验一次**：滚轮能翻页了吗？验完再往下。

### 2.2 删除 TitleBar

1. 删除文件 `src/components/TitleBar.tsx`。
2. `src/App.tsx` 删掉 `import TitleBar` 与 `{isWindows && <TitleBar />}`。
3. `src/styles/base.css`：
   - 删除 `:root { --titlebar-height: 0px }`（第 3-5 行）与 `body[data-platform="windows"] { --titlebar-height: 36px }`（第 7-9 行）。已确认全库只有 `.titlebar` 一处引用这个变量，删干净不留残引用。
   - 删除第 365-439 行整段 `/* ---------- Custom Title Bar (Windows) ---------- */`。
   - **但 `.titlebar-btn` 系列的视觉规则要搬到 `topbar.css`**（改名 `.topbar__winbtn`），不要直接扔掉——Windows 的三个窗口按钮在 TopBar 里活下来了，包括 `.titlebar-btn-close:hover` 那条用 `--intensity-4` 做红色的规则。

原 `TitleBar.tsx` 的窗口控制逻辑（`getCurrentWindow()` / `isMaximized` / `onResized` 订阅 / `minimize` / `toggleMaximize` / `close` / `Minus`·`Square`·`X`·`Copy` 四个 lucide 图标与它们的 `size`·`strokeWidth`）**原样搬进 TopBar**，不要改行为。

### 2.3 `src/components/TopBar.tsx`

#### 结构（从左到右）

```
[粒度分段 日|周|月] [← ] [anchor 标签] [ →] [今天] │ [应用筛选芯片 ▾] │ ←弹性空隙→ │ [返回] │ [窗口按钮(仅 Windows)]
```

#### 粒度分段

- 三个按钮，值 `day` / `week` / `month`，label 取 `KIND_LABEL`。
- 当前 `kind` 高亮。
- **不被当前页支持的档**（`!PAGE_KIND_CAP[page].includes(k)`）：`disabled` + `text-decoration: line-through` + `title="「时间线」页只支持日粒度"`。
- 点击 → `actions.setKind(k)`。

#### anchor 导航与标签

标签文案规则（`now` 每次渲染取一次即可，不用 tick）：

| kind | anchor 情形 | 显示 |
|---|---|---|
| day | = 今天 | `今天` |
| day | = 昨天 | `昨天` |
| day | 其他 | `8月3日`；跨年时 `2025年8月3日` |
| week | 含今天 | `本周` |
| week | 其他 | `8月11日 – 8月17日`（区间末日 = anchor+6 天） |
| month | 含今天 | `本月` |
| month | 其他 | `2026年8月` |

- `←` → `actions.stepAnchor(-1)`；`→` → `actions.stepAnchor(1)`。
- **`→` 在 anchor 已是"当前区间"时 disabled**（不能翻到未来），`title="没有未来的数据"`。判断方式：`normalizeAnchor(kind, formatAnchor(new Date())) === anchor`。
- 「今天」按钮 → `actions.goToday()`，anchor 已是当前区间时 disabled。

#### 应用筛选芯片

- 未筛选：`全部应用` + `ChevronDown` 图标，中性配色。
- 已筛选：高亮（`--color-accent-soft` 底 + `--color-accent` 字）+ `<AppIcon>` + App 名 + 一个 `✕`。点 `✕` → `actions.setApp(null)`，**不要连带弹出列表**（`e.stopPropagation()`）。
- 点芯片主体 → 弹出应用列表。

列表数据源：

```ts
import { fetchAppRankingInRange } from "../data/client";
import { toMs } from "../data/ranges";
// 弹层打开时拉一次，(kind, anchor) 变化时失效重拉
const rank = await fetchAppRankingInRange(toMs(kind, anchor));
```

**必须用 `get_app_ranking_in_range`。** 它已存在（现在只有 Dev 页在用），返回按 `total_sec` 降序的 `{app_bundle_id, app_name, bucket_count, total_sec}`，正好是要的形状。**不要**学 `Keyboard.tsx:136-141` 那样 `fetchBucketsInRange` 回来前端 `aggregateByApp().slice(0,8)`。

列表项：`<AppIcon bundleId>` + `app_name || app_bundle_id` + 右侧时长（`total_sec` 格式化，复用 `src/utils/format.ts` 里现成的函数，不要新写）。过滤掉 `app_bundle_id` 为空或 `"unknown"` 的项（沿用 Keyboard 现有做法）。列表顶部固定一项「全部应用」。

弹层要点：
- `z-index: 100`（顶栏自身是 10）。
- 点击外部关闭：`useEffect` 挂 `document.addEventListener("mousedown", ...)`，判断 `ref.current.contains(e.target)`。
- `Escape` 关闭。
- 列表可能很长 → `max-height: 320px; overflow-y: auto`，容器加 `.scroll-area` class 复用现成的滚动条样式。

#### 返回按钮

`useHistoryDepth() === 0` 时 `disabled`。点击 → `actions.back()`。图标 `ArrowLeft`（lucide）。

#### 窗口按钮

仅 `isWindows` 时渲染，逻辑与图标从 `TitleBar.tsx` 原样搬。

#### 拖拽区（**与原方案不同，仔细读**）

盘点结论：macOS 下右半边窗口**现在完全没有拖拽区**，拖拽全在侧栏（`base.css:188` `.sidebar{-webkit-app-region:drag}` + `Sidebar.tsx` 各层的 `data-tauri-drag-region`）。

所以：

- **顶栏是新增拖拽区，侧栏原有的一律保留不动。** 用户已经习惯拖侧栏，动它是纯损失。
- 顶栏根元素挂 `data-tauri-drag-region` + CSS `-webkit-app-region: drag`。
- 弹性空隙 `<div className="topbar__spacer" data-tauri-drag-region />` 是主要的可拖区域。
- **所有交互元素**（三个粒度按钮、两个箭头、今天、芯片、弹层、返回、三个窗口按钮）都要加 `data-tauri-drag-region="false"` **和** CSS `-webkit-app-region: no-drag`。两个都要，缺一个在某个平台上就点不动。
- macOS 红绿灯让位由 `.sidebar-header` 的 `padding-left: var(--traffic-light-inset)` 提供（`base.css:221-227`），顶栏只占 `.app-right` 不与红绿灯重叠，**这套机制不动**。

### 2.4 `src/styles/topbar.css`

新文件。在 `App.css` 或 `main.tsx` 现有的样式导入处引入（照现有 css 的引入方式来，不要另起一套）。

**照抄这些约束**（都是踩过坑的）：

```css
.topbar {
  flex: 0 0 46px;          /* 定高，不参与伸缩 */
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  flex-wrap: nowrap;       /* 绝不换行 */
  overflow: hidden;        /* 挤爆时裁掉而不是撑破布局 */
  position: relative;
  z-index: 10;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  -webkit-app-region: drag;
  user-select: none;
  -webkit-user-select: none;
}

.topbar > * { flex: none; }              /* 所有直接子元素不伸不缩 */
.topbar__spacer { flex: 1 1 auto; min-width: 0; }   /* 唯一的弹性项 */

.topbar__app-menu { z-index: 100; }      /* 应用列表弹层 */

/* 交互元素统一排除拖拽 */
.topbar button,
.topbar .topbar__chip,
.topbar__app-menu { -webkit-app-region: no-drag; }
```

窄窗口降级：

```css
@media (max-width: 940px) {
  /* 隐藏"范围"/"应用"这类文字标签，只留控件本体 */
  .topbar__label { display: none; }
}
@media (max-width: 820px) {
  .topbar { gap: var(--space-1); padding: 0 var(--space-2); }
  .topbar button { padding-left: var(--space-2); padding-right: var(--space-2); }
  .topbar__chip { max-width: 130px; }
}
```

#### 深色模式：只写 `[data-theme="dark"]`

`src/main.tsx:20-26` 在渲染前**恒会**给 `<html>` 设上 `data-theme="light"` 或 `"dark"`（跟随系统时也会解析成具体值）。

所以**新 CSS 一律只写 `[data-theme="dark"] .topbar__xxx { ... }`，不要写 `@media (prefers-color-scheme: dark)`**。后者在「系统深色 + 用户手动选浅色」时会错误命中。`base.css` 里那些 media query 是历史写法，它们后面都跟了 `[data-theme="light"]` 兜底覆盖——新代码不要复制这个模式。

#### 可用的设计 token

间距只有：`--space-1: 4px` / `--space-2: 8px` / `--space-3: 12px` / `--space-4: 16px` / `--space-6: 24px` / `--space-8: 32px`。**没有 `--space-5`、`--space-7`**，别写。

字号：`--text-xs: 12` / `--text-sm: 13`（body 默认）/ `--text-base: 14` / `--text-lg: 16` / `--text-xl: 20` / `--text-2xl: 28` / `--text-display: 36`。

其余颜色/圆角/阴影/缓动见 `src/styles/tokens.css`，**不要硬编码色值**。

### 2.5 顺手验一个未测过的 CSS 组合

`page-shell.css` 里 `.page-shell--fill`（第 47 行）和 `.page-shell--no-header`（第 42 行）**从未同时出现过**——只有 Timeline 用 `fill`、只有 Keyboard 用 `stickyHeader`。

Batch 3 会把日期导航搬到顶栏，Timeline 的 header 很可能被抽空 → 变成 `fill` 且无 header。

**本批临时把 `src/pages/Timeline.tsx:466-469` 的 `header` prop 去掉，跑一次看布局是否正常（body 应该 `flex:1; min-height:0` 且顶部有 `--space-6` 内距），然后改回来。** 结论写进 commit message。

别留到 Batch 3 才发现——那时候你分不清是 PageShell 的锅还是时间线重写的锅。

---

## 3 · C3：三个共享件 + DeltaBadge 重写

放在 `src/components/shared/`。这四个东西原本埋在 Batch 2，前移到这里是为了让后续 Batch 2 / 4 / 5 能并行而不互相覆盖。

### 3.1 `ContextChips.tsx`

渲染当前上下文的可清除标签，各页页头统一用它。

```tsx
interface ContextChipsProps {
  /** 要显示哪几类 chip，由页面决定 */
  show: Array<"app" | "focusHour" | "selectedKey">;
  /** 已筛选 App 的显示名（页面传，组件不自己查） */
  appName?: string;
}
```

- `app` → `应用 · ${appName} ✕`，叉 → `actions.setApp(null)`
- `focusHour` → `定位 · ${hour}:00 ✕`，叉 → `actions.setFocusHour(null)`
- `selectedKey` → `单键 · ${key} ✕`，叉 → `actions.setSelectedKey(null)`
- 对应字段为 null 时不渲染该 chip；全为空时组件返回 `null`（不要渲染空容器留出间距）

### 3.2 `Toast.tsx` + `useToast()`

全局单例，Provider 挂在 `ContextProvider` 内层（这样 toast 能调 `actions.back()`）。

```tsx
useToast().show({ message: "已筛选 Chrome，全站生效", undoLabel: "取消筛选" });
```

- 位置：右下角固定，`position: fixed`，`z-index: 200`（高于弹层的 100）。
- 自动消失：4 秒。鼠标悬停时暂停计时。
- 同时最多显示 1 条，新的顶掉旧的。
- 撤销按钮点击后立即关闭。

**撤销语义（全站统一，必须写死）：**

> **toast 的撤销 = `actions.back()`，整体回退到跳转前的完整状态。**

不是"只清掉某一个字段"。反例：概览点 Chrome 跳时间线，若撤销只清 appId，用户会停在「时间线 + 无筛选」——一个谁都没要求过的状态。分项清除是 `ContextChips` 上那个叉的职责，两者不重叠。

因此：**只有走了 `actions.navigate()` 的操作才配弹 toast**（因为只有它压了栈）。顶栏上改范围、改筛选不弹 toast。

### 3.3 悬停导轨 `drillable.css`

全站「可下钻」的统一视觉语言。一个 utility class，Batch 2 / 3 / 5 的所有可点行直接挂，**不许各自复制一份**。

```css
.drillable {
  position: relative;
}
.drillable::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2.5px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  transform: scaleY(0);
  transform-origin: center;
  transition: transform var(--dur-fast) var(--ease-smooth);
}
.drillable:hover::before,
.drillable:focus-visible::before {
  transform: scaleY(1);
}
@media (prefers-reduced-motion: reduce) {
  .drillable::before { transition: none; }
}
```

挂 `.drillable` 的元素必须是真 `<button>` 或带 `tabindex={0}` + `role="button"` + 键盘 Enter/Space 处理。`:focus-visible` 要有可见轮廓（Batch 6 会统一巡检，这里先做对）。

### 3.4 `DeltaBadge.tsx` —— **重写，不是新建**

#### 现状（已确认）

- 文件已存在：`src/components/DeltaBadge.tsx`，48 行。
- 当前签名 `{ delta: number | null }`，只接一个已经算好的百分比。
- **全库只有一个调用点**：`src/pages/Insights.tsx:377` 的 `<DeltaBadge delta={a.deltaPct} />`。
- 百分比在 `src/pages/Insights.tsx:92-98` 的 `calculateDelta(thisWeek, lastWeek)` 里算，**单位是小时**：
  ```ts
  function calculateDelta(thisWeek: number, lastWeek: number): number | null {
    if (lastWeek === 0) return null;                 // ← 没有基数阈值，这是 bug 根因
    const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
    if (Math.abs(pct) <= 5) return 0;                // ← 阈值 5%，新规范是 2.5%
    return pct;
  }
  ```
  「0.0h 显示 95%」就出在这里：`hours` 显示时被格式化成 `0.0`，但实际值是 0.04，上周 0.02，算出来 100%。

#### 新契约

```tsx
interface DeltaBadgeProps {
  /** 当期值，单位 **分钟** */
  current: number;
  /** 基期值，单位 **分钟** */
  previous: number;
  /** 'vs 上周' | 'vs 上月' | 'vs 昨天'，由调用方给 */
  vsLabel: string;
  /** 基数阈值，单位 **分钟**。日 20 / 周 120 / 月 600 */
  baseThreshold: number;
}
```

> ⚠️ **单位统一为分钟**。现有调用方传的是小时，迁移时必须 `* 60`。这是最容易出错的一步。

五种情况**互斥**，按顺序判断：

| # | 条件 | 渲染 |
|---|---|---|
| 1 | `current < baseThreshold && previous < baseThreshold` | 灰色 `—`，副文案 `基期不足 ${baseThreshold} 分钟` |
| 2 | `previous < baseThreshold && current >= baseThreshold` | `新` 标签 |
| 3 | `Math.abs((current - previous) / previous) < 0.025` | `持平` + vsLabel |
| 4 | `current > previous` | `↑ X.X%` + vsLabel |
| 5 | `current < previous` | `↓ X.X%` + vsLabel |

细节：
- 第 1 种**必须说出原因**，不能只给一个横杠。这是原方案点名要改的。
- 百分比保留一位小数（`X.X%`），不是取整。
- 保留现有的 `MAX_DELTA_PCT = 999` 封顶逻辑与 `title` 里的「已封顶显示」说明——那个是对的。
- `vsLabel` 挂在徽章可见文案里（不是只放 `title`），这样分母是谁一眼可见。
- 复用现有 class 名 `.ins-delta` / `.ins-delta--up|down|flat|new` 与 `src/styles/insights.css:218-260` 的样式；新增的「基期不足」态加 `.ins-delta--na`。**样式文件先留在 insights.css 不动**，Batch 5 再考虑要不要挪位置——本批不做样式搬家，减少爆炸面。

#### 迁移唯一调用点

`src/pages/Insights.tsx`：

1. 删除 `calculateDelta`（第 92-98 行）。
2. `WeekApp` 类型里的 `deltaPct: number | null` 换成 `currentMin: number; previousMin: number`。
3. 第 202-219 行的 map 里，不再算 pct，改为把两期的**分钟数**带出来。
4. 第 377 行改为：
   ```tsx
   <DeltaBadge
     current={a.currentMin}
     previous={a.previousMin}
     vsLabel="vs 上周"
     baseThreshold={120}
   />
   ```

**全站所有环比展示必须走这个组件，任何地方都不许再自己算百分比。** Batch 5 会在规律页大量使用它。

---

## 4 · C4：数据层收敛与文档

### 4.1 `src/data/useRangeData.ts`

单一数据入口。**本批只建立它并让它可用，不强制改造现有页面**（页面迁移是 Batch 2/3/4/5 各自的事）。

```ts
export function useRangeData(kind: RangeKind, anchor: string, appId: string | null, opts?: {...})
```

要点：

1. 内部 `toMs(kind, anchor)` → `fetchBucketsInRange` → 前端按 `appId` 过滤/聚合。
2. **为什么以 buckets 为主源**：`get_hourly_activity` 与 `get_app_ranking_in_range` 都不接 app 参数，一旦有 appId 就用不了。而 `get_buckets_in_range` 返回的每个桶都带 `app_bundle_id`，前端过滤是准确的。统一走它，避免各页对 appId 的支持度不一致。
3. 加一个 `key = ${kind}|${anchor}|${appId ?? "*"}` 的内存 Map 缓存，**上限 12 条，超出丢最早的**。
   - 为什么要缓存：`App.tsx:21-38` 的 `renderPage` switch 让切页时整棵子树卸载重挂，所有 `useState` 回初值。全局 range 提上去后，来回切页会反复重查同一份数据，体感会比重构前慢。
   - 缓存是**进程内**的，不落盘。数据写入是持续的，所以缓存要能被主动作废：暴露一个 `invalidate()`，Overview 的 30 秒轮询、Settings 的清空数据都要调它。
4. 返回 `{ buckets, loading, error, refetch }`。

### 4.2 更新 `CLAUDE.md`

现有表述：

> 它是「视口顶 → 首个可见内容 = `var(--space-6)`」的唯一真源。

加上顶栏之后不再是「视口顶」。改为：

> 它是「**顶栏底沿** → 首个可见内容 = `var(--space-6)`」的唯一真源。

同时在「不要动」列表里补一条：`src/styles/topbar.css` 的 `.topbar` 定高/不换行/z-index 三条约束。

---

## 5 · 明确不做（做了就是超范围）

- **不改任何页面的数据渲染。** Overview 仍然硬编码 `todayRange()`，Keyboard 仍然有自己的日/周切换和 App 筛选，Timeline 仍然有 `TimelineHeader` 的日期导航，Insights 仍然有 `WeekSelector`。这些在 Batch 2/3/4/5 各自删。
- **不删 `Keyboard.tsx:144` 的 `setAppFilter("all")`。** 那行留给 Batch 4。
- **不改 `NavKey` 的取值。** `keyboard` → `input`、`insights` → `patterns` 的改名在 Batch 4 / 5 做。
- **不动侧栏的任何拖拽区。**
- **不动** `analytics/` 下的任何文件。
- **不动** `keyboard/` 与 `timeline/` 下的任何组件与样式。
- **不加持久化。**
- 不引入任何新依赖（状态管理库、动画库、日期库一律不要）。lucide-react 已有，可以用。

---

## 6 · 完工检查表

代码层：

- [ ] `npx tsc --noEmit` 无新增错误
- [ ] `cargo check`（本批没动 Rust，跑一下确认没误伤）
- [ ] 全库 grep `TitleBar`、`titlebar-height` 零残留
- [ ] 全库 grep `calculateDelta` 零残留
- [ ] 全库 grep `new Date("` 与 `toISOString()` —— 确认没有在 anchor 相关代码里出现
- [ ] 1.3.6 的自测表 10 项全对

功能层（跑起来点）：

- [ ] **滚轮能翻页了**（`min-height:0` 的验收点，在 Overview / Settings 这种长页上试）
- [ ] 四个页面显示内容与改动前完全一致
- [ ] 顶栏出现在右侧主区上方，高 46px，不换行
- [ ] 切到时间线，粒度分段的「周」「月」变灰 + 划线，hover 有 title 说明
- [ ] 切到洞察，「日」变灰 + 划线
- [ ] anchor `←`/`→` 能翻，`→` 在当前区间时 disabled
- [ ] 「今天」按钮在非当前区间时可点，点了回到今天
- [ ] 切 `日→周→月`，anchor 标签正确（周显示区间、月显示年月）
- [ ] 应用芯片弹层能打开，列表按时长降序，点外部/Esc 关闭
- [ ] 选一个 App，芯片高亮显示图标+名字；点 ✕ 清除且不触发弹层
- [ ] 侧栏切页仍有淡入淡出转场；快速连点多个页面不出现闪烁或卡在半透明
- [ ] 关掉设置里的页面转场开关，切页无动画且不报错
- [ ] 侧栏切页后返回按钮可点，点了回到上一页
- [ ] 返回按钮在初始状态 disabled

平台层：

- [ ] macOS：拖侧栏能移动窗口（原有行为不变）
- [ ] macOS：拖顶栏空白处能移动窗口（新增行为）
- [ ] macOS：红绿灯位置与之前一致，未被顶栏影响
- [ ] Windows：只有**一层**顶栏（不是 36+46 两层）
- [ ] Windows：最小化 / 最大化 / 还原 / 关闭四个行为正常，最大化图标会在 `Square` 与 `Copy` 之间切换
- [ ] Windows：关闭按钮 hover 是红底白字

主题与响应式：

- [ ] 浅色 / 深色各扫一遍，顶栏所有元素都有正确配色
- [ ] 设置里手动切「浅色」但系统是深色时，顶栏**不能**变深色（这条专门验 `[data-theme]` 有没有写对）
- [ ] 窗口拖到 940px 以下：文字标签消失，控件不换行不溢出
- [ ] 窗口拖到 820px 以下：间距收紧，芯片截断，仍不换行

附带结论：

- [ ] 2.5 的 `fill` + `--no-header` 试验结果已写进 commit message

---

## 7 · 完工后停下

本批结束后**不要自动进入 Batch 2**。把完工检查表的勾选结果和 2.5 的试验结论报上来，等人工验证通过。
