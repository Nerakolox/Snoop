/**
 * 键盘 —— 外设活动画像
 * QWERTY 60% 布局俯视热力图 + 鼠标热力 + Top 按键排行。
 * 切换 App 筛选/时段可查看不同 mock 预设。全 mock 数据。
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

type Intensity = 0 | 1 | 2 | 3 | 4;

type KeyVariant = "letter" | "num" | "mod" | "space";
type KeyDef = {
  id: string;
  label: string;
  /** 键宽：单位是标准字母键宽度，缺省 1；Space 6.25u，Backspace 2u 等 */
  w?: number;
  variant?: KeyVariant;
};

type AppFilter = "all" | "cs2" | "vscode" | "chrome" | "terminal";
type TimeFilter = "today" | "week";

// ---- 键盘布局：ANSI 60% -----------------------------------------------------

const letter = (l: string): KeyDef => ({
  id: l.toLowerCase(),
  label: l,
  variant: "letter",
});
const num = (l: string): KeyDef => ({ id: l, label: l, variant: "num" });

const ROWS: KeyDef[][] = [
  [
    { id: "grave", label: "`" },
    num("1"), num("2"), num("3"), num("4"), num("5"),
    num("6"), num("7"), num("8"), num("9"), num("0"),
    { id: "minus", label: "-" },
    { id: "equal", label: "=" },
    { id: "backspace", label: "Backspace", w: 2, variant: "mod" },
  ],
  [
    { id: "tab", label: "Tab", w: 1.5, variant: "mod" },
    letter("Q"), letter("W"), letter("E"), letter("R"), letter("T"),
    letter("Y"), letter("U"), letter("I"), letter("O"), letter("P"),
    { id: "lbracket", label: "[" },
    { id: "rbracket", label: "]" },
    { id: "backslash", label: "\\", w: 1.5 },
  ],
  [
    { id: "caps", label: "Caps", w: 1.75, variant: "mod" },
    letter("A"), letter("S"), letter("D"), letter("F"), letter("G"),
    letter("H"), letter("J"), letter("K"), letter("L"),
    { id: "semicolon", label: ";" },
    { id: "quote", label: "'" },
    { id: "enter", label: "Enter", w: 2.25, variant: "mod" },
  ],
  [
    { id: "lshift", label: "Shift", w: 2.25, variant: "mod" },
    letter("Z"), letter("X"), letter("C"), letter("V"), letter("B"),
    letter("N"), letter("M"),
    { id: "comma", label: "," },
    { id: "period", label: "." },
    { id: "slash", label: "/" },
    { id: "rshift", label: "Shift", w: 2.75, variant: "mod" },
  ],
  [
    { id: "lctrl", label: "Ctrl", w: 1.25, variant: "mod" },
    { id: "lwin", label: "Cmd", w: 1.25, variant: "mod" },
    { id: "lalt", label: "Alt", w: 1.25, variant: "mod" },
    { id: "space", label: "Space", w: 6.25, variant: "space" },
    { id: "ralt", label: "Alt", w: 1.25, variant: "mod" },
    { id: "fn", label: "Fn", w: 1.25, variant: "mod" },
    { id: "menu", label: "Menu", w: 1.25, variant: "mod" },
    { id: "rctrl", label: "Ctrl", w: 1.25, variant: "mod" },
  ],
];

// ---- 预设：mock 按键次数（今天） --------------------------------------------
// 每个预设都是一天内的按键次数分布，切筛选就是切一张预设表；
// 强度分档在渲染时按当前预设的 max 归一化，所以只关心形状不必对齐量级。

