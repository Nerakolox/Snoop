/**
 * 概览 —— Snoop 的首页
 * 定位：今日快照 + 猫的实时陪伴，只展示今天的数据。
 */

import { useEffect, useState } from "react";
import {
  fetchBucketsInRange,
  fetchHourlyActivity,
  todayRange,
  type RawBucket,
} from "../data";
import {
  aggregateByApp,
  aggregateByHour,
  computeIntensity,
  intensityVar,
  type Intensity,
  MOOD_LABELS,
  MOUSE_PIXELS_PER_METER,
  RECENT_ACTIVITY_WINDOW_MS,
  pickCatQuip,
} from "../analytics";
import AppIcon from "../components/AppIcon";

type NowStatus = {
  appName: string;
  appBundleId: string;
  moodLabel: string;
  moodIntensity: Intensity;
  catQuip: string;
};

type KpiPart = { kind: "num" | "unit"; text: string };
type Kpi = {
  label: string;
  parts: KpiPart[];
};

type AppRow = {
  name: string;
  bundleId: string;
  minutes: number;
  intensity: Intensity;
};

/** 格式化时长：毫秒 → "X时Y分" 或 "X分" */
function formatDuration(ms: number): KpiPart[] {
  const totalMin = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) {
    return [
      { kind: "num", text: String(hours) },
      { kind: "unit", text: "时" },
      { kind: "num", text: String(mins) },
      { kind: "unit", text: "分" },
    ];
  }
  return [
    { kind: "num", text: String(mins) },
    { kind: "unit", text: "分" },
  ];
}

/** 格式化数字：加千分位 */
function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 格式化鼠标里程：像素 → 米/公里 */
function formatMouseDistance(pixels: number): KpiPart[] {
  const meters = pixels / MOUSE_PIXELS_PER_METER;
  if (meters >= 1000) {
    const km = (meters / 1000).toFixed(1);
    return [
      { kind: "num", text: km },
      { kind: "unit", text: "公里" },
    ];
  }
  const m = Math.round(meters);
  return [
    { kind: "num", text: String(m) },
    { kind: "unit", text: "米" },
  ];
}

