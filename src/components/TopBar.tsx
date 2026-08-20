import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useContextState,
  useContextActions,
  useHistoryDepth,
  useToday,
  KIND_LABEL,
  PAGE_KIND_CAP,
  normalizeAnchor,
  type RangeKind,
} from "../store/context";
import type { NavKey } from "./Sidebar";
import { toMs } from "../data/ranges";
import { fetchAppRankingInRange } from "../data/client";
import type { RawAppRank } from "../data/types";
import { anchorLabel, formatDuration } from "../utils/format";
import AppIcon from "./AppIcon";
import TopBarTools from "./topbar/TopBarTools";
import Tooltip from "./shared/Tooltip";

const isWindows =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const PAGE_LABEL: Record<NavKey, string> = {
  overview: "概览",
  timeline: "时间线",
  input: "输入",
  patterns: "规律",
  ai: "AI",
  settings: "设置",
  dev: "原始数据",
  "keymap-test": "键盘映射测试",
};

const KIND_ORDER: RangeKind[] = ["day", "week", "month"];

export default function TopBar() {
  const { page, kind, anchor, appId } = useContextState();
  const actions = useContextActions();
  const historyDepth = useHistoryDepth();

  const today = useToday();
  const cap = PAGE_KIND_CAP[page];

  const atCurrentAnchor = normalizeAnchor(kind, today) === anchor;

  // store 只存 bundleId，展示名从这里查。来源：应用列表拉取结果 + 用户主动选择。
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [rank, setRank] = useState<RawAppRank[]>([]);
  const [rankLoading, setRankLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuScrollRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const prevAppIdRef = useRef(appId);
  const [menuThumb, setMenuThumb] = useState<{ top: number; height: number } | null>(null);

  const updateMenuThumb = useCallback(() => {
    const el = menuScrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      setMenuThumb(null);
      return;
    }
    const inset = 4;
    const trackHeight = clientHeight - inset * 2;
    const thumbHeight = Math.max((clientHeight / scrollHeight) * trackHeight, 24);
    const top = inset + (scrollTop / (scrollHeight - clientHeight)) * (trackHeight - thumbHeight);
    setMenuThumb({ top, height: thumbHeight });
  }, []);

  useEffect(() => {
    // appId !== null 时也要拉：外部（概览/规律/时间线）下钻设置 appId 时菜单并未打开，
    // 但芯片仍要靠这份排行数据把 bundle id 解析成人话名，否则芯片会一直显示原始 bundle id。
    if (!menuOpen && appId === null) return;
    let cancelled = false;
    setRankLoading(true);
    fetchAppRankingInRange(toMs(kind, anchor))
      .then((list) => {
        if (cancelled) return;
        setRank(list);
        setAppNames((prev) => {
          const next = { ...prev };
          for (const r of list) {
            if (r.app_bundle_id && r.app_name) next[r.app_bundle_id] = r.app_name;
          }
          return next;
        });
      })
      .catch((e) => console.error("获取应用排行失败:", e))
      .finally(() => {
        if (!cancelled) setRankLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen, kind, anchor, appId]);

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

  // App 筛选值真的变了才闪——不是「点了芯片」才闪。
  // 所以从概览/规律/时间线点 App 下钻（actions.navigate({ appId })）同样会触发，
  // 这正是这个动效的用途：把视线拉回顶栏，说明刚才那一点改的是全局筛选。
  // 切回「全部应用」（appId → null）也算变化，同样闪。
  useLayoutEffect(() => {
    if (prevAppIdRef.current === appId) return;   // 首次挂载不闪
    prevAppIdRef.current = appId;
    const el = chipRef.current;
    if (!el) return;
    el.classList.remove("is-flash");
    void el.offsetWidth;   // 强制同步重排：不读这一下，remove→add 会被合并成「没变化」，动画不会重播
    el.classList.add("is-flash");
  }, [appId]);

  function pickApp(item: RawAppRank | null) {
    if (item === null) {
      actions.setApp(null);
    } else {
      if (item.app_name) {
        setAppNames((prev) => ({ ...prev, [item.app_bundle_id]: item.app_name }));
      }
      actions.setApp(item.app_bundle_id);
    }
    setMenuOpen(false);
  }

  const filteredRank = rank.filter(
    (r) => r.app_bundle_id && r.app_bundle_id !== "unknown"
  );

  // 芯片显示状态完全由全局 appId 派生，不再有本地副本。
  // 这样从概览/规律/时间线点 App 下钻（actions.navigate({ appId })）时芯片也会正确更新。
  const selectedApp = appId ? { bundleId: appId, name: appNames[appId] ?? appId } : null;

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuThumb();
  }, [menuOpen, rankLoading, filteredRank.length, updateMenuThumb]);

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar__kind" role="group" aria-label="时间粒度">
        {KIND_ORDER.map((k) => {
          const enabled = cap.includes(k);
          const title = enabled
            ? undefined
            : `「${PAGE_LABEL[page]}」页只支持${cap.map((c) => KIND_LABEL[c]).join("/")}粒度`;
          return (
            <Tooltip key={k} content={title}>
              <button
                type="button"
                data-tauri-drag-region="false"
                className={`topbar__kind-btn ${kind === k ? "is-active" : ""} ${!enabled ? "is-disabled" : ""}`}
                disabled={!enabled}
                onClick={() => actions.setKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            </Tooltip>
          );
        })}
      </div>

      <Tooltip content="上一个">
        <button
          type="button"
          data-tauri-drag-region="false"
          className="topbar__nav-btn"
          onClick={() => actions.stepAnchor(-1)}
          aria-label="上一个"
        >
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
      </Tooltip>
      <span className="topbar__anchor-label">{anchorLabel(kind, anchor, today)}</span>
      <Tooltip content={atCurrentAnchor ? "没有未来的数据" : "下一个"}>
        <button
          type="button"
          data-tauri-drag-region="false"
          className="topbar__nav-btn"
          onClick={() => actions.stepAnchor(1)}
          disabled={atCurrentAnchor}
          aria-label="下一个"
        >
          <ChevronRight size={16} strokeWidth={2} />
        </button>
      </Tooltip>
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
          ref={chipRef}
          type="button"
          data-tauri-drag-region="false"
          className={`topbar__chip ${selectedApp ? "is-filtered" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          onAnimationEnd={(e) => {
            // 只清自己的动画——animationend 会从子元素冒泡上来
            if (e.target === e.currentTarget) {
              e.currentTarget.classList.remove("is-flash");
            }
          }}
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
          <div className="topbar__app-menu" data-tauri-drag-region="false">
            <div
              className="topbar__app-menu-scroll"
              ref={menuScrollRef}
              onScroll={updateMenuThumb}
            >
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
            {menuThumb && (
              <div
                className="topbar__app-menu-thumb"
                style={{ top: menuThumb.top, height: menuThumb.height }}
                aria-hidden
              />
            )}
          </div>
        )}
      </div>

      <TopBarTools />

      <div className="topbar__spacer" data-tauri-drag-region />

      <Tooltip content="返回">
        <button
          type="button"
          data-tauri-drag-region="false"
          className="topbar__back-btn"
          onClick={() => actions.back()}
          disabled={historyDepth === 0}
          aria-label="返回"
        >
          <ArrowLeft size={16} />
        </button>
      </Tooltip>

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
      <Tooltip content="最小化">
        <button
          className="topbar__winbtn"
          data-tauri-drag-region="false"
          onClick={() => win.minimize()}
          aria-label="最小化"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
      </Tooltip>
      <Tooltip content={maximized ? "还原" : "最大化"}>
        <button
          className="topbar__winbtn"
          data-tauri-drag-region="false"
          onClick={() => win.toggleMaximize()}
          aria-label={maximized ? "还原" : "最大化"}
        >
          {maximized ? <Copy size={12} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
        </button>
      </Tooltip>
      <Tooltip content="关闭">
        <button
          className="topbar__winbtn topbar__winbtn--close"
          data-tauri-drag-region="false"
          onClick={() => win.close()}
          aria-label="关闭"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </Tooltip>
    </div>
  );
}
