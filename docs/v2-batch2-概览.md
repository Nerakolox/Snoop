# Batch 2 · 概览页接入全局上下文 + 全量下钻

> 执行前先读 `docs/v2-工单-修订版.md` 的「全局约束」与「三条跨批语义」两节。
> 开工前：`git commit -m "chore: Batch 2 开工前存档"`

本批把概览页从「写死今天」改成「消费全局 (kind, anchor, appId)」，并让页面上每一块都能下钻。

---

## 0 · 产出清单

| # | 动作 | 文件 |
|---|---|---|
| **C1** | 修改 | `src/analytics/aggregate.ts`（新增两个从 buckets 出发的分组函数） |
| C1 | 修改 | `src/store/context.tsx`（抽出并导出 `shiftAnchor`） |
| **C2** | 重写 | `src/pages/Overview.tsx`（接全局上下文 + 页头 + 数据口径） |
| C2 | 修改 | `src/styles/overview.css` |
| **C3** | 修改 | `src/pages/Overview.tsx`（下钻交互 + toast） |
| **C4** | 修改 | `src/pages/Overview.tsx` + `overview.css`（节奏区三形态） |

C2/C3/C4 都动同一个文件，但**分三个 commit**，每个 commit 后页面都应该是能跑的。

---

## 1 · C1：两个前置能力

### 1.1 背景：`fetchHourlyActivity` 在有 appId 时不能用

现在 `Overview.tsx:107-110` 同时拉两份数据：

```ts
const [todayBuckets, hourlyData] = await Promise.all([
  fetchBucketsInRange(range),
  fetchHourlyActivity(range),
]);
```

`get_hourly_activity` **不接 app 参数**（Batch 0 盘点清单 C 已确认）。一旦有全局 appId，这条路直接废掉——它会返回所有 App 的小时聚合，与页面其他部分对不上。

同理 `aggregateByHour(hourBuckets)` 吃的是 `RawHourBucket[]`，也用不了。

**解法：节奏区一律从 `buckets` 出发，不再调 `fetchHourlyActivity`。** 好处是无论有没有 appId 都走同一条代码路径，不会出现「不筛选时准、筛选后不准」这种最难查的 bug。

### 1.2 在 `src/analytics/aggregate.ts` 新增两个函数

```ts
/**
 * 按**本地小时**把桶分组，每组走 computeIntensity 得到强度档。
 * 返回定长 24 的数组，无数据的小时为 0。
 *
 * 与既有的 aggregateByHour 的区别：那个吃后端预聚合的 RawHourBucket[]，
 * 拿不到 app 维度；这个吃已按 appId 过滤好的 RawBucket[]。
 */
export function intensityByHourFromBuckets(buckets: RawBucket[]): Intensity[];

/**
 * 按**本地日期**把桶分组，返回该区间内每一天的
 * { dayMs, activeMs, intensity }，按日期升序，**包含无数据的空天**
 * （空天 activeMs=0、intensity=0），这样周柱状与月历不用自己补洞。
 *
 * 区间边界由调用方给（用 toMs 的结果），不要在函数里猜。
 */
export function statsByDayFromBuckets(
  buckets: RawBucket[],
  startMs: number,
  endMs: number
): Array<{ dayMs: number; activeMs: number; intensity: Intensity }>;
```

实现要求：

- **分组后一律调用 `computeIntensity(组内的桶)`**（`analytics/intensity.ts:126`，注释写明是「一段桶 → 平均强度档，先合计再归一化」）。
  - **禁止**自己写 `value / max` 这类线性归一化。`analytics/intensity.ts` 是强度单一真相，这条是全局约束。
  - 不要用 `computeIntensityFromTotals`——它要求传入完整的鼠标分项，从 `DayStat` 那种已聚合结构里补不出来。直接传桶数组给 `computeIntensity` 最省事也最准。
