/**
 * 键盘配列选择器 - 带 SVG 图标的切换组件
 */

import type { LayoutId } from "../keyboardLayouts";

type LayoutOption = {
  id: LayoutId;
  name: string;
  keys: number;
  icon: React.ReactNode;
};

const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    id: "60",
    name: "60%",
    keys: 61,
    icon: (
      <svg viewBox="0 0 60 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="4" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="8" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="12" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="16" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="20" width="56" height="3" rx="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "64",
    name: "64%",
    keys: 64,
    icon: (
      <svg viewBox="0 0 60 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="4" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="8" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="12" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="16" width="52" height="3" rx="1" fill="currentColor" />
        <rect x="56" y="14" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="2" y="20" width="48" height="3" rx="1" fill="currentColor" />
        <rect x="52" y="20" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="55" y="20" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="58" y="20" width="2" height="3" rx="0.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "75",
    name: "75%",
    keys: 84,
    icon: (
      <svg viewBox="0 0 68 26" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="62" height="2.5" rx="1" fill="currentColor" />
        <rect x="2" y="5.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="59" y="5.5" width="5" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="9.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="59" y="9.5" width="5" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="13.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="59" y="13.5" width="5" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="17.5" width="52" height="3" rx="1" fill="currentColor" />
        <rect x="56" y="16" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="59" y="17.5" width="5" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="21.5" width="48" height="3" rx="1" fill="currentColor" />
        <rect x="52" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="55" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="58" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "87",
    name: "TKL",
    keys: 87,
    icon: (
      <svg viewBox="0 0 80 26" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="62" height="2.5" rx="1" fill="currentColor" />
        <rect x="66" y="2" width="12" height="2.5" rx="1" fill="currentColor" />
        <rect x="2" y="5.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="5.5" width="8" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="9.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="9.5" width="8" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="13.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="17.5" width="52" height="3" rx="1" fill="currentColor" />
        <rect x="56" y="16" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="60" y="19" width="8" height="1.5" rx="0.5" fill="currentColor" />
        <rect x="2" y="21.5" width="48" height="3" rx="1" fill="currentColor" />
        <rect x="52" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="55" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="58" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "96",
    name: "96%",
    keys: 98,
    icon: (
      <svg viewBox="0 0 88 26" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="62" height="2.5" rx="1" fill="currentColor" />
        <rect x="66" y="2" width="20" height="2.5" rx="1" fill="currentColor" />
        <rect x="2" y="5.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="5.5" width="26" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="9.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="9.5" width="26" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="13.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="13.5" width="26" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="17.5" width="52" height="3" rx="1" fill="currentColor" />
        <rect x="56" y="16" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="60" y="17.5" width="26" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="21.5" width="48" height="3" rx="1" fill="currentColor" />
        <rect x="52" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="55" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="58" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "104",
    name: "100%",
    keys: 104,
    icon: (
      <svg viewBox="0 0 92 26" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="62" height="2.5" rx="1" fill="currentColor" />
        <rect x="66" y="2" width="8" height="2.5" rx="1" fill="currentColor" />
        <rect x="76" y="2" width="14" height="2.5" rx="1" fill="currentColor" />
        <rect x="2" y="5.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="5.5" width="8" height="3" rx="1" fill="currentColor" />
        <rect x="70" y="5.5" width="20" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="9.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="60" y="9.5" width="8" height="3" rx="1" fill="currentColor" />
        <rect x="70" y="9.5" width="20" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="13.5" width="56" height="3" rx="1" fill="currentColor" />
        <rect x="70" y="13.5" width="20" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="17.5" width="52" height="3" rx="1" fill="currentColor" />
        <rect x="56" y="16" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="70" y="17.5" width="20" height="3" rx="1" fill="currentColor" />
        <rect x="2" y="21.5" width="48" height="3" rx="1" fill="currentColor" />
        <rect x="52" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="55" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
        <rect x="58" y="21.5" width="2" height="3" rx="0.5" fill="currentColor" />
      </svg>
    ),
  },
];

type LayoutPickerProps = {
  value: LayoutId;
  onChange: (id: LayoutId) => void;
};

export default function LayoutPicker({ value, onChange }: LayoutPickerProps) {
  return (
    <div className="layout-picker">
      {LAYOUT_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`layout-option${value === opt.id ? " is-active" : ""}`}
          onClick={() => onChange(opt.id)}
          aria-label={`${opt.name} 配列，${opt.keys} 键`}
          title={`${opt.name} (${opt.keys}键)`}
        >
          <div className="layout-icon">{opt.icon}</div>
          <div className="layout-label">{opt.name}</div>
        </button>
      ))}
    </div>
  );
}
