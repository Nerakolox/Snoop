/**
 * 时间线 —— 猫的今日观察日记
 * 静态占位版：一天的会话按早→晚顺序流下来，左侧一条脉络线穿过所有节点，
 * 值得吐槽的会话下方挂一个 accent-soft 底色的猫气泡。
 * 全 mock 数据，等接入后端 command 再替换。
 */

import type { ComponentType, CSSProperties } from "react";
import {
  Code2,
  Globe,
  MessageCircle,
  Moon,
  Terminal,
} from "lucide-react";

type Intensity = 0 | 1 | 2 | 3 | 4;

type IconComp = ComponentType<{ size?: number | string }>;

type Session = {
  start: string;
  end: string;
  appName: string;
  minutes: number;
  /** 该会话的活跃强度，独立于时长；映射到 --intensity-* 色阶 */
  intensity: Intensity;
  /** 胶囊上显示的文案，如"高强度""摸鱼""挂机" */
  intensityLabel: string;
  /** 只挂在"值得吐槽"的会话上，mock 里约 1/3 覆盖 */
  quip?: string;
};

// ---- 占位数据 ---------------------------------------------------------------

const APP_ICONS: Record<string, IconComp> = {
  VSCode: Code2,
  Chrome: Globe,
  终端: Terminal,
  QQ: MessageCircle,
  微信: MessageCircle,
  无操作: Moon,
};

const SESSIONS: Session[] = [
  {
    start: "09:12",
    end: "09:47",
    appName: "VSCode",
    minutes: 35,
    intensity: 4,
    intensityLabel: "高强度",
  },
  {
    start: "09:47",
    end: "09:50",
    appName: "Chrome",
    minutes: 3,
    intensity: 1,
    intensityLabel: "路过",
  },
  {
    start: "09:50",
    end: "10:30",
    appName: "VSCode",
    minutes: 40,
    intensity: 4,
    intensityLabel: "高强度",
    quip: "手速拉满，deadline 的味道我闻到了。",
  },
  {
    start: "10:30",
    end: "11:15",
    appName: "Chrome",
    minutes: 45,
    intensity: 1,
    intensityLabel: "摸鱼",
    quip: "说好的查资料呢？我看你在看视频。",
  },
  {
    start: "11:15",
    end: "11:38",
    appName: "QQ",
    minutes: 23,
    intensity: 2,
    intensityLabel: "中",
  },
  {
    start: "11:38",
    end: "12:05",
    appName: "VSCode",
    minutes: 27,
    intensity: 3,
    intensityLabel: "中高",
  },
  {
    start: "14:00",
    end: "14:20",
    appName: "无操作",
    minutes: 20,
    intensity: 0,
    intensityLabel: "挂机",
    quip: "鼠标一动不动 20 分钟，人呢？睡着了？",
  },
  {
    start: "14:20",
    end: "15:35",
    appName: "终端",
    minutes: 75,
    intensity: 4,
    intensityLabel: "高强度",
  },
  {
    start: "15:35",
    end: "16:10",
    appName: "VSCode",
    minutes: 35,
    intensity: 3,
    intensityLabel: "中高",
    quip: "写完这段是不是就可以摸鱼了？",
  },
  {
    start: "16:10",
    end: "16:45",
    appName: "微信",
    minutes: 35,
    intensity: 2,
    intensityLabel: "中",
  },
  {
    start: "16:45",
    end: "17:20",
    appName: "Chrome",
    minutes: 35,
    intensity: 1,
    intensityLabel: "摸鱼",
  },
  {
    start: "17:20",
    end: "17:52",
    appName: "VSCode",
    minutes: 32,
    intensity: 3,
    intensityLabel: "中高",
  },
];

// ---- 渲染 -------------------------------------------------------------------

function intensityVar(level: Intensity) {
  return `var(--intensity-${level})`;
}

/** 高强度色底文字用白；低强度浅底用主文字色，保证对比。 */
function tagTextColor(level: Intensity) {
  return level >= 3 ? "#fff" : "var(--color-text)";
}

export default function Timeline() {
  return (
    <div className="timeline">
      <div className="timeline-list">
        {[...SESSIONS].reverse().map((s, i) => {
          const stripColor = intensityVar(s.intensity);
          const Icon = APP_ICONS[s.appName] ?? Moon;
          const axisStyle = { "--dot-color": stripColor } as CSSProperties;
          return (
            <div key={i} className="timeline-item">
              <div className="timeline-time">{s.start}</div>
              <div className="timeline-axis" style={axisStyle}>
                <span className="timeline-dot" />
              </div>
              <div className="timeline-body">
                <article
                  className="session-card"
                  style={{ borderLeftColor: stripColor }}
                >
                  <header className="session-head">
                    <span className="session-app-icon" aria-hidden>
                      <Icon size={16} />
                    </span>
                    <span className="session-app-name">{s.appName}</span>
                    <span className="session-range">
                      {s.start}–{s.end}
                    </span>
                  </header>
                  <div className="session-meta">
                    <span
                      className="session-tag"
                      style={{
                        background: stripColor,
                        color: tagTextColor(s.intensity),
                      }}
                    >
                      {s.intensityLabel}
                    </span>
                    <span className="session-duration">
                      用了 {s.minutes} 分钟
                    </span>
                  </div>
                </article>
                {s.quip && (
                  <div className="cat-bubble">
                    <div className="cat-bubble-avatar" aria-hidden>
                      猫
                    </div>
                    <p className="cat-bubble-text">{s.quip}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
