# Batch 6 · 收尾 · 执行文档

> 总纲条目见 `docs/v2-工单-修订版.md` 「Batch 6 · 收尾」。本篇是可执行版本，与总纲冲突时以本篇为准。
> 开工前先 `git commit`（存档点），完工后停下等人工验证，不连做样式整体重构。

---

## 0 · 先读：本批的前置决策

原工单五条里，第 2 条（托盘小窗共用状态）在盘点后确认现状是**从零开始的新功能**，其余四条本批实做。以下是实做过程中要澄清的判断，均不违反总纲的三条跨批语义与全局约束。

### 0.1 托盘小窗——本批不做，理由写死

`src-tauri/src/lib.rs` 现状（grep 确认）：只有 `TrayIconBuilder` 建的托盘图标，处理左键点击（显隐主窗）与右键菜单，**没有任何 `WebviewWindow::builder` 构建的托盘弹窗**。工单原话「跨 WebviewWindow 共用意味着实时状态得走 Tauri event 而不是 React state，不是半天的活」——这条估工结论现在被验证为准确：这不是"改造现有小窗"，而是"设计一个新窗口 + 新的 Tauri event 广播机制 + 新窗口自己的一套渲染"，工作量与本批其余四条不在一个量级。**按工单自带的逃生舱口，本批只做侧栏，托盘另开一批。**

### 0.2 「此刻」是搬家，不是复制

`docs/v2-交接-改造路程.md` §5.2 第 2 条记录的 bug——Overview 的「此刻」卡用的是**筛选后**的 `buckets`，导致筛选到某 App 时若你正用别的 App 会显示「挂机中」，而这个卡本该是 LIVE、与筛选正交的——**在搬家时随构造自然消失**：新组件常驻侧栏，不接受 `appId`，固定读全量桶。不是"顺手改一下"，是搬家这个动作本身就让 bug 无处附着。

### 0.3 新状态命名与眼睛映射（判断调用，写死不再问）

工单原话：「猫头 SVG，四种状态对应三种眼睛（睁/眯/闭）」+「状态标签…四态：爆肝中 / 正常节奏 / 摸鱼中 / 挂机中」。

现有 `analytics/intensity.ts` 的 `Intensity` 是 0-4 五档（強度单一真相，不可修改）。四态标签要求比五档少一档，映射：

| Intensity | 状态标签 | 眼睛 |
|---|---|---|
| 0 | 挂机中 | 闭 |
| 1 | 摸鱼中 | 眯 |
| 2 | 正常节奏 | 睁 |
| 3、4 | 爆肝中 | 睁 |

3/4 合并成一档"爆肝中"是工单自己的四态要求（强度算法本身仍是五档，只是这个标签展示层做了折叠，不影响 `computeIntensity` 单一真相）。2 与 3/4 共用"睁眼"——工单自己说的是三种眼睛对四种状态，必然有一档共享，"正常节奏"和"爆肝中"看起来都该是清醒睁眼，用呼吸圆点的颜色/标签文字区分档位，眼睛只负责"是否有精神"这一个维度。

`src/analytics/constants.ts` 现有 `MOOD_LABELS`（5 档字典）**全项目零消费者**（grep 确认，唯一用途就是即将删除的 Overview 此刻卡），直接删除，换成两个新的纯函数 `moodLabelOf` / `eyeStateOf`（4 态折叠逻辑写在这两个函数里，全项目唯一入口，不得在组件里另写 if）。

`CAT_QUIPS` / `pickCatQuip` / `RECENT_ACTIVITY_WINDOW_MS` **保留**——新组件继续用，只是调用方从 `Overview.tsx` 换成新的 `SidebarLive.tsx`。

### 0.4 交互一致性巡检结论：大部分已合规，本批只修真缺口

逐条对照工单第 3、4 条，结论：

