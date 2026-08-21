/**
 * DatePicker —— 自研日期选择器（替代原生 <input type="date">）。
 *
 * 视觉复用全局 token（颜色/圆角/间距/字体），与 Tab、按钮同一套语言，深浅双态
 * 自动跟随 `data-theme`。行为：月份切换 + 年份快速跳转、禁用未来日期（可选禁用
 * 无数据日期）、方向键移动 / Enter 选中 / Esc 关闭、点击外部关闭。
 *
 * 定位用「相对容器 + 绝对弹层」（与 TopBar 应用筛选菜单同款），不 portal 到 body：
 * 弹层需紧贴触发器、随其滚动，portal + 手动定位反而要处理更多边界。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { formatAnchor, parseAnchor } from "../../data/ranges";
import { useToday } from "../../store/context";

/** 周一起，与应用其它处（aggregate.ts 的 mondayIndex）同约定。 */
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

interface DatePickerProps {
  /** 'YYYY-MM-DD'；空串显示 placeholder */
  value: string;
  onChange: (date: string) => void;
  /** 最早可选日期（含，'YYYY-MM-DD'）。默认无下限。 */
  minDate?: string;
  /** 最晚可选日期（含）。默认今天（useToday，全局当日基准）。 */
  maxDate?: string;
  /** 额外禁用某日期（返回 true 禁用），如「无数据」的日期。 */
  isDateDisabled?: (date: string) => boolean;
  placeholder?: string;
}

export default function DatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  isDateDisabled,
  placeholder = "选择日期",
}: DatePickerProps) {
  const today = useToday();
  const max = maxDate ?? today;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const d = parseAnchor(value || today);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [cursor, setCursor] = useState<string>(value || today);
  const [pickingYear, setPickingYear] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  function openPicker() {
    const d = parseAnchor(value || today);
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setCursor(value || today);
    setPickingYear(false);
    setOpen(true);
  }

  // 点击外部 / Esc 关闭。
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 打开后聚焦网格，方向键 / Enter 直接可用。
  useEffect(() => {
    if (open && !pickingYear) gridRef.current?.focus();
  }, [open, pickingYear]);

  function isDisabled(date: string): boolean {
    if (minDate && date < minDate) return true;
    if (date > max) return true;
    if (isDateDisabled && isDateDisabled(date)) return true;
    return false;
  }

  function select(date: string) {
    if (isDisabled(date)) return;
    onChange(date);
    setOpen(false);
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const d = parseAnchor(cursor);
    let next: Date | null = null;
    if (e.key === "ArrowLeft") next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    else if (e.key === "ArrowRight") next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    else if (e.key === "ArrowUp") next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
    else if (e.key === "ArrowDown") next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
    else if (e.key === "PageUp") next = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    else if (e.key === "PageDown") next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    else if (e.key === "Enter") { select(cursor); return; }
    else return;

    e.preventDefault();
    const s = formatAnchor(next);
    setCursor(s);
    setView({ year: next.getFullYear(), month: next.getMonth() });
  }

  // 6×7 网格：展示月首日对齐到周一起排。
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const offset = (first.getDay() + 6) % 7; // 周一=0
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) =>
      formatAnchor(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
    );
  }, [view]);

  // 年份快速跳转：以 max 年为上限，向下 20 年。
  const years = useMemo(() => {
    const top = parseAnchor(max).getFullYear();
    return Array.from({ length: 20 }, (_, i) => top - i);
  }, [max]);

  const maxD = parseAnchor(max);
  const canNextMonth =
    view.year < maxD.getFullYear() ||
    (view.year === maxD.getFullYear() && view.month < maxD.getMonth());

  const viewKey = `${view.year}-${String(view.month + 1).padStart(2, "0")}`;

  return (
    <div className="date-picker" ref={rootRef}>
      <button
        type="button"
        className={`date-picker__trigger${value ? " has-value" : ""}`}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="date-picker__trigger-text">{value || placeholder}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="date-picker__popover" role="dialog" aria-label="选择日期">
          <div className="date-picker__head">
            <button
              type="button"
              className="date-picker__nav"
              onClick={() => shiftMonth(-1)}
              aria-label="上个月"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="date-picker__head-label"
              onClick={() => setPickingYear((v) => !v)}
              title="点击快速跳转年份"
            >
              {view.year}年{view.month + 1}月
            </button>
            <button
              type="button"
              className="date-picker__nav"
              onClick={() => shiftMonth(1)}
              disabled={!canNextMonth}
              aria-label="下个月"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {pickingYear ? (
            <div className="date-picker__years">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  className={`date-picker__year${y === view.year ? " is-active" : ""}`}
                  onClick={() => {
                    setView((v) => ({ ...v, year: y }));
                    setPickingYear(false);
                  }}
                >
                  {y}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="date-picker__weekdays">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="date-picker__weekday">
                    {w}
                  </span>
                ))}
              </div>
              <div className="date-picker__grid" ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown}>
                {cells.map((date) => {
                  if (!date.startsWith(viewKey)) {
                    return <span key={date} className="date-picker__cell date-picker__cell--muted" />;
                  }
                  const disabled = isDisabled(date);
                  const cls = [
                    "date-picker__cell",
                    date === today ? "is-today" : "",
                    date === value ? "is-selected" : "",
                    date === cursor ? "is-cursor" : "",
                    disabled ? "is-disabled" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={date}
                      type="button"
                      className={cls}
                      disabled={disabled}
                      onClick={() => select(date)}
                    >
                      {parseAnchor(date).getDate()}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
