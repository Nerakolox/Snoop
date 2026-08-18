# Batch 5 · 规律页（原洞察页）

> 执行前先读 `docs/v2-工单-修订版.md` 的「全局约束」与「三条跨批语义」两节，
> 以及 `docs/v2-交接-改造路程.md` 的第四节「写死的规则」。
> 开工前：`git commit -m "chore: Batch 5 开工前存档"`

---

## 0 · 先读：本批的五条前置决策

### 0.1 样式不在本批范围内

用户已明确「样式整体重构留到最后」。本批新增/重排的一切元素**做到结构正确、数据正确、可交互即可，不打磨视觉**。

具体说：可以往 `src/styles/insights.css` 追加最朴素的布局规则（`display:grid` / `gap` / 字号），**不要**重排它已有的规则、不要调色、不要做动效。看起来朴素是预期结果，不是缺陷。

### 0.2 CSS 文件名和 `.ins-*` 类名前缀**一律不改**

这是本批最容易踩的坑：

`src/components/DeltaBadge.tsx` 渲染的是 `.ins-delta` / `.ins-delta--up` / `.ins-delta-num` 等类，而这些类的样式**定义在 `src/styles/insights.css` 里**（`.ins-delta*` 共 7 条）。

而 `DeltaBadge` **不只这一页在用**——`src/pages/Overview.tsx:473` 的 App 排行每行都挂着它。

所以：

- **不要**把 `src/styles/insights.css` 改名成 `patterns.css`
- **不要**把 `.ins-*` 前缀批量替换成 `.pat-*`
- **不要**动 `App.css:10` 的 `@import "./styles/insights.css"`

一旦改了，概览页的环比徽章会集体掉样式，而你在规律页上看不出来。类名清理是样式重构那一批的事。

同理，`src/pages/Insights.tsx` 与 `src/components/insights/` 目录**保持现在的文件名**（与 Batch 4 保留 `Keyboard.tsx` 文件名是同一个理由：改文件名会让 git 把整个文件当新增，diff 不可读）。本批只改 `NavKey` 这个**取值**，不改文件路径。

### 0.3 「周期总结卡」这一批要做**两件事**，不是一件

工单里这条被拆在两处，读起来会以为已经做过了。事实是：

| 出处 | 原文 | 实际状态 |
|---|---|---|
| 工单 Batch 2「仍然生效的原始要点」#4 | 周期总结卡从 Insights 迁入（概览） | ❌ 没做 |
| 工单 Batch 2「盘点后调整」#3 | 周期总结卡挪到 Batch 5 | 就是这一批 |
| 工单 Batch 5 #5 | 周报卡本页删除（Batch 2 已迁往概览） | 前提不成立 |

所以本批 **C4 要同时做**：

1. 在 `src/pages/Overview.tsx` **新建**「周期总结卡」（日/周/月都出文案）
2. 在 `src/pages/Insights.tsx` **删除**「猫的周报」那一整块（`:285-306` 的 `.ins-report`）

不要只做其中一件。只删不建 = 功能净损失；只建不删 = 两页各有一段猫说的话，且口径不同。

### 0.4 作息画像在「月」粒度下**不能复用现有的 `aggregateWeekHourGrid`**

`src/analytics/aggregate.ts:188` 的 `aggregateWeekHourGrid` 第三个参数是 `weekStartMs`，它推导每格对应时刻的算法是：

```ts
const cellHourStartMs = weekStartMs + ri * 24 * HOUR_MS + ci * HOUR_MS;   // :246-248
```

这个式子只在「范围恰好是一周」时成立。规律页支持 `week` + `month` 两个粒度，月粒度下同一个 (星期几, 小时) 格子对应 4~5 个不同日期，上式算出来的时刻**是错的**，会让「挂机 / 未采集」两态大面积误判。

本批要新增一个 `aggregateDowHourGrid`（见 §3.1），**并保留 `aggregateWeekHourGrid` 不动**——`src/pages/Dev.tsx:105` 还在用它。

### 0.5 本批的四个 commit

| # | 内容 |
|---|---|
| C1 | 改名 `insights` → `patterns` + 接入全局上下文 + 删 `WeekSelector` |
| C2 | 环比口径收敛（抽 `computeDelta`）+ 顶部两张卡 + App 排行重排 |
| C3 | 作息画像（新增 `aggregateDowHourGrid`）+ 猫发现的规律 4 张卡 |
| C4 | 周期总结卡进概览 + 删除本页猫周报 |

每个 commit 结束后跑一次 `npx tsc --noEmit`。

---

## 1 · C1：改名 + 接入全局上下文

### 1.1 `NavKey` 取值 `insights` → `patterns`