| 巡检项 | 结论 |
|---|---|
| 所有可点行用 `.drillable` | ✅ 已合规（grep 全项目 `.drillable` 用法，Overview/Insights/Timeline 的可点行都已挂载，真 `<button>`） |
| 所有走 `navigate` 的跳转弹 toast | ✅ 已合规（Batch 1-5 期间已是既定纪律，本次复核未发现漏项） |
| 可点元素为真 button 或 tabindex+role+键盘处理 | ✅ 已合规，全站可点元素排查下来都是真 `<button>` |
| focus-visible 有可见轮廓 | 🔴 **一处缺口**：`src/styles/settings.css` 的 `.setting-toggle { outline: none; }` 没有配套的 focus-visible 替代样式（对照组 `.setting-ignore-input` 同样 `outline:none` 但有 `:focus { border-color: ... }` 兜底，`.setting-toggle` 没有）。本批修。 |
| 统一 `data-tt`/`data-tt-title` tooltip 约定 | ⚠️ **工单要求的东西不存在**：全项目 grep `data-tt` 零命中，现状是原生 `title=` 属性（占绝大多数）+ Timeline/Keyboard 各自的富提示组件（各自文件内闭环，不跨页复用）。现在发明一整套新 tooltip 组件系统属于**样式基础设施**，违反"样式整体重构留到最后"的排期决定，也不在"半天工期"量级内。本批**不新建 tooltip 组件**，只确认现有原生 `title=` 用法本身没有互相打架（复核结论：没有）。这条工单条目实际上该在样式重构时处理，此处记录不做的理由，不是漏做。 |
| 空态文案（该范围无数据时给下一步指引，不只显示 0） | 🔴 **一处缺口**：`TopKeysPanel.tsx` 空态文案是「还没有数据」，没给下一步。其余面板（`RatioPanel` 的"无按键数据"、`MousePanel` 逐项"未使用"降级、Overview 的 `noDataReason()`、Timeline 的 `swimlane-empty`、Insights 的"这段范围还没有足够的数据"）复核后**均已给出原因或替代展示，判定合规**，不需要跟着改一遍。 |

结论：本批 C2 只精确修这两处，不是重写空态系统或造新组件。

### 0.5 拖拽区处理沿用侧栏既有写法，不引入 TopBar 那一套

`Sidebar.tsx` 现有的 `.sidebar-item` 按钮排除拖拽的方式是纯 CSS：`base.css:314` 的 `-webkit-app-region: no-drag`，**没有**额外挂 `data-tauri-drag-region="false"` 属性（这点和 `TopBar.tsx` 大量使用该属性的写法不一样，是两处历史上独立发展出的写法，都在跑，互不冲突）。新组件里的可点元素（吐槽换一句的点击区）**沿用侧栏已验证的 CSS-only 方案**，不额外挂属性，避免在同一个文件里出现两套排除拖拽的写法。

---

## 1 · C1：侧栏底部实时区

### 1.1 `src/analytics/constants.ts` —— 删 `MOOD_LABELS`，加两个映射函数

删除（第 13-20 行）：

```ts
/** 强度等级 → 状态标签映射 */
export const MOOD_LABELS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "挂机中",
  1: "摸鱼中",
  2: "正常节奏",
  3: "认真工作",
  4: "爆肝模式",
};
```

原位替换为：

```ts
import type { Intensity } from "./types";

/** 侧栏实时区的四态标签——五档强度折叠成四态，3/4 合并为"爆肝中"（工单原话）。 */
export function moodLabelOf(intensity: Intensity): string {
  if (intensity >= 3) return "爆肝中";
  if (intensity === 2) return "正常节奏";
  if (intensity === 1) return "摸鱼中";
  return "挂机中";
}

/** 猫头三态眼睛——2 与 3/4 共用"睁"，靠呼吸圆点/标签文字区分档位，眼睛只管"有没有精神"。 */
export function eyeStateOf(intensity: Intensity): "open" | "squint" | "closed" {
  if (intensity >= 2) return "open";
  if (intensity === 1) return "squint";
  return "closed";
}
```

文件顶部加 `import type { Intensity } from "./types";`（现状文件顶部没有任何 import，是纯常量文件）。

### 1.2 新建 `src/components/sidebar/CatMascot.tsx`

极简 SVG，纯展示，`eyeState` 决定眼睛画法。不做阴影/渐变/精修——这批和之前所有批次一样，只做"结构正确、可交互即可"，视觉留给最后的样式整体重构。

