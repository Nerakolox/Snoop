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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
