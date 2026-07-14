/**
 * 时间线顶部日期切换栏 —— 日期导航、回到今天、重置视图、压缩空白切换。
 */

import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Maximize2,
  Minimize2,
} from "lucide-react";

type TimelineHeaderProps = {
  dateLabel: string;
  isToday: boolean;
  /** 是否处于自定义视口（非"全视图"）。为 true 时展示"重置视图"按钮 */
  hasCustomViewport: boolean;
  compressed: boolean;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  onResetView: () => void;
  onToggleCompressed: () => void;
};

export default function TimelineHeader({
  dateLabel,
  isToday,
  hasCustomViewport,
  compressed,
  onPrevDay,
  onNextDay,
  onToday,
  onResetView,
  onToggleCompressed,
}: TimelineHeaderProps) {
  return (
    <div className="swimlane-date-picker">
      <button className="swimlane-nav-btn" onClick={onPrevDay} title="前一天">
        <ChevronLeft size={18} />
      </button>
      <div className="swimlane-date-label">
        <Calendar size={16} />
        <span>{dateLabel}</span>
      </div>
      <button
        className="swimlane-nav-btn"
        onClick={onNextDay}
        disabled={isToday}
        title="后一天"
      >
        <ChevronRight size={18} />
      </button>
      {!isToday && (
        <button className="swimlane-today-btn" onClick={onToday}>
          回到今天
        </button>
      )}
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