```tsx
type Props = {
  eyeState: "open" | "squint" | "closed";
  className?: string;
};

export default function CatMascot({ eyeState, className }: Props) {
  return (
    <svg
      viewBox="0 0 48 48"
      width="32"
      height="32"
      className={className}
      aria-hidden
    >
      {/* 耳朵 */}
      <path d="M10 14 L16 4 L20 16 Z" fill="currentColor" opacity="0.85" />
      <path d="M38 14 L32 4 L28 16 Z" fill="currentColor" opacity="0.85" />
      {/* 头 */}
      <circle cx="24" cy="26" r="16" fill="currentColor" opacity="0.85" />
      {/* 眼睛：睁=圆点，眯=细横线，闭=弧线 */}
      {eyeState === "open" && (
        <>
          <circle cx="18" cy="25" r="2" fill="var(--color-surface)" />
          <circle cx="30" cy="25" r="2" fill="var(--color-surface)" />
        </>
      )}
      {eyeState === "squint" && (
        <>
          <rect x="15" y="24.5" width="6" height="1.5" rx="0.75" fill="var(--color-surface)" />
          <rect x="27" y="24.5" width="6" height="1.5" rx="0.75" fill="var(--color-surface)" />
        </>
      )}
      {eyeState === "closed" && (
        <>
          <path d="M15 25 Q18 27.5 21 25" stroke="var(--color-surface)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M27 25 Q30 27.5 33 25" stroke="var(--color-surface)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
```

`currentColor` 走父级 `color`（下面 `.sidebar-live-mascot` 里设置成 `var(--color-accent)`），深浅色自动继承，不需要额外的 `[data-theme="dark"]` 规则。

### 1.3 新建 `src/components/sidebar/SidebarLive.tsx`

```tsx
/**
 * 侧栏底部常驻实时区 —— LIVE，不受任何页面的范围/App 筛选影响。
 * 固定读"今天"的全量桶（appId=null），故意不接全局上下文。
 */

import { useEffect, useMemo, useState } from "react";
import { computeIntensity, eyeStateOf, moodLabelOf, pickCatQuip, RECENT_ACTIVITY_WINDOW_MS } from "../../analytics";
import { formatAnchor } from "../../data/ranges";
import { useRangeData } from "../../data/useRangeData";
import CatMascot from "./CatMascot";

export default function SidebarLive() {
  const today = formatAnchor(new Date());
  const { buckets: allBuckets, refetch } = useRangeData("day", today, null);

  useEffect(() => {
    const timer = setInterval(() => refetch(), 30_000);
    return () => clearInterval(timer);
  }, [refetch]);

  const status = useMemo(() => {
    const nowTs = Date.now();
    const recent = allBuckets.filter((b) => nowTs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS);
    if (recent.length === 0) {
      return { appName: "", intensity: 0 as const };
    }
    const byApp = new Map<string, number>();
    for (const b of recent) {
      byApp.set(b.app_name || b.app_bundle_id, (byApp.get(b.app_name || b.app_bundle_id) || 0) + (b.duration_ms || 0));
    }
    const dominant = [...byApp.entries()].sort((a, b) => b[1] - a[1])[0];
    return { appName: dominant[0], intensity: computeIntensity(recent) };
  }, [allBuckets]);

  const [rerollTick, setRerollTick] = useState(0);
  const quip = useMemo(
    () => pickCatQuip(status.intensity, status.appName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status.intensity, status.appName, rerollTick]
  );

  return (
    <div className="sidebar-live">
      <div className="sidebar-live-top">
        <CatMascot eyeState={eyeStateOf(status.intensity)} className="sidebar-live-mascot" />
        <div className="sidebar-live-status">
          <span className={`sidebar-live-dot sidebar-live-dot--${status.intensity}`} aria-hidden />
          <span className="sidebar-live-label">{moodLabelOf(status.intensity)}</span>
        </div>
        <span className="sidebar-live-badge">LIVE · 不随范围变</span>
      </div>
      <button
        type="button"
        className="sidebar-live-quip"
        style={{ ["-webkit-app-region" as string]: "no-drag" }}
        onClick={() => setRerollTick((t) => t + 1)}
        title="点击换一句"
      >
        {quip}
      </button>
    </div>
  );
}
```

要点：

