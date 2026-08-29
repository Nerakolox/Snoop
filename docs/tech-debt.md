# 技术债务清单（待还的债）

> 只记录，不是现在要做的事。当相关代码要动、或用户反馈问题时，从这里取。
> 「手写 FFI 敞口清单」单独记在 `docs/macos-notes.md`，本清单放**非 FFI 的通用债务**。
> 「已还的债」一节保留历史，方便日后回溯「这个坑当年是怎么填的」，不要再当新债处理。

## 已还的债

### macOS Keychain use-after-free（换 security-framework）

- 详见 `docs/macos-notes.md`「Keychain 崩溃」。根因是手写 CF FFI 的
  `CFDictionaryCreateMutable(..., NULL, NULL)` 没让 value 被 retain，却在返回前提前
  `CFRelease` 两个 CFString，`SecItemCopyMatching` 复制查询字典时撞野指针 → EXC_BAD_ACCESS。
- 修复：手写 CF FFI 全部换成 `security-framework` crate 的泛型口令接口，CF 对象生命周期
  交给 crate 管理，类型层面杜绝 use-after-free。
- 来源：AI 安全存储（Key 存 OS 凭证库）。

### 时长口径命名不一致（前台 vs 活跃）

- 概览页 KPI 曾标「活跃时长」却算 `unionDurationMs` = 前台墙钟（不筛输入），与报告页定义的
  「活跃时长 = 有输入」同名异义，同一个词指向两个数。
- 修复：概览 KPI 改名「前台时长」；「活跃时长」一词固定给「有输入」口径。两处数字各得一个
  诚实的名字，不再误导。
- 来源：批次 4a（报告页 + 日报）。

### 分类占比跨页口径分歧（概览前台 vs 报告有输入）

- 概览 `get_category_breakdown` 原按 `duration_ms` 直接求和（前台口径），报告按 `is_active()`
  过滤（有输入口径），同一天两个页面给出的分类占比对不上。
- 修复：统一到有输入口径——概览改用 `SUM(CASE WHEN {ACTIVE_PREDICATE} THEN duration_ms ELSE 0 END)`，
  `ACTIVE_PREDICATE` 上提到 `db.rs` 作单一来源（概览/报告共用，不再两处各写一份）；概览分类占比
  标题旁标注「按活跃时长统计」。
- 来源：统一时长口径命名（小批次）。

### 按键/鼠标采集把系统自动重复计为多次输入

- 现象：按住某键不放时，操作系统在初始延迟后持续补发 KeyPress（自动重复）。采集层把每一次
  补发都当成独立按键计数，导致长按类操作（方向键滚动、退格连删、游戏中长按移动）产生巨量虚假
  计数；实测 → 键单日 88,106 次、占总按键 92%。
- 根因：`activity_tracker.rs` 的 `handle_input_event` 对每个 `KeyPress` / `ButtonPress` 无条件
  +1，没有区分「从未按下 → 按下」的下降沿与自动重复。
- 修复：维护按下状态集合（物理键码 → 按下时刻）。只有按下沿才计一次，抬起移出集合；超过 30 秒
  无任何事件的卡死键强制清出（兜底窗口失焦 / 系统休眠丢失抬起事件）。长按独立统计
  （`long_press_count` / `long_press_duration_ms` 落 `activity_buckets`，暂不在界面展示），不混入
  总按键数；鼠标按键同逻辑。
- **数据口径警示**：本次修复**之前**的输入统计包含自动重复计数，**跨越修复时点的周期对比不可信**；
  历史数据无法区分真实敲击与自动重复，不做回溯修正（存量桶的长按两列恒为 0）。
- 来源：长按自动重复计数修复（工单）。

## 仍欠的债（按优先级）

### 1. macOS 键鼠采集可能完全失效 —— rdev CFRunLoop 线程错位（最高，需验证）

- 现象：`activity_tracker.rs:292` 用 `thread::spawn` 跑 `rdev::listen`。rdev 在 macOS 上把
  CGEventTap 的 source 加进**主线程** run loop，却 `CFRunLoopRun()` 跑**当前线程**（spawn 出来的
  这个线程）自己的 loop。source 挂在 main loop 上、没人去跑 main loop，事件可能永远不被派发 →
  macOS 上键鼠桶 key/mouse 全 0、时间线无暖色、输入页无数据。**当前开发机是 Windows，从未在
  Mac 上跑过，现状未确认。**
- 影响：若成立，macOS 版的「采集」核心功能是坏的，且静默无报错（`listen` 正常返回、每桶全 0，
  与 `macos.rs:19-23` 的授权静默失效注释同源——都是「看起来正常、实际采不到」）。
- 建议修法：先在真 Mac 上验证——看时间线色块有没有暖色、输入页有没有数据。确认后要么把 rdev
  监听挪回主线程，要么换/封装 rdev 的 macOS 实现。
- 优先级：最高（决定 macOS 是否能用）。

### 2. 批次 5（猫的嘴替）与批次 6（周报月报）从未真机运行验证

- 现象：两个批次上线后没做过运行时验证，数据不足、渲染效果未知。
- 影响：可能藏着只有真机/真实数据才暴露的问题（周报作息模块、猫吐槽批量生成、侧栏实时状态）。
- 建议修法：在 Mac + Windows 各跑一轮真实采集数据，逐页核对报告与侧栏。
- 优先级：中高。

