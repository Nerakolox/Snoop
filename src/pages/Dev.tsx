import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

export default function Dev() {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [todayKeys, setTodayKeys] = useState<number>(0);
  const [ranking, setRanking] = useState<AppRank[]>([]);
  const [expanded, setExpanded] = useState<Record<number, KeyDetail[] | "loading" | "error">>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
