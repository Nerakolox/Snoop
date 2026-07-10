import { useState } from "react";
import Sidebar, { NavKey } from "./components/Sidebar";
import Overview from "./pages/Overview";
import Timeline from "./pages/Timeline";
import Keyboard from "./pages/Keyboard";
import Insights from "./pages/Insights";
import Settings from "./pages/Settings";
import Dev from "./pages/Dev";

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
  }
}

export default function App() {
  const [active, setActive] = useState<NavKey>("overview");

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={setActive} />
      <main className="app-main">{renderPage(active)}</main>
    </div>
  );
}