- `today` 每次渲染都重新算（不用 `useMemo(() => ..., [])`），30 秒轮询触发的重渲染会顺带让跨午夜后的 anchor 自愈——这是刻意与 `Overview.tsx:150` 的 `useMemo(() => new Date(), [])`（挂账 §5.2 第 7 条）不同的写法，新代码不必复刻旧代码已知的小瑕疵，但**不回头去改 Overview 那处**（不在本批范围，属于"顺手多改"）。
- `computeIntensity(recent)` 类型是 `Intensity`（0-4 联合类型），`status.intensity` 在 `recent.length === 0` 分支手写 `0 as const` 保证两个分支类型一致。
- 呼吸圆点用 `sidebar-live-dot--${status.intensity}` 5 个类（0-4），不是 4 个——颜色可以五档细分，即使标签折叠成四态，这是允许的（标签折叠不代表颜色也要折叠，工单没要求颜色只分四档）。
- `-webkit-app-region: no-drag` 通过内联 style 而不是新增 CSS 类规则也可以，但为了和 `.sidebar-item` 保持同一种写法（写在 CSS 里，不写内联），下面 1.4 的 CSS 改用类选择器，**这里的内联写法仅为草稿说明其必要性，实现时删掉内联 style，改成 CSS 类里加 `-webkit-app-region: no-drag`**（见 1.4）。

> 写手在真正落这段代码时，把 `sidebar-live-quip` 的内联 `style` 那行删掉，靠 1.4 里 `.sidebar-live-quip` 类自带 `-webkit-app-region: no-drag` 即可，不要两处都写。

### 1.4 `src/styles/base.css` —— `.sidebar-bottom` 改造 + 新增实时区样式

现状（`base.css:281-291`）：

```css
.sidebar-bottom {
  margin-top: auto;
  padding: var(--space-4) var(--space-3) var(--space-6);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

@media (prefers-color-scheme: dark) {
  .sidebar-bottom {
    border-top-color: rgba(255, 255, 255, 0.08);
  }
}
```

改为（加 flex 列 + gap，让 `SidebarLive` 和 `设置` 项之间有间距；`@media` 保留原样——这是历史遗留写法，本批不新增违反 `[data-theme]` 约定的规则，但也不去修这一处已存在的旧写法，不在本批范围内）：

```css
.sidebar-bottom {
  margin-top: auto;
  padding: var(--space-4) var(--space-3) var(--space-6);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
```

新增实时区样式块（追加在 `.sidebar-item-label` 规则之后，即文件当前的 sidebar 区块末尾）：

```css
.sidebar-live {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3);
}

.sidebar-live-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.sidebar-live-mascot {
  color: var(--color-accent);
  flex-shrink: 0;
}

.sidebar-live-status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.sidebar-live-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  animation: sidebar-live-breathe 2s ease-in-out infinite;
}

.sidebar-live-dot--0 { background: var(--intensity-0); }
.sidebar-live-dot--1 { background: var(--intensity-1); }
.sidebar-live-dot--2 { background: var(--intensity-2); }
.sidebar-live-dot--3 { background: var(--intensity-3); }
.sidebar-live-dot--4 { background: var(--intensity-4); }

@keyframes sidebar-live-breathe {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-live-dot { animation: none; }
}

.sidebar-live-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-live-badge {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-3);
  white-space: nowrap;
  flex-shrink: 0;
}

.sidebar-live-quip {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  text-align: left;
  font-size: var(--text-xs);
  color: var(--color-text-3);
  font-style: italic;
  line-height: 1.4;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.sidebar-live-quip:hover {
  color: var(--color-text-2);
}
```

`--intensity-0..4` 与 `--space-*` 都是既有 token，不新增变量。`.sidebar-live-badge` 用 `margin-left: auto` 顶到行右侧，宽度不够时侧栏本来就是定宽（`--sidebar-width`），若显示挤压属已知边界，不在本批处理（侧栏宽度是样式重构的事）。

### 1.5 `src/components/Sidebar.tsx` —— 接入

加 import：

```tsx
import SidebarLive from "./sidebar/SidebarLive";
```

`.sidebar-bottom` 内容从：

```tsx
<div className="sidebar-bottom" data-tauri-drag-region>
  {renderItem(SETTINGS_ITEM)}
</div>
```

改为：

```tsx
<div className="sidebar-bottom" data-tauri-drag-region>
  <SidebarLive />
  {renderItem(SETTINGS_ITEM)}
</div>
```

放在设置项**上方**——现成槽位从下往上读是"呼吸区在上、设置固定在最底"，符合"设置是收尾项"的既有直觉，且更靠近侧栏主体，猫更显眼。

### 1.6 `src/pages/Overview.tsx` —— 删除「此刻」卡

