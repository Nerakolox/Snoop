import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useContextState,
  useContextActions,
  useHistoryDepth,
  KIND_LABEL,
  PAGE_KIND_CAP,
  normalizeAnchor,
  type RangeKind,
} from "../store/context";
import type { NavKey } from "./Sidebar";
import { formatAnchor, toMs } from "../data/ranges";
import { fetchAppRankingInRange } from "../data/client";
import type { RawAppRank } from "../data/types";
import { anchorLabel, formatDuration } from "../utils/format";
import AppIcon from "./AppIcon";

const isWindows =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const PAGE_LABEL: Record<NavKey, string> = {
  overview: "概览",
  timeline: "时间线",
  input: "输入",
  patterns: "规律",
  settings: "设置",
  dev: "原始数据",
  "keymap-test": "键盘映射测试",
};

const KIND_ORDER: RangeKind[] = ["day", "week", "month"];

export default function TopBar() {
  const { page, kind, anchor, appId } = useContextState();
  const actions = useContextActions();
  const historyDepth = useHistoryDepth();

  const now = useMemo(() => new Date(), []);
  const cap = PAGE_KIND_CAP[page];

  const atCurrentAnchor = normalizeAnchor(kind, formatAnchor(new Date())) === anchor;

  const [selectedApp, setSelectedApp] = useState<{ bundleId: string; name: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rank, setRank] = useState<RawAppRank[]>([]);
  const [rankLoading, setRankLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    setRankLoading(true);
    fetchAppRankingInRange(toMs(kind, anchor))
      .then((list) => {
        if (!cancelled) setRank(list);
      })
      .catch((e) => console.error("获取应用排行失败:", e))
      .finally(() => {
        if (!cancelled) setRankLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen, kind, anchor]);

  useEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (appId === null) setSelectedApp(null);
  }, [appId]);

  function pickApp(item: RawAppRank | null) {
    if (item === null) {
      actions.setApp(null);
      setSelectedApp(null);
    } else {
      actions.setApp(item.app_bundle_id);
      setSelectedApp({ bundleId: item.app_bundle_id, name: item.app_name || item.app_bundle_id });
    }
    setMenuOpen(false);
  }

  const filteredRank = rank.filter(
    (r) => r.app_bundle_id && r.app_bundle_id !== "unknown"
  );

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar__kind" role="group" aria-label="时间粒度">
        {KIND_ORDER.map((k) => {
          const enabled = cap.includes(k);
          const title = enabled
            ? undefined
            : `「${PAGE_LABEL[page]}」页只支持${cap.map((c) => KIND_LABEL[c]).join("/")}粒度`;
          return (
            <button
              key={k}
              type="button"
              data-tauri-drag-region="false"
              className={`topbar__kind-btn ${kind === k ? "is-active" : ""} ${!enabled ? "is-disabled" : ""}`}
              disabled={!enabled}
              title={title}
              onClick={() => actions.setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        data-tauri-drag-region="false"
        className="topbar__nav-btn"
        onClick={() => actions.stepAnchor(-1)}
        aria-label="上一个"
        title="上一个"
      >
        <ChevronLeft size={16} strokeWidth={2} />
      </button>
      <span className="topbar__anchor-label">{anchorLabel(kind, anchor, now)}</span>
      <button
        type="button"
        data-tauri-drag-region="false"
        className="topbar__nav-btn"
        onClick={() => actions.stepAnchor(1)}
        disabled={atCurrentAnchor}
        aria-label="下一个"
        title={atCurrentAnchor ? "没有未来的数据" : "下一个"}
      >
        <ChevronRight size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        data-tauri-drag-region="false"
        className="topbar__today-btn"
        onClick={() => actions.goToday()}
        disabled={atCurrentAnchor}
      >
        今天
      </button>

      <div className="topbar__divider" aria-hidden />

      <div className="topbar__app-filter" ref={menuRef}>
        <button
          type="button"
          data-tauri-drag-region="false"
          className={`topbar__chip ${selectedApp ? "is-filtered" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {selectedApp ? (
            <>
              <AppIcon bundleId={selectedApp.bundleId} appName={selectedApp.name} size={16} />
              <span className="topbar__label">{selectedApp.name}</span>
              <span
                className="topbar__chip-clear"
                role="button"
                tabIndex={0}
                data-tauri-drag-region="false"
                aria-label="清除应用筛选"
                onClick={(e) => {
                  e.stopPropagation();
                  pickApp(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    pickApp(null);
                  }
                }}
              >
                <X size={12} />
              </span>
            </>
          ) : (
            <>
              <span className="topbar__label">全部应用</span>
              <ChevronDown size={14} />
            </>
          )}
        </button>

        {menuOpen && (
          <div className="topbar__app-menu scroll-area" data-tauri-drag-region="false">
            <button
              type="button"
              className={`topbar__app-menu-item ${!selectedApp ? "is-active" : ""}`}
              onClick={() => pickApp(null)}
            >
              全部应用
            </button>
            {rankLoading && <div className="topbar__app-menu-empty">加载中…</div>}
            {!rankLoading && filteredRank.length === 0 && (
              <div className="topbar__app-menu-empty">该范围内暂无数据</div>
            )}
            {!rankLoading &&
              filteredRank.map((r) => (
                <button
                  type="button"
                  key={r.app_bundle_id}
                  className={`topbar__app-menu-item ${selectedApp?.bundleId === r.app_bundle_id ? "is-active" : ""}`}
                  onClick={() => pickApp(r)}
                >
                  <AppIcon bundleId={r.app_bundle_id} appName={r.app_name} size={16} />
                  <span className="topbar__app-menu-name">{r.app_name || r.app_bundle_id}</span>
                  <span className="topbar__app-menu-time">{formatDuration(r.total_sec * 1000)}</span>
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="topbar__spacer" data-tauri-drag-region />

      <button
        type="button"
        data-tauri-drag-region="false"
        className="topbar__back-btn"
        onClick={() => actions.back()}
        disabled={historyDepth === 0}
        aria-label="返回"
        title="返回"
      >
        <ArrowLeft size={16} />
      </button>

      {isWindows && <WindowControls />}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="topbar__winctrls">
      <button
        className="topbar__winbtn"
        data-tauri-drag-region="false"
        onClick={() => win.minimize()}
        aria-label="最小化"
        title="最小化"
      >
        <Minus size={14} strokeWidth={1.5} />
      </button>
      <button
        className="topbar__winbtn"
        data-tauri-drag-region="false"
        onClick={() => win.toggleMaximize()}
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
      >
        {maximized ? <Copy size={12} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      <button
        className="topbar__winbtn topbar__winbtn--close"
        data-tauri-drag-region="false"
        onClick={() => win.close()}
        aria-label="关闭"
        title="关闭"
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}
