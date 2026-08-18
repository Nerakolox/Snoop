# Batch 3 · 时间线接入全局上下文

> 执行前先读 `docs/v2-工单-修订版.md` 的「全局约束」与「三条跨批语义」两节。
> 开工前：`git commit -m "chore: Batch 3 开工前存档"`

**本批已相对原方案大幅缩减。先读第 0 节，那里写明了哪些工单条目作废。**

---

## 0 · 作废的工单条目（最重要，先读）

原 v2 方案的 Batch 3 是照着 `snoop-v2-prototype.html` 写的，而原型远比现有实现原始。盘点后确认以下三条**全部作废**：

### 0.1 ~~「坐标映射收敛为单一函数 toX」~~ —— 已经存在，且比工单要求的更强

`src/analytics/timeline.ts` 已有完整的分段虚拟坐标系：

- `buildSegments(start, end, gaps, compressed)` → `SegmentsData`
- `timeToVirt(t, segs)` / `virtToTime(v, segs)` —— 双向映射
- `buildTicks(segments, viewStart, viewEnd)` —— 刻度
- `COMPRESS_THRESHOLD_MS = 2h`（正是工单要的阈值）、`COMPRESSED_GAP_VIRT_MS = 2h`

`Timeline.tsx` 文件头注释原话：「所有位置换算通过分段映射 `timeToVirt` / `virtToTime` 统一转换到"虚拟坐标"，缩放和平移直接操作虚拟坐标，避免坐标系混用」。

刻度尺（`Timeline.tsx:507`）、色块（`blockStyle` :433）、可见性判断（`isBlockVisible` :441）、gap 带（`gapBands` :448）**全部**经由 `timeToVirt`。页面里没有任何地方自己算 x。

工单要新建的 `toX(min)` 是它的弱化版——只支持横向滚动，不支持缩放。**照工单重写 = 用更弱的坐标系替换更强的。禁止执行。**

### 0.2 ~~「空白块改单层覆盖」~~ —— 已经是单层

`Timeline.tsx:522-538` 的 `.swimlane-gap-overlay` 就是一个绝对定位的单层覆盖，高度按泳道数算，gap 带画在这一层。代码注释写着「单层覆盖，不随泳道滚动」。

工单描述的「每条泳道里各画一个 gap 是建模错误」**在本项目不存在**。

### 0.3 ~~「不加缩放控件 / 改为横向滚动 + scrollLeft 定位」~~ —— 会造成功能回退

现有实现已有：

| 能力 | 位置 |
|---|---|
| 滚轮缩放（以鼠标位置为锚点） | `Timeline.tsx:269-307` |
| 拖拽平移（横向平移 + 纵向滚泳道） | `:310-374` |
| 视口越界自动复位安全带 | `:157-168` |
| 切压缩时保留当前时间范围 | `toggleCompressed` :214-244 |
| 四向渐隐遮罩 | `:389-423` |
| 重置视图按钮 | `TimelineHeader` |

**这些一律保留，一行都不要动。**

同时注意：这个时间线**根本不用 `scrollLeft`**，横向靠 viewport 虚拟坐标，没有横向滚动条。工单里「自动 scrollLeft 定位（目标位置减 320px）」在本实现里无处安放。

### 0.4 本批实际范围

只做下面这些，全部是外围增量，不碰坐标系、不碰 gap 层、不碰缩放平移：

| # | 内容 |
|---|---|
| C1 | 接全局上下文：删页内日期导航、range 改由 (kind, anchor) 派生、`adaptKind`、`ContextChips` |
| C2 | appId 下其他泳道灰化（不隐藏）+ 段位可点跳转 + toast |
| C3 | 强度曲线 + 突变标记 + 底部图例 |

风险等级：**中**（原为高）。工期：一天以内。

---

## 0.5 · 样式即将大改，不要打磨视觉

本批之后有一次整体样式重构。所以：

- 新增元素（强度曲线、图例、灰化态）**做到结构正确、数据正确、可交互即可**，配色/间距/动效从简，走现有 token，不要花时间调视觉。
- 不要为了新元素去重排 `timeline.css` 的既有结构。
- 不要新增 CSS 变量。

---

## 1 · C1：接入全局上下文

### 1.1 数据取用方式（本批的关键决策，照做）

**时间线继续直接调 `fetchBucketsInRange`，不接 `useRangeData`。**

两个理由，都成立：