- 分组用本地时间：`new Date(b.bucket_start).getHours()` / `.getDate()` 直出本地值（`bucket_start` 是 UTC ms，JS 的 getter 自动转本地）。**不要用 `toISOString()` 切字符串**，那是 UTC。
- `activeMs` 用 `unionDurationMs(组内桶)`（同文件第 15 行），不要用简单相加——见 §2.3。

### 1.3 在 `src/store/context.tsx` 抽出 `shiftAnchor`

App 排行要显示环比徽章，需要「上一个同粒度区间」的数据。这个位移逻辑现在只活在 reducer 的 `STEP_ANCHOR` 分支里（`context.tsx:148-154`），外面拿不到。

抽成导出的纯函数，**reducer 改为调用它**（不要复制一份）：

```ts
/** anchor 按当前粒度前后位移。dir=-1 上一个区间，dir=1 下一个。 */
export function shiftAnchor(kind: RangeKind, anchor: string, dir: 1 | -1): string {
  const d = parseAnchor(anchor);
  if (kind === "day")   d.setDate(d.getDate() + dir);
  if (kind === "week")  d.setDate(d.getDate() + 7 * dir);
  if (kind === "month") d.setMonth(d.getMonth() + dir);   // 不要 +30 天
  return formatAnchor(d);
}
```

reducer 里改成：

```ts
case "STEP_ANCHOR":
  return { ...s, cur: { ...cur, anchor: shiftAnchor(cur.kind, cur.anchor, a.dir) } };
```

行为必须完全不变，改完在顶栏点几下 `‹` `›` 确认。

---

## 2 · C2：接入全局上下文

### 2.1 数据来源改造

删掉 `Overview.tsx:106` 的 `todayRange()` 与 `:107-110` 的 `Promise.all`，改为：

```tsx
const { kind, anchor, appId } = useContextState();
const { range, note } = adaptKind("overview", { kind, anchor });   // overview 支持全部三档，note 恒为 null
const { buckets, loading, refetch } = useRangeData(kind, anchor, appId);
```

> 概览的 `PAGE_KIND_CAP` 是 `["day","week","month"]`，`adaptKind` 永远不降级。仍然照写这一行 + 渲染 note，**是为了让后续所有页面结构一致**，别因为「这里用不上」就省掉。

同时**再拉一份基期数据**给 DeltaBadge 用：

```tsx
const prevAnchor = shiftAnchor(kind, anchor, -1);
const { buckets: prevBuckets } = useRangeData(kind, prevAnchor, appId);
```

> 这会让缓存里同时存当期与基期两份，`CACHE_LIMIT = 12` 够用。

`fetchHourlyActivity` 的 import 删掉（本页不再用）。

### 2.2 30 秒轮询加条件

现状 `Overview.tsx:208-213` 无条件每 30 秒 `refresh()`。改为：

```tsx
const isLive = kind === "day" && anchor === formatAnchor(new Date());

useEffect(() => {
  if (!isLive) return;                 // 看历史数据没必要轮询
  const timer = setInterval(() => refetch(), 30_000);
  return () => clearInterval(timer);
}, [isLive, refetch]);
```

**用 `refetch()` 不要用 `invalidateRangeData()`。** 后者会清掉整个缓存（包括基期那份和别的页面的），只想刷新当前这一份的话 `refetch` 才对——它只删自己那个 key（`useRangeData.ts:100-103`）。

### 2.3 活跃时长改用权威口径

现状 `Overview.tsx:161-167` 是逐桶裸加：

```ts
for (const b of todayBuckets) { totalDuration += b.duration_ms || 0; ... }
```

改成 `unionDurationMs(buckets)`（`analytics/aggregate.ts:15`）。

理由：那个函数的注释写明它是「总时长的权威口径」，且 `aggregateByApp` 内部也走并集。两边口径不一致的话，**「App 排行各行时长之和」永远对不上「活跃时长」**，而这恰好是本批人工验证要核对的项。

按键 / 点击 / 里程三个是纯计数，继续裸加，不用改。

### 2.4 页头（新增）

概览现在是 `--no-header` 变体（`Overview.tsx:218` 只传了 `className`）。改为传 `header`：

