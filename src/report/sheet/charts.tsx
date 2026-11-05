/**
 * 杂志版式的图表层 —— 全部手写 SVG / CSS，不引图表库。
 *
 * 设计口径与样稿一致：图表只负责「形状」，数字与文案由 `copy.ts` 给；
 * tooltip 只做悬浮补充，不进导出图（portal 到 body，截图节点里没有它）。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import type { CategorySnap, DailyReport, DayCell, HourCell, MonthWeek, CategoryHalfShift } from "../types";
import { formatDurationCompact } from "../../utils/format";
import { DOW_LABELS, dateLabel } from "../format";
import { renderNarrativeLine } from "../markup";
import { monthOffset } from "./copy";

// ── tooltip ─────────────────────────────────────────────────────────────────

type TipState = { x: number; y: number; text: string } | null;

function useTip() {
  const [tip, setTip] = useState<TipState>(null);
  return {
    tip,
    show: (x: number, y: number, text: string) => setTip({ x, y, text }),
    hide: () => setTip(null),
  };
}

function TipLayer({ tip }: { tip: TipState }) {
  if (!tip) return null;
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  return createPortal(
    <div
      className="rs-tip"
      role="status"
      style={{
        left: Math.max(8, Math.min(tip.x + 12, vw - 240)),
        top: Math.max(8, tip.y - 42),
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 「8h」「2h40」「40m」—— 柱顶标签专用，比 formatDurationCompact 短。 */
function hmShort(ms: number): string {
  const total = Math.floor(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return m > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  return `${m}m`;
}

/** 向上取整到 step 的倍数，至少 min。 */
function niceMax(value: number, step: number, min: number): number {
  return Math.max(min, Math.ceil(value / step) * step);
}

// ── 日报：逐小时柱状图 ──────────────────────────────────────────────────────

const HOURLY_W = 940;
const HOURLY_H = 236;
const HOUR_PLOT_LEFT = 30;
const HOUR_PLOT_RIGHT = 930;
const HOUR_BASELINE = 194;
const HOUR_TOP = 24;

export function HourlyChart({
  d,
  eveningPct,
  lead,
}: {
  d: DailyReport;
  eveningPct: number;
  lead?: string | null;
}) {
  const { tip, show, hide } = useTip();
  const maxMs = Math.max(...d.hourly.map((h) => h.active_ms), 1);
  const axisMaxMin = niceMax(maxMs / 60_000, 15, 30);
  const slot = (HOUR_PLOT_RIGHT - HOUR_PLOT_LEFT) / 24;
  const barW = 26;
  const yOf = (ms: number) =>
    HOUR_BASELINE - (ms / 60_000 / axisMaxMin) * (HOUR_BASELINE - HOUR_TOP);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(axisMaxMin * f));
  const eveningX = HOUR_PLOT_LEFT + 18 * slot;

  return (
    <>
      <div className="rs-chart-heading">
        <span>{lead ? renderNarrativeLine(lead) : "白天慢慢来，晚上连成片。"}</span>
        <small>每小时输入活跃 / 分钟</small>
      </div>
      <svg
        className="rs-chart"
        viewBox={`0 0 ${HOURLY_W} ${HOURLY_H}`}
        role="img"
        aria-label={`逐小时输入活跃：${d.peak_hour} 点达到峰值 ${Math.round(maxMs / 60_000)} 分钟。`}
        onPointerLeave={hide}
      >
        <rect
          x={eveningX}
          y={HOUR_TOP - 6}
          width={HOUR_PLOT_RIGHT - eveningX}
          height={HOUR_BASELINE - HOUR_TOP + 6}
          fill="#ede9ff"
        />
        <text
          x={(eveningX + HOUR_PLOT_RIGHT) / 2}
          y={HOUR_TOP - 12}
          textAnchor="middle"
          fontSize="10"
          fill="#6c5ce7"
        >
          晚间 · {Math.round(eveningPct * 100)}% 的活跃时间
        </text>

        {ticks.map((t) => {
          const y = yOf(t * 60_000);
          return (
            <g key={t}>
              <line
                x1={HOUR_PLOT_LEFT}
                x2={HOUR_PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke="#e2dfe8"
                strokeDasharray={t === 0 ? undefined : "3 4"}
              />
              <text x={HOUR_PLOT_LEFT - 9} y={y + 4} textAnchor="end" className="rs-axis">
                {t}
              </text>
            </g>
          );
        })}

        {d.hourly.map((h: HourCell) => {
          const x = HOUR_PLOT_LEFT + 5 + h.hour * slot;
          const y = yOf(h.active_ms);
          const height = Math.max(HOUR_BASELINE - y, h.active_ms > 0 ? 1.5 : 1);
          const evening = h.hour >= 18;
          // 品牌紫一个色相，用透明度区分白天 / 晚间；无记录走边框灰。
          const fill = h.active_ms <= 0 ? "#e2dfe8" : "#6c5ce7";
          const fillOpacity = h.active_ms <= 0 ? 1 : evening ? 1 : 0.34;
          const isPeak = h.hour === d.peak_hour && h.active_ms > 0;
          return (
            <g
              key={h.hour}
              className="rs-bar-group"
              tabIndex={0}
              onPointerMove={(e) =>
                show(
                  e.clientX,
                  e.clientY,
                  `${String(h.hour).padStart(2, "0")}:00—${String(h.hour + 1).padStart(2, "0")}:00 · ${formatDurationCompact(h.active_ms)}`,
                )
              }
              onFocus={(e) => {
                const r = (e.target as SVGGElement).getBoundingClientRect();
                show(r.left, r.top, `${String(h.hour).padStart(2, "0")}:00 · ${formatDurationCompact(h.active_ms)}`);
              }}
              onBlur={hide}
            >
              <rect
                className="rs-bar"
                x={x}
                y={y}
                width={barW}
                height={height}
                fill={fill}
                fillOpacity={fillOpacity}
                rx="1"
              />
              {h.hour % 3 === 0 && (
                <text x={x + barW / 2} y={HOUR_BASELINE + 22} textAnchor="middle" className="rs-axis">
                  {String(h.hour).padStart(2, "0")}
                </text>
              )}
              {isPeak && (
                <text
                  x={x + barW / 2}
                  y={y - 8}
                  textAnchor="middle"
                  fontSize="12"
                  fill="#6c5ce7"
                >
                  {Math.round(h.active_ms / 60_000)} 分
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <TipLayer tip={tip} />
    </>
  );
}

// ── 周报：七日柱状图 ────────────────────────────────────────────────────────

export function WeekBars({
  days,
  maxDay,
}: {
  days: DayCell[];
  maxDay: DayCell | null;
}) {
  const { tip, show, hide } = useTip();
  const maxMin = Math.max(...days.map((d) => d.active_ms / 60_000), 60);
  const axisMaxH = Math.ceil(maxMin / 60);
  const plotW = 570;
  const left = 30;
  const baseline = 222;
  const top = 30;
  const slot = plotW / 7;
  const barW = 46;
  const yOf = (ms: number) =>
    baseline - (ms / 3_600_000 / axisMaxH) * (baseline - top);
  const ticks = Array.from({ length: axisMaxH / 2 + 1 }, (_, i) => i * 2).filter(
    (t) => t <= axisMaxH,
  );

  return (
    <>
      <svg
        className="rs-chart"
        viewBox="0 0 610 264"
        role="img"
        aria-label="本周七天输入活跃时长。"
        onPointerLeave={hide}
      >
        <rect x={left + slot * 5} y={top - 8} width={slot * 2} height={baseline - top + 8} fill="#ede9ff" rx="3" />
        {ticks.map((t) => {
          const y = yOf(t * 3_600_000);
          return (
            <g key={t}>
              <line
                x1={left}
                x2={610}
                y1={y}
                y2={y}
                stroke="#e2dfe8"
                strokeWidth=".7"
                strokeDasharray={t ? "3 4" : undefined}
              />
              <text x={left - 13} y={y + 3} textAnchor="end" fill="#9b96a4" fontSize="9">
                {t}
              </text>
            </g>
          );
        })}
        {days.map((day, i) => {
          const x = left + 12 + i * slot;
          const y = yOf(day.active_ms);
          const height = Math.max(baseline - y, day.active_ms > 0 ? 2 : 0);
          const weekend = day.dow >= 5;
          const isMax = maxDay?.date === day.date;
          return (
            <g
              key={day.date}
              className="rs-bar-group"
              tabIndex={0}
              onPointerMove={(e) =>
                show(
                  e.clientX,
                  e.clientY,
                  `${DOW_LABELS[day.dow]} ${dateLabel(day.date)} · ${formatDurationCompact(day.active_ms)}`,
                )
              }
              onFocus={(e) => {
                const r = (e.target as SVGGElement).getBoundingClientRect();
                show(
                  r.left,
                  r.top,
                  `${DOW_LABELS[day.dow]} ${dateLabel(day.date)} · ${formatDurationCompact(day.active_ms)}`,
                );
              }}
              onBlur={hide}
            >
              <title>
                {DOW_LABELS[day.dow]}：{formatDurationCompact(day.active_ms)}
              </title>
              {day.active_ms > 0 ? (
                <>
                  <rect
                    className="rs-bar"
                    x={x}
                    y={y}
                    width={barW}
                    height={height}
                    fill="#6c5ce7"
                    fillOpacity={weekend ? 1 : 0.34}
                    rx="2"
                  />
                  <text
                    x={x + barW / 2}
                    y={y - 9}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight={isMax ? 600 : 400}
                    fill={isMax ? "#6c5ce7" : "#7b7686"}
                  >
                    {hmShort(day.active_ms)}
                  </text>
                </>
              ) : (
                <text x={x + barW / 2} y={y - 9} textAnchor="middle" fontSize="10" fill="#9b96a4">
                  —
                </text>
              )}
              <text x={x + barW / 2} y={244} textAnchor="middle" fontSize="10" fill="#5c5868">
                {DOW_LABELS[day.dow].replace("周", "")}
              </text>
              <text x={x + barW / 2} y={260} textAnchor="middle" fontSize="8" fill="#9b96a4">
                {dateLabel(day.date).replace("月", ".").replace("日", "")}
              </text>
            </g>
          );
        })}
      </svg>
      <TipLayer tip={tip} />
    </>
  );
}

// ── 周报：夜间结束点阵 ──────────────────────────────────────────────────────

export function NightDots({
  marks,
}: {
  marks: { dow: string; label: string; pos: number; weekend: boolean; overnight: boolean }[];
}) {
  if (marks.length === 0) {
    return <p className="rs-empty">这一周没有完整的结束时间记录。</p>;
  }
  return (
    <div className="rs-nights">
      {marks.map((m) => (
        <div key={m.dow} className={`rs-night-col${m.weekend ? " is-weekend" : ""}`}>
          <span>{m.dow}</span>
          <div className="rs-night-stem" aria-hidden="true">
            <i style={{ top: `${m.pos}%` }} />
          </div>
          <b>{m.label}</b>
        </div>
      ))}
    </div>
  );
}

// ── 月报：日历热力 ──────────────────────────────────────────────────────────

// 品牌紫的浅→深档：0 档 accent-soft，4 档 accent；空白天在 CSS 里走 surface-2。
const TONES = ["#ede9ff", "#ded8fb", "#bfb3f5", "#9583ec", "#6c5ce7"];

function toneOf(ms: number, max: number): { tone: string; ink: string } {
  if (ms <= 0) return { tone: "#f0eef3", ink: "#9b96a4" };
  const ratio = max > 0 ? ms / max : 0;
  const idx = ratio > 0.8 ? 4 : ratio > 0.6 ? 3 : ratio > 0.4 ? 2 : ratio > 0.2 ? 1 : 0;
  return { tone: TONES[idx], ink: idx >= 3 ? "#ffffff" : "#5c5868" };
}

export function MonthCalendar({ days }: { days: DayCell[] }) {
  const { tip, show, hide } = useTip();
  const max = Math.max(...days.map((d) => d.active_ms), 1);
  const first = days[0];
  const offset = first ? monthOffset(first.date) : 0;
  const maxDay = days.reduce(
    (a, b) => (b.active_ms > a.active_ms ? b : a),
    days[0] ?? null,
  );
  const [selected, setSelected] = useState<string | null>(maxDay?.date ?? null);
  const selectedDay = days.find((d) => d.date === selected) ?? maxDay;

  if (days.length === 0) return <p className="rs-empty">这个月没有逐日记录。</p>;

  return (
    <>
      <div className="rs-calendar" aria-label="本月每日输入活跃时长">
        {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
          <span key={w} className="rs-weekday">
            {w}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <div key={`e${i}`} className="rs-cal-empty" aria-hidden="true" />
        ))}
        {days.map((d) => {
          const tone = toneOf(d.active_ms, max);
          const dom = Number(d.date.slice(8, 10));
          return (
            <button
              key={d.date}
              type="button"
              className="rs-cal-cell"
              aria-pressed={d.date === selected}
              aria-label={`${dateLabel(d.date)}，${formatDurationCompact(d.active_ms)}`}
              style={{ background: tone.tone, color: tone.ink }}
              onClick={() => setSelected(d.date)}
              onPointerMove={(e) =>
                show(e.clientX, e.clientY, `${dateLabel(d.date)} · ${formatDurationCompact(d.active_ms)}`)
              }
              onPointerLeave={hide}
              onFocus={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                show(r.left, r.top, `${dateLabel(d.date)} · ${formatDurationCompact(d.active_ms)}`);
              }}
              onBlur={hide}
            >
              <b>{String(dom).padStart(2, "0")}</b>
              <span>{hmShort(d.active_ms)}</span>
            </button>
          );
        })}
      </div>
      <div className="rs-cal-detail" aria-live="polite">
        <span>
          {selectedDay
            ? `${dateLabel(selectedDay.date)} · 星期${DOW_LABELS[selectedDay.dow].replace("周", "")}`
            : "—"}
        </span>
        <strong>
          {selectedDay
            ? `${formatDurationCompact(selectedDay.active_ms)}${selectedDay.date === maxDay?.date ? " · 本月最高" : ""}`
            : "—"}
        </strong>
      </div>
      <div className="rs-heat-key">
        <span>少</span>
        {TONES.map((t) => (
          <i key={t} style={{ background: t }} />
        ))}
        <span>多</span>
        <span className="rs-heat-note">色深表示输入活跃时长</span>
      </div>
      <TipLayer tip={tip} />
    </>
  );
}

// ── 月报：按周趋势折线 ──────────────────────────────────────────────────────

export function WeekTrend({ weeks }: { weeks: MonthWeek[] }) {
  const shown = weeks.filter((w) => w.days_with_data > 0);
  if (shown.length === 0) return <p className="rs-empty">这个月没有按周的趋势。</p>;
  const maxMs = Math.max(...shown.map((w) => w.avg_daily_active_ms), 1);
  const axisMaxH = Math.max(2, Math.ceil(maxMs / 3_600_000));
  const left = 35;
  const right = 555;
  const baseline = 110;
  const top = 18;
  const step = shown.length > 1 ? (right - left) / (shown.length - 1) : 0;
  const yOf = (ms: number) => baseline - (ms / 3_600_000 / axisMaxH) * (baseline - top);
  const points = shown
    .map((w, i) => `${left + i * step},${yOf(w.avg_daily_active_ms)}`)
    .join(" ");

  return (
    <svg className="rs-chart" viewBox="0 0 600 145" role="img" aria-label="按周分组的日均输入活跃趋势。">
      <line x1={left - 10} x2={right + 25} y1={baseline} y2={baseline} stroke="#e2dfe8" />
      <polyline points={points} fill="none" stroke="#6c5ce7" strokeWidth="2" />
      {shown.map((w, i) => {
        const x = left + i * step;
        const y = yOf(w.avg_daily_active_ms);
        return (
          <g key={w.week_start}>
            <circle cx={x} cy={y} r="4" fill="#6c5ce7" />
            <text x={x} y={y - 11} textAnchor="middle" fontSize="11" fill="#6c5ce7">
              {hmShort(w.avg_daily_active_ms)}
            </text>
            <text x={x} y={baseline + 19} textAnchor="middle" fontSize="9" fill="#7b7686">
              {shortRange(w.clip_from, w.clip_to)}
              {w.partial ? "*" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function shortRange(from: string, to: string): string {
  const a = Number(from.slice(8, 10));
  const b = Number(to.slice(8, 10));
  return `${String(a).padStart(2, "0")}—${String(b).padStart(2, "0")}`;
}

// ── 月报：上下半月漂移 ──────────────────────────────────────────────────────

export function ShiftBars({
  shifts,
  nameOf,
}: {
  shifts: CategoryHalfShift[];
  nameOf: (id: string) => string;
}) {
  const shown = [...shifts].sort((a, b) => Math.abs(b.delta_pp) - Math.abs(a.delta_pp)).slice(0, 5);
  if (shown.length === 0) return <p className="rs-empty">这个月没有足够的两段数据。</p>;
  const maxShare = Math.max(
    ...shown.flatMap((s) => [s.first_half_share_pct, s.second_half_share_pct]),
    10,
  );
  const scale = Math.max(60, Math.ceil(maxShare / 10) * 10);

  return (
    <div className="rs-shift">
      <div className="rs-shift-head">
        <span>上半月 → 下半月</span>
        <span>分类占比</span>
      </div>
      {shown.map((s) => {
        const a = (s.first_half_share_pct / scale) * 100;
        const b = (s.second_half_share_pct / scale) * 100;
        const left = Math.min(a, b);
        const width = Math.abs(b - a);
        return (
          <div key={s.category} className="rs-shift-row">
            <span>{nameOf(s.category)}</span>
            <div className="rs-shift-track">
              <i className="rs-shift-link" style={{ left: `${left}%`, width: `${width}%` }} />
              <i className="rs-shift-dot" style={{ left: `${a}%` }}>
                <span>{Math.round(s.first_half_share_pct)}%</span>
              </i>
              <i className="rs-shift-dot is-new" style={{ left: `${b}%` }}>
                <span className="is-below">{Math.round(s.second_half_share_pct)}%</span>
              </i>
            </div>
            <strong className={s.delta_pp >= 0 ? "is-up" : "is-down"}>
              {s.delta_pp >= 0 ? "+" : "−"}
              {Math.abs(s.delta_pp).toFixed(0)} pp
            </strong>
          </div>
        );
      })}
    </div>
  );
}

// ── 分类条 ──────────────────────────────────────────────────────────────────

/** 日报：单份分类占比条（无基线）。 */
export function CategoryBars({ categories }: { categories: CategorySnap[] }) {
  const shown = categories.filter((c) => c.active_ms > 0).slice(0, 6);
  if (shown.length === 0) return <p className="rs-empty">今天没有分类记录。</p>;
  const max = Math.max(...shown.map((c) => c.share_pct), 1);
  return (
    <div className="rs-cats">
      {shown.map((c, i) => (
        <div key={c.id} className="rs-cat-row">
          <span>{c.name}</span>
          <div className="rs-cat-track">
            <div
              className="rs-cat-bar"
              style={{ width: `${(c.share_pct / max) * 100}%`, opacity: 1 - i * 0.12 }}
            />
          </div>
          <span className="rs-cat-value">{formatDurationCompact(c.active_ms)}</span>
        </div>
      ))}
    </div>
  );
}

/** 周报：分类占比 + 前四周基线标记。 */
export function CategoryDeltaBars({
  categories,
  deltas,
  showBaseline,
}: {
  categories: CategorySnap[];
  deltas: Map<string, number>;
  showBaseline: boolean;
}) {
  const shown = categories.filter((c) => c.active_ms > 0).slice(0, 6);
  if (shown.length === 0) return <p className="rs-empty">这一周没有分类记录。</p>;
  // 刻度必须把「前四周基线」也算进去：基线可能高于本周最高占比，否则标记会跑出轨道。
  const values = shown.flatMap((c) => {
    const delta = deltas.get(c.id);
    return delta != null ? [c.share_pct, c.share_pct - delta] : [c.share_pct];
  });
  const max = Math.max(...values, 1);
  const scale = Math.max(65, Math.ceil(max / 10) * 10);
  return (
    <div className={`rs-cats${showBaseline ? "" : " is-baseline-off"}`}>
      {shown.map((c, i) => {
        const delta = deltas.get(c.id);
        const baselineShare = delta != null ? c.share_pct - delta : null;
        return (
          <div key={c.id} className="rs-cat-row">
            <span>
              <i className="rs-cat-swatch" style={{ background: c.color }} />
              {c.name}
            </span>
            <div className="rs-cat-track">
              <div
                className="rs-cat-bar"
                style={{ width: `${(c.share_pct / scale) * 100}%`, opacity: 1 - i * 0.1 }}
              />
              {showBaseline && baselineShare != null && (
                <i
                  className="rs-cat-baseline"
                  style={{ left: `${Math.min(100, Math.max(0, (baselineShare / scale) * 100))}%` }}
                />
              )}
            </div>
            <span className="rs-cat-value">{Math.round(c.share_pct)}%</span>
            {showBaseline && delta != null && (
              <span className={`rs-cat-delta ${delta >= 0 ? "is-up" : "is-down"}`}>
                {delta >= 0 ? "+" : "−"}
                {Math.abs(delta).toFixed(1)}pp
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
