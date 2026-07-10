/**
 * 洞察 —— 跨天使用回顾
 * 以周为粒度：猫周报吐槽 + 本周活跃趋势柱状图 +
 * App 排行（带环比）+ 一周 x 24 小时作息热力网格。
 * 全 mock 数据。
 */

import { useMemo } from "react";
import type { CSSProperties } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Sparkles,
} from "lucide-react";

type Intensity = 0 | 1 | 2 | 3 | 4;

type WeekDay = {
  short: string; // 一二三四五六日
  long: string; // 周一…周日
  hours: number; // 当天活跃小时
};

type WeekApp = {
  name: string;
  hours: number;
  intensity: Intensity;
  /** 环比上周：> 0 上升，< 0 下降，null 视作持平 */
  deltaPct: number | null;
};

// ---- mock 数据 --------------------------------------------------------------

const WEEK_TOTAL_HOURS = 38;
const WEEK_DAILY_AVG = 5.4;

const WEEK: WeekDay[] = [
  { short: "一", long: "周一", hours: 5.2 },
  { short: "二", long: "周二", hours: 6.1 },
  { short: "三", long: "周三", hours: 8.3 },
  { short: "四", long: "周四", hours: 4.0 },
  { short: "五", long: "周五", hours: 6.5 },
  { short: "六", long: "周六", hours: 2.0 },
  { short: "日", long: "周日", hours: 3.0 },
];

const WEEK_APPS: WeekApp[] = [
  { name: "Chrome", hours: 14, intensity: 1, deltaPct: 20 },
  { name: "VSCode", hours: 9, intensity: 4, deltaPct: -8 },
  { name: "终端", hours: 6, intensity: 4, deltaPct: 5 },
  { name: "QQ", hours: 3, intensity: 2, deltaPct: -15 },
  { name: "微信", hours: 2, intensity: 2, deltaPct: null },
  { name: "Figma", hours: 1.5, intensity: 3, deltaPct: 30 },
];

const CAT_REPORT =
  "这周你一共活跃了 38 小时，其中 Chrome 占了 14 小时——比上周还多，我们真的需要谈谈。不过周三那天你在 VSCode 爆肝了 6 小时，算你厉害。";

/**
 * 一周 × 24 小时作息强度矩阵。7 行 × 24 列。
 * 工作日集中在 9–12、14–18、20–23；周末更晚起更晚睡；凌晨基本静默。
 * 值域 0..4，直接映射到 --intensity-*。
 */
const HOURLY_GRID: Intensity[][] = [
  // 周一
  [0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 4, 3, 1, 2, 3, 4, 4, 3, 1, 2, 3, 3, 2, 0],
  // 周二
  [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 4, 2, 2, 4, 4, 3, 3, 1, 2, 3, 3, 2, 1],
  // 周三
  [0, 0, 0, 0, 0, 0, 0, 1, 3, 4, 4, 4, 2, 3, 4, 4, 4, 4, 2, 3, 4, 4, 3, 1],
  // 周四
  [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 3, 1, 1, 2, 3, 2, 2, 0, 1, 2, 2, 1, 0],
  // 周五
  [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 3, 2, 2, 3, 4, 3, 3, 2, 3, 4, 3, 2, 1],
  // 周六
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 2],
  // 周日
  [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 1, 1, 2, 2, 2, 3, 3, 3, 2, 1],
];

const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

// ---- 工具 -------------------------------------------------------------------

function intensityVar(level: Intensity) {
  return `var(--intensity-${level})`;
}

/** 把小时数（含小数）格式化为 "X 小时" 或 "X.X 小时"。 */
function fmtHours(h: number) {
  return Number.isInteger(h) ? `${h}` : h.toFixed(1);
}

// ---- 渲染 -------------------------------------------------------------------