const PRESETS_TODAY: Record<AppFilter, Record<string, number>> = {
  all: {
    space: 312, w: 289, e: 245, t: 220, a: 210, o: 200, i: 195, n: 190, s: 180, h: 170,
    r: 165, d: 155, l: 145, c: 130, u: 120, m: 110, f: 100, g: 90, y: 85, p: 75,
    b: 65, v: 55, k: 45, j: 35, x: 25, q: 20, z: 15,
    enter: 180, backspace: 155, tab: 90, lshift: 130, rshift: 40,
    lctrl: 201, rctrl: 30, lalt: 20, ralt: 10, lwin: 35, menu: 5, fn: 2,
    caps: 3,
    comma: 60, period: 50, slash: 20, semicolon: 30, quote: 15,
    "1": 25, "2": 20, "3": 15, "4": 12, "5": 10, "6": 8, "7": 8, "8": 6, "9": 5, "0": 12,
    minus: 8, equal: 6, grave: 3,
    lbracket: 4, rbracket: 4, backslash: 2,
  },
  cs2: {
    // WASD + Space + Shift + 数字快切武器
    w: 480, a: 320, s: 280, d: 340, space: 520, lshift: 380, lctrl: 260,
    q: 145, e: 155, r: 130, f: 88, g: 55, tab: 70,
    "1": 120, "2": 95, "3": 80, "4": 60, "5": 45,
    "6": 20, "7": 15, "8": 10, "9": 8, "0": 5,
    b: 15, t: 20, y: 5, m: 12, x: 6, c: 8, v: 10, n: 3, u: 2, i: 3, o: 2, p: 2,
    h: 4, j: 3, k: 2, l: 2, z: 3,
    enter: 30, backspace: 5, caps: 0, lwin: 8, lalt: 6, menu: 2,
    comma: 4, period: 3, slash: 2, semicolon: 2, quote: 1,
    minus: 2, equal: 1, grave: 45,
    rshift: 3, rctrl: 5, ralt: 2, fn: 1,
    lbracket: 1, rbracket: 1, backslash: 1,
  },
  vscode: {
    // Ctrl/Cmd 快捷键、Tab 缩进、Enter 换行、Backspace 大量删改
    lctrl: 420, tab: 380, enter: 320, backspace: 380,
    lshift: 240, lalt: 90, space: 285,
    e: 240, t: 230, a: 220, o: 210, i: 210, n: 200, s: 195, h: 180, r: 175,
    d: 165, l: 150, c: 145, u: 130, m: 115, w: 155, f: 130, g: 100, y: 90, p: 85,
    b: 70, v: 65, k: 55, j: 45, x: 30, q: 22, z: 18,
    semicolon: 110, comma: 90, period: 85, slash: 55, quote: 70,
    lbracket: 55, rbracket: 55, backslash: 25,
    "1": 30, "2": 25, "3": 20, "4": 15, "5": 12, "6": 8, "7": 6, "8": 5, "9": 4, "0": 20,
    minus: 45, equal: 40, grave: 60,
    caps: 2, rshift: 55, rctrl: 40, ralt: 20, lwin: 30, menu: 3, fn: 8,
  },
  chrome: {
    lctrl: 260, tab: 140, enter: 120, backspace: 95, space: 180, lshift: 90,
    e: 160, t: 145, a: 140, o: 130, i: 130, n: 125, s: 120, r: 115, h: 105,
    l: 95, d: 90, u: 80, c: 75, m: 70, w: 65, f: 55, g: 50, y: 45, p: 40,
    b: 35, v: 25, k: 20, j: 15, x: 10, q: 8, z: 5,
    slash: 45, period: 60, comma: 40, semicolon: 20, quote: 15,
    "1": 15, "2": 12, "3": 10, "4": 6, "5": 5, "6": 3, "7": 3, "8": 2, "9": 2, "0": 8,
    minus: 6, equal: 4, grave: 2,
    lbracket: 3, rbracket: 3, backslash: 2,
    caps: 1, rshift: 15, rctrl: 20, ralt: 5, lwin: 25, menu: 1, fn: 1, lalt: 10,
  },
  terminal: {
    // 命令行：Enter/Tab/Ctrl 大量，ls/cd/rm/mkdir 等常用命令字母偏高
    enter: 380, tab: 240, lctrl: 280, backspace: 210, space: 260, lshift: 140,
    l: 180, s: 200, r: 160, m: 145, k: 120, d: 165, c: 175, e: 155, o: 130,
    a: 145, t: 130, i: 125, u: 90, n: 115, h: 100, g: 85, y: 70, p: 95,
    b: 60, v: 45, w: 55, f: 75, q: 15, x: 20, z: 10, j: 20,
    minus: 80, slash: 110, period: 60, comma: 20, semicolon: 15, quote: 30,
    "1": 25, "2": 20, "3": 15, "4": 10, "5": 8, "6": 5, "7": 5, "8": 3, "9": 3, "0": 12,
    grave: 30, equal: 15,
    lbracket: 8, rbracket: 8, backslash: 15,
    caps: 1, rshift: 20, rctrl: 30, ralt: 8, lwin: 15, menu: 2, fn: 2, lalt: 15,
  },
};