```tsx
<PageShell className="overview" header={<OverviewHeader ... />}>
```

header 内容：

1. **标题**：`概览`
2. **副标题**：`${范围文案} · ${天数} 天数据${appId ? ` · 已筛选 ${appName}` : ""}`
   - 范围文案复用顶栏那套：今天 / 昨天 / 具体日期 / 本周 / 区间 / 本月 / 年月。**把 TopBar 里的 `anchorLabel` 抽到 `src/utils/format.ts` 导出，两边共用**，不要复制一份。
   - 「天数」= **有采集数据的天数**，不是自然天数。定义：`buckets` 里出现过的不同本地日期个数。日粒度下就是 0 或 1。
3. **映射警示**：`note !== null` 时在标题右侧渲染一行警示文案（概览用不上，但要写，后续页面复用同一个组件）
4. **上下文 chips**：`<ContextChips show={["app"]} appName={appName} />`

> `appName` 从 `buckets` 里找 `app_bundle_id === appId` 的第一个 `app_name` 即可；找不到就退回显示 `appId`。**不要为了拿名字额外发一次 IPC。**

CSS 注意（`CLAUDE.md` 的 PageShell 约定）：

- `.overview` 根 class 现在是 `gap: var(--space-6); max-width: 100%`，**保持不动**。绝不加 `padding`，绝不加 `display: flex`。
- header 内部的排版写新 class（如 `.overview-header`），放 `overview.css`。

### 2.5 「此刻」卡的处理

`Overview.tsx:219-242` 的 `.now-card` **本批不删**，但**加条件渲染**：

```tsx
{isLive && <section className="now-card"> ... </section>}
```

理由：

- 它是实时状态，与时间范围正交。在「本月」视图顶上挂一个「此刻」是原方案点名要治的时态混乱。
- 但**现在还不能删**——Batch 6 才把它挪进侧栏。删了会有连续几批没有实时状态可看。
- 条件渲染是零成本的折中：常用路径（今天）体验不变，历史视图不再时态错乱。

Batch 6 会把这一整段搬进侧栏并从这里删掉，届时 `isLive` 这个变量在本页只剩轮询用。

### 2.6 空态

`loading` 为 true 且 `buckets` 为空时显示骨架或「加载中」；加载完仍为空时，四块内容各自给空态：

- 数字卡显示 `0`，但**副文案要说明原因**：`该范围没有采集到数据` 或有筛选时 `${appName} 在该范围内没有记录`
- App 排行：现有的「今天还没有数据」文案（`Overview.tsx:267-271`）改成随范围变的文案
- 节奏区：整条灰格，下方一行说明

**不要只显示一排 0 就完事**——这是 Batch 6 巡检项，提前做对。

---

## 3 · C3：下钻交互

### 3.1 统一规则

- 所有可点元素挂 `.drillable`（`src/components/shared/drillable.css`，Batch 1 已建），**不要自己写悬停样式**。
- 所有可点元素是真 `<button>`，或带 `tabindex={0}` + `role="button"` + Enter/Space 处理。
- **跨页跳转一律走 `actions.navigate({...})` 一次调用**，一次改完所有字段。
  - ✅ `actions.navigate({ page: "timeline", appId: app.bundleId })`
  - ❌ `actions.setApp(id); actions.navigate({ page: "timeline" })` ← 压出一个中间态，返回键会退到一个谁都没见过的状态
- 走了 `navigate` 的操作**才**弹 toast，撤销回调是 `actions.back()`（Batch 1 已定，不要改成清单个字段）。
- 顶栏上的操作不弹 toast。

### 3.2 逐项

| 元素 | 位置 | 动作 | toast 文案 |
|---|---|---|---|
| 活跃时长卡 | `kpi-row` 第 1 张 | `navigate({ page: "timeline" })` | `已跳转到时间线` / 撤销 `返回` |
| 总按键 | 第 2 张 | `navigate({ page: "keyboard" })` | 同上 |
| 总点击 | 第 3 张 | `navigate({ page: "keyboard" })` | 同上 |
| 鼠标里程 | 第 4 张 | `navigate({ page: "keyboard" })` | 同上 |
| App 排行行 | `.app-row` | `navigate({ page: "timeline", appId: 该 App })` | `已筛选 ${名称}，全站生效` / 撤销 `取消筛选` |

