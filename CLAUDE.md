# Snoop 项目约定

## 提交信息
- 用中文写 commit message。
- 不加 Claude 署名 / Co-Authored-By 尾注。

## 主视图页面布局：PageShell
右侧主视图的所有页面级组件都用 `src/components/PageShell.tsx` 包裹，它是「视口顶 → 首个可见内容 = `var(--space-6)`」的唯一真源。样式在 `src/styles/page-shell.css`。

新增页面时：
- 根元素写 `<PageShell className="xxx-page" header={...} stickyHeader fill>`，页面根 class 只放布局，**绝不再写 padding**（顶距由 PageShell 提供，左右/底沿用 `--space-8` / `--space-6`）。
- 根 class 若要给内容区块加纵向间距，只写 `gap`（**不写 `display:flex`**），经 `.page-shell__body { gap: inherit }` 下传；否则会和 header 的 `margin-bottom` 叠加成双倍间距。
- `stickyHeader` 用于吸顶筛选栏（如 Keyboard）；`fill` 用于页面自管滚动（如 Timeline，内部由 `.swimlane-body` 滚动）。

不要动：
- `base.css` 的 `.app-shell` / `.app-right` / `.app-main` / `.page-layer`。
- `body[data-platform="macos"]` 下的红绿灯让位、`[data-platform="windows"]` 下的 titlebar。

引入于 commit ee042b8。
