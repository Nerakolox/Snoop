// 「AI」页 —— 服务 / 隐私 / 分类 / 记录 四区块，吸顶 Tab 栏切换。
//
// 内容本身全部搬自原设置页的 AISettings / AppCategories，本页只做布局：
// 吸顶分段控件切 tab，body 常驻 <AISettings tab={tab} />（组件内 state 不丢）。

import { useState } from "react";
import PageShell from "../components/PageShell";
import AISettings, { type AiTab } from "../components/ai/AISettings";

const TABS: { value: AiTab; label: string }[] = [
  { value: "service", label: "服务" },
  { value: "privacy", label: "隐私" },
  { value: "category", label: "分类" },
  { value: "log", label: "记录" },
];

export default function Ai() {
  const [tab, setTab] = useState<AiTab>("service");

  return (
    <PageShell
      className="ai-page"
      stickyHeader
      header={
        <div className="setting-segmented" role="tablist" aria-label="AI 区块">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              className={`setting-seg-btn ${tab === t.value ? "is-active" : ""}`}
              onClick={() => setTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <AISettings tab={tab} />
    </PageShell>
  );
}