1. **时间线需要未筛选的全量数据。** 其他 App 的泳道要灰化显示、不能隐藏（见 §2.1），所以取数阶段必须拿全量，appId 只影响渲染。`useRangeData` 的主要价值是「统一 appId 过滤口径」，这里用不上。
2. **`useRangeData` 的缓存键不含 `liveEnd`**（`useRangeData.ts:28-30`）。活范围的 `end_ms` 每分钟都在动，一旦缓存就等于把 now 冻住，时间线会停在首次加载那一刻不再前进。绕开缓存正好躲掉这个问题。

所以只改 range 的来源，取数逻辑（`Timeline.tsx:247-266` 那个 effect）**结构不动**：

```tsx
const { kind, anchor, appId } = useContextState();
const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("timeline", { kind, anchor });
// PAGE_KIND_CAP.timeline = ["day"]，所以 viewKind 恒为 "day"；
// 全局是周/月时 adaptKind 会降级并给出 note，页头要渲染它。

// 保留现有的 nowMs 每分钟 tick（Timeline.tsx:115-121），它是活范围前进的驱动
const fetchRange = useMemo(
  () => toMs(viewKind, viewAnchor, { liveEnd: true }),
  [viewKind, viewAnchor, nowMs]
);
const fullDayRange = fetchRange;   // 见下
```

> **`dataRange` 与 `displayRange` 两个本地函数（`Timeline.tsx:30-63`）删掉**，它们的语义已经被 `toMs(..., {liveEnd:true})` 完全覆盖：
> - 今天 → `end = now`
> - 历史 → `end = 次日 0 点`
>
> 原来两个函数的返回值其实完全一致（对比 `:34-44` 与 `:51-63`），保留两个名字只是历史遗留。合并成一个 `range` 即可，`globalGaps` / `buildSegments` 的入参跟着改。

`nowMs` 的 tick 条件从 `isToday` 改为「viewAnchor 是今天」：

```tsx
const isTodayView = viewAnchor === formatAnchor(new Date());
useEffect(() => {
  if (!isTodayView) return;
  setNowMs(Date.now());
  const timer = setInterval(() => setNowMs(Date.now()), 60_000);
  return () => clearInterval(timer);
}, [isTodayView]);
```

### 1.2 删除页内日期导航

**`src/pages/Timeline.tsx`：**

- 删 `selectedDate` state（`:68`）
- 删 `today` / `isToday` / `dateLabel` 三个 useMemo（`:104-112`）—— `isToday` 的用途由 `isTodayView` 接管
- 删 `goPrevDay`（`:191`）/ `goNextDay`（`:199`）/ `goToday`（`:209`）
- `:187-189` 的「切换日期时重置视图」effect 依赖改为 `[viewAnchor]`（**保留这个行为**，换天必须重置视口）
- 删除 `startOfDay` / `isSameDay` / `formatPeriodLabel` 的 import（若其他地方仍用则保留）

**`src/components/timeline/TimelineHeader.tsx`：**

删掉这五个 props 及其 UI：`dateLabel` / `isToday` / `onPrevDay` / `onNextDay` / `onToday`（对应 `:39-58` 的前一天/日期标签/后一天/回到今天）。

**保留**：`hasCustomViewport` + `onResetView`（重置视图按钮）、`compressed` + `onToggleCompressed`（压缩空白切换）。

所以 header **不会变空**，仍有两个视图控制按钮。`fill` + `--no-header` 的组合本批用不上（Batch 1 已验证过它可用，但这里不需要）。

组件顶部的注释要跟着改，不要留「日期切换栏」这种已失效的描述。

对应 CSS：`.swimlane-nav-btn` / `.swimlane-date-label` / `.swimlane-today-btn`（`timeline.css:205-264`）**本批先留着不删**——样式大改时统一清理，现在删了万一要回滚更麻烦。

### 1.3 页头补充

在 header 里（`.swimlane-date-picker` 那一行，或它上方另起一行）加：

1. **映射警示**：`note !== null` 时渲染。文案由 `adaptKind` 给（如「「月」视图在此页不可用，已映射为「日」」）。
2. **上下文 chips**：`<ContextChips show={["app", "focusHour"]} appName={appName} />`
   - `appName` 从 `lanes` 里找 `app_bundle_id === appId` 的 `app_name`，找不到退回 `appId`。不要为此发额外 IPC。

### 1.4 focusHour：本批只存不定位

**用户决定：本批不实现自动定位，只把它显示出来。**

- `ContextChips` 里显示「定位 · 15:00 ✕」，叉能清除。
- **不画焦点竖线，不改 viewport，不做任何滚动或缩放。**
- 在 `Timeline.tsx` 里留一条 TODO 注释说明这是有意为之：