`NavKey` 是字符串联合类型，**五个文件六处**要一起改。漏一处 TS 报错（好），或者运行时页面变空白（坏）。

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/components/Sidebar.tsx` | `:4` | 联合类型里 `"insights"` → `"patterns"` |
| `src/components/Sidebar.tsx` | `:12` | `MAIN_ITEMS` 的 key 改 `"patterns"`，label 「洞察」→「规律」 |
| `src/App.tsx` | `:27` | `renderPage` 的 `case "insights"` → `case "patterns"` |
| `src/store/context.tsx` | `:33` | `PAGE_KIND_CAP` 的 key `insights` → `patterns` |
| `src/store/context.tsx` | `:26-27` | 那条 ⚠️ 注释说的就是这次改名，**改完把注释删掉** |
| `src/components/TopBar.tsx` | `:27` | `PAGE_LABEL` 的 key 与 label 一起改成 `patterns: "规律"` |

`PAGE_KIND_CAP.patterns` 的值**保持 `["week", "month"]` 不变**——本来就是对的，只是 key 换了。

侧栏图标沿用 `Lightbulb`（lucide）。换图标是视觉决定，样式重构时再说。

**不改**：`src/pages/Insights.tsx` 文件名、组件函数名 `Insights`、`src/components/insights/` 目录名、`src/styles/insights.css`（理由见 §0.2）。

改完执行这条自查，应该**零结果**：

```bash
grep -rn '"insights"' src/
```

（`src/styles/insights.css` 的文件名、`App.css` 的 `@import`、`Insights.tsx:258` 的 `console.error` 字符串不在这条 grep 的命中范围内，属正常。）

### 1.2 接全局上下文

照 `src/pages/Overview.tsx:167-190` 的写法抄，那是本项目已验证过的范式：

```tsx
const { kind, anchor, appId } = useContextState();
const actions = useContextActions();
const toast = useToast();

const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("patterns", { kind, anchor });

// 全量（未按 app 过滤）——App 排行、作息画像、猫的规律都要看全站数据
const { buckets: allBuckets, loading } = useRangeData(viewKind, viewAnchor, null);
// 按当前筛选过滤——顶部两张卡的数字用它
const buckets = useMemo(
  () => (appId === null ? allBuckets : allBuckets.filter((b) => b.app_bundle_id === appId)),
  [allBuckets, appId]
);

// 基期，供所有 DeltaBadge 环比用
const prevAnchor = shiftAnchor(viewKind, viewAnchor, -1);
const { buckets: prevAllBuckets } = useRangeData(viewKind, prevAnchor, null);

const vsLabel = viewKind === "week" ? "vs 上周" : "vs 上月";
const baseThreshold = viewKind === "week" ? 120 : 600;
```

注意几点：

- **`viewKind` 只可能是 `week` 或 `month`**（`PAGE_KIND_CAP` 卡死了）。所以 `vsLabel` / `baseThreshold` 只有两个分支，不要写 `day` 分支——写了也永远走不到，是死代码。
- `adaptKind` 的返回值**只读不写**。绝对不要 `useEffect(() => actions.setKind(viewKind))`。这是工单「三条跨批语义」第 1 条，违反了会让用户在概览选的「日」被这一页吃掉。
- 用户在顶栏点「日」时，`kind` 会真的变成 `day`，`adaptKind` 把它投影成 `week` 并返回非空 `note`。这是**预期行为**，`note` 要渲染出来（见 §1.4）。

### 1.3 删除页内周选择器

**删文件**：`src/components/insights/WeekSelector.tsx`

> 它现在复用的是 `.kb-filter-row` / `.kb-date-picker` / `.kb-nav-btn` 这套键盘页的类。删掉组件即可，**不要顺手去 `keyboard.css` 里删这些类**——输入页还在用。

**`src/pages/Insights.tsx` 里跟着删**：

- `:11` `import WeekSelector`
- `:30` `import { startOfWeek, isSameWeek, formatWeekLabel } from "../utils/date"`
- `:119` `const today = useMemo(() => new Date(), [])`
- `:120` `selectedWeekStart` state
- `:135-138` `isCurrentWeek`
- `:140-143` `weekLabel`
- `:145-153` `goPrevWeek` / `goNextWeek`
- `:266` useEffect 依赖里的 `selectedWeekStart, isCurrentWeek`
- `:277-282` header 里的 `<WeekSelector>`

这四个能力（上一周 / 下一周 / 当前周判断 / 周标签）**全部已被顶栏吸收**，且顶栏还多给了一个「今天」按钮——`TopBar.tsx:151-159`，`WeekSelector` 现在缺这个。改完是功能净增。

**`src/utils/date.ts` 的清理**：删完之后 `formatWeekLabel` 和 `isSameWeek` 可能变成无人调用。先 grep 确认：

```bash
grep -rn "formatWeekLabel\|isSameWeek\|formatPeriodLabel" src/
```

零消费者才删；有消费者就留着。**`startOfWeek` / `startOfDay` / `isSameDay` 一律保留**（`isSameWeek` 内部依赖 `startOfWeek`，且它们可能被别处用）。TS 不会对未被引用的 `export` 报错，所以留着不会挡编译——拿不准就留着，不要为了「干净」删出编译错误。

### 1.4 页头

现在 header 里放的是 `<WeekSelector>`，换成标题块。照 `Overview.tsx:136-165` 的 `OverviewHeader` 抄结构：

```tsx
<div className="ins-header">
  <div className="ins-header-titlerow">
    <h1 className="ins-header-title">规律</h1>
    {note !== null && <span className="ins-header-note">{note}</span>}
  </div>
  <p className="ins-header-subtitle">
    {anchorLabel(viewKind, viewAnchor, now)} · {daysWithData} 天数据
    {appId ? ` · 已筛选 ${appName ?? appId}` : ""}
  </p>
  <ContextChips show={["app"]} appName={appName} />