> `page: "keyboard"` 是当前的 NavKey 取值。Batch 4 改名成 `input` 时会一起改，现在写 `input` 会跳不过去。

数字卡额外要求：

- 悬停时右上角浮出目标提示（如 `→ 时间线`），用 CSS 伪元素或一个 `absolute` 的小标签，别引组件。
- **活跃时长卡在多天范围下**（`kind !== "day"`）副文案写 `日均 ${X} · 分母 ${N} 天`，N 就是 §2.4 定义的「有采集数据的天数」。日粒度下不显示这行。

App 排行行额外要求：

- 存在 `appId` 时，**非选中行 `opacity: 0.34`，不隐藏**。选中行保持不变。
- 每行右侧挂 `<DeltaBadge>`：
  ```tsx
  <DeltaBadge
    current={当期该 App 分钟数}
    previous={基期同 App 分钟数（prevBuckets 里找不到则 0）}
    vsLabel={kind === "day" ? "vs 昨天" : kind === "week" ? "vs 上周" : "vs 上月"}
    baseThreshold={kind === "day" ? 20 : kind === "week" ? 120 : 600}
  />
  ```
  - **单位是分钟**，`aggregateByApp` 给的是 `duration_ms`，记得 `/ 60_000`。这是 Batch 1 迁移时最容易错的一步，别再错一次。
  - 基期数据来自 §2.1 的 `prevBuckets`，同样走 `aggregateByApp`。

---

## 4 · C4：节奏区三形态

现在是写死的 24 格热力条（`Overview.tsx:296-332`）。改为随 `kind` 换形态。

### 4.1 三形态

| kind | 形态 | 数据 | 点击 |
|---|---|---|---|
| `day` | 24 格一维热力条（沿用现有 `.heat-strip` / `.heat-cell` / `.heat-scale`） | `intensityByHourFromBuckets(buckets)` | `navigate({ page: "timeline", focusHour: h })` |
| `week` | 7 天柱状 | `statsByDayFromBuckets(buckets, start, end)` | `navigate({ kind: "day", anchor: 该天 })` |
| `month` | 日历热力（按周排列，首行按星期几缩进） | 同上 | `navigate({ kind: "day", anchor: 该天 })` |

要点：

- **三种形态共用 `intensityVar(level)` 着色**（`analytics/intensity.ts:165`），禁止组件内自算归一化。
- 周/月点击时 patch 里**同时给 `kind` 和 `anchor`**。`NAVIGATE` 的 reducer 有一条「patch 带了 kind 但没给 anchor 时自动 reanchor」（`context.tsx:171-173`）——那是给别处兜底的，这里我们明确知道要哪天，两个都给，别依赖兜底。
- 月历首行缩进用 `grid-column-start`，星期以**周一为第一列**（与 `analytics` 里 `mondayIndex` 一致，`aggregate.ts:332`）。
- 空天（无采集数据）与「有数据但强度 0」要**视觉可区分**：空天用虚线边框或更浅的底，hover 提示「无采集数据」。这两者混淆是数据类界面最常见的谎报。
- 标题随 kind 变：`今日节奏` / `本周节奏` / `本月节奏`（非当前区间时用日期文案，别写「今日」）。

### 4.2 现有 `.heat-scale` 的处理

`Overview.tsx:309-331` 那五个刻度是硬编码 `gridColumn: 1/7/13/19/24`，只对 24 格形态成立。**只在 `kind === "day"` 时渲染**，周/月形态各自写自己的轴标签（周= 一二三四五六日，月= 日期或周次）。

---

## 5 · 明确不做