type MouseData = { left: number; right: number; wheel: number; travelKm: number };

const MOUSE_TODAY: Record<AppFilter, MouseData> = {
  all: { left: 1240, right: 320, wheel: 850, travelKm: 1.2 },
  cs2: { left: 4820, right: 3210, wheel: 60, travelKm: 4.8 },
  vscode: { left: 620, right: 145, wheel: 1240, travelKm: 0.7 },
  chrome: { left: 480, right: 90, wheel: 2340, travelKm: 1.6 },
  terminal: { left: 180, right: 40, wheel: 320, travelKm: 0.4 },
};

const WEEK_MULT = 5.2;

function scaleKeys(map: Record<string, number>, mult: number): Record<string, number> {
  if (mult === 1) return map;
  const out: Record<string, number> = {};
  for (const k in map) out[k] = Math.round(map[k] * mult);
  return out;
}

function scaleMouse(m: MouseData, mult: number): MouseData {
  if (mult === 1) return m;
  return {
    left: Math.round(m.left * mult),
    right: Math.round(m.right * mult),
    wheel: Math.round(m.wheel * mult),
    travelKm: Number((m.travelKm * mult).toFixed(1)),
  };
}

// ---- 强度分档：按当前预设的 max 归一化 --------------------------------------

function bucket(n: number, max: number): Intensity {
  if (n <= 0) return 0;
  const pct = n / (max || 1);
  if (pct >= 0.7) return 4;
  if (pct >= 0.45) return 3;
  if (pct >= 0.22) return 2;
  return 1;
}

function intensityVar(level: Intensity) {
  return `var(--intensity-${level})`;
}

// ---- 展示常量 ---------------------------------------------------------------

const APP_LABELS: { id: AppFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "cs2", label: "CS2" },
  { id: "vscode", label: "VSCode" },
  { id: "chrome", label: "Chrome" },
  { id: "terminal", label: "终端" },
];

const TIME_LABELS: { id: TimeFilter; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "week", label: "本周" },
];

const KEY_DISPLAY_NAMES: Record<string, string> = {
  space: "Space", enter: "Enter", backspace: "Backspace", tab: "Tab",
  lctrl: "Ctrl", rctrl: "Ctrl", lshift: "Shift", rshift: "Shift",
  lalt: "Alt", ralt: "Alt", lwin: "Cmd", caps: "Caps",
  minus: "-", equal: "=", grave: "`", semicolon: ";", quote: "'",
  comma: ",", period: ".", slash: "/",
  lbracket: "[", rbracket: "]", backslash: "\\",
  menu: "Menu", fn: "Fn",
};

function keyDisplay(id: string): string {
  if (KEY_DISPLAY_NAMES[id]) return KEY_DISPLAY_NAMES[id];
  if (id.length === 1) return id.toUpperCase();
  return id;
}

// ---- 渲染 -------------------------------------------------------------------