</div>
```

- `anchorLabel` 从 `src/utils/format.ts` 导入，已支持 week / month。
- `daysWithData` = 有采集数据的天数，照 `Overview.tsx:114-121` 的 `daysWithDataOf` 抄一份（或提到 `src/analytics/aggregate.ts` 共用，二选一，别两处各写一份逻辑不同的）。
- `appName` 从 `allBuckets` 里找：`allBuckets.find(b => b.app_bundle_id === appId)?.app_name ?? appId`。**用 `allBuckets` 不要用 `buckets`**——概览那边用 `buckets` 是个已记录的小瑕疵（交接文档 §5.2 第 6 条），别把它复制过来。
- `PageShell` 的 `header` 属性照原样传，**页面根 class 绝不写 padding**（`CLAUDE.md` 的约定）。
- `.ins-header*` 这几个类是新增的，往 `insights.css` 末尾追加最朴素的规则即可。

---

## 2 · C2：环比口径收敛 + 顶部两张卡 + App 排行

### 2.1 抽出 `computeDelta`（这是挂账 #1 的正解）

**现状问题**（交接文档 §5.2 第 1 条）：`Insights.tsx:241-253` 有一段内联的环比计算：

```ts
const weekChange = topApp && topApp.hours > 0
  ? (() => {
      const lastWeekSameApp = lastWeekAppStats.find(...);
      const lastWeekHours = lastWeekSameApp ? lastWeekSameApp.duration_ms / (60*60*1000) : 0;
      if (lastWeekHours === 0) return null;                      // ← 没有基数阈值
      const pct = Math.round(((topApp.hours - lastWeekHours) / lastWeekHours) * 100);
      return Math.abs(pct) <= 5 ? 0 : pct;                       // ← ±5% 视为持平，与 DeltaBadge 的 2.5% 不一致
    })()
  : null;
```

它没有基数阈值，所以「基期 0.0h → 显示 95%」那类离谱百分比在文案里仍然存在。同一个页面上，徽章说「新」、文案说「+95%」，两套口径。

**做法**：把 `DeltaBadge` 的判定逻辑抽成纯函数，徽章和文案共用一个真源。

新建 `src/analytics/delta.ts`：

```ts
/**
 * 环比判定的单一真源。DeltaBadge 渲染它，文案生成也读它，
 * 避免「徽章说新增、文案说 +95%」这类同页自相矛盾。
 * 单位一律是**分钟**，与 DeltaBadge 的既有契约一致。
 */

/** 环比百分比封顶：超过此值一律显示 "999%+"，避免分母极小时把布局撑破 */
export const MAX_DELTA_PCT = 999;
/** 变化幅度在此比例以内视为持平 */
export const FLAT_RATIO = 0.025;

export type DeltaVerdict =
  | { kind: "na" }                                        // 当期基期都不足基数，无从比较
  | { kind: "new" }                                       // 基期不足、当期够 → 视为新增
  | { kind: "flat" }
  | { kind: "up"; pct: number; capped: boolean }
  | { kind: "down"; pct: number; capped: boolean };