export default function Overview() {
  const [buckets, setBuckets] = useState<RawBucket[]>([]);
  const [now, setNow] = useState<NowStatus>({
    appName: "—",
    appBundleId: "",
    moodLabel: "静默中",
    moodIntensity: 0,
    catQuip: "还没有数据喵～",
  });
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [hourly, setHourly] = useState<Intensity[]>(Array(24).fill(0));
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const range = todayRange();
      const [todayBuckets, hourlyData] = await Promise.all([
        fetchBucketsInRange(range),
        fetchHourlyActivity(range),
      ]);

      setBuckets(todayBuckets);

      // ① 此刻状态 —— 最近 1-2 分钟内的"主导 App"（占用时长最多的 App）
      const nowTs = Date.now();
      const recentBuckets = todayBuckets.filter(
        (b) => nowTs - b.bucket_start < RECENT_ACTIVITY_WINDOW_MS
      );
      if (recentBuckets.length > 0) {
        // 按 app_bundle_id 聚合最近窗口内的时长，找出主导 App
        const appDurations = new Map<string, { duration: number; name: string; bundleId: string }>();
        for (const b of recentBuckets) {
          const key = b.app_bundle_id;
          const existing = appDurations.get(key);
          if (existing) {
            existing.duration += b.duration_ms || 0;
          } else {
            appDurations.set(key, {
              duration: b.duration_ms || 0,
              name: b.app_name || b.app_bundle_id,
              bundleId: b.app_bundle_id,
            });
          }
        }
        const dominant = [...appDurations.values()].sort(
          (a, b) => b.duration - a.duration
        )[0];
        const recentIntensity = computeIntensity(recentBuckets);
        setNow({
          appName: dominant.name || "未知应用",
          appBundleId: dominant.bundleId || "",
          moodLabel: MOOD_LABELS[recentIntensity],
          moodIntensity: recentIntensity,
          catQuip: pickCatQuip(recentIntensity, dominant.name || ""),
        });
      } else {
        setNow({
          appName: "—",
          appBundleId: "",
          moodLabel: "挂机中",
          moodIntensity: 0,
          catQuip: "人呢？挂机了喵？",
        });
      }

      // ② 今日核心数字
      let totalDuration = 0;
      let totalKeys = 0;
      let totalClicks = 0;
      let totalMouseDist = 0;
      for (const b of todayBuckets) {
        totalDuration += b.duration_ms || 0;
        totalKeys += b.key_total || 0;
        totalClicks +=
          (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
        totalMouseDist += b.mouse_move_dist || 0;
      }
      setKpis([
        { label: "今日活跃", parts: formatDuration(totalDuration) },
        {
          label: "总按键",
          parts: [
            { kind: "num", text: formatNumber(totalKeys) },
            { kind: "unit", text: "次" },
          ],
        },
        {
          label: "总点击",
          parts: [
            { kind: "num", text: formatNumber(totalClicks) },
            { kind: "unit", text: "次" },
          ],
        },
        { label: "鼠标里程", parts: formatMouseDistance(totalMouseDist) },
      ]);

      // ③ App 时长排行 Top 6
      const appStats = aggregateByApp(todayBuckets);
      setApps(
        appStats.slice(0, 6).map((a) => ({
          name: a.app_name || a.app_bundle_id,
          bundleId: a.app_bundle_id,
          minutes: Math.round(a.duration_ms / 60_000),
          intensity: a.intensity,
        }))
      );

      // ④ 今日时段分布
      const hourStats = aggregateByHour(hourlyData);
      setHourly(hourStats.map((h) => h.intensity));
    } catch (e) {
      console.error("Overview refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // 每 30 秒自动刷新
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, []);

  const maxMinutes = Math.max(...apps.map((a) => a.minutes), 1);

  return (
    <div className="overview">
      {/* ① 此刻状态 —— 猫的舞台 */}
      <section className="now-card">
        <div className="now-mascot" aria-hidden>
          {now.appBundleId ? (
            <AppIcon bundleId={now.appBundleId} appName={now.appName} size={64} />
          ) : (
            <span className="now-mascot-placeholder">猫</span>
          )}
        </div>
        <div className="now-info">
          <div className="now-label">此刻</div>
          <div className="now-app" title={now.appName}>{now.appName}</div>
          <div
            className="now-mood"
            style={{
              background: intensityVar(now.moodIntensity),
              color: now.moodIntensity >= 3 ? "#fff" : "var(--color-text)",
            }}
          >
            {now.moodLabel}
          </div>
          <p className="now-quip">{now.catQuip}</p>
        </div>
      </section>

      {/* ② 今日核心数字 */}
      <section className="kpi-row">
        {kpis.map((k) => (
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
          {apps.length === 0 && (
            <div style={{ color: "var(--color-text-3)", padding: "12px 0" }}>
              今天还没有数据
            </div>
          )}
          {apps.map((app) => {
            const pct = (app.minutes / maxMinutes) * 100;
            return (
              <div key={app.bundleId} className="app-row">
                <div className="app-row-name" title={app.name}>
                  <AppIcon bundleId={app.bundleId} appName={app.name} size={18} />
                  <span>{app.name}</span>
                </div>
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
          {hourly.map((level, hour) => (
            <div
              key={hour}
              className="heat-cell"
              style={{ background: intensityVar(level) }}
              title={`${hour}:00 · 强度 ${level}`}
            />
          ))}
        </div>
        <div className="heat-scale">
          <span
            className="heat-scale-tick heat-scale-tick--edge-start"
            style={{ gridColumn: 1 }}
          >
            0
          </span>
          <span className="heat-scale-tick" style={{ gridColumn: 7 }}>
            6
          </span>
          <span className="heat-scale-tick" style={{ gridColumn: 13 }}>
            12
          </span>
          <span className="heat-scale-tick" style={{ gridColumn: 19 }}>
            18
          </span>
          <span
            className="heat-scale-tick heat-scale-tick--edge-end"
            style={{ gridColumn: 24 }}
          >
            24
          </span>
        </div>
      </section>
    </div>
  );
}
