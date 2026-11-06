# 设置页「关于」加 QQ 群社群入口 · 执行单

> 目标：在「设置 → 关于」里，紧挨现有的 GitHub 仓库行，加一个跳转 QQ 群的按钮。
> 只加一个 `SettingRow`，不动样式、不动布局。
>
> 核准日期：2026-11-06。以下现状均已 read 核实。

---

## 零、已核准的事实

### 0.1 现有外链的写法

`src/pages/Settings.tsx:781-790`（「关于」分组内、`开源仓库` 行）：

```tsx
        <SettingRow label="开源仓库">
          <button
            className="setting-btn"
            onClick={() => openUrl("https://github.com/Nerakolox/Snoop")}
          >
            <ExternalLink size={13} />
            GitHub
          </button>
        </SettingRow>
```

`openUrl` 已在 `src/pages/Settings.tsx:7` 从 `@tauri-apps/plugin-opener` 引入，无需新增依赖。

### 0.2 QQ 群链接（来自 README，不要改写）

`README.md:106`：

```
[点击链接加入群聊【Snoop的猫(Bug)窝】](https://qm.qq.com/q/PmKmgf3aQC)
```

- 群名：**Snoop的猫(Bug)窝**
- 邀请链接：`https://qm.qq.com/q/PmKmgf3aQC`

### 0.3 样式无需改动

- `SettingRow`（`Settings.tsx:55` 起）已支持 `label` / `desc` / 子元素。
- `.setting-btn`（`src/styles/settings.css:185`）就是 GitHub 按钮那套尺寸和间距。
- **不要**新增 CSS 类、不要改 `settings.css`。

---

## 一、改动清单（只有 1 个文件，2 处）

`src/pages/Settings.tsx`

### 1.1 lucide 图标导入加 `Users`（第 9-12 行）

**改前：**

```tsx
import {
  Sun, Moon, Monitor, Power, Minimize2,
  Download, Trash2, RefreshCw, Plus, X, ExternalLink, Code, Tags, ChevronRight,
} from "lucide-react";
```

**改后：**

```tsx
import {
  Sun, Moon, Monitor, Power, Minimize2,
  Download, Trash2, RefreshCw, Plus, X, ExternalLink, Code, Tags, ChevronRight,
  Users,
} from "lucide-react";
```

### 1.2 在 `开源仓库` 行之后插入社群行（约第 790 行）

**改前：**

```tsx
        <SettingRow label="开源仓库">
          <button
            className="setting-btn"
            onClick={() => openUrl("https://github.com/Nerakolox/Snoop")}
          >
            <ExternalLink size={13} />
            GitHub
          </button>
        </SettingRow>

        <SettingRow
          label="检查更新"
```

**改后：**

```tsx
        <SettingRow label="开源仓库">
          <button
            className="setting-btn"
            onClick={() => openUrl("https://github.com/Nerakolox/Snoop")}
          >
            <ExternalLink size={13} />
            GitHub
          </button>
        </SettingRow>

        <SettingRow label="社群" desc="Snoop的猫(Bug)窝 · 反馈与交流">
          <button
            className="setting-btn"
            onClick={() => openUrl("https://qm.qq.com/q/PmKmgf3aQC")}
            aria-label="加入 QQ 群"
          >
            <Users size={13} />
            QQ 群
          </button>
        </SettingRow>

        <SettingRow
          label="检查更新"
```

> 位置固定在 `开源仓库` 与 `检查更新` 之间，不要挪到别的分组。

---

## 二、验收

### 2.1 编译

```bash
npx tsc --noEmit
npm run build
```

（只要通过即可；本单没有 Rust 改动。）

### 2.2 真机 WKWebView（`npm run dev`）

1. 打开「设置 → 关于」：`社群` 行位于 `开源仓库` 下方、`检查更新` 上方。
2. 行内按钮外观与 `GitHub` 按钮一致（同高、同圆角、同字体、左图标右文字）。
3. 点击 `QQ 群`：系统默认浏览器打开 `https://qm.qq.com/q/PmKmgf3aQC`，
   **不**在应用内嵌窗口打开，也没有控制台报错。
4. 缩放窗口宽度：按钮不被挤压、不换行、不出现横向滚动条。
5. 亮/暗主题下按钮文字与图标清晰可读（沿用 `.setting-btn` 现有配色，不应有硬编码颜色）。

---

## 三、明确不在本单范围内

- **不要**改 `settings.css` / 新增任何样式类。
- **不要**改 PageShell、页面根 class、`--space-*` 间距。
- **不要**动 GitHub 行、检查更新行或其它分组。
- **不要**在 README 之外再发明群号 / 群链接 / 二维码。
- **不要**提交 commit（改完停下，等人工验证后再提交）。
