import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Sidebar, { NavKey } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import Overview from "./pages/Overview";
import Timeline from "./pages/Timeline";
import Keyboard from "./pages/Keyboard";
import Insights from "./pages/Insights";
import Settings from "./pages/Settings";
import Ai from "./pages/Ai";
import Dev from "./pages/Dev";
import KeymapTest from "./pages/KeymapTest";
import { useContextState, useContextActions } from "./store/context";
import { TopBarToolsProvider } from "./components/topbar/TopBarToolsContext";
import { useAiEnabled } from "./ai/master";

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
    case "input":
      return <Keyboard />;
    case "patterns":
      return <Insights />;
    case "ai":
      return <Ai />;
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
  const { page } = useContextState();
  const actions = useContextActions();
  const [aiEnabled] = useAiEnabled();
  const [displayed, setDisplayed] = useState<NavKey>(page);
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

  // 总开关关闭时若还停在「AI」页，跳回概览（覆盖「停在 AI 页时关掉开关」的防御路径）。
  useEffect(() => {
    if (page === "ai" && !aiEnabled) {
      actions.navigate({ page: "overview" });
    }
  }, [page, aiEnabled, actions]);

  useEffect(() => {
    const unlistenPromise = listen<string>("menu-navigate", (event) => {
      const target = event.payload as NavKey;
      actions.navigate({ page: target });
    });
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, [actions]);

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

  useEffect(() => {
    if (page === displayed) return;

    if (!transitionEnabled) {
      clearTimers();
      setDisplayed(page);
      setPhase("idle");
      return;
    }

    clearTimers();
    setPhase("leaving");                                   // 1) 淡出旧页
    timerRef.current = window.setTimeout(() => {
      setDisplayed(page);                                  // 2) 换页
      setPhase("entering-start");
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = window.requestAnimationFrame(() => {
          setPhase("entering");                            // 3) 双 rAF 后触发 transition
          timerRef.current = window.setTimeout(() => {
            setPhase("idle");
            timerRef.current = null;
          }, FADE_IN_MS);
        });
      });
    }, FADE_OUT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  function handleSelect(next: NavKey) {
    if (next === page) return;
    actions.navigate({ page: next });
  }

  let layerClass = "page-layer";
  if (phase === "leaving") layerClass += " is-leaving";
  else if (phase === "entering-start") layerClass += " is-entering-start";
  else if (phase === "entering") layerClass += " is-entering";

  const dur = phase === "leaving" ? FADE_OUT_MS : FADE_IN_MS;
  const style = { "--page-fade-dur": `${dur}ms` } as React.CSSProperties;

  return (
    <div className="app-shell">
      <Sidebar active={page} onSelect={handleSelect} />
      <TopBarToolsProvider>
        <div className="app-right">
          <TopBar />
          <main className="app-main">
            <div className={layerClass} style={style}>
              {renderPage(displayed)}
            </div>
          </main>
        </div>
      </TopBarToolsProvider>
    </div>
  );
}
