import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseKLE, getLabelRdevCode, getDisplayLabel, type KLEKey } from "../kleParser";
import {
  getSavedLayout,
  saveLayout,
  loadLayoutJSON,
} from "../components/KLELayoutPicker";
import { getAllLayouts } from "../layouts";
import KLEKeyboard from "../components/KLEKeyboard";

const DOM_TO_RDEV: Record<string, string> = {
  Backquote: "BackQuote", Minus: "Minus", Equal: "Equal",
  BracketLeft: "LeftBracket", BracketRight: "RightBracket",
  Backslash: "BackSlash", Semicolon: "SemiColon", Quote: "Quote",
  Comma: "Comma", Period: "Period", Slash: "Slash",
  Backspace: "Backspace", Tab: "Tab", CapsLock: "CapsLock",
  Enter: "Return", Space: "Space", Escape: "Escape",
  ShiftLeft: "ShiftLeft", ShiftRight: "ShiftRight",
  ControlLeft: "ControlLeft", ControlRight: "ControlRight",
  AltLeft: "Alt", AltRight: "AltGr",
  MetaLeft: "MetaLeft", MetaRight: "MetaRight",
  ContextMenu: "Apps",
  Insert: "Insert", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "UpArrow", ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow", ArrowRight: "RightArrow",
  PrintScreen: "PrintScreen", ScrollLock: "ScrollLock", Pause: "Pause",
  NumLock: "NumLock",
  NumpadDivide: "KpDivide", NumpadMultiply: "KpMultiply",
  NumpadSubtract: "KpMinus", NumpadAdd: "KpPlus",
  NumpadEnter: "KpReturn", NumpadDecimal: "KpDecimal",
  Numpad0: "Kp0", Numpad1: "Kp1", Numpad2: "Kp2", Numpad3: "Kp3",
  Numpad4: "Kp4", Numpad5: "Kp5", Numpad6: "Kp6", Numpad7: "Kp7",
  Numpad8: "Kp8", Numpad9: "Kp9",
};

