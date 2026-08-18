# Batch 4 · 输入页（原键盘页）

> 执行前先读 `docs/v2-工单-修订版.md` 的「全局约束」与「三条跨批语义」两节。
> 开工前：`git commit -m "chore: Batch 4 开工前存档"`

---

## 0 · 两条已定决策（先读，它们改变了原工单的形态）

### 0.1 ~~「布局改为左右两栏，右侧固定 266px 侧栏」~~ —— 作废

原工单要把页面切成「左键盘热力 + 右 266px 固定栏」。算过之后不成立：

现有缩放机制（`KeyboardPanel.tsx:56-65`）的可用宽算式：

```
usable = .kle-viewport 的 clientWidth − SCROLLBAR_RESERVE(1) − 2 × SCALER_PAD_X(8)
scale  = clamp(usable / (maxX × KEY_UNIT), MIN_SCALE, 1)      // KEY_UNIT=44, MIN_SCALE=0.55
```

104 配列 `maxX ≈ 22.5`，scale=1 需要约 **990px**，缩到下限 0.55 仍需 **545px**。

窗口最小宽 960px（`src-tauri/tauri.conf.json:20` 的 `minWidth`）。切成两栏后键盘可用宽约：

```
960 − 240(侧栏) − 266(右栏) − 32(gap) − 48(panel padding) ≈ 374px  <  545px
```

**键盘会永久带横向滚动条**，而它是这一页的主体。窗口要拉到 ~1130px 以上才正常。

加上「样式即将整体重构」，现在做布局重构等于做一遍扔一遍，还要重新承担缩放抖动的风险。

**所以：键盘继续占满宽，两块新内容（单键下钻、键鼠比）进现有的 `.kb-lower-section` 网格。**

### 0.2 顺带修一个反馈环：`.app-main` 加 `scrollbar-gutter: stable`

`src/styles/base.css:31-38` 的 `.app-main` 没有 `scrollbar-gutter`。页面级滚动条一出现，整页可用宽就少 10px，键盘跟着重算 scale。内容高度在临界点附近时会来回震荡。

在 `.app-main` 加一行：

```css
.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;   /* ← 新增：滚动条恒定占位，断开「内容高度变 → 滚动条切换 → 键盘重算 scale」的反馈环 */
  ...
}
```

代价：所有页面恒定少 10px 可用宽。收益：这类反馈环彻底消失。

> 这与 `.kle-viewport` 上已有的 `scrollbar-gutter: stable`（`keyboard.css:457`）是同一个思路，那里的注释把来龙去脉写得很清楚，可以对照读。

### 0.3 本批范围

| # | 内容 |
|---|---|
| C1 | 页面改名 + 接全局上下文（删页内 App 筛选与日期筛选） |
| C2 | 单键下钻 |
| C3 | 鼠标面板升级 + 键鼠比 |

**不做**：布局重构、右侧固定栏。

### 0.4 样式即将大改

新增元素做到结构正确、数据正确、可交互即可，**不打磨视觉**。不要为新元素重排 `keyboard.css` 的既有结构。

---

## 1 · C1：改名与接入全局上下文

### 1.1 页面改名 `keyboard` → `input`