```tsx
// TODO(样式大改): focusHour 目前只经 ContextChips 展示，不驱动视口。
// 现有时间线是 viewport 虚拟坐标模型（无 scrollLeft），自动定位需要
// 与 viewport 安全带、压缩开关同步，等样式重构定稿后再实现。
```

概览页点热力格跳过来时仍然会设 focusHour + 弹 toast，chip 会出现——用户能看到上下文被带过来了，只是时间线暂不自动移动。这是本批的预期行为，不是 bug。

---

## 2 · C2：筛选灰化与段位可点

### 2.1 appId 下其他泳道灰化

**灰化不是过滤。** `lanes` 仍然是全量（`buildAppLanes(buckets)` 不传 appId），只在渲染时降透明度。

在 `SwimLane` 加一个 prop：

```tsx
/** 存在全局 App 筛选且本泳道不是被选中的那个时为 true */
dimmed?: boolean;
```

`Timeline.tsx` 传入 `dimmed={appId !== null && lane.app_bundle_id !== appId}`。

CSS：

```css
.swimlane-row--dim { opacity: 0.18; }
```

（工单区间是 0.12–0.25，取 0.18。样式大改时再定最终值。）

**注意**：`.swimlane-gap-overlay` 是全局状态层，**不参与灰化**——空白是全局的，与选了哪个 App 无关。

### 2.2 段位可点

现在 `.swimlane-block`（`SwimLane.tsx:52-72`）只有 hover 出 tooltip，没有 onClick。加：

```tsx
onClick={() => onClickBlock(lane.app_bundle_id, lane.app_name, block)}
```

`Timeline.tsx` 里：

```tsx
function handleBlockClick(bundleId: string, name: string, block: TimeBlock) {
  const hour = new Date(block.start_ms).getHours();
  actions.navigate({ appId: bundleId, focusHour: hour });
  toast.show({ message: `已筛选 ${name}，全站生效`, undoLabel: "取消筛选" });
}
```

要点：

- **一次 `navigate` 同时给 `appId` 和 `focusHour`**，不要拆两步（拆了会压出中间态）。
- `page` 不用给——本来就在时间线页，`navigate` 会把当前状态压栈，`back()` 能回到未筛选态。
- toast 撤销 = `back()`（Batch 1 已定，不要改成清单个字段）。
- 色块本身还是 `<div>`。**本批不改成 `<button>`**——它带 inline `background` 和绝对定位，换标签会牵动 `.swimlane-block` 的一堆样式，留给样式大改。但要加 `role="button"` + `tabIndex={0}` + `onKeyDown`（Enter/Space），键盘可达性先补上。
- hover 的 tooltip 逻辑（`onMouseEnter` / `onMouseLeave`）保持不动。

### 2.3 与拖拽平移的冲突

`.swimlane-chart` 上挂了 `onMouseDown` / `onMouseMove` / `onMouseUp` 做拖拽平移（`Timeline.tsx:495-497`）。色块加了 onClick 后，**拖拽结束时会误触发点击**。

处理：在 `handleMouseDown` 里记下起始坐标，`onClick` 时判断位移是否小于阈值（建议 4px），超过就认为是拖拽、不触发跳转。

```tsx
// mouseDown 时已有 dragStartRef.current = { x, y, ... }
function isClickNotDrag(e: React.MouseEvent): boolean {
  const s = dragStartRef.current;
  if (!s) return true;
  return Math.abs(e.clientX - s.x) < 4 && Math.abs(e.clientY - s.y) < 4;
}
```

**这一条必须做，否则拖着看时间线会不停地误跳转、误弹 toast。**

---

## 3 · C3：强度曲线、突变标记、图例

> 视觉从简（见 §0.5）。这一组是纯增量，不改任何既有元素。

### 3.1 强度曲线

- 一条 SVG `<path>`，叠在泳道区上方或轴下方（位置自定，样式大改会重排）。
- 数据：按小时的活跃强度。**直接复用 Batch 2 新增的 `intensityByHourFromBuckets(buckets)`**（`analytics/aggregate.ts`），不要新写聚合。
- **x 坐标必须走 `timeToVirt` + `virtToPct`**，与刻度尺、色块共用同一套映射。任何自己算 x 的写法都是错的。
  - 每个小时取该小时的起始时刻 `t`，`virtToPct(timeToVirt(t, segmentsData.segments))` 得到百分比。
  - SVG 用 `viewBox="0 0 100 H"` + `preserveAspectRatio="none"`，x 直接用百分比数值，这样缩放/平移时曲线自动跟随，不用监听。
- 曲线要跟着 viewport 变化重算（依赖 `viewRange`），与刻度尺行为一致。

