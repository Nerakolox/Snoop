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

const TRANSITION_MS = 220;

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

export default function App() {
  const [active, setActive] = useState<NavKey>("overview");
  const [transitionEnabled, setTransitionEnabled] = useState(
    () => localStorage.getItem("page_transition_enabled") !== "false"
  );
  const [prevKey, setPrevKey] = useState<NavKey | null>(null);
  const prevKeyRef = useRef<NavKey>(active);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      setTransitionEnabled((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener("page-transition-change", handler);
    return () => window.removeEventListener("page-transition-change", handler);
  }, []);

  function handleSelect(next: NavKey) {
    if (next === active) return;
    if (transitionEnabled) {
      setPrevKey(prevKeyRef.current);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setPrevKey(null);
        timerRef.current = null;
      }, TRANSITION_MS);
    }
    prevKeyRef.current = next;
    setActive(next);
  }

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={handleSelect} />
      <div className="app-right">
        {isWindows && <TitleBar />}
        <main className="app-main">
          <div className="page-stack">
            {prevKey !== null && prevKey !== active && (
              <div key={`out-${prevKey}`} className="page-layer is-leaving" aria-hidden>
                {renderPage(prevKey)}
              </div>
            )}
            <div
              key={`in-${active}`}
              className={`page-layer${transitionEnabled ? " is-entering" : ""}`}
            >
              {renderPage(active)}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