`NavKey` 是字符串联合类型，**四个文件五处**要一起改，漏一处 TS 就会报错或运行时 undefined：

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/components/Sidebar.tsx` | `:4` | `NavKey` 联合类型里 `"keyboard"` → `"input"` |
| `src/components/Sidebar.tsx` | `:11` | `MAIN_ITEMS` 的 key 改 `"input"`，label 「键盘」→「输入」 |
| `src/App.tsx` | `:25` | `renderPage` 的 `case "keyboard"` → `case "input"` |
| `src/store/context.tsx` | `:33` | `PAGE_KIND_CAP` 的 key `keyboard` → `input` |
| `src/pages/Overview.tsx` | `:286` `:295` `:301` | 三张数字卡的 `target: "keyboard"` → `"input"` |

文件本身 `src/pages/Keyboard.tsx` **暂不改文件名**——改文件名会让 git 把整个文件当新增，diff 不可读，样式大改时再一起理。组件函数名 `Keyboard` 保留亦可，改成 `Input` 也行，但要同步 `App.tsx` 的 import。

侧栏图标沿用 `Keyboard`（lucide），或换成更中性的（如 `MousePointerClick`）——**这是视觉决定，样式大改时再定，本批不折腾**。

### 1.2 接全局上下文

```tsx
const { kind, anchor, appId, selectedKey } = useContextState();
const actions = useContextActions();
const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("input", { kind, anchor });
const range = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);
```

`PAGE_KIND_CAP.input = ["day","week","month"]`，永不降级，但仍照写 `adaptKind` 并渲染 `note`，保持各页结构一致。

**取数保持现有两段式，不接 `useRangeData`：**

- `fetchBucketsInRange(range)` → `allBuckets`（未筛选，鼠标面板与键鼠比要用到分 App 对比）
- `fetchKeyDetailsInRange(range, appId ?? undefined)` → 按键明细（Batch 0.5 已让它支持 app 参数）

> 键盘页的按键明细必须走后端 app 过滤，不能前端过滤——`key_details` 与 bucket 是分表的，前端拿不到关联。这是 Batch 0.5 存在的全部理由。

### 1.3 删除页内筛选控件

**`src/pages/Keyboard.tsx`：**

- 删第 1 行 App 筛选：`:274-292` 的 `.kb-filter-row--apps` 整块 + `appFilter` state（`:60`）+ `appFilterButtons` useMemo（`:254-264`）+ `appList` state（`:119`）
- 删第 2 行日期栏：`:295-352` 的 `.kb-filter-row--date` 整块 + `timeFilter`（`:61`）/ `selectedDate`（`:62`）/ `today`（`:78`）/ `isCurrentPeriod`（`:79`）/ `dateLabel`（`:86`）+ `goPrevPeriod`（`:153`）/ `goNextPeriod`（`:165`）/ `goToToday`（`:179`）+ `getTimeRange`（`:46`）+ `TIME_LABELS`（`:36`）
- **删 `:143` 的 `setAppFilter("all")`** —— 这行是全局化的直接障碍，Batch 0.5 时按工单保留至今，现在删
- `:197-207` 两个 useEffect 合并成一个，依赖改为 `[viewKind, viewAnchor, appId]`
- `:251` 的 `topPanelTitle` 改为随 `viewKind` 变（日/周/月），非当前区间时不写「今天」

**保留**：

- 第 3 行 `KLELayoutPicker`（`:355-357`）——**那是展示配置不是数据筛选，性质不同**。自定义配列导入、不支持特性警告全部保留。
- `refresh` 按钮可以留在配列那一行，或去掉（全局上下文变化会自动重拉）。留着更保险。
- `loading` / `showLoading` 的 200ms 延迟显示机制（`:209-221`）——防闪烁，别删。

**保留但要改**：`stickyHeader` 现在只剩配列一行，仍然保留 `stickyHeader`（内容变少不影响该机制）。

### 1.4 页头补充

- `note !== null` 时渲染映射警示
- `<ContextChips show={["app", "selectedKey"]} appName={appName} />`
  - `appName` 从 `allBuckets` 里找，找不到退回 `appId`

---

## 2 · C2：单键下钻

### 2.1 交互

点键盘上任意键 → 该键写入全局 `selectedKey`（`actions.setSelectedKey(label)`）→ 详情块显示该键数据。再点同一个键取消选中。

**位置：进 `.kb-lower-section` 网格**，与鼠标面板、Top 按键并列。不要在键盘正下方另开一块会撑高的区域。

> 原工单说「面板固定右栏，不要在键盘下方展开——会触发 ResizeObserver」。实际机制是 RO 观测 `.kle-viewport` 只读 `clientWidth`（`KeyboardPanel.tsx:47-73`），高度变化本身不影响它。真正的风险是高度变化导致**页面级滚动条切换**从而改变宽度——那条已由 §0.2 的 `scrollbar-gutter: stable` 堵死。所以进网格是安全的。

`selectedKey` 存的是**KLE 键标签**（如 `"E"`、`"Shift"`），与 `kleKeyCounts` 的 key 一致。查询时再转 rdev code。

### 2.2 数据

用 Batch 0.5 已建好的两个接口：

```ts
fetchKeyHourlyDistribution(keyCode, range, appId ?? undefined)  // → { hour_start, count }[]
fetchKeyAppDistribution(keyCode, range)                         // → { app_bundle_id, app_name, count }[]
```

`keyCode` 是 **rdev code 字符串**，由 `getLabelRdevCode(label)` 从 KLE 标签转出（`src/kleParser.ts:327`）。

内容：

1. 键名 + 该键在当前上下文（range × appId）下的总次数
2. 24 根时段分布迷你柱。`hour_start` 是「本地整点对应的 UTC ms」，`new Date(hour_start).getHours()` 直出本地小时
3. 跨应用分布 Top 3：`<AppIcon>` + 名称 + 条 + 次数。**这一块不受 appId 影响**（接口本身不接 app 参数），标题旁标注「不受应用筛选影响」
4. 未选中时显示空态引导文案

### 2.3 修饰键合并计数（这是一个数据修复，不只是 UI）

`src/kleParser.ts:232-241` 的映射表现状：

```ts
Shift: "ShiftLeft",   shift: "ShiftLeft",
Ctrl:  "ControlLeft", control: "ControlLeft",
Alt:   "Alt",         alt: "Alt",   option: "Alt",
Win:   "MetaLeft",    command: "MetaLeft",   "⌘": "MetaLeft",
```

左右两个 Shift 键帽的 KLE 标签都是 `"Shift"`，都映射到 `ShiftLeft`。**如果 rdev 实际会发出 `ShiftRight`，那些按键次数现在全部丢失了。**

本批要做：

1. **先查证**：开 Dev 页（原始数据）看 `key_details` 里实际出现过哪些 key_code，确认是否存在 `ShiftRight` / `ControlRight` / `AltGr` / `MetaRight`。**把查证结果写进 commit message。**
2. 若存在，在构建 `kleKeyCounts`（`Keyboard.tsx:235-244`）时按组求和：

```ts
const MERGED_GROUPS: Record<string, string[]> = {
  ShiftLeft:   ["ShiftLeft", "ShiftRight"],
  ControlLeft: ["ControlLeft", "ControlRight"],
  Alt:         ["Alt", "AltGr"],
  MetaLeft:    ["MetaLeft", "MetaRight"],
};
```

   把组名放 `src/analytics/keys.ts` 或 `kleParser.ts`，**不要写在组件里**。
3. UI：左右两个修饰键帽显示相同的合并数字。右侧那个**不可点**，tooltip 注明「与左侧合并计数」。

> 若查证结果是 rdev 从不发 `*Right`，第 2 步就不用做，但**第 3 步的 tooltip 仍要做**——两个键帽显示同一个数字，用户有权知道为什么。

---

## 3 · C3：鼠标面板升级 + 键鼠比

### 3.1 `MousePanel.tsx` 是升级，不是新建

`src/components/keyboard/MousePanel.tsx` 已存在（130 行），已经有：五分区着色的鼠标图形（`.mouse-shape` + `.mouse-btn--left/right` + `.mouse-wheel` + `.mouse-side--back/forward`）、下方 `<dl>` 统计列表、`bucketSimple` 着色。

**只改三处：**

1. **侧键为 0 时不再整块隐藏。** 现在 `:81` 和 `:113` 都是 `{(back > 0 || forward > 0) && ...}`，等于 0 就消失。改为：始终渲染，为 0 时降透明度 + 文案显示「未使用」。
2. **列表里任何为 0 的项都显示「未使用」并降透明度**，不只是侧键。
3. **侧键条件文案**：
   - `back + forward > 0` → 「你是会用侧键的少数人，配列里值得给它们留位置」
   - `= 0` → 「可以在配列里隐藏它们」

`mouseData` 的聚合逻辑、`wheel = middle + round(scrollDist/100)` 的口径、`travelKm` 的算法**一律不动**。

### 3.2 键鼠比（新）

```
ratio = 点击数 ÷ 按键数
点击数 = Σ(mouse_left + mouse_right + mouse_middle)
按键数 = Σ(key_total)
```

数据从 `allBuckets`（按 appId 过滤后）直接算，**不需要新接口**。

展示三件：

1. 大数字（保留两位小数）
2. 判定标签：`> 0.25` 鼠标型 / `< 0.08` 键盘型 / 其余均衡型
3. 一条从「偏键盘」到「偏鼠标」的滑块

**滑块位置必须对数映射：**

```ts
const pos = Math.min(1, Math.max(0, (Math.log10(ratio) + 1.6) / 2.2));
```

理由：这个比值在不同 App 间跨度约 60 倍（终端类 ~0.03，播放器类 ~1.7）。线性映射会把大半应用挤在最左端 2% 的区间里，完全失去分辨力。阈值可调但**必须是对数**。

边界：

- `按键数 === 0` → **不要除零**。显示「无按键数据」，滑块置灰不定位。
- `点击数 === 0 且 按键数 > 0` → ratio = 0，`log10(0) = -Infinity`，`clamp` 后是 0，落在最左端，语义正确。但要确认 `-Infinity` 不会渗进 style 里变成 `NaN%`——先判 `ratio <= 0` 直接取 0。

放在 `.kb-lower-section` 网格里。网格现在是两列（`keyboard.css:468` `minmax(0,1fr) minmax(0,1.2fr)`），加了单键下钻和键鼠比后变成四块，改成 `repeat(auto-fit, minmax(240px, 1fr))` 或明确的两行两列——**具体形态从简，样式大改时再定**。`@media (max-width: 900px)` 那条单列降级保留。

---

## 4 · 明确不做

- **不动 `KeyboardPanel.tsx` 的任何一行。** `KEY_UNIT` / `clientWidth` 测量 / `Math.floor` 量化 / `SCALE_EPSILON` 死区 / rAF 合并 / ResizeObserver 的观测对象与依赖数组，**一律不碰**。
- **不动** `src/layouts/metrics.ts`、`src/kleParser.ts` 的解析逻辑（§2.3 的映射表补充除外）。

### `KLEKeyboard.tsx` 的边界（修订：允许加交互 prop）

初版工单写的「`KLEKeyboard.tsx` 零改动」范围写窄了。准确的边界是：

**禁止改动 —— 尺寸模型（`KLEKeyboard.tsx:56-91`）**

- `layoutWidth` / `layoutHeight` 的计算
- `.kle-scaler` 的 `width: Math.round(layoutWidth * scale) + SCALER_PAD_X * 2`、`height`、`paddingLeft/Right`、`margin: "0 auto"`
- `.kle-keyboard` 的 `width` / `height` / `transform: scale(...)` / `transformOrigin` / `willChange`
- `.kle-viewport` 的 `viewportRef` 挂载与 `--scrollable` class 逻辑

这几行与 `KeyboardPanel` 的测量是一套配平过的东西，动一处就要重新验抖动。

**允许改动 —— 单键渲染（`:92-197`）**

该段本来就是外部驱动的：已有 `aria-label`、三个 `onMouse*`、以及 `pressedIndices?: Set<number>`（外部按 index 驱动单键视觉状态）。加交互 prop 是顺着既有设计走。

允许新增的 prop（保持最小）：

```ts
/** 点击某个键。index 与 keys 数组下标一致 */
onKeyClick?: (index: number, key: KLEKey) => void;
/** 当前选中的键（下标），用于加选中态 class */
selectedIndex?: number | null;
/** 不可点的键（下标集合），通常是右侧合并计数的修饰键 */
mergedIndices?: Set<number>;
/** 覆盖某个键的 title（右侧修饰键说明「与左侧合并计数」） */
keyTitles?: Record<number, string>;
```

渲染侧只加：`onClick`（`mergedIndices` 命中时不挂）、`title`、选中态 class；`keyStyle` 里**只允许改 `cursor`**（由 `onKeyClick && !merged` 决定 `pointer` / `default`），其余字段不动。

**不要用事件委托 + `closest()` 反查 DOM 序**。理由：`cursor: "default"` 是行内样式，命令式改要与行内样式打架；且 DOM 序等于数组序是巧合不是契约，样式大改一旦加包裹层或改渲染顺序，点击会**静默错位**。

**左右修饰键的区分**：左右 Shift 的 `key.label` 都是 `"Shift"`，按 label 分不出左右。用 `key.x` 判断——同 label 的多个键里 `x` 最小的是主键，其余进 `mergedIndices`。**这个判定在父组件算**，`KLEKeyboard` 只管渲染。
- **不动** `.kle-viewport` / `.kb-keyboard-section` 的任何 CSS，特别是 `scrollbar-gutter: stable`。
- **不改布局为左右两栏**（见 §0.1）。
- **不重命名** `src/pages/Keyboard.tsx` 文件。
- **不删** `TopKeysPanel`——原工单的右栏三块里没列它，但那是遗漏，它是现有功能。
- 不碰其他页面（除 §1.1 列的五处改名）。
- 不引新依赖。

---

## 5 · 一处待修的陈旧注释（顺手改）

`src/styles/keyboard.css:437-439` 写着：

> 键盘区域 —— ResizeObserver 观测对象。

但代码里 `ro.observe(vp)` 观测的是 `.kle-viewport`（`KeyboardPanel.tsx:73`），不是 `.kb-keyboard-section`。`KeyboardPanel.tsx:35-37` 的注释才是对的。

把 CSS 那段注释改对，免得后来者照着错的注释去"修复"。**只改注释，不改任何 CSS 规则。**

---

## 6 · 完工检查表

代码层：

- [ ] `npx tsc --noEmit` 无错误
- [ ] `git diff --stat` 确认 **`KeyboardPanel.tsx` / `layouts/metrics.ts` 未被修改**
- [ ] `git diff src/components/KLEKeyboard.tsx` 逐行确认：只动了 §4 允许的部分（新增 prop、`onClick`、`title`、选中态 class、`cursor`），**`:56-91` 的尺寸模型零改动**
- [ ] 全库 grep `"keyboard"` 作为 NavKey 的用法零残留（`styles/keyboard.css` 文件名不算）
- [ ] `Keyboard.tsx` grep `appFilter` / `timeFilter` / `selectedDate` / `getTimeRange` 零残留
- [ ] `Math.log10` 只出现在键鼠比一处，且有 clamp

**回归（重点——本批风险全在"别把缩放搞抖"）：**

- [ ] 慢慢拖动窗口宽度，从最大拖到 960px 再拖回去：键盘**平滑缩放，不抖动、不闪烁、尺寸不来回跳**
- [ ] 在临界宽度附近来回微调 ±5px：不出现无限抖动
- [ ] 切换配列（TKL ↔ 104 ↔ 自定义）：缩放正确，不残留上一个配列的尺寸
- [ ] 键盘横向滚动条只在窗口极窄时出现，正常宽度下不出现
- [ ] 键 hover 的阴影不被右侧裁切
- [ ] 加了 `scrollbar-gutter: stable` 后，**其他四个页面**排版没有异常（会恒定少 10px）

新功能：

- [ ] 顶栏切日/周/月，按键热力跟着变
- [ ] 顶栏选某个 App，热力图明显变化（走的是后端 app 过滤，不是前端折算）
- [ ] 顶栏翻 anchor，数据跟着变
- [ ] 点某个键 → 详情块出现该键数据；再点一次取消
- [ ] 详情块的时段分布 24 根柱，小时对得上（挑一个你记得的时段核对）
- [ ] 跨应用 Top 3 有数据，且标注了「不受应用筛选影响」
- [ ] 单键总次数 = 该键在热力图上 tooltip 显示的数字
- [ ] `ContextChips` 显示「单键 · E」，叉能清除，清除后详情块回到空态
- [ ] 左右 Shift 显示相同数字，右 Shift 不可点且 tooltip 说明合并计数
- [ ] 侧键为 0 时**仍然显示**（灰化 + 「未使用」），不是消失
- [ ] 键鼠比：切换不同 App，滑块**明显移动**且几个 App 分布在两端之间（不是全挤在最左）
- [ ] 找一个只用键盘的 App（如终端）和一个鼠标为主的（如播放器/浏览器），两者滑块位置差异明显
- [ ] 选一个没有按键数据的范围：显示「无按键数据」，不出现 NaN / Infinity

配列相关（回归）：

- [ ] KLE 配列选择器还在、能切
- [ ] 自定义配列导入还能用
- [ ] 不支持特性警告还会出现

主题：

- [ ] 浅色 / 深色各扫一遍
- [ ] 系统深色 + 手选浅色时页面是浅色

---

## 7 · 完工后停下

不要自动进入下一批。报告检查表结果，特别说明：

1. 「回归」那一组是否全过，尤其是**拖窗口宽度时键盘不抖**
2. §2.3 的查证结论：`key_details` 里到底有没有 `ShiftRight` / `ControlRight` / `AltGr` / `MetaRight`
