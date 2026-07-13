import { useEffect, useState } from "react";
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

  useEffect(() => {
    const handler = (e: Event) => {
      setTransitionEnabled((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener("page-transition-change", handler);
    return () => window.removeEventListener("page-transition-change", handler);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={setActive} />
      <div className="app-right">
        {isWindows && <TitleBar />}
        <main className="app-main">
          <div
            key={active}
            className={`page-transition${transitionEnabled ? "" : " is-disabled"}`}
          >
            {renderPage(active)}
          </div>
        </main>
      </div>
    </div>
  );
}
