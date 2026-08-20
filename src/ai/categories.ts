// 应用分类的前端元数据 —— 类别值 / 中文名 / 展示色。
// 与后端 `Category` 枚举严格对齐（as_str / label）。改枚举必须同步这里。

export interface CategoryMeta {
  value: string;
  label: string;
  color: string;
}

// 颜色是新增的「分类色板」，刻意不复用时间线强度轴的单色渐变：
// 分类是离散互斥的类别，需要用可区分的独立色相，而不是同一个轴的深浅。
export const CATEGORIES: CategoryMeta[] = [
  { value: "development", label: "开发", color: "#3b82f6" },
  { value: "communication", label: "沟通", color: "#22c55e" },
  { value: "browsing", label: "浏览", color: "#06b6d4" },
  { value: "entertainment", label: "娱乐", color: "#ec4899" },
  { value: "design", label: "设计", color: "#8b5cf6" },
  { value: "document", label: "文档", color: "#f97316" },
  { value: "system", label: "系统", color: "#64748b" },
  { value: "remote", label: "远程控制", color: "#6366f1" },
  { value: "download", label: "下载工具", color: "#eab308" },
  { value: "other", label: "其他", color: "#94a3b8" },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

export const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.color]),
);