- **不动 `analytics/intensity.ts`。** 只新增 `aggregate.ts` 里的两个函数。
- **不删「此刻」卡**（只加条件渲染），不动 `pickCatQuip` / `MOOD_LABELS` 相关逻辑。
- **不做周期总结卡。** 原工单把「周报从 Insights 迁入概览」放在本批，**移到 Batch 5 一起做**——那时 Insights 正在重排，两边文案能一次对齐，避免在两个批次里各写一半模板。本批不碰。
- 不改任何别的页面。
- 不改 `TopBar`（除了 §2.4 把 `anchorLabel` 抽到 `utils/format.ts` 共用，那是纯搬家，行为不变）。
- 不引新依赖。

---

## 6 · 完工检查表

代码层：

- [ ] `npx tsc --noEmit` 无新增错误
- [ ] 全库 grep `fetchHourlyActivity` —— 概览页零引用（Insights / Dev 仍在用，那是对的）
- [ ] 全库 grep `todayRange` —— 概览页零引用
- [ ] `aggregate.ts` 的两个新函数内部都调了 `computeIntensity`，没有任何 `/ max` 形式的归一化
- [ ] `STEP_ANCHOR` 已改为调用 `shiftAnchor`，没有留下重复实现

数据正确性（**本批的核心**）：

- [ ] 不筛选时，**App 排行各行时长之和 ≈ 活跃时长**（差值应在 1% 内；差得多说明 §2.3 的口径没统一）
- [ ] 选中某个 App 后，活跃时长 = 该 App 在排行里那一行的时长
- [ ] 选中某个 App 后，节奏区的格子明显变稀疏（不是按比例整体变浅——那说明用了折算而不是重新聚合）
- [ ] 日 / 周 / 月三档下，数字都跟着变，且月的数字 > 周的 > 日的
- [ ] 顶栏翻到上个月，数字变成上个月的（不是仍显示本月）
- [ ] 开 DevTools Console，切几次范围，**不出现 `[aggregate] ... 疑似存在重叠桶` 的 warn**（`aggregate.ts:60`）

交互层：

- [ ] 四张数字卡都能点，悬停有 `→ 目标` 提示，跳转正确
- [ ] App 排行行悬停出现紫色导轨（`.drillable`），点击后跳时间线且顶栏芯片显示该 App
- [ ] 存在筛选时，非选中行变淡但**仍然可见**
- [ ] 每次跳转弹 toast，点撤销回到跳转前的**完整状态**（页面 + 筛选一起回退）
- [ ] 顶栏返回按钮与 toast 撤销行为一致
- [ ] 日粒度点热力格 → 跳时间线，顶栏出现「定位 · X:00」chip
- [ ] 周粒度点某天柱 → 切到该天，顶栏粒度变「日」且 anchor 是那天
- [ ] 月粒度点某天格 → 同上
- [ ] 键盘 Tab 能走到所有可点元素，`focus-visible` 有可见轮廓，Enter 能触发

形态与文案：

- [ ] 日 = 24 格 + 0/6/12/18/24 刻度；周 = 7 柱 + 星期标签；月 = 日历且首行缩进正确（周一为第一列）
- [ ] 月视图里空天与「强度 0 的有数据天」视觉可区分，hover 文案不同
- [ ] 节奏区标题随范围变，非当前区间时不写「今日」
- [ ] 副标题的「天数」是有数据的天数，不是自然天数（找一个中间有空档的月份验）
- [ ] 「此刻」卡只在 `kind=day 且 anchor=今天` 时出现；切到昨天/本周/本月消失
- [ ] 切到非今天时，30 秒后**没有**自动刷新（开 Network 面板看 invoke 调用）
- [ ] 空数据范围（翻到很久以前）时，四块都有说明性空态，不是一排 0

主题：

- [ ] 浅色 / 深色各扫一遍，含新增的 header、日历格、DeltaBadge、导轨
- [ ] 系统深色 + 手选浅色时页面是浅色（验 `[data-theme]` 写法）

---

## 7 · 完工后停下

不要自动进入下一批。报告检查表结果 + 「App 排行之和 vs 活跃时长」的实际差值百分比。
