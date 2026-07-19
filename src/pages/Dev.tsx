import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchAppRankingInRange,
  fetchBucketsInRange,
  fetchHourlyActivity,
  fetchKeyDetailsInRange,
  thisWeekRange,
  todayRange,
} from "../data";
import {
  aggregateByApp,
  aggregateByDay,
  aggregateByHour,
  aggregateShortSessions,
  aggregateWeekHourGrid,
  classifyKeys,
  computeIntensity,
  debugEpm,
  mergeSessions,
} from "../analytics";

type Bucket = {
  id: number;
  bucket_start: number;
  duration_ms: number;
  app_name: string;
  app_bundle_id: string;
  key_total: number;
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_move_dist: number;
  scroll_dist: number;
};

type KeyDetail = { key_code: string; count: number };

type AppRank = {
  app_bundle_id: string;
  app_name: string;
  bucket_count: number;
  total_sec: number;
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type AnalyticsSummary = {
  scope: "today" | "week";
  bucketCount: number;
  sessionCount: number;
  aggregatedSessionCount: number;
  topApps: { name: string; hours: number; intensity: number }[];
  topRegions: { region: string; count: number }[];
  hourlyIntensity: number[];
  dailyActive: { day_of_week: number; hours: number }[];
  weekGridPreview: string;
  overallIntensity: number;
  overallEpm: number;
  intensityDist: [number, number, number, number, number];
  epmBreakdown: { keys: number; clicks: number; moveEvents: number; scrollEvents: number };
  keyDetailRows: number;
  hourRows: number;
};

export default function Dev() {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [todayKeys, setTodayKeys] = useState<number>(0);
  const [ranking, setRanking] = useState<AppRank[]>([]);
  const [expanded, setExpanded] = useState<Record<number, KeyDetail[] | "loading" | "error">>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary[] | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null);

  async function verifyAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsErr(null);
    try {
      const scopes: { scope: "today" | "week"; range: ReturnType<typeof todayRange> }[] = [
        { scope: "today", range: todayRange() },
        { scope: "week", range: thisWeekRange() },
      ];
      const summaries: AnalyticsSummary[] = [];
      for (const s of scopes) {
        const [rawBuckets, keyDetails, hourly, appRank] = await Promise.all([
          fetchBucketsInRange(s.range),
          fetchKeyDetailsInRange(s.range),
          fetchHourlyActivity(s.range),
          fetchAppRankingInRange(s.range),
        ]);

        const sessions = mergeSessions(rawBuckets);
        const aggregated = aggregateShortSessions(sessions);
        const appStats = aggregateByApp(rawBuckets);
        const regionStats = classifyKeys(keyDetails);
        const hourStats = aggregateByHour(hourly);
        const dayStats = aggregateByDay(rawBuckets);
        const weekGrid = aggregateWeekHourGrid(hourly, new Map(), Date.now());

        console.groupCollapsed(`analytics · ${s.scope}`);
        console.log("time range", s.range);
        console.log("raw buckets", rawBuckets);
        console.log("sessions", sessions);
        console.log("aggregatedSessions", aggregated);
        console.log("appStats", appStats);
        console.log("regionStats", regionStats);
        console.log("hourStats", hourStats);
        console.log("dayStats", dayStats);
        console.log("weekGrid", weekGrid);
        console.log("appRank (server-side)", appRank);
        console.log("overall intensity", computeIntensity(rawBuckets));
        console.log("EPM debug", debugEpm(rawBuckets));
        console.groupEnd();

        // 用 App 级 EPM 拆一份分档分布，肉眼确认"不是全4"
        const dist: [number, number, number, number, number] = [0, 0, 0, 0, 0];
        for (const a of appStats) dist[a.intensity] += 1;
        const dbg = debugEpm(rawBuckets);

        summaries.push({
          scope: s.scope,
          bucketCount: rawBuckets.length,
          sessionCount: sessions.length,
          aggregatedSessionCount: aggregated.length,
          topApps: appStats.slice(0, 5).map((a) => ({
            name: a.app_name || a.app_bundle_id,
            hours: +(a.duration_ms / 3_600_000).toFixed(2),
            intensity: a.intensity,
          })),
          topRegions: regionStats
            .filter((r) => r.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map((r) => ({ region: r.region, count: r.count })),
          hourlyIntensity: hourStats.map((h) => h.intensity),
          dailyActive: dayStats.map((d) => ({
            day_of_week: d.day_of_week,
            hours: +(d.active_ms / 3_600_000).toFixed(2),
          })),
          weekGridPreview: weekGrid
            .map((row) => row.join(""))
            .join("\n"),
          overallIntensity: computeIntensity(rawBuckets),
          overallEpm: +dbg.epm.toFixed(1),
          intensityDist: dist,
          epmBreakdown: dbg.breakdown,
          keyDetailRows: keyDetails.length,
          hourRows: hourly.length,
        });
      }
      setAnalytics(summaries);
    } catch (e) {
      console.error(e);
      setAnalyticsErr(String(e));
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const [b, t, r] = await Promise.all([
        invoke<Bucket[]>("get_buckets"),
        invoke<number>("get_today_key_total"),
        invoke<AppRank[]>("get_app_ranking"),
      ]);
      setBuckets(b);
      setTodayKeys(t);
      setRanking(r);
      setExpanded({});
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggleRow(id: number) {
    const cur = expanded[id];
    if (cur !== undefined && cur !== "loading") {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    if (cur === "loading") return;
    setExpanded((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const details = await invoke<KeyDetail[]>("get_key_details", { bucketId: id });
      setExpanded((prev) => ({ ...prev, [id]: details }));
    } catch (e) {
      console.error(e);
      setExpanded((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  return (
    <div className="dev-page">
      <div className="dev-header">
        <h2>Dev · 原始数据</h2>
        <button onClick={refresh} disabled={loading}>
          {loading ? "刷新中..." : "刷新"}
        </button>
      </div>

      {err && <p className="dev-error">错误: {err}</p>}

      <section className="dev-section">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Analytics 验证（today / this week）</h3>
          <button onClick={verifyAnalytics} disabled={analyticsLoading}>
            {analyticsLoading ? "跑分析中..." : "跑一次"}
          </button>
        </div>
        <p style={{ color: "var(--color-text-3)", margin: "8px 0 12px" }}>
          详细结果打印到 DevTools Console；下方是概要，用于肉眼验证 mergeSessions / aggregateByApp /
          aggregateByHour / classifyKeys / computeIntensity。
        </p>
        {analyticsErr && <p className="dev-error">错误: {analyticsErr}</p>}
        {analytics &&
          analytics.map((s) => (
            <div key={s.scope} className="dev-section" style={{ marginTop: 12 }}>
              <h3>
                范围: {s.scope} · 桶 {s.bucketCount} · 会话 {s.sessionCount} →{" "}
                {s.aggregatedSessionCount}（碎片处理后）· 整体强度 {s.overallIntensity} ·
                key_detail 行 {s.keyDetailRows} · hour 行 {s.hourRows}
              </h3>
              <div
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  background: "var(--color-bg-2)",
                  padding: 8,
                  borderRadius: 6,
                  margin: "6px 0 12px",
                }}
              >
                整体 EPM {s.overallEpm}（keys {s.epmBreakdown.keys} · clicks {s.epmBreakdown.clicks}{" "}
                · moveEv {s.epmBreakdown.moveEvents} · scrollEv {s.epmBreakdown.scrollEvents}）
                · App 分档分布 [0..4] = [{s.intensityDist.join(", ")}]
              </div>
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <b>Top Apps</b>
                  <ol>
                    {s.topApps.map((a, i) => (
                      <li key={i}>
                        {a.name} · {a.hours}h · 强度 {a.intensity}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <b>Top 按键区域</b>
                  <ol>
                    {s.topRegions.map((r, i) => (
                      <li key={i}>
                        {r.region} · {r.count}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <b>时段强度（0-23）</b>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                    {s.hourlyIntensity.join(" ")}
                  </pre>
                </div>
                <div>
                  <b>每日活跃</b>
                  <ol>
                    {s.dailyActive.map((d, i) => (
                      <li key={i}>
                        DoW {d.day_of_week} · {d.hours}h
                      </li>
                    ))}
                  </ol>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <b>7×24 强度网格（周一 → 周日 × 0..23）</b>
                  <pre
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      whiteSpace: "pre",
                      margin: 0,
                    }}
                  >
                    {s.weekGridPreview}
                  </pre>
                </div>
              </div>
            </div>
          ))}
      </section>

      <section className="dev-section">
        <h3>今日总按键数: {todayKeys}</h3>
      </section>

      <section className="dev-section">
        <h3>App 时长排行 (按桶数)</h3>
        <table className="dev-table" border={1}>
          <thead>
            <tr>
              <th>#</th>
              <th>app_name</th>
              <th>app_bundle_id</th>
              <th>bucket_count</th>
              <th>total_sec</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((r, i) => (
              <tr key={r.app_bundle_id}>
                <td>{i + 1}</td>
                <td>{r.app_name}</td>
                <td>{r.app_bundle_id}</td>
                <td>{r.bucket_count}</td>
                <td>{r.total_sec}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dev-section">
        <h3>activity_buckets ({buckets.length} 行, 最新在上)</h3>
        <table className="dev-table" border={1}>
          <thead>
            <tr>
              <th>时间</th>
              <th>app_name</th>
              <th>key_total</th>
              <th>mouse_left</th>
              <th>mouse_right</th>
              <th>mouse_middle</th>
              <th>mouse_move_dist</th>
              <th>scroll_dist</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const detail = expanded[b.id];
              const isOpen = detail !== undefined;
              return (
                <Fragment key={b.id}>
                  <tr
                    onClick={() => toggleRow(b.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      {isOpen ? "▼ " : "▶ "}
                      {fmtTime(b.bucket_start)}
                    </td>
                    <td>{b.app_name}</td>
                    <td>{b.key_total}</td>
                    <td>{b.mouse_left}</td>
                    <td>{b.mouse_right}</td>
                    <td>{b.mouse_middle}</td>
                    <td>{b.mouse_move_dist}</td>
                    <td>{b.scroll_dist}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8}>
                        {detail === "loading" && "加载中..."}
                        {detail === "error" && "加载失败"}
                        {Array.isArray(detail) && (
                          detail.length === 0 ? (
                            "(无按键明细)"
                          ) : (
                            <table className="dev-table" border={1}>
                              <thead>
                                <tr>
                                  <th>key_code</th>
                                  <th>count</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.map((k) => (
                                  <tr key={k.key_code}>
                                    <td>{k.key_code}</td>
                                    <td>{k.count}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
