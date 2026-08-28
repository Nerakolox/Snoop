import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  LAYOUT,
  LAYOUT_MAX_X,
  LAYOUT_MAX_Y,
  displayLabel,
  keyByCode,
} from "../keyboardLayout";
import KLEKeyboard from "../components/KLEKeyboard";
import PageShell from "../components/PageShell";

type LogEntry = {
  ts: number;
  source: "dom" | "rdev";
  eventType: string;
  code: string;
  matchedLabel: string | null;
  unmatched: boolean;
};

const MAX_LOG = 30;

export default function KeymapTest() {
  const [pressedCodes, setPressedCodes] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogEntry[]>([]);

  // 前台 DOM 与后台 rdev 都归一化到 W3C `code`，这里只做「code → 配列」匹配。
  function handlePress(code: string, source: "dom" | "rdev", eventType: string) {
    setPressedCodes((prev) => new Set([...prev, code]));
    const key = keyByCode(code);
    const matchedLabel = key ? displayLabel(key) : null;
    const isMouseBtn = eventType === "ButtonPress";
    setLog((prev) => [
      { ts: Date.now(), source, eventType, code, matchedLabel,
        unmatched: !matchedLabel && !isMouseBtn },
      ...prev.slice(0, MAX_LOG - 1),
    ]);
  }

  function handleRelease(code: string) {
    setPressedCodes((prev) => { const n = new Set(prev); n.delete(code); return n; });
  }

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      e.preventDefault();
      handlePress(e.code, "dom", "KeyPress");
    };
    const onUp = (e: KeyboardEvent) => { handleRelease(e.code); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ event_type: string; code: string }>(
      "input-event",
      ({ payload }) => {
        const { event_type, code } = payload;
        if (event_type === "KeyPress") handlePress(code, "rdev", event_type);
        else if (event_type === "KeyRelease") handleRelease(code);
        else if (event_type === "ButtonPress") handlePress(code, "rdev", event_type);
        else if (event_type === "ButtonRelease") handleRelease(code);
      }
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const pressedIndices = useMemo(() => {
    const set = new Set<number>();
    pressedCodes.forEach((code) => {
      const idx = LAYOUT.findIndex((k) => k.code === code);
      if (idx !== -1) set.add(idx);
    });
    return set;
  }, [pressedCodes]);

  function fmtTime(ts: number) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  }

  return (
    <PageShell
      className="dev-page"
      header={
        <div className="dev-header">
          <h2>键盘映射测试</h2>
          <span style={{ color: "var(--color-text-3)", fontSize: "var(--text-xs)" }}>
            前台用 DOM 捕获，后台用 rdev 捕获，双方都归一化到 W3C code
          </span>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="panel" style={{ padding: "var(--space-4)", overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <KLEKeyboard keys={LAYOUT} keyCounts={{}} allCounts={[]} pressedIndices={pressedIndices} maxX={LAYOUT_MAX_X} maxY={LAYOUT_MAX_Y} />
        </div>
      </section>

      <section className="panel" style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>实时按键日志</span>
          <button className="kb-filter-btn" onClick={() => setLog([])}>清空</button>
        </div>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, display: "flex", flexDirection: "column", gap: 2, maxHeight: 320, overflowY: "auto" }}>
          {log.length === 0 && <span style={{ color: "var(--color-text-3)" }}>按下任意键开始记录...</span>}
          {log.map((entry, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "90px 40px 90px 1fr 1fr",
              gap: 8, padding: "3px 6px", borderRadius: 4,
              background: entry.unmatched ? "color-mix(in oklab, var(--intensity-4) 12%, transparent)" : "var(--color-surface-2)",
              color: entry.unmatched ? "var(--intensity-4)" : "var(--color-text)",
            }}>
              <span style={{ color: "var(--color-text-3)" }}>{fmtTime(entry.ts)}</span>
              <span style={{ color: entry.source === "dom" ? "var(--color-accent)" : "var(--color-text-3)", fontSize: 10 }}>{entry.source.toUpperCase()}</span>
              <span style={{ color: "var(--color-text-2)" }}>{entry.eventType}</span>
              <span>{entry.code}</span>
              <span>
                {entry.unmatched
                  ? <span style={{ color: "var(--intensity-4)", fontWeight: 600 }}>未映射: {entry.code}</span>
                  : entry.matchedLabel ?? "—"}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-3)", display: "grid", gridTemplateColumns: "90px 40px 90px 1fr 1fr", gap: 8, padding: "0 6px" }}>
          <span>时间</span><span>来源</span><span>事件类型</span><span>W3C 键码</span><span>匹配键位</span>
        </div>
      </section>
      </div>
    </PageShell>
  );
}