export function computeDelta(
  current: number,
  previous: number,
  baseThreshold: number
): DeltaVerdict {
  if (current < baseThreshold && previous < baseThreshold) return { kind: "na" };
  if (previous < baseThreshold) return { kind: "new" };

  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < FLAT_RATIO) return { kind: "flat" };

  const pct = Math.abs(ratio) * 100;
  const capped = pct > MAX_DELTA_PCT;
  return current > previous
    ? { kind: "up", pct, capped }
    : { kind: "down", pct, capped };
}
```

然后：

1. `src/analytics/index.ts` 加一行 `export * from "./delta";`
2. `src/components/DeltaBadge.tsx` 改成**只负责渲染**：调 `computeDelta`，按 `verdict.kind` 五个分支渲染。删掉文件顶部的 `MAX_DELTA_PCT` / `FLAT_RATIO` 常量（已移入 `delta.ts`）。
3. `Insights.tsx` 的内联 `weekChange` 整段删除，文案改读 `computeDelta`。

> ⚠️ **`DeltaBadge` 的渲染结果必须与改造前逐字节一致**——类名、图标、文案、`title` 属性全部不变。它在概览页 App 排行上有 6 行实例，改坏了你在规律页上看不出来。这是**纯重构**：把 `:20-71` 的判断顺序原样搬进 `computeDelta`，渲染部分只是把 `if` 条件换成 `verdict.kind ===`。改完自己对着原文件逐分支比一遍。

### 2.2 顶部两张并排卡

放在页面最上方，一行两张（`.ins-top-cards`，`display:grid; grid-template-columns: 1fr 1fr; gap: var(--space-4)`）。

**卡 A · 活跃对比**

- 大数字：当前范围活跃时长。**必须用 `unionDurationMs(buckets)`**（`src/analytics/aggregate.ts:16`），不要逐桶裸加 `duration_ms`。理由：并集口径是「总时长的权威口径」，裸加与 `aggregateByApp` 不一致，会导致「App 排行各行之和 ≠ 活跃时长」。
- `<DeltaBadge current={当期分钟} previous={基期分钟} vsLabel={vsLabel} baseThreshold={baseThreshold} />`
  - 当期分钟 = `Math.round(unionDurationMs(buckets) / 60_000)`
  - 基期分钟 = `Math.round(unionDurationMs(prevBuckets) / 60_000)`，`prevBuckets` 是 `prevAllBuckets` 按同一个 `appId` 过滤后的结果——**基期也要过滤**，否则筛了 App 之后当期是单 App、基期是全站，环比毫无意义。
- 副文案：`日均 ${日均时长} · 分母 ${daysWithData} 天`。**分母是有采集数据的天数，不是自然天数**（工单 Batch 2 §5 明确写死）。`daysWithData === 0` 时日均写 `—`，不要除零。

**卡 B · 键鼠比**

- 大数字 `ratio.toFixed(2)` + 判定标签 + 近 14 天迷你柱状趋势。
- **不要重新实现对数映射。** `src/components/keyboard/RatioPanel.tsx:19-22` 已有 `ratioToSliderPos`，Batch 4 的完工检查表里有一条「`Math.log10` 只出现在键鼠比一处」，要维持这个不变量。

  做法：把 `ratioToSliderPos` 和判定标签阈值一起提到 `src/analytics/keys.ts`（末尾追加），两边都 import：

  ```ts
  /**
   * 键鼠比 → 滑块位置 [0,1]。
   * 比值在不同 App 间跨度约 60 倍（终端类 ~0.03，播放器类 ~1.7），线性映射会把
   * 大半应用挤在最左端，必须走对数。ratio <= 0 时 log10 是 -Infinity，
   * 先行短路成 0，避免 NaN% 渗进 style。
   */
  export function ratioToSliderPos(ratio: number): number {
    if (ratio <= 0) return 0;
    return Math.min(1, Math.max(0, (Math.log10(ratio) + 1.6) / 2.2));
  }

  /** 键鼠比判定标签。阈值与 Batch 4 一致，改这里两页同时生效。 */
  export function ratioVerdict(ratio: number): "鼠标型" | "键盘型" | "均衡型" {
    return ratio > 0.25 ? "鼠标型" : ratio < 0.08 ? "键盘型" : "均衡型";
  }
  ```

  然后 `RatioPanel.tsx` 删掉自己那份 `ratioToSliderPos` 和 `:46` 的三元判定，改成 import。**`RatioPanel` 的渲染输出不变**，纯提取。

- **近 14 天迷你柱状趋势**：这是唯一一处需要**跳出当前范围**取数的地方（当前范围可能是某个历史月，但「近 14 天」永远是相对今天的）。

  所以它**不能走 `useRangeData`**（那个的入参是 `(kind, anchor)` 语义，表达不了「今天往前 14 天」）。直接调 `fetchBucketsInRange`：

  ```ts
  const [trend14, setTrend14] = useState<Array<{ dayMs: number; ratio: number }>>([]);

  useEffect(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);              // 明天 0 点，闭右开
    const start = new Date(end);
    start.setDate(start.getDate() - 14);         // ⚠️ 用 setDate，不要 end - 14*DAY_MS
    let cancelled = false;
    fetchBucketsInRange({ start_ms: start.getTime(), end_ms: end.getTime() })
      .then((raw) => {
        if (cancelled) return;
        const src = appId === null ? raw : raw.filter((b) => b.app_bundle_id === appId);
        // 按本地日分组求 ratio，空天 ratio = 0
        setTrend14(/* … */);
      })
      .catch((e) => console.error("近 14 天键鼠比趋势获取失败:", e));
    return () => { cancelled = true; };
  }, [appId]);
  ```

  依赖数组只放 `appId`——它与 `viewKind` / `viewAnchor` **无关**，跟着范围重拉是错的。

  分组可以直接用 `statsByDayFromBuckets`（`aggregate.ts:153`）拿到补齐空天的日列表，再自己按天算 ratio；或者自己 `Map` 分组。两者都行，别把 `statsByDayFromBuckets` 改签名。

- **除零**：`keys === 0` 时不要算 ratio。整张卡显示「无按键数据」，滑块置灰不定位，趋势柱全空。

### 2.3 App 排行 · 环比

现有 `:344-380` 那块基本可用，改三处：

1. **数据源换成 `aggregateByApp(allBuckets)`**（现在是 `thisWeekAppStats`，来自页内自己 fetch 的 buckets）。基期同理换成 `aggregateByApp(prevAllBuckets)`。照 `Overview.tsx:182-188` 建一个 `prevMinutesByApp` 的 `Map`，比每行 `.find()` 干净。
2. **每行挂 `.drillable` 并可点** → `actions.navigate({ page: "overview", appId })` + toast。
   - 行元素必须是真 `<button type="button">`（现在是 `<div className="ins-app-row">`）。工单 Batch 6 §3 的一致性巡检会查这条，现在改比later 改便宜。
   - toast：`toast.show({ message: \`已筛选 ${name}，全站生效\`, undoLabel: "取消筛选" })`。撤销 = `actions.back()` **整体回退**，不是只清 appId——这是工单「三条跨批语义」第 2 条。`Toast` 组件内部已经这么实现了，你只要给 `undoLabel` 就行，不要自己写撤销回调。
3. **已有筛选时非选中行 `opacity: 0.34`（不隐藏）**，照 `Overview.tsx:451` 的 `dim` 写法：`const dim = appId !== null && appId !== a.bundleId`。

`DeltaBadge` 的四个 props 照现有 `:370-375` 原样保留，`vsLabel` / `baseThreshold` 换成 §1.2 里按 `viewKind` 派生的那两个变量（现在是硬编码的 `"vs 上周"` / `120`，月粒度下是错的）。

### 2.4 「本周活跃趋势」柱状图怎么办

现有 `:311-341` 的 `.ins-trend-panel` 是写死 7 天的（`buildWeekDays` + `DAY_LABELS`）。

月粒度下 7 根柱子表达不了 30 天。**做法**：改用 `statsByDayFromBuckets(buckets, range.start_ms, range.end_ms)`，柱子数量由范围决定（周=7 根，月=28~31 根），横轴标签周粒度显示「一二三四五六日」、月粒度显示日期数字（每 5 天标一个，避免挤成一坨）。

- `buildWeekDays`（`:93-114`）随之删除。
- 柱子颜色继续用 `bucketSimple(值, 最大值)` + `intensityVar(level)`，**不要自己写线性归一化**（工单全局约束：`src/analytics/intensity.ts` 是强度单一真相）。
- 柱子可点 → `actions.navigate({ kind: "day", anchor: 该天 })` + toast，照 `Overview.tsx:349-353` 的 `goToDay` 抄。anchor 用 `formatAnchor(new Date(dayMs))`，**不要 `toISOString().slice(0,10)`**（那是 UTC，东八区会漂一天）。

---

## 3 · C3：作息画像 + 猫发现的规律

### 3.1 新增 `aggregateDowHourGrid`

在 `src/analytics/aggregate.ts` 末尾追加。**不要改 `aggregateWeekHourGrid`**（`Dev.tsx:105` 在用）。

```ts
export type DowHourCell = {
  intensity: Intensity;
  state: "active" | "idle" | "no_data";
  /** 该格在本范围内覆盖了几天（周粒度恒为 1，月粒度 4~5） */
  sampleDays: number;
};

/**
 * 星期 × 小时的三态网格，适用于**任意长度**的范围。行 0=周一 … 6=周日。
 *
 * 与 aggregateWeekHourGrid 的区别：那个把「格子 → 时刻」的映射写死成
 * weekStartMs + ri*24h + ci*1h，只在范围恰好是一周时成立。月粒度下同一格
 * 对应 4~5 个不同日期，那个式子算出来的时刻是错的，会让挂机/未采集大面积误判。
 * 这里改为遍历范围内每一个本地整点，逐格累计。
 */
export function aggregateDowHourGrid(
  hourBuckets: RawHourBucket[],
  heartbeats: Map<number, boolean>,
  startMs: number,
  endMs: number
): DowHourCell[][] {
  // 1) 活动累计：hour_start 已是「本地整点对应的 UTC ms」，getDay()/getHours() 直出本地值
  // 2) 心跳与样本天数：从 startMs 所在日 0 点起，按天推进游标，
  //    每天内 h=0..23 用 new Date(y, m, d, h).getTime() 生成整点时刻，
  //    落在 [startMs, endMs) 内才计入
  // 3) 定态：有活动 → active；否则有心跳 → idle；否则 → no_data
}
```

实现时的三个硬性要求：

- 游标推进**必须**用 `cur.setDate(cur.getDate() + 1)`，**不要** `t += DAY_MS`。后者在有夏令时的地区会漂（中国无 DST 所以现在看不出来，但 `aggregate.ts:171` 那处 `t += DAY_MS` 已经是一笔记录在案的技术债，见交接文档 §5.2 第 9 条，别再添一笔）。
- 生成整点时刻**必须**用 `new Date(y, m, d, h).getTime()`，不要 `dayStart + h * HOUR_MS`。理由同上。
- 行索引用文件里已有的 `mondayIndex()`（`:383`），不要重写一个。它是 `function` 声明不是 `export`，同文件内直接调即可。

### 3.2 作息画像改造

现有 `:384-471` 的 `.ins-rhythm-panel` 结构（7 行 × 24 列 grid + 刻度 + 图例）**保留**，只改数据源和交互：

1. 数据源换成 `aggregateDowHourGrid(hourly, heartbeatMap, range.start_ms, range.end_ms)`。

   `hourly` / `heartbeatMap` 仍走 `fetchHourlyActivity` / `fetchHourlyHeartbeats`——这两个接口**不接 app 参数**，所以：

2. **标题右侧标注「不受应用筛选影响」**，且只在 `appId !== null` 时显示。这是工单 Batch 5 §4 明确要求的。理由要写进 tooltip：此视图基于 `get_hourly_heartbeats`，与前台 App 无关。

3. **活跃格可点**，跳转到时间线：

   ```ts
   actions.navigate({ page: "timeline", kind: "day", anchor: 目标日期, focusHour: ci });
   ```

   ⚠️ **目标日期怎么定**：格子是 (星期几, 小时)，月粒度下对应 4~5 个日期，必须挑一个。规则定为「**当前范围内、该星期几的最后一天，且不晚于今天**」。写一个纯函数：

   ```ts
   /** 范围内该 dow(0=周一) 的最后一天，不晚于今天；没有则返回 null。 */
   function lastDateOfDow(dowIndex: number, startMs: number, endMs: number, now: Date): string | null
   ```

   从范围末尾往前逐日回溯，命中即返回 `formatAnchor(d)`。返回 `null` 时该格不可点。

   > 为什么一次 `navigate` 里同时给 `page` / `kind` / `anchor` / `focusHour` 四个字段：工单 Batch 2 §6 写死了「一次 navigate 同时改多个字段，不要拆成两步」——拆了会压出一个中间态，`back()` 要按两次才回得来。
   >
   > 注意 `NAVIGATE` reducer（`context.tsx:171-179`）在 `patch.kind` 存在且 `patch.anchor` 缺席时会自己 `reanchor`。这里我们**同时给了 anchor**，所以走的是「原样采纳」的分支，不会被覆盖。这是对的。

4. **挂机格与未采集格不可点**（工单原文）。渲染成 `<div>` 而不是 `<button>`，或者 `<button disabled>`——二选一，别给个能 focus 却没反应的元素。

5. 跳转后弹 toast，`undoLabel: "返回"`。

6. tooltip 补 `sampleDays`：月粒度下写成 `周三 14:00 · 强度 3 · 合并 4 天`，让用户知道这一格不是单日数据。

### 3.3 「猫发现的规律」4 张卡

新增一块。每张卡 = **标题 + 依据 + 跳转动作**，跳转目标必须是**能验证这条结论**的页面与状态（工单原文）。

四条规律用现成数据就能算，不要为它们加接口：

| # | 标题 | 依据（算法） | 跳转 |
|---|---|---|---|
| 1 | 你的高产时段 | `aggregateDowHourGrid` 里 `state==="active"` 且 intensity 最高的格 | `{ page:"timeline", kind:"day", anchor: lastDateOfDow(...), focusHour: 该小时 }` |
| 2 | 你几乎住在这里 | `aggregateByApp(allBuckets)[0]`，算它占总时长的百分比 | `{ page:"overview", appId: 该 bundleId }` |
| 3 | 键鼠画像 | §2.2 的 ratio + `ratioVerdict(ratio)` | `{ page:"input" }` |
| 4 | 夜猫子指数 | 22:00–次日 02:00 的活跃时长占比 | `{ page:"timeline", kind:"day", anchor: 范围内最后一个有数据的日期, focusHour: 23 }` |

硬性要求：

- **每条都要有数据不足时的降级**。比如排行为空、`daysWithData < 3`、ratio 无法计算。降级方式：**这张卡不渲染**，而不是渲染一张写着 `NaN%` 或「住得最久的是 undefined」的卡。四张全不满足时，整块显示一句空态文案。
- 文案里的百分比一律 `toFixed(0)` 或 `toFixed(1)`，不要出现 17 位小数。
- 每张卡挂 `.drillable`，是真 `<button>`，跳转后弹 toast。
- 猫的口吻沿用 `src/analytics/constants.ts` 里 `CAT_QUIPS` 的风格（「喵～」结尾、略带吐槽），但**这四张卡的文案是模板拼接，不要走 `pickCatQuip`**——那个是随机抽句子的，用在这里会导致同一份数据每次渲染说法不同，用户会以为数据在变。

---

## 4 · C4：周期总结卡进概览 + 删除本页猫周报

### 4.1 在 `src/pages/Overview.tsx` 新建周期总结卡

**位置**：`.kpi-row` 之后、「App 排行」`<section className="panel">` 之前（即 `:437` 与 `:440` 之间）。

**模板**（工单 Batch 2 §4 原文，参数化到日/周/月）：

```
${范围}${天数描述}，你活跃了 X，敲下 Y 次按键、点出 Z 次点击，鼠标跑了 W 公里。
住得最久的是 <App>（时长）。${判语}
```

- `${范围}` 用 `anchorLabel(viewKind, viewAnchor, now)`（已有，`utils/format.ts:5`）。
- `${天数描述}`：`day` 粒度不写；`week`/`month` 写「共 N 天有数据」，N = `daysWithData`。
- X / Y / Z / W 直接复用页面里已算好的 `activeDuration` / `totalKeys` / `totalClicks` / `totalMouseDist`，**不要重算**。格式化复用 `formatDurationPlain` / `formatNumber` / `formatMouseDistance`（都在同文件里）。
- **判语按日均活跃小时数分四档，阈值 9 / 6 / 3**（工单写死）：

  ```
  日均 >= 9  → 爆肝档
  日均 >= 6  → 认真档
  日均 >= 3  → 正常档
  否则        → 摸鱼档
  ```

  日均 = `activeDuration / daysWithData / 3600_000`。`daysWithData === 0` 时整张卡不渲染。

- **`appId !== null` 时**：「住得最久的是 <App>」这半句去掉（筛选到某个 App 后说「住得最久的是它」是废话），改成在开头标注「已筛选 ${appName}」。
- `isEmpty` 时不渲染这张卡（`Overview.tsx:333` 已有 `isEmpty`）。

类名用 `.overview-summary`，样式写进 `src/styles/overview.css`，**朴素即可**。

> 这张卡是纯展示，**不可点、不弹 toast**。它没有单一的下钻目标。

### 4.2 删除 `src/pages/Insights.tsx` 的猫周报

删 `:285-306` 的整个 `<section className="ins-report">`，以及随之无用的：

- `:56-90` `generateCatReport`
- `:131` `catReport` state、`:132` `weekTotalHours`、`:133` `weekDailyAvg`
- `:216-253` 的 `topApp` / `busiestDay` / `weekChange` 计算（`weekChange` 就是挂账 #1，C2 已经处理了口径，这里连同宿主一起删）
- `:9` `import { Sparkles }`（确认没别处用）

`.ins-report*` / `.ins-chip*` 的 CSS 规则**留在 `insights.css` 里不删**——样式重构那批统一清理死规则，现在删等于在两个批次里各清一半。

---

## 5 · 明确不做

- **不动 `src/styles/insights.css` 的文件名、`.ins-*` 前缀、已有规则**（§0.2）。只允许在文件末尾追加新类。
- **不动 `aggregateWeekHourGrid`**（`Dev.tsx` 在用）。
- **不动 `src/pages/Dev.tsx`**。它有意不接全局上下文，继续用自己的 `todayRange` / `thisWeekRange`（交接文档 §5.2 第 10 条）。
- **不动时间线的任何文件**。`src/pages/Timeline.tsx` / `src/components/timeline/*` / `src/styles/timeline.css` / `src/analytics/timeline.ts` 一行都不要碰。本项目历史上出过时间线样式污染导致整站崩坏。
- **不动键盘缩放机制**：`KeyboardPanel.tsx` / `KLEKeyboard.tsx` 的尺寸模型 / `layouts/metrics.ts`。本批唯一允许碰的键盘相关文件是 `RatioPanel.tsx`，且只是把两个函数改成 import（§2.2）。
- **不修交接文档 §5.2 的第 2 条**（概览「此刻」卡吃筛选后数据）。那条绑在 Batch 6 的「搬进侧栏」上，现在改等于改两遍。
- **不修 §5.2 的第 5 条**（`useRangeData` 缓存键不含 `liveEnd`）。本批没有 `liveEnd` 调用方。
- **不做样式打磨**（§0.1）。
- **不引新依赖。**

---

## 6 · 完工检查表

### 代码层

- [ ] `npx tsc --noEmit` 无错误
- [ ] `grep -rn '"insights"' src/` 零结果
- [ ] `grep -rn "WeekSelector\|selectedWeekStart\|goPrevWeek\|goNextWeek" src/` 零结果
- [ ] `grep -rn "Math.log10" src/` **只有一处**，在 `src/analytics/keys.ts`
- [ ] `git diff --stat` 确认**未修改**：`src/pages/Timeline.tsx`、`src/components/timeline/*`、`src/styles/timeline.css`、`src/analytics/timeline.ts`、`src/components/KeyboardPanel.tsx`、`src/components/KLEKeyboard.tsx`、`src/pages/Dev.tsx`
- [ ] `git diff src/styles/insights.css` 只有**新增**行，没有修改/删除行
- [ ] `git diff src/components/DeltaBadge.tsx` 确认是纯重构：五个分支的类名、图标、文案、`title` 与改造前完全一致

### 回归（重点：别把概览搞坏）

- [ ] **概览页 App 排行的环比徽章样式正常**（这是 §0.2 那个坑的直接验收项：颜色、圆角、箭头图标都在）
- [ ] 概览页 App 排行的环比数值与改造前一致（换个 anchor 对照几行）
- [ ] 输入页的键鼠比卡片显示正常，滑块位置与改造前一致（`RatioPanel` 是纯提取，位置不该变）
- [ ] 输入页切换不同 App，滑块仍然明显移动
- [ ] 时间线页面无任何视觉变化
- [ ] 侧栏「规律」能点开，图标在，不空白

### 新功能

- [ ] 顶栏切「周」/「月」，规律页数据跟着变
- [ ] 顶栏点「日」→ 页头出现降级警示文案，页面按周渲染；**切回概览页，概览仍然是「日」**（这条验的是 `adaptKind` 不写回全局，是工单第 1 条跨批语义）
- [ ] 顶栏翻 anchor（‹ ›），数据跟着变；「今天」按钮能回到本周/本月
- [ ] 顶栏选某个 App：顶部两张卡的数字变了，App 排行非选中行变淡，作息画像标题右侧出现「不受应用筛选影响」
- [ ] `ContextChips` 显示「应用 · XXX」，点叉能清除
- [ ] 活跃对比卡的日均分母 = 有采集数据的天数（跟页头副标题的「N 天数据」对得上）
- [ ] 键鼠比的 14 天趋势**不随范围变化**（翻到上个月，趋势柱不变）
- [ ] App 排行行可点 → 跳概览且带上筛选；toast 出现；点「取消筛选」整体回到点击前的状态（页面回到规律页 **且** 筛选被清掉）
- [ ] 活跃趋势柱：周粒度 7 根、月粒度 28~31 根；点某根 → 切到该天
- [ ] 作息画像活跃格可点 → 跳时间线且定位到对应日期；挂机格/未采集格点不动
- [ ] **月粒度下作息画像的「未采集」格分布合理**（这是 §0.4 那个坑的直接验收项：如果整块都是「未采集」或整块都是「挂机」，说明 `aggregateDowHourGrid` 的时刻推导错了）
- [ ] 猫的规律 4 张卡都有内容，点击都能跳到能验证该结论的位置
- [ ] 概览页出现周期总结卡；日/周/月三个粒度都出文案，且数字与上方 KPI 一致
- [ ] 规律页的猫周报已消失

### DeltaBadge 五分支（工单人工验证项：造极端数据）

挑几个 App / 几个 anchor 凑出这五种情况，逐个确认：

- [ ] 当期基期都低于阈值 → 显示 `—`
- [ ] 基期低于阈值、当期够 → 显示「新」
- [ ] 变化幅度 < 2.5% → 显示「持平」
- [ ] 正常上升 / 下降 → 箭头方向与百分比正确
- [ ] 基期极小导致百分比爆炸 → 封顶显示 `999%+`，布局没被撑破

### 边界

- [ ] 选一个完全没有数据的范围（比如翻到去年某月）：不出现 `NaN` / `Infinity` / `undefined`，每块都有空态文案
- [ ] 筛选一个在当前范围没有数据的 App：页头 chip 显示的是 App 名不是 bundle id

### 主题

- [ ] 浅色 / 深色各扫一遍
- [ ] 系统深色 + 应用内手选浅色 → 页面是浅色（**新写的 CSS 只能用 `[data-theme="dark"]`，禁止 `@media (prefers-color-scheme: dark)`**）

---

## 7 · 完工后停下

**不要自动进入 Batch 6。** 报告检查表结果，并明确说明这三条：

1. 「回归」那一组是否全过——特别是**概览页的环比徽章样式有没有掉**
2. 月粒度下作息画像的三态分布是否合理（§0.4 的坑有没有踩）
3. `src/utils/date.ts` 里 `formatWeekLabel` / `isSameWeek` 最终是删了还是留了，以及依据

顺带更新两份文档（本批的收尾工作，不要漏）：

- `docs/v2-工单-修订版.md` 的进度表：Batch 5 标 ✅ + commit 号
- `docs/v2-交接-改造路程.md`：第三节加一段「Batch 5」逐批记录；§5.2 的挂账第 1 条标为已解决；§6.3 的依赖链更新
