import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// 平台标记：供 CSS 通过 body[data-platform] 分派样式
const ua = navigator.userAgent;
const platform =
  /Windows/i.test(ua) ? "windows" :
  /Mac OS X|Macintosh/i.test(ua) ? "macos" :
  /Linux/i.test(ua) ? "linux" : "unknown";
document.body.dataset.platform = platform;

// 禁用 webview 默认右键菜单，让 App 更像原生程序（Ctrl+C/V 依然可用）
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 主题初始化：在渲染前立即应用，避免闪烁
const savedTheme = localStorage.getItem("theme") as "system" | "light" | "dark" | null;
const theme = savedTheme || "system";
const root = document.documentElement;
if (theme === "system") {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", isDark ? "dark" : "light");
} else {
  root.setAttribute("data-theme", theme);
}

// 监听系统主题变化（仅当用户选择"跟随系统"时生效）
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
mediaQuery.addEventListener("change", () => {
  const current = localStorage.getItem("theme");
  if (current === "system") {
    root.setAttribute("data-theme", mediaQuery.matches ? "dark" : "light");
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
