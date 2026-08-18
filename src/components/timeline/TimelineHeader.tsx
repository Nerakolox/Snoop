/**
 * 时间线顶部控制栏 —— 映射警示、上下文 chips、重置视图、压缩空白切换。
 * 日期导航已交给全局顶栏（`TopBar.tsx`），此处不再自管日期。
 */

import { Maximize2, Minimize2 } from "lucide-react";
import ContextChips from "../shared/ContextChips";

type TimelineHeaderProps = {
  /** adaptKind 降级警示；未降级为 null */
  note: string | null;
  appName?: string;
  /** 是否处于自定义视口（非"全视图"）。为 true 时展示"重置视图"按钮 */
  hasCustomViewport: boolean;
  compressed: boolean;
  onResetView: () => void;
  onToggleCompressed: () => void;
};

export default function TimelineHeader({
  note,
  appName,
  hasCustomViewport,
  compressed,
  onResetView,
  onToggleCompressed,
}: TimelineHeaderProps) {
  return (
    <div className="swimlane-date-picker">
      {note !== null && <span className="swimlane-header-note">{note}</span>}
      <ContextChips show={["app", "focusHour"]} appName={appName} />
      {hasCustomViewport && (
        <button
          className="swimlane-reset-btn"
          onClick={onResetView}
          title="重置视图"
        >
          <Maximize2 size={16} />
          <span>重置视图</span>
        </button>
      )}
      <button
        className="swimlane-compress-toggle"
        onClick={onToggleCompressed}
        title={compressed ? "切换到完整视图" : "切换到压缩视图"}
      >
        {compressed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
        <span>{compressed ? "展开空白" : "压缩空白"}</span>
      </button>
    </div>
  );
}
