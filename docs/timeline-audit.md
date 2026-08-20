# 时间线页渲染层现状审计

> 只读调研，事实优先，不含重构建议。所有结论附 `文件:行号`。拿不准处标注「未确认」。

---

## 1. 文件清单

时间线页面（泳道图 / 甘特图）涉及的文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/pages/Timeline.tsx` | 697 | 页面主组件。消费全局 `(kind, anchor, appId)`、取数、持有视口/压缩/拖拽/缩放/气泡等全部本地状态，位置换算函数 `virtToPct`/`blockStyle`/`isBlockVisible` 在此定义并以 props 下传子组件 |
| `src/analytics/timeline.ts` | 252 | 泳道/段/刻度/空白检测纯函数：`buildAppLanes`、`computeGlobalGaps`、`buildSegments`、`timeToVirt`、`virtToTime`、`buildTicks`；常量 `COMPRESS_THRESHOLD_MS`、`COMPRESSED_GAP_VIRT_MS`、`COLOR_PALETTE` |
| `src/analytics/intensity.ts` | 182 | 活跃强度分档（EPM）全项目唯一入口：`computeBucketIntensity`、`computeIntensity`、`intensityVar` 等 |
| `src/analytics/aggregate.ts` | 500 | 聚合派生数据；强度曲线数据源 `intensityByHourFromBuckets`（`src/analytics/aggregate.ts:139`）在此定义 |
| `src/analytics/constants.ts` | 169 | 分析层常量；突变吐槽 `pickSpikeQuip`（`src/analytics/constants.ts:164`） |
| `src/components/timeline/SwimLane.tsx` | 88 | 单条 App 泳道渲染（label + track + 色块 + 网格线），纯展示组件，位置计算全由父组件 props 注入 |
| `src/components/timeline/TimelineTooltip.tsx` | 69 | 色块 hover 气泡，portal 到 `document.body`，`positionTooltip` 定位 |
| `src/styles/timeline.css` | 641 | 泳道图 + 强度曲线 + 渐隐遮罩 + gap 板样式。**1–183 行为旧 `.timeline` 列表样式，见 §9 已知问题** |

时间线直接依赖的共享模块（非页面专属）：

| 文件 | 职责 |
| --- | --- |
| `src/components/shared/Tooltip.tsx` | 通用悬浮提示（label、gap 板、spike 标记复用） |
| `src/components/shared/tooltipPosition.ts` | tooltip 定位算法（TimelineTooltip 与通用 Tooltip 共用） |
| `src/components/PageShell.tsx` | 页面外壳（Timeline 用 `fill` 自管滚动） |
| `src/components/topbar/TopBarToolsContext.tsx` + `TopBarTools.tsx` | 顶栏工具槽（Timeline 注册「重置视图」「展开/压缩空白」按钮） |
| `src/store/context.tsx` | 全局状态与 `adaptKind` |
| `src/data/client.ts` / `ranges.ts` / `types.ts` | 取数与时间范围计算 |

---

## 2. 时间 → 坐标映射

### 2.1 映射的实现方式

坐标体系是**纯 CSS 百分比**（`left` / `width` 均用 `%`），不使用 px、CSS grid 或 transform 来做时间轴定位。中间经过一层「虚拟坐标」（单位仍为 ms，见下），最终由 `virtToPct` 换算成百分比。

核心是两个原始函数：

- `timeToVirt(t, segs)` — `src/analytics/timeline.ts:182`。时间戳 → 虚拟坐标。遍历 `Segment[]`，`data` 段 1:1 线性（`virt = virt_start + (t - time_start)`，`timeline.ts:192`），`gap` 段按比例线性（`timeline.ts:193`）。
- `virtToTime(v, segs)` — `src/analytics/timeline.ts:199`。逆映射，`timeline.ts:209–210`。

再加一个页面内包装：

- `virtToPct(v)` — `src/pages/Timeline.tsx:376`。虚拟坐标 → 视口内左侧百分比：`((v - viewRange.start) / viewSpan) * 100`。

### 2.2 所有「时间 → 横向位置」的调用点

| 用途 | 位置 | 说明 |
| --- | --- | --- |
| 色块 left/width | `src/pages/Timeline.tsx:381`（`blockStyle`） | `timeToVirt` 起点/终点 → `virtToPct` → `{left:%,width:%}`，最小宽度 0.3% |
| 色块可见性裁剪 | `src/pages/Timeline.tsx:389`（`isBlockVisible`） | 用 `timeToVirt` 判断是否落在视口，非定位但同属映射 |
| 顶部刻度 tick | `src/pages/Timeline.tsx:582` | `left: ${virtToPct(tk.virt)}%` |
| 每条泳道的网格线 | `src/components/timeline/SwimLane.tsx:57` | 同样 `left: ${virtToPct(tk.virt)}%`，**按 lane 复制一份** |
| gap 灰色板 | `src/pages/Timeline.tsx:420`（`gapBands`） | `virtToPct(g.virt_start / g.virt_end)` → left/width % |
| 强度曲线 x | `src/pages/Timeline.tsx:444`（`curvePoints`） | `virtToPct(timeToVirt(t, segments))` |
| spike 标记 / 气泡 left | `src/pages/Timeline.tsx:608`、`:617` | 复用 `curvePoints[hour].x` |

### 2.3 重复点

1. **坐标换算本身已收敛**：所有位置都经过 `timeToVirt` + `virtToPct`，没有第二套独立换算。重复的是**调用点各自手工组合**这两个原语（约 6 处，见上表）。
2. **tick 渲染重复**：顶部 `swimlane-axis` 与每条泳道 `swimlane-track` 各渲染一遍同一批 `ticks`（`Timeline.tsx:578` vs `SwimLane.tsx:53`），网格线按 lane 数量级复制（见 §3 DOM 数量）。
3. **尺寸常量在 JS 与 CSS 之间重复**：见 §7。

### 2.4 「压缩空白 (>2h)」算法

- 阈值：`COMPRESS_THRESHOLD_MS = 2 * 60 * 60 * 1000`（2 小时），`src/analytics/timeline.ts:47`。
- 空白检测：`computeGlobalGaps(lanes, fullStart, fullEnd, threshold)` — `src/analytics/timeline.ts:115`。把**所有 lane 的 block 区间**收集、排序、合并（`timeline.ts:121–133`），相邻合并区间的空隙 > 阈值即记为一个全局 gap（`timeline.ts:134–141`）。
- 压缩后宽度：**固定宽度**，不是按比例。每个 gap 段映射为 `COMPRESSED_GAP_VIRT_MS = 2h` 的虚拟宽度（`timeline.ts:48`，使用处 `timeline.ts:170`）。
- 数据结构：**有独立的「段」结构**。`Segment` 类型（`src/analytics/timeline.ts:23`，`type: "data" | "gap"`），由 `buildSegments`（`timeline.ts:144`）产出 `SegmentsData { segments, virtGaps, totalVirt, compressed }`（`timeline.ts:38`）。`virtGaps` 单独存 gap 段供灰色板渲染。

### 2.5 「展开空白」开关

- 开关状态：`const [compressed, setCompressed] = useState(true)` — `src/pages/Timeline.tsx:56`（默认开启）。
- 切换函数：`toggleCompressed` — `src/pages/Timeline.tsx:158`。顶栏按钮触发（`Timeline.tsx:544`）。
- **两种模式是同一套映射代码，不是两条分支**：`buildSegments(..., compressed)` 在 `compressed=false` 或 `gaps.length===0` 时返回单段全量 `data` 段（`timeline.ts:151–158`），`timeToVirt`/`virtToTime` 始终只操作传入的 `segments` 数组。切换时通过 `virtToTime` → 重建 segments → `timeToVirt` 往返，保留当前视口对应的真实时间范围（`Timeline.tsx:164–186`）。

---

## 3. 数据规模

### 3.1 视图粒度

时间线页被限制为**仅日粒度**：`PAGE_KIND_CAP.timeline = ["day"]`（`src/store/context.tsx:26`）。任何非 day 的全局 kind 经 `adaptKind("timeline", ...)` 降级为日（`context.tsx:104–119`）。因此**不存在周/月视图**，数据规模永远是单日。

### 3.2 rect（活动区块）数量

- 数据源 `RawBucket` 为 5 秒（或提前结算的）活动桶（`src/data/types.ts:7`）。
- 一天的桶数理论上限 ≈ `24 * 3600 / 5 = 17,280`。
- `buildAppLanes` 会把相邻、间隙 ≤ 1000ms 的同 app 桶合并成一个 block（`src/analytics/timeline.ts:91–96`），所以 block 数 ≈ App 切换会话数，而非桶数。
  - **典型值**：连续使用少数 App → 每条 lane 几个 block，总 block 数十量级。
  - **实测值**（2026-08-20，真实库 6006 桶 / 4 个有数据日，方法见 §10）：单日 block 总数最大 **732**、中位数 **208.5**（82 / 213 / 732 / 204）；单条 lane 最大 block 数 **191**。理论最坏值 1.7 万属极端推断，实测远低于此（**已确认**）。

### 3.3 合并 / 分桶

- **合并**：有，仅「相邻同 app 段合并」（间隙 ≤1s），在 `buildAppLanes`（`src/analytics/timeline.ts:91–96`）。
- **按像素分桶**：无。没有按像素宽度做任何聚合。
- **视口裁剪**：渲染前用 `isBlockVisible`（`Timeline.tsx:389`）+ `blocks.filter(isBlockVisible)`（`SwimLane.tsx:60`）剔除视口外 block，仅减渲染数量，不改数据。

### 3.4 DOM 节点数量级（推断）

- 每条 lane 渲染：1 行 + label（AppIcon + 文本）+ `T` 条网格线 + `V` 个可见 block。
- `T` = `buildTicks` 输出数：全视图（24h）间隔 3h，剪枝后约 ~9；缩放至最小档（30min 视口）间隔 10min，约 ~4（`src/analytics/timeline.ts:222–225`）。
- 网格线**按 lane 复制**：`N` 条 lane × `T` 条网格线。
- 总计 ≈ `N × (1 + T + V)` + 头部 `T` tick + 强度行（1 个 SVG path + 至多 23 个 spike 标记）+ `N` 或更少的 gap 板 + 4 个渐隐遮罩。
- 即：DOM 规模与 lane 数 × 网格线数线性相关，网格线是主要的乘数来源。此为代码结构推断，未实测（**未确认**）。

---

## 4. 交互清单

| 交互 | 触发元素 | 处理函数 | 依赖 DOM 冒泡？ |
| --- | --- | --- | --- |
| hover 色块 → 气泡 | `.swimlane-block`（`pointer-events:auto`，`timeline.css:443`） | `onMouseEnter/Leave` → `onHoverBlock` → `setHoveredBlock`（`SwimLane.tsx:70–80`）；`TimelineTooltip` 渲染气泡（`Timeline.tsx:692`） | React 合成 `mouseenter/leave`，非冒泡（enter/leave 本身不冒泡）；块元素需可命中，track 本身 `pointer-events:none`（`timeline.css:418`） |
| tooltip 定位 | `TimelineTooltip` portal | `positionTooltip`（`TimelineTooltip.tsx:40`，`tooltipPosition.ts:7`），锚点取块的 `getBoundingClientRect`（`SwimLane.tsx:71`） | 无 |
| 点击色块 → 筛选 app | `.swimlane-block` | `onClick` → `onBlockClick` → `handleBlockClick` → `selectApp` → `actions.navigate({appId, focusHour})`（`SwimLane.tsx:81`，`Timeline.tsx:403–412`） | React 合成 click 冒泡到块本身；与拖拽用 `isClickNotDrag`（4px 阈值）区分（`Timeline.tsx:397`） |
| 点击 spike 标记 → 气泡 | `.swimlane-spike-marker` | `onClick` → `handleSpikeClick`（`Timeline.tsx:475`，`Timeline.tsx:609`） | React 合成 click |
| 拖拽平移 | `.swimlane-chart`（容器） | `onMouseDown/Move/Up`（`Timeline.tsx:256–327`，绑定于 `Timeline.tsx:570–572`）；松手兜底用 `window` 原生 `mouseup`（`Timeline.tsx:329–335`） | 依赖 mousedown **冒泡到 chart 容器**（块虽 `pointer-events:auto` 但事件仍冒泡到容器）；Move/Up 也用 React 合成事件 |
| 滚轮缩放 | `.swimlane-chart`（原生监听） | `useEffect` 内 `addEventListener("wheel", ...)`，`passive:false` + `stopPropagation`（`Timeline.tsx:215–253`）；最小视口 30min（`Timeline.tsx:235`） | 原生事件监听，不经过 React 合成；用 `trackRef.getBoundingClientRect`（`Timeline.tsx:223`） |
| 键盘（色块激活） | `.swimlane-block`（`role=button` `tabIndex=0`，`SwimLane.tsx:64–65`） | `onKeyDown` Enter/Space → `handleBlockKeyDown`（`SwimLane.tsx:82`，`Timeline.tsx:414–418`） | React 合成 keydown |
| 键盘（spike 气泡关闭） | window | Esc + 点击外部，`window` keydown/mousedown 监听（`Timeline.tsx:482–499`） | 原生监听，`target.closest(...)` 判断（`Timeline.tsx:489`） |
| 右键 | — | **无右键交互** | — |
| 重置视图 / 压缩开关 | 顶栏工具按钮 | `resetView`（`Timeline.tsx:148`）、`toggleCompressed`（`Timeline.tsx:158`），经 `useTopBarTools` 注册（`Timeline.tsx:505–554`） | 无 |

补充：`spikePopover` 的关闭（点别处）依赖 window 级 `mousedown` 捕获（`Timeline.tsx:487–494`），这是页面内**唯一依赖全局事件冒泡 + `closest` 查询**的交互。

---

## 5. 与全局状态的耦合

### 5.1 time range 与 app filter 如何传入

- 全局状态来源：`useContextState()` / `useContextActions()`（`src/pages/Timeline.tsx:39–40`），来自 `src/store/context.tsx` 的 `StateCtx`/`ActionsCtx`（React Context + useReducer）。
- **time range**：由顶栏（`TopBar.tsx`）通过 `actions.setKind/stepAnchor/goToday` 改全局 `kind/anchor`；Timeline 读取后经 `adaptKind("timeline", {kind,anchor})` 投影（`Timeline.tsx:42`），再用 `toMs(viewKind, viewAnchor, {liveEnd:true})` 生成 `[start_ms,end_ms)`（`Timeline.tsx:92–96`）。`liveEnd` 让「今天」的 end 收到当前时刻，`nowMs` 每分钟推进驱动刷新（`Timeline.tsx:81–88`）。
- **app filter**：全局 `appId` 直接读（`Timeline.tsx:39`）。**只用于灰化未选中的泳道**（`dimmed` prop，`Timeline.tsx:665`），**不参与取数过滤**——`fetchBucketsInRange` 取全量（注释 `Timeline.tsx:190–193`）。
- **取数**：直接 `fetchBucketsInRange(range)`（`Timeline.tsx:199`），不走 `useRangeData`（理由见注释 `Timeline.tsx:190–193`）。

### 5.2 局部状态与全局状态的关系

时间线本地状态：`buckets`、`viewport`、`compressed`、`hoveredBlock`、`isDragging`、`spikePopover`、`fadeMasks`（`Timeline.tsx:44–78`）。均为页面内视口/交互状态，**不与全局状态重复**。

唯一需要注意的耦合点：

- `focusHour`：`selectApp` 通过 `actions.navigate({appId, focusHour})` 写入全局（`Timeline.tsx:405`），但 Timeline **只写不读**——目前不驱动视口定位（TODO，`Timeline.tsx:501`），仅由 `TopBarTools.tsx:28–56` 读出来渲染顶栏芯片。
- `viewKind/viewAnchor/note` 是全局 `kind/anchor` 的**读取时投影**（`adaptKind`），Timeline 绝不回写 `setKind`（约定见 `context.tsx:99–103` 注释）。

---

## 6. 强度曲线

### 6.1 数据来源

- `hourlyIntensity = intensityByHourFromBuckets(buckets)`（`src/pages/Timeline.tsx:441`）。
- 实现：`src/analytics/aggregate.ts:139`。按 `new Date(bucket_start).getHours()` 把桶分到 0–23 小时，每组合计走 `computeIntensity`。
- **采样点数量：固定 24**（每小时一个，无数据小时强度 0），`aggregate.ts:140–146`。

### 6.2 是否复用 `analytics/intensity.ts`

**复用**。`intensityByHourFromBuckets` → `computeIntensity`（`aggregate.ts:145`）→ `src/analytics/intensity.ts:126`，最终落到 `bucketIntensityFromEpm`（`intensity.ts:108`）。时间线页**没有自己重写强度计算**，只自己写了「按小时分桶」这一层（在 `aggregate.ts`，非 Timeline 页内）。

### 6.3 曲线 x 是否与 lane 同一套映射

**是**。`curvePoints` 用 `t = range.start_ms + hour * 3_600_000`，`x = virtToPct(timeToVirt(t, segments))`（`Timeline.tsx:446–447`），与色块/刻度共用 `timeToVirt` + `virtToPct`。

隐含假设（值得注意）：`hour` 索引对应 `range.start_ms + hour*1h` 只在**日粒度、range.start_ms 为本地 0 点**时成立。该前提由 `PAGE_KIND_CAP` 保证（时间线恒为日），故当前成立，但非通用。

补充：曲线 y 坐标由 `level/4` 映射到 `CURVE_VB_H`（32，`Timeline.tsx:438`、`448`），与 CSS `.swimlane-intensity-track { height:32px }`（`timeline.css:556`）对应。突变检测（spike）为独立公式：`v > prev*1.8 && v > maxLevel*0.45`（`Timeline.tsx:459–471`，注释称「照抄工单公式」）。

---

## 7. 尺寸与响应

### 7.1 容器宽度获取 / ResizeObserver

- **没有 ResizeObserver，也不测量容器宽度**。时间轴定位全部用百分比（`virtToPct`），天然自适应容器宽度，无需 px 宽。
- 仅有的 DOM 尺寸读取是事件触发的 `getBoundingClientRect`：
  - 滚轮缩放：`trackRef.getBoundingClientRect()`（`Timeline.tsx:223`）
  - 拖拽平移：`trackRef.getBoundingClientRect()`（`Timeline.tsx:285`）
  - 气泡锚点：块的 `getBoundingClientRect()`（`SwimLane.tsx:71`）
- 项目里唯一的 `ResizeObserver` 在 `TopBarTools.tsx:153`（顶栏工具槽溢出检测），与时间线图表无关。

### 7.2 行高、行头宽度

全部是**硬编码常量**，不是 CSS 变量、非计算值：

- 行高 48px：`.swimlane-row { min-height:48px }`（`timeline.css:382`）、`.swimlane-track { height:48px }`（`timeline.css:413`）。
- 行间距 8px：`.swimlane-body { gap: var(--space-2) }`（`timeline.css:299`），`--space-2 = 8px`（`tokens.css:35`）。
- 行头宽度 200px：**三处重复**——`.swimlane-axis-label { width:200px }`（`timeline.css:264`）、`.swimlane-label { width:200px }`（`timeline.css:386`）、gap 覆盖层 `.swimlane-gap-overlay { left:200px }`（`timeline.css:497`）。
- 强度轨道高 32px：`.swimlane-intensity-track { height:32px }`（`timeline.css:556`）与 JS `CURVE_VB_H = 32`（`Timeline.tsx:438`）重复。

**JS 侧重复硬编码**：gap 覆盖层高度公式 `lanes.length * 48 + Math.max(0, lanes.length - 1) * 8 + 32`（`Timeline.tsx:634`），把行高 48、间距 8、强度轨高 32 三个 CSS 值在 JS 里又写了一遍。

---

## 8. 依赖

`package.json`（`/Users/nerakolo/aaaa-dev/Snoop/package.json`）中**没有任何 d3-\*、chart 库、canvas 库**。可视化/图形相关依赖为空。

时间线页的图形全部是**手写原生 DOM/CSS + 一个内联 SVG**：

- 色块/刻度/网格线/gap 板：`div` + CSS（百分比定位）。
- 强度曲线：原生 `<svg>` + `<path>`（`Timeline.tsx:594–600`），`viewBox="0 0 100 32"` + `preserveAspectRatio="none"`，x 用百分比坐标（与 CSS 百分比一致）。
- 现有依赖只有图标库（`lucide-react`、`@fortawesome/*`）和 `react`/`@tauri-apps/*`，与图表无关。

---

## 9. 已知问题

### 9.1 TODO / FIXME / HACK

搜索时间线相关文件，仅发现 1 处字面 `TODO`（无 FIXME / HACK）：

> `// TODO(样式大改): focusHour 目前只经顶栏内建芯片展示，不驱动视口。` `src/pages/Timeline.tsx:501`

（`src/pages/Timeline.tsx:502–503` 后续两行：`// 现有时间线是 viewport 虚拟坐标模型（无 scrollLeft），自动定位需要 / // 与 viewport 安全带、压缩开关同步，等样式重构定稿后再实现。`）

### 9.2 注释中描述的 workaround / 注意事项

1. **拖拽松手不清 `dragStartRef`**（`src/pages/Timeline.tsx:322–327`）：
   > `// 注意：这里不清 dragStartRef —— click 事件在浏览器里晚于 mouseup 触发，`
   > `// 若此处置 null，色块的 onClick 里就再也读不到本次拖拽的起点，`
   > `// 拖拽/点击判定会失效。dragStartRef 留到下一次 mousedown 时自然覆盖。`

2. **取数绕开 `useRangeData` 的缘由**（`src/pages/Timeline.tsx:190–193`）：
   > `// ① 其他 App 的泳道要灰化显示而不是被过滤掉，取数阶段必须是全量；`
   > `// ② useRangeData 的缓存键不含 liveEnd，会把"今天"的 now 冻在首次加载那一刻。`

3. **突变检测阈值照抄工单，不改**（`src/pages/Timeline.tsx:459`）：
   > `// 突变检测：v > prev*1.8 且 v > 当日峰值*0.45（照抄工单公式，不改阈值）`

4. **视口安全带**（`src/pages/Timeline.tsx:122–134`）：数据变化导致 `totalVirt` 变化时越界复位 viewport，并用 `eslint-disable` 只依赖 `totalVirt`。

5. **gap 覆盖层 `left:200px` 须与 label 宽度一致**（`src/styles/timeline.css:497`）：
   > `/* 与 .swimlane-label 宽度一致，避开 App 名称列 */`

6. **灰化透明度为暂定值**（`src/styles/timeline.css:540–541`）：
   > `/* 区间取 0.12–0.25，先定 0.18，样式大改时再定最终值。 */`

7. **强度曲线视觉从简**（`src/styles/timeline.css:546`）：
   > `/* 活跃强度曲线 + 突变标记 —— 结构/数据正确即可，视觉从简（样式大改时再打磨） */`

### 9.3 疑似废弃代码

`src/styles/timeline.css` 第 **1–183 行**的旧 `.timeline` / `.timeline-list` / `.timeline-item` / `.timeline-dot` / `.session-card` / `.cat-bubble` 等类，在当前代码库中**无任何 TSX/TS 引用**（grep 验证仅 CSS 自身命中）。当前时间线页实际使用 `.swimlane-*` 系列（`Timeline.tsx:557` 起）。这些规则应属早期竖向时间线列表的遗留样式（**未确认**是否为刻意保留）。

---

## 10. Task 4 参数量化实测（2026-08-20）

> 方法：直接读真实库 `com.snoop.app/snoop.db`（经仓库根 `_snoop_link.db` 软链，6006 桶，
> 覆盖 2026-07-09 ~ 07-14，其中 07-11/12 无数据，实际 **4 个有数据日**）。用 `npx tsx` 调真实
> `buildAppLanes` + `quantizeLane`，按本地日分组、压缩开（compressed=true）、日视图全视图量化。

**跳变率定义**：对每条 lane，`跳变率 = (RLE 段数 − 1) / 有电平格数`。「有电平格数」= 量化后
非 null 的格数（null = 无覆盖，渲染为空轨道，不参与电平）；相邻同档格已被 RLE 合并，故「段数 − 1」
即相邻格电平跳变总次数。若改以 cellCount 为分母，值会整体低一个量级（约 0.02），此处取「有电平
格数」更能反映渲染出来的视觉噪点。

### 10.1 格宽（每格 ≈ 2 分钟）

4 个有数据日共 53 条 lane，日视图量化后（活跃 4 档）跳变率分布：

| 分位 | 跳变率 |
| --- | --- |
| 中位数 | **0.444** |
| p75 | 0.591 |
| p90 | 0.667 |
| p95 | 0.727 |
| 最大 | 0.800 |

**结论**：中位数 0.444，几乎贴着 0.45 判据（未严格超过），但 p75=0.591、p90=0.667——约 1/4 以上的
lane 跳变率明显超标、视觉偏噪。根因：典型 lane 有电平的格仅 ~6 格（中位数）、段数 ~5，「每格 ≈2 分钟」
把大量短会话（每 session 常 < 2min）拆成密集电平跳变。

### 10.2 档位数（活跃 4 档 → 2 档）

按修正 D，把活跃档从 4 档降到 2 档（1/2 → 低，3/4 → 高，挂机 0 不参与）重测：

| 分位 | 跳变率（2 档） |
| --- | --- |
| 中位数 | **0** |
| p75 | 0.054 |
| p90 | 0.182 |
| 最大 | 0.5 |

**结论**：降到 2 档后中位数归零、p90 仅 0.182，噪点基本消失。**只报数据，不自行改默认值。**