删除以下几处（行号以搬家前的现状为准，实际操作时按内容匹配，不要死抠行号——中间步骤的删除会让后续行号偏移）：

1. **Import**：`MOOD_LABELS`、`computeIntensity`、`RECENT_ACTIVITY_WINDOW_MS`、`pickCatQuip` 四个从 `../analytics` 的具名导入删除。`AppIcon`、`intensityVar`、`type Intensity` 继续保留（`Intensity` 类型在文件其余处仍被 `AppRow`/`Kpi` 之类用到，删除前先确认——若删完 `NowStatus` 后 `Intensity` 再无引用则一并删除该 type import，写手落地时用 `tsc --noEmit` 兜底，未使用的 import 会报错，删不干净会立刻暴露）。
2. **`NowStatus` type**（文件顶部，`type NowStatus = {...}` 整块）删除。
3. **`now` state**：`const [now, setNow] = useState<NowStatus>({...})` 整块删除。
4. **计算 `now` 的 `useEffect`**（依赖 `[isLive, buckets]` 那个，从 `if (!isLive) return;` 到结尾 `}, [isLive, buckets]);`）整块删除。
5. **渲染块**：`{isLive && (<section className="now-card">...</section>)}` 整块删除。

**保留不动**：`isLive` 常量定义（`kind === "day" && anchor === formatAnchor(new Date())`）与它下面那个 30 秒轮询 `useEffect`——那个轮询驱动的是页面自己的 `refetch()`（`useRangeData` 数据刷新），跟此刻卡是两件事，此刻卡删除后轮询继续服务页面数据本身的实时性。

### 1.7 `src/styles/overview.css` —— 删除 now-card 样式块

删除第 73-142 行（从注释 `/* ① 此刻状态 —— 猫的舞台 ------- */` 到 `.now-quip` 规则结束），紧接着的第 144 行 `/* ② KPI 一排 ------- */` 及之后原样保留。删除后建议把 `/* ② KPI 一排 */` 的注释改成 `/* ① KPI 一排 */`（序号跟着往前挪一位，避免留下"① 去哪了"的断层）——顺带把文件顶部第 2 行注释 `四段纵向：now-card / kpi-row / panel(App 榜) / panel(热力条)。` 改成 `三段纵向：kpi-row / panel(App 榜) / panel(热力条)。`。

---

## 2 · C2：交互一致性补丁 + 空态文案

### 2.1 `src/styles/settings.css` —— `.setting-toggle` 补 focus-visible

现状（约第 103-114 行）：

```css
.setting-toggle {
  width: 40px;
  height: 22px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--color-surface-2);
  cursor: pointer;
  position: relative;
  transition: background var(--dur-fast) var(--ease-smooth);
  padding: 0;
  outline: none;
}
```

`outline: none` 后面补一条新规则（不改这块本身，紧接着加）：

