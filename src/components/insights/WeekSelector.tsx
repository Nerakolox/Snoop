/**
 * 洞察页周选择器 —— 复用键盘页小号样式
 */

import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";

type WeekSelectorProps = {
  weekLabel: string;
  isCurrentWeek: boolean;
  onPrevWeek: () => void;
  onNextWeek: () => void;
};

export default function WeekSelector({
  weekLabel,
  isCurrentWeek,
  onPrevWeek,
  onNextWeek,
}: WeekSelectorProps) {
  return (
    <div className="kb-filter-row kb-filter-row--date">
      <div className="kb-date-picker">
        <button
          className="kb-nav-btn"
          onClick={onPrevWeek}
          title="上一周"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="kb-date-label">
          <Calendar size={14} />
          <span>{weekLabel}</span>
        </div>
        <button
          className="kb-nav-btn"
          onClick={onNextWeek}
          disabled={isCurrentWeek}
          title="下一周"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
