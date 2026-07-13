import { useEffect, useState } from "react";
import { BarChart3, Clock, Keyboard, Lightbulb, Settings, Database, TestTube } from "lucide-react";

export type NavKey = "overview" | "timeline" | "keyboard" | "insights" | "settings" | "dev" | "keymap-test";

type NavItem = { key: NavKey; label: string; icon: React.ReactNode };

const MAIN_ITEMS: NavItem[] = [
  { key: "overview", label: "概览", icon: <BarChart3 size={18} /> },
  { key: "timeline", label: "时间线", icon: <Clock size={18} /> },
  { key: "keyboard", label: "键盘", icon: <Keyboard size={18} /> },
  { key: "insights", label: "洞察", icon: <Lightbulb size={18} /> },
];

const DEV_ITEMS: NavItem[] = [
  { key: "dev", label: "原始数据", icon: <Database size={18} /> },
  { key: "keymap-test", label: "键盘映射测试", icon: <TestTube size={18} /> },
];
const SETTINGS_ITEM: NavItem = { key: "settings", label: "设置", icon: <Settings size={18} /> };

type Props = {
  active: NavKey;
  onSelect: (k: NavKey) => void;
};

export default function Sidebar({ active, onSelect }: Props) {
  const [devMode, setDevMode] = useState(() => localStorage.getItem("dev_mode") === "true");

  useEffect(() => {
    const handleDevModeChange = (e: CustomEvent<boolean>) => {
      setDevMode(e.detail);
    };
    window.addEventListener("dev-mode-change", handleDevModeChange as EventListener);
    return () => window.removeEventListener("dev-mode-change", handleDevModeChange as EventListener);
  }, []);

  const renderItem = (item: NavItem) => (
    <button
      key={item.key}
      className={`sidebar-item ${active === item.key ? "is-active" : ""}`}
      onClick={() => onSelect(item.key)}
    >
      <span className="sidebar-item-icon">{item.icon}</span>
      <span className="sidebar-item-label">{item.label}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-header" data-tauri-drag-region>
        <h1 className="sidebar-brand" data-tauri-drag-region>Snoop</h1>
      </div>

      <nav className="sidebar-nav">
        {MAIN_ITEMS.map(renderItem)}
      </nav>

      {devMode && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">开发</div>
          {DEV_ITEMS.map(renderItem)}
        </div>
      )}

      <div className="sidebar-bottom">
        {renderItem(SETTINGS_ITEM)}
      </div>
    </aside>
  );
}