```css
.setting-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

### 2.2 `src/components/keyboard/TopKeysPanel.tsx` —— 空态文案加下一步引导

现状第 34-36 行：

```tsx
{topKeys.length === 0 && (
  <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>还没有数据</div>
)}
```

改为：

```tsx
{topKeys.length === 0 && (
  <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>
    这段范围还没有按键记录，换个时间范围或清除应用筛选试试
  </div>
)}
```

### 2.3 巡检结论存档（不改代码）

见 §0.4 表格，本节不重复。`data-tt` 统一 tooltip 约定明确本批不做，理由已写死在 §0.4，留给样式整体重构。

---

## 3 · 明确不做

- **托盘小窗共用状态**（原工单第 2 条）——另开一批，理由见 §0.1。
- **统一 `data-tt` tooltip 组件**——现状不存在这套东西，本批不新建，理由见 §0.4。留给样式整体重构。
- 以下文件保持 Batch 3/4 定下的隔离边界，本批不涉及：`Timeline.tsx`、`src/components/timeline/*`、`timeline.css`、`analytics/timeline.ts`、`KeyboardPanel.tsx`、`KLEKeyboard.tsx`、`layouts/metrics.ts`、`Dev.tsx`。
- `docs/v2-交接-改造路程.md` §5.1 记录的样式崩坏、§5.2 第 3/4/5/6/7/8/9/10 条挂账——按既定排期留给样式整体重构，本批不顺手修。
- `Overview.tsx:329` 的 `nowLabel = useMemo(() => new Date(), [])`（挂账 §5.2 第 7 条）——`SidebarLive.tsx` 用了不同写法（每次渲染重算），但**不回头改 Overview 这处**，避免本批范围蔓延。

---

## 4 · 完工检查表

### 代码层（可自查）

- [ ] `npx tsc --noEmit` 全过
- [ ] `MOOD_LABELS` 已删除，`grep -r MOOD_LABELS src/` 零命中
- [ ] `moodLabelOf` / `eyeStateOf` 在 `analytics/constants.ts` 定义，`analytics/index.ts` barrel 自动导出（`export * from "./constants"` 已存在，不用改 barrel）
- [ ] `Overview.tsx` 里 `NowStatus`、`now` state、对应 `useEffect`、`now-card` JSX 均已删除，`isLive` 与它的轮询 `useEffect` 仍在
- [ ] `overview.css` 的 `.now-*` 规则块已删除
- [ ] `Sidebar.tsx` 引入并渲染 `SidebarLive`，位置在设置项上方
- [ ] `SidebarLive` 不接受也不读取 `appId`（`git diff` 确认组件内没有 `useContextState`/`appId` 字样）
- [ ] `.setting-toggle:focus-visible` 规则已加
- [ ] `TopKeysPanel` 空态文案已更新
- [ ] `git diff` 确认 `Timeline.tsx` / timeline 相关文件 / `KeyboardPanel.tsx` / `KLEKeyboard.tsx` / `Dev.tsx` 零改动

### 回归（需人工，`npm run tauri dev`）

- [ ] 侧栏在任意页面（概览/时间线/输入/规律/设置）都能看到实时区，切页不消失、不重置动画
- [ ] Overview 页面「此刻」卡已消失，页面其余内容（KPI/App 排行/节奏区）显示正常
- [ ] 深浅色各看一遍侧栏实时区（含猫头 `currentColor`、呼吸点五档颜色、quip 文字）
- [ ] macOS 下侧栏拖拽区仍然可用（若有 macOS 环境）；点击 quip 文案不触发窗口拖拽

### 新功能验证

- [ ] 有活动时（最近 2 分钟内有桶）：猫眼睁开或眯着，状态标签随强度变化，quip 与当前 App 相关
- [ ] 无最近活动（挂机 2 分钟以上）：猫眼闭上，标签「挂机中」
- [ ] 点击 quip 文案能换一句（多点几次应出现不同句子，允许小概率重复——`pickCatQuip` 是随机抽取，不保证不重复）
- [ ] **验证 §5.2 第 2 条 bug 已修**：在输入页或时间线筛选到某个 App（比如筛到 Chrome），此时用其他 App（比如切到 VSCode 打字），侧栏实时区应显示"爆肝中/正常节奏"等真实状态，而不是被筛选值污染成「挂机中」——这是本批唯一一处功能性 bug 修复，务必测
- [ ] `.setting-toggle` 用 Tab 键聚焦，能看到可见的焦点轮廓（设置页 → 深色模式开关之类）
- [ ] 输入页在数据为空的范围下，TopKeysPanel 显示新文案（可临时切到一个肯定没数据的历史日期验证）

### 边界

- [ ] 应用刚启动、`allBuckets` 为空时（新用户/清空数据后）侧栏实时区不报错，猫眼闭合，quip 走 intensity=0 的池子
- [ ] 跨午夜后（若能等到或手动改系统时间测试）侧栏 anchor 自愈，不需要重启应用

---

## 5 · 完工后停下

按协作纪律，代码层跑完、检查表代码层与回归项目自查后，**停下等人工在 `tauri dev` 里验证**，不自动往下做样式整体重构。

验证通过后：

1. `docs/v2-工单-修订版.md` 的进度表 Batch 6 一行改成「✅ 完成（commit 范围，功能验收待人工做）」
2. `docs/v2-交接-改造路程.md`：
   - 第三节补 Batch 6 逐批记录（仿 Batch 5 的写法：commit 拆分、盘点中的判断调用、遗留问题）
   - §5.2 第 2 条标记为已解决（仿第 1 条的写法）
   - §6.2「尚未开始的功能批次」删除 Batch 6 段落
   - §6.3 依赖关系图的 `6 → [样式重构]` 改成 `6 ✅ → [样式重构]`
   - 第一节「当前进度」摘要更新，指向"功能批次全部完成，下一步是样式整体重构"