export default function Keyboard() {
  const [appFilter, setAppFilter] = useState<AppFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("today");

  const mult = timeFilter === "week" ? WEEK_MULT : 1;

  const keyCounts = useMemo(
    () => scaleKeys(PRESETS_TODAY[appFilter], mult),
    [appFilter, mult]
  );

  const mouseData = useMemo(
    () => scaleMouse(MOUSE_TODAY[appFilter], mult),
    [appFilter, mult]
  );

  const maxKey = useMemo(() => {
    let m = 0;
    for (const k in keyCounts) if (keyCounts[k] > m) m = keyCounts[k];
    return m;
  }, [keyCounts]);

  const maxMouse = Math.max(mouseData.left, mouseData.right, mouseData.wheel, 1);

  const topKeys = useMemo(() => {
    return Object.entries(keyCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, n]) => ({ id, n }));
  }, [keyCounts]);

  const topPanelTitle =
    timeFilter === "week" ? "本周按得最多" : "今天按得最多";

  return (
    <div className="kb-page">
      {/* ① 顶部筛选栏 */}
      <div className="kb-filters">
        <div className="kb-filter-group">
          {APP_LABELS.map((a) => (
            <button
              key={a.id}
              className={`kb-filter-btn${appFilter === a.id ? " is-active" : ""}`}
              onClick={() => setAppFilter(a.id)}
              type="button"
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="kb-segmented" role="tablist" aria-label="时间范围">
          {TIME_LABELS.map((t) => (
            <button
              key={t.id}
              className={`kb-segmented-btn${timeFilter === t.id ? " is-active" : ""}`}
              onClick={() => setTimeFilter(t.id)}
              type="button"
              role="tab"
              aria-selected={timeFilter === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ② 键盘热力图 —— 视觉主体 */}
      <section className="panel kb-keyboard-panel">
        <div className="kb-keyboard">
          {ROWS.map((row, ri) => (
            <div key={ri} className="kb-row">
              {row.map((key) => {
                const count = keyCounts[key.id] ?? 0;
                const level = bucket(count, maxKey);
                const style: CSSProperties = {
                  flexGrow: key.w ?? 1,
                  background: intensityVar(level),
                  color: level >= 3 ? "#fff" : "var(--color-text-2)",
                };
                return (
                  <div
                    key={key.id}
                    className={`kb-key kb-key--${key.variant ?? "letter"}`}
                    style={style}
                    aria-label={`${keyDisplay(key.id)}, ${count} 次`}
                  >
                    <span className="kb-key-label">{key.label}</span>
                    <span className="kb-key-count">{count.toLocaleString()} 次</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {/* ③④ 下方并排：鼠标 · Top 按键 */}
      <div className="kb-lower">
        {/* ③ 鼠标热力 */}
        <section className="panel">
          <h3 className="panel-title">鼠标</h3>
          <div className="mouse-card">
            <div className="mouse-shape" aria-hidden>
              <div
                className="mouse-btn mouse-btn--left"
                style={{
                  background: intensityVar(bucket(mouseData.left, maxMouse)),
                }}
                title={`左键 · ${mouseData.left.toLocaleString()} 次`}
              />
              <div
                className="mouse-btn mouse-btn--right"
                style={{
                  background: intensityVar(bucket(mouseData.right, maxMouse)),
                }}
                title={`右键 · ${mouseData.right.toLocaleString()} 次`}
              />
              <div
                className="mouse-wheel"
                style={{
                  background: intensityVar(bucket(mouseData.wheel, maxMouse)),
                }}
                title={`滚轮 · ${mouseData.wheel.toLocaleString()}`}
              />
            </div>
            <dl className="mouse-stats">
              <div className="mouse-stat">
                <dt>左键</dt>
                <dd>{mouseData.left.toLocaleString()}</dd>
              </div>
              <div className="mouse-stat">
                <dt>右键</dt>
                <dd>{mouseData.right.toLocaleString()}</dd>
              </div>
              <div className="mouse-stat">
                <dt>滚轮</dt>
                <dd>{mouseData.wheel.toLocaleString()}</dd>
              </div>
              <div className="mouse-stat">
                <dt>移动</dt>
                <dd>
                  {mouseData.travelKm}
                  <span className="mouse-stat-unit">公里</span>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* ④ Top 按键排行 */}
        <section className="panel">
          <h3 className="panel-title">{topPanelTitle}</h3>
          <div className="topkey-list">
            {topKeys.map((k) => {
              const pct = topKeys[0] ? (k.n / topKeys[0].n) * 100 : 0;
              const level = bucket(k.n, maxKey);
              return (
                <div key={k.id} className="topkey-row">
                  <div className="topkey-name">{keyDisplay(k.id)}</div>
                  <div className="topkey-track">
                    <div
                      className="topkey-fill"
                      style={{ width: `${pct}%`, background: intensityVar(level) }}
                    />
                  </div>
                  <div className="topkey-count">{k.n.toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
