/**
 * 概览 —— Snoop 的首页
 * 定位：今日快照 + 猫的实时陪伴，只展示今天的数据。
 * 当前为静态占位版：所有数字都是假数据，等接入后端 command 再替换。
 */

type NowStatus = {
  appName: string;
  moodLabel: string;
  /** 决定胶囊染色的强度档位：0=静默，4=猛敲 */
  moodIntensity: 0 | 1 | 2 | 3 | 4;
  catQuip: string;
};

/** KPI 值拆成段：数字大字、单位小字，串起来看起来是一个整体。 */
type KpiPart = { kind: "num" | "unit"; text: string };
type Kpi = {
  label: string;
  parts: KpiPart[];
};

type AppRow = {
  name: string;
  minutes: number;
  intensity: 0 | 1 | 2 | 3 | 4;
};

// ---- 占位数据 ---------------------------------------------------------------

const NOW: NowStatus = {
  appName: "Google Chrome",
  moodLabel: "摸鱼中",
  moodIntensity: 1,
  catQuip: "盯着 Chrome 半小时了，在看什么好东西喵？",
};

const KPIS: Kpi[] = [
  {
    label: "今日活跃",
    parts: [
      { kind: "num", text: "2" },
      { kind: "unit", text: "时" },
      { kind: "num", text: "14" },
      { kind: "unit", text: "分" },
    ],
  },
  {
    label: "总按键",
    parts: [
      { kind: "num", text: "1,043" },
      { kind: "unit", text: "次" },
    ],
  },
  {
    label: "总点击",
    parts: [
      { kind: "num", text: "320" },
      { kind: "unit", text: "次" },
    ],
  },
  {
    label: "鼠标里程",
    parts: [
      { kind: "num", text: "1.2" },
      { kind: "unit", text: "公里" },
    ],
  },
];

const APPS: AppRow[] = [
  // intensity 是"该 App 的活跃强度"抽象字段（0=挂着摸鱼，4=猛敲），
  // 独立于时长；接入真实数据时把活跃度算进这里，颜色自动跟上。
  { name: "Chrome", minutes: 19, intensity: 1 },
  { name: "终端", minutes: 17, intensity: 4 },
  { name: "VSCode", minutes: 12, intensity: 3 },
  { name: "QQ", minutes: 8, intensity: 1 },
  { name: "微信", minutes: 5, intensity: 1 },
  { name: "系统设置", minutes: 3, intensity: 1 },
];

/** 24 小时强度序列：0-6 睡觉、9-11 上午高强度、12-13 午休、14-17 下午、20-22 收尾 */
const HOURLY: (0 | 1 | 2 | 3 | 4)[] = [
  0, 0, 0, 0, 0, 0, 0, 1, 1, 3, 4, 4,
  1, 1, 3, 4, 3, 3, 1, 1, 2, 2, 1, 0,
];

// ---- 渲染 -------------------------------------------------------------------

function intensityVar(level: 0 | 1 | 2 | 3 | 4) {
  return `var(--intensity-${level})`;
}

export default function Overview() {
  const maxMinutes = Math.max(...APPS.map((a) => a.minutes));

  return (
    <div className="overview">
      {/* ① 此刻状态 —— 猫的舞台 */}
      <section className="now-card">
        <div className="now-mascot" aria-hidden>
          <span className="now-mascot-placeholder">猫</span>
        </div>
        <div className="now-info">
          <div className="now-label">此刻</div>
          <div className="now-app">{NOW.appName}</div>
          <div
            className="now-mood"
            style={{
              background: intensityVar(NOW.moodIntensity),
              color: NOW.moodIntensity >= 3 ? "#fff" : "var(--color-text)",
            }}
          >
            {NOW.moodLabel}
          </div>
          <p className="now-quip">{NOW.catQuip}</p>
        </div>
      </section>

      {/* ② 今日核心数字 */}
      <section className="kpi-row">
        {KPIS.map((k) => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">
              {k.parts.map((p, i) => (
                <span
                  key={i}
                  className={p.kind === "num" ? "kpi-num" : "kpi-unit"}
                >
                  {p.text}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>

      {/* ③ App 时长排行 */}
      <section className="panel">
        <h3 className="panel-title">App 排行</h3>
        <div className="app-list">
          {APPS.map((app) => {
            const pct = (app.minutes / maxMinutes) * 100;
            return (
              <div key={app.name} className="app-row">
                <div className="app-row-name">{app.name}</div>
                <div className="app-row-track">
                  <div
                    className="app-row-fill"
                    style={{
                      width: `${pct}%`,
                      background: intensityVar(app.intensity),
                    }}
                  />
                </div>
                <div className="app-row-time">{app.minutes} 分</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ④ 今日时段分布 —— 24 小时热力条 */}
      <section className="panel">
        <h3 className="panel-title">今日节奏</h3>
        <div className="heat-strip">
          {HOURLY.map((level, hour) => (
            <div
              key={hour}
              className="heat-cell"
              style={{ background: intensityVar(level) }}
              title={`${hour}:00 · 强度 ${level}`}
            />
          ))}
        </div>
        {/* 刻度与热力条共用同一份 24 列网格，格子内居中 → 刻度必然对齐格中心。
           0 贴左缘、24 贴右缘（第 24 格的右侧线） */}
        <div className="heat-scale">
          <span className="heat-scale-tick heat-scale-tick--edge-start" style={{ gridColumn: 1 }}>
            0
          </span>
          <span className="heat-scale-tick" style={{ gridColumn: 7 }}>6</span>
          <span className="heat-scale-tick" style={{ gridColumn: 13 }}>12</span>
          <span className="heat-scale-tick" style={{ gridColumn: 19 }}>18</span>
          <span className="heat-scale-tick heat-scale-tick--edge-end" style={{ gridColumn: 24 }}>
            24
          </span>
        </div>
      </section>
    </div>
  );
}
