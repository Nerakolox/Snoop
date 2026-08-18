import { X } from "lucide-react";
import { useContextState, useContextActions } from "../../store/context";

interface ContextChipsProps {
  /** 要显示哪几类 chip，由页面决定 */
  show: Array<"app" | "focusHour" | "selectedKey">;
  /** 已筛选 App 的显示名（页面传，组件不自己查） */
  appName?: string;
}

export default function ContextChips({ show, appName }: ContextChipsProps) {
  const { appId, focusHour, selectedKey } = useContextState();
  const actions = useContextActions();

  const chips: { key: string; label: string; onClear: () => void }[] = [];

  if (show.includes("app") && appId !== null) {
    chips.push({
      key: "app",
      label: `应用 · ${appName ?? appId}`,
      onClear: () => actions.setApp(null),
    });
  }
  if (show.includes("focusHour") && focusHour !== null) {
    chips.push({
      key: "focusHour",
      label: `定位 · ${focusHour}:00`,
      onClear: () => actions.setFocusHour(null),
    });
  }
  if (show.includes("selectedKey") && selectedKey !== null) {
    chips.push({
      key: "selectedKey",
      label: `单键 · ${selectedKey}`,
      onClear: () => actions.setSelectedKey(null),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="context-chips">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="context-chip"
          onClick={c.onClear}
        >
          <span>{c.label}</span>
          <X size={12} />
        </button>
      ))}
    </div>
  );
}