### 3.2 突变标记

检测规则（照抄，不要改阈值）：

```ts
// v = 当前小时强度值，prev = 前一小时，max = 当日峰值
const isSpike = v > prev * 1.8 && v > max * 0.45;
```

- 每个突变点渲染一个可点标记（小圆点或小三角）。
- 点击弹出猫的吐槽气泡，文案模板化且**含具体时刻**，如「${H}点突然来劲了喵，键盘要冒烟了」。
- 文案沿用现有猫人格口吻，参考 `analytics` 里的 `pickCatQuip`。可以新增一个 `pickSpikeQuip(hour, intensity)` 放在同一处，**不要在组件里写死文案数组**。
- 气泡关闭方式：再点一次 / 点别处 / Esc。

### 3.3 底部图例

三项，静态：

- 挂机（有心跳无输入）
- 压缩空白 (>2h)
- 活跃强度曲线

放在 `.swimlane-chart` 下方。纯展示，无交互。

---

## 4 · 明确不做

- **不动 `src/analytics/timeline.ts`。** 一行都不改。
- **不动** `buildSegments` / `timeToVirt` / `virtToTime` / `buildTicks` 的任何调用方式。
- **不动**滚轮缩放、拖拽平移、视口安全带、渐隐遮罩、压缩切换、重置视图。
- **不动** `.swimlane-gap-overlay` 的结构与定位逻辑。
- **不做** focusHour 的自动定位（见 §1.4）。
- **不改** `.swimlane-block` 的标签类型（div → button 留给样式大改）。
- **不删** `timeline.css` 里日期导航的遗留样式。
- 不碰任何其他页面。
- 不引新依赖。

---

## 5 · 完工检查表

代码层：

- [ ] `npx tsc --noEmit` 无新增错误
- [ ] `git diff --stat` 确认 **`src/analytics/timeline.ts` 未被修改**
- [ ] `Timeline.tsx` 里 grep `selectedDate` / `goPrevDay` / `goNextDay` / `dataRange` / `displayRange` 全部零残留
- [ ] 强度曲线的 x 坐标经过 `timeToVirt`，grep 确认没有 `/ 24 * 100` 这类自算写法

**回归（最重要——这批的风险全在"别把能用的搞坏"）：**

- [ ] 滚轮能缩放，缩放锚点跟着鼠标位置
- [ ] 拖拽能横向平移
- [ ] 拖拽能纵向滚泳道
- [ ] 缩放后「重置视图」按钮出现，点了回到全视图
- [ ] 「压缩空白 / 展开空白」切换正常，切换后当前看的时间范围不跳
- [ ] 四向渐隐遮罩在该出现时出现
- [ ] 刻度尺与色块**对齐**（缩放到不同倍率各看一次）
- [ ] 压缩灰块位置正确，hover 出「空闲 X · HH:MM – HH:MM」
- [ ] 色块 hover tooltip 正常

新功能：

- [ ] 顶栏切日期，时间线跟着变（页内已无日期导航）
- [ ] 顶栏切到「周」或「月」，时间线降级为日 + 页头显示映射警示
- [ ] 从「周」切回「日」，anchor 落点合理
- [ ] 选中某 App：该泳道正常，其余泳道**变淡但仍可见**，gap 覆盖层**不变淡**
- [ ] 点某个色块 → 顶栏芯片变成该 App，弹 toast
- [ ] **拖拽平移后松手不会误触发跳转**（反复拖十次，一次都不该跳）
- [ ] toast 撤销 = 整体回退（筛选和视口一起回到点击前）
- [ ] chips 显示「应用 · X」和「定位 · H:00」，各自能单独清除
- [ ] 从概览点热力格跳过来：chip 出现「定位 · H:00」，时间线**不自动移动**（本批预期行为）
- [ ] 强度曲线随缩放/平移跟随，不脱节
- [ ] 突变标记可点，气泡文案含具体时刻
- [ ] 图例三项都在

主题：

- [ ] 浅色 / 深色各扫一遍，重点看灰化的泳道在深底上是否还看得见

---

## 6 · 出事就回滚

时间线历史上有过样式污染导致整站崩坏。**任何一块样式秃了，立刻回滚到本批开头的 commit，不要在崩坏状态上继续修。**

判断依据：如果别的页面（概览/键盘/设置）出现样式异常，说明改动漏出了 timeline 相关文件——那是必须回滚的信号，不是可以就地修的 bug。

---

## 7 · 完工后停下

不要自动进入下一批。报告检查表结果，特别说明「回归」那一组是否全过。