function domCodeToRdev(code: string): string {
  if (DOM_TO_RDEV[code]) return DOM_TO_RDEV[code];
  if (/^Key[A-Z]$/.test(code)) return code;
  if (/^Digit(\d)$/.test(code)) return `Num${code.slice(5)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

// Labels that appear twice (left+right) and need position-based disambiguation
const PAIRED_LABELS: Record<string, [string, string]> = {
  Shift: ["ShiftLeft", "ShiftRight"],
  shift: ["ShiftLeft", "ShiftRight"],
  Ctrl: ["ControlLeft", "ControlRight"],
  control: ["ControlLeft", "ControlRight"],
  Alt: ["Alt", "AltGr"],
  alt: ["Alt", "AltGr"],
  option: ["Alt", "AltGr"],
};

function buildRdevIndexMap(keys: KLEKey[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const byLabel = new Map<string, { idx: number; x: number }[]>();
  keys.forEach((k, idx) => {
    const arr = byLabel.get(k.label) ?? [];
    arr.push({ idx, x: k.x });
    byLabel.set(k.label, arr);
  });
  byLabel.forEach((entries, label) => {
    const pair = PAIRED_LABELS[label];
    if (pair && entries.length >= 2) {
      const sorted = [...entries].sort((a, b) => a.x - b.x);
      const push = (code: string, idx: number) => {
        const a = map.get(code) ?? []; a.push(idx); map.set(code, a);
      };
      push(pair[0], sorted[0].idx);
      push(pair[1], sorted[sorted.length - 1].idx);
    } else {
      const rc = getLabelRdevCode(label);
      if (rc !== undefined) {
        entries.forEach(({ idx }) => {
          const a = map.get(rc) ?? []; a.push(idx); map.set(rc, a);
        });
      }
    }
  });
  return map;
}

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
  const [layouts, setLayouts] = useState(() => getAllLayouts());
  const KNOWN = useMemo(() => layouts.map((l) => l.id), [layouts]);
  const NAME_MAP = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of layouts) m[l.id] = l.name;
    return m;
  }, [layouts]);
  const [layoutId, setLayoutId] = useState(() => getSavedLayout());
  const [kleKeys, setKleKeys] = useState<KLEKey[]>([]);
  const [pressedCodes, setPressedCodes] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pickerIdx, setPickerIdx] = useState(() => Math.max(0, KNOWN.indexOf(getSavedLayout())));

  // 允许其他页面（Keyboard 页导入/删除自定义配列）后同步刷新
  useEffect(() => {
    const onStorage = () => setLayouts(getAllLayouts());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const kleKeysRef = useRef<KLEKey[]>([]);
  kleKeysRef.current = kleKeys;

  const rdevIndexMap = useMemo(() => buildRdevIndexMap(kleKeys), [kleKeys]);
  const rdevIndexMapRef = useRef(rdevIndexMap);
  rdevIndexMapRef.current = rdevIndexMap;

  async function loadLayout(id: string) {
    try {
      const json = await loadLayoutJSON(id);
      setKleKeys(parseKLE(json));
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => { loadLayout(layoutId); }, []);

  function handlePress(code: string, source: "dom" | "rdev", eventType: string) {
    setPressedCodes((prev) => new Set([...prev, code]));
    const keys = kleKeysRef.current;
    const indices = rdevIndexMapRef.current.get(code);
    const matched = indices?.length ?? 0 > 0;
    const matchedLabel = matched ? (getDisplayLabel(keys[indices![0]]?.label ?? "") || "Space") : null;
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
      handlePress(domCodeToRdev(e.code), "dom", "KeyPress");
    };
    const onUp = (e: KeyboardEvent) => { handleRelease(domCodeToRdev(e.code)); };
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
      rdevIndexMap.get(code)?.forEach((idx) => set.add(idx));
    });
    return set;
  }, [pressedCodes, rdevIndexMap]);

  function selectLayout(id: string) {
    setLayoutId(id); saveLayout(id); loadLayout(id);
    setPickerIdx(KNOWN.indexOf(id));
  }

  function fmtTime(ts: number) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  }

  return (
    <div className="dev-page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="dev-header">
        <h2>键盘映射测试</h2>
        <span style={{ color: "var(--color-text-3)", fontSize: "var(--text-xs)" }}>
          前台用 DOM 捕获，后台用 rdev 捕获
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--color-text-2)", fontSize: "var(--text-xs)" }}>配列</span>
        <button className="kb-nav-btn" onClick={() => setPickerIdx(i => Math.max(0, i-1))} disabled={pickerIdx === 0}>
          <ChevronLeft size={14} />
        </button>
        {KNOWN.map((id, i) => (
          <button key={id} className={`kb-filter-btn${layoutId === id ? " is-active" : ""}`}
            onClick={() => selectLayout(id)}
            style={{ display: Math.abs(i - pickerIdx) <= 2 ? undefined : "none" }}>
            {NAME_MAP[id] || id}
          </button>
        ))}
        <button className="kb-nav-btn" onClick={() => setPickerIdx(i => Math.min(KNOWN.length-1, i+1))} disabled={pickerIdx >= KNOWN.length-1}>
          <ChevronRight size={14} />
        </button>
      </div>

      <section className="panel" style={{ padding: "var(--space-4)", overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <KLEKeyboard keys={kleKeys} keyCounts={{}} allCounts={[]} pressedIndices={pressedIndices} unitSize={46} />
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
              background: entry.unmatched ? "rgba(225,90,76,0.12)" : "var(--color-surface-2)",
              color: entry.unmatched ? "var(--intensity-4)" : "var(--color-text)",
            }}>
              <span style={{ color: "var(--color-text-3)" }}>{fmtTime(entry.ts)}</span>
              <span style={{ color: entry.source === "dom" ? "var(--color-accent)" : "var(--color-text-3)", fontSize: 10 }}>{entry.source.toUpperCase()}</span>
              <span style={{ color: "var(--color-text-2)" }}>{entry.eventType}</span>
              <span>{entry.code}</span>
              <span>
                {entry.unmatched
                  ? <span style={{ color: "var(--intensity-4)", fontWeight: 600 }}>未匹配: {entry.code}</span>
                  : entry.matchedLabel ?? "—"}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-3)", display: "grid", gridTemplateColumns: "90px 40px 90px 1fr 1fr", gap: 8, padding: "0 6px" }}>
          <span>时间</span><span>来源</span><span>事件类型</span><span>rdev 键码</span><span>匹配键位</span>
        </div>
      </section>
    </div>
  );
}
