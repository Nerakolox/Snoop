import { useEffect, useRef, useState } from "react";
import Sidebar, { NavKey } from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import Overview from "./pages/Overview";
import Timeline from "./pages/Timeline";
import Keyboard from "./pages/Keyboard";
import Insights from "./pages/Insights";
import Settings from "./pages/Settings";
import Dev from "./pages/Dev";
import KeymapTest from "./pages/KeymapTest";

const isWindows =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

// 两段动画：先淡出旧页（旧内容往上飞），换页并等新页 layout 完成，
// 再淡入新页（新内容从下方浮上）
const FADE_OUT_MS = 160;
const FADE_IN_MS = 280;

function renderPage(key: NavKey) {
  switch (key) {
    case "overview":
      return <Overview />;
    case "timeline":
      return <Timeline />;
    case "keyboard":
      return <Keyboard />;
    case "insights":
      return <Insights />;
    case "settings":
      return <Settings />;
    case "dev":
      return <Dev />;
    case "keymap-test":
      return <KeymapTest />;
  }
}

type Phase = "idle" | "leaving" | "entering-start" | "entering";

export default function App() {
  const [active, setActive] = useState<NavKey>("overview");
  const [displayed, setDisplayed] = useState<NavKey>("overview");
  const [phase, setPhase] = useState<Phase>("idle");
  const [transitionEnabled, setTransitionEnabled] = useState(
    () => localStorage.getItem("page_transition_enabled") !== "false"
  );
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      setTransitionEnabled((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener("page-transition-change", handler);
    return () => window.removeEventListener("page-transition-change", handler);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  function clearTimers() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function handleSelect(next: NavKey) {
    if (next === active) return;
    setActive(next);

    if (!transitionEnabled) {
      clearTimers();
      setDisplayed(next);
      setPhase("idle");
      return;
    }

    clearTimers();

    // 1) 淡出旧页
    setPhase("leaving");

    timerRef.current = window.setTimeout(() => {
      // 2) 换页 —— 新页以"entering-start"（透明 + 下方 10px）挂载，无过渡
      setDisplayed(next);
      setPhase("entering-start");

      // 3) 两次 rAF 后切到 entering，触发 transition
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = window.requestAnimationFrame(() => {
          setPhase("entering");
          timerRef.current = window.setTimeout(() => {
            setPhase("idle");
            timerRef.current = null;
          }, FADE_IN_MS);
        });
      });
    }, FADE_OUT_MS);
  }

  let layerClass = "page-layer";
  if (phase === "leaving") layerClass += " is-leaving";
  else if (phase === "entering-start") layerClass += " is-entering-start";
  else if (phase === "entering") layerClass += " is-entering";

  const dur = phase === "leaving" ? FADE_OUT_MS : FADE_IN_MS;
  const style = { "--page-fade-dur": `${dur}ms` } as React.CSSProperties;

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={handleSelect} />
      <div className="app-right">
        {isWindows && <TitleBar />}
        <main className="app-main">
          <div className={layerClass} style={style}>
            {renderPage(displayed)}
          </div>
        </main>
      </div>
    </div>
  );
}