export default function Insights() {
  const maxDay = useMemo(
    () => Math.max(...WEEK.map((d) => d.hours), 1),
    []
  );

  return (
    <div className="ins-page">
      {/* ① 猫的周报吐槽 —— 顶部通栏 */}
      <section className="ins-report">
        <div className="ins-report-avatar" aria-hidden>
          <Sparkles size={20} />
        </div>
        <div className="ins-report-body">
          <div className="ins-report-title">猫的周报</div>
          <p className="ins-report-text">{CAT_REPORT}</p>
          <div className="ins-report-chips">
            <span className="ins-chip">
              <span className="ins-chip-num">{WEEK_TOTAL_HOURS}</span>
              <span className="ins-chip-unit">小时 · 本周活跃</span>
            </span>
            <span className="ins-chip">
              <span className="ins-chip-num">{WEEK_DAILY_AVG}</span>
              <span className="ins-chip-unit">小时 · 日均</span>
            </span>
          </div>
        </div>
      </section>

      {/* ②③ 中间左右分栏：趋势图 · App 排行 */}
      <div className="ins-split">
        {/* ② 本周活跃趋势 */}
        <section className="panel ins-trend-panel">
          <h3 className="panel-title">本周活跃趋势</h3>
          <div className="ins-trend">
            {WEEK.map((d) => {
              const pct = (d.hours / maxDay) * 100;
              // 柱子强度：按天时长在本周内相对占比映射
              const level: Intensity =
                pct >= 85 ? 4 : pct >= 65 ? 3 : pct >= 40 ? 2 : 1;
              const barStyle: CSSProperties = {
                height: `${pct}%`,
                background: intensityVar(level),
              };
              return (
                <div key={d.short} className="ins-trend-col">
                  <div className="ins-trend-bar-wrap">
                    <div className="ins-trend-bar" style={barStyle}>
                      <span className="ins-trend-tip">
                        {fmtHours(d.hours)} 小时
                      </span>
                    </div>
                  </div>
                  <div className="ins-trend-label">{d.short}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ③ 本周 App 排行 + 环比 */}
        <section className="panel ins-apps-panel">
          <h3 className="panel-title">本周 App 排行</h3>
          <div className="ins-apps">
            {WEEK_APPS.map((a) => {
              const pct = (a.hours / WEEK_APPS[0].hours) * 100;
              return (
                <div key={a.name} className="ins-app-row">
                  <div className="ins-app-name">{a.name}</div>
                  <div className="app-row-track">
                    <div
                      className="app-row-fill"
                      style={{
                        width: `${pct}%`,
                        background: intensityVar(a.intensity),
                      }}
                    />
                  </div>
                  <div className="ins-app-time">{fmtHours(a.hours)}h</div>
                  <DeltaBadge delta={a.deltaPct} />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* ④ 作息画像 —— 一周 × 24 小时 */}
      <section className="panel ins-rhythm-panel">
        <h3 className="panel-title">作息画像</h3>
        <div className="ins-rhythm">
          <div className="ins-rhythm-days" aria-hidden>
            {DAY_LABELS.map((d) => (
              <span key={d} className="ins-rhythm-day">
                {d}
              </span>
            ))}
          </div>
          <div className="ins-rhythm-body">
            <div className="ins-rhythm-grid">
              {HOURLY_GRID.map((row, ri) =>
                row.map((level, ci) => (
                  <div
                    key={`${ri}-${ci}`}
                    className="ins-rhythm-cell"
                    style={{ background: intensityVar(level) }}
                    title={`周${DAY_LABELS[ri]} ${ci}:00 · 强度 ${level}`}
                  />
                ))
              )}
            </div>
            <div className="ins-rhythm-scale">
              <span
                className="ins-rhythm-tick ins-rhythm-tick--edge-start"
                style={{ gridColumn: 1 }}
              >
                0
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 7 }}>
                6
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 13 }}>
                12
              </span>
              <span className="ins-rhythm-tick" style={{ gridColumn: 19 }}>
                18
              </span>
              <span
                className="ins-rhythm-tick ins-rhythm-tick--edge-end"
                style={{ gridColumn: 24 }}
              >
                24
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---- 环比徽章 ---------------------------------------------------------------

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) {
    return (
      <span className="ins-delta ins-delta--flat" title="与上周持平">
        <Minus size={12} />
        <span className="ins-delta-num">持平</span>
      </span>
    );
  }
  if (delta > 0) {
    return (
      <span className="ins-delta ins-delta--up" title={`较上周 +${delta}%`}>
        <ArrowUpRight size={12} />
        <span className="ins-delta-num">{delta}%</span>
      </span>
    );
  }
  return (
    <span className="ins-delta ins-delta--down" title={`较上周 ${delta}%`}>
      <ArrowDownRight size={12} />
      <span className="ins-delta-num">{Math.abs(delta)}%</span>
    </span>
  );
}