### 3. 概览分类占比图零值行占位

- 现象：零值分类不出现在图例里，导致不同周期图例行数跳动。
- 影响：图例布局不稳定。
- 建议修法：图例按分类数固定占位，零值置灰但保留行位。
- 优先级：低。
- 备注：原「配色硬编码 Tailwind hex、不随主题切换」一条已解决 —— 分类色改为每个分类
  自己的 OKLCH 色相（只存 hue，L/C 由主题层给），实时视图取色统一走 `categories/store`
  的 `fillOf`，硬编码色板文件 `ai/categories.ts` 已删除。（报告不走这条路，见第 8 条。）

### 4. AI 页输入框对齐

- 现象：服务配置的 base_url / model / API Key 三行输入框走 `.ai-row-right--field`（固定 320px），
  与整页其它「label + toggle」行的右缘/宽度对齐仍有毛边。
- 影响：视觉毛边。
- 建议修法：统一 `.ai-row-right--field` 与普通 `.ai-row-right` 的对齐规则。
- 优先级：低。

### 5. 侧栏猫无法区分「人不在」与「人在但无键鼠输入」

- 现象：两种完全不同的情况都算成「挂机中」——近 2 分钟没有桶（人离开电脑）vs 有桶但 EPM ≤ 0
  （人在，但在开会/读文档/看视频）。数据上其实可区分：前者 `recent.length === 0`，后者有桶但
  EPM ≤ 0（`SidebarLive.tsx:28-41` → `computeIntensity` `intensity.ts:126-137`）。
- 影响：0 档文案对后一种情况说错话——人就在屏幕前，猫却说「静悄悄，去哪了喵？」。这与报告页
  「不把无输入时间说成负面」是同一条原则，只是侧栏还没落实。
- 建议修法：侧栏状态从单一 `intensity` 扩成 `(intensity, presence)`，presence 区分
  away / present-silent，0 档文案按 presence 分两组。
- 优先级：低。

### 6. platform/macos.rs 重度 unsafe（能跑，记录备查）

- 现象：红绿灯偏移 + 前台 App + NSWorkspace 观察者整段是 `objc`/`cocoa` 的 unsafe 消息 + 运行时
  ClassDecl 注册 + static 钉生命周期 + autorelease pool 手管。详细敞口清单见
  `docs/macos-notes.md`「手写 FFI 敞口清单」。
- 影响：能跑，但任一生命周期/线程假设被打破都可能闪退。当前开发机是 Windows，无法本地验证。
- 建议修法：保持现状，备查；改动 macOS 平台代码前先读 macos-notes.md。
- 优先级：低（记录备查）。

### 7. 报告导出走 SVG foreignObject，平台原生截图是退路（已记录）

- 现象：导出成图（批次 7）用前端自截图——SVG `<foreignObject>` 包真实 DOM → canvas → PNG →
  Rust 写盘。当时「Rust 开隐藏窗口 + 截图」原方案走不通：`tauri-2.11.5` / `wry-0.55.1` 源码里
  screenshot/capture/snapshot/print-to-image 全部 0 命中；官方 `tauri-plugin-screenshot` 是新依赖
  且只截整屏、不支持隐藏窗口。
- 影响：foreignObject 渲染保真度依赖 WebView 实现，跨平台/跨版本可能有差异；本批已用「只用安全
  CSS 特性 + 方版叙事改字符截断」提前规避，但**没有双平台真机验证**。
- 建议修法：若真遇保真度问题，退路是平台原生截图（Windows `ICoreWebView2::CapturePreview` /
  macOS `WKWebView.takeSnapshotWithConfiguration:`），需把 wry 提为直接依赖 + 双平台真机验证——
  正是本批主动避开的路径。只有 foreignObject 确实跑不通才回头。
- 优先级：低。

### 8. 报告快照未完全自包含：周月的 pp 差仍从 data_json 取

- 现象：报告快照（`report/snapshot.rs` 的 `CategorySnap`）存了分类 id、显示名、解析后的色值、
  活跃时长、占比五项。但周报分类行的 `share_delta_pp`（vs 前 4 周的百分点差）和月报
  「上半月 vs 下半月」的 `delta_pp` 不在其中，`ReportCard` 仍从 `data_json` 取这两个数，
  只有名字和配色走快照。
- 影响：**当前无正确性问题**。`data_json` 本身就是生成时算好落库的，与快照同一时刻凝固、
  同生命周期，所以两边取数的结果一致，「已生成的报告不受后续分类变更影响」照样成立。
  代价只在结构上：快照不是一份能脱离 `data_json` 独立渲染的完整数据，将来若要把快照
  单独导出（分享一份报告数据、迁移到别的展示端），得连 `data_json` 一起带走。
- 建议修法：真需要自包含时，给 `CategorySnap` 加一个可选的 `share_delta_pp`，
  由 `build` 从 `data_json` 的分类项里一并读进来（周报的 `CategoryDelta` 本来就有这个字段，
  日报月报没有，故为 `Option`）；月报的 `half_shift` 是另一套形状，需要单开一个数组。
  不做这一步之前，别把「快照 = 报告的全部展示数据」当成已经成立的前提。
- 优先级：低（结构整洁性，不是缺陷）。
- 来源：报告生成时快照（分类冻结）。
