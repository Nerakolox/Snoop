import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { useContextState, useContextActions } from "../../store/context";
import { useTopBarToolItems, type TopBarToolItem } from "./TopBarToolsContext";

const MORE_BTN_WIDTH = 24;

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export default function TopBarTools() {
  const { page, focusHour, selectedKey } = useContextState();
  const actions = useContextActions();
  const pageItems = useTopBarToolItems();

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [overflowKeys, setOverflowKeys] = useState<Set<string>>(new Set());

  // 内建上下文芯片：由这里直接从 store 读，页面不用管（见 S2 文档 4.2）
  const builtins: TopBarToolItem[] = useMemo(() => {
    const list: TopBarToolItem[] = [];
    if (page === "timeline" && focusHour !== null) {
      list.push({
        key: "__builtin-focus-hour",
        priority: "high",
        node: (
          <span className="topbar__chip topbar__chip--context is-filtered">
            <span className="topbar__label">定位 · {formatHour(focusHour)}</span>
            <span
              className="topbar__chip-clear"
              role="button"
              tabIndex={0}
              data-tauri-drag-region="false"
              aria-label="清除定位"
              onClick={(e) => {
                e.stopPropagation();
                actions.setFocusHour(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  actions.setFocusHour(null);
                }
              }}
            >
              <X size={12} />
            </span>
          </span>
        ),
      });
    }
    if (page === "input" && selectedKey !== null) {
      list.push({
        key: "__builtin-selected-key",
        priority: "high",
        node: (
          <span className="topbar__chip topbar__chip--context is-filtered">
            <span className="topbar__label">单键 · {selectedKey}</span>
            <span
              className="topbar__chip-clear"
              role="button"
              tabIndex={0}
              data-tauri-drag-region="false"
              aria-label="清除单键筛选"
              onClick={(e) => {
                e.stopPropagation();
                actions.setSelectedKey(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  actions.setSelectedKey(null);
                }
              }}
            >
              <X size={12} />
            </span>
          </span>
        ),
      });
    }
    return list;
  }, [page, focusHour, selectedKey, actions]);

  const allItems = useMemo(() => [...builtins, ...pageItems], [builtins, pageItems]);

  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    const measureEl = measureRef.current;
    if (!containerEl || !measureEl) return;

    function recompute() {
      if (!containerEl || !measureEl) return;
      if (allItems.length === 0) {
        setVisibleKeys(new Set());
        setOverflowKeys(new Set());
        return;
      }

      const spacerEl = containerEl.nextElementSibling as HTMLElement | null;
      const spacerWidth = spacerEl ? spacerEl.getBoundingClientRect().width : 0;
      const containerWidth = containerEl.getBoundingClientRect().width;
      const available = containerWidth + spacerWidth;

      const gap = parseFloat(getComputedStyle(containerEl).columnGap || "0") || 0;

      const widths = new Map<string, number>();
      measureEl.querySelectorAll<HTMLElement>("[data-key]").forEach((el) => {
        widths.set(el.dataset.key as string, el.getBoundingClientRect().width);
      });

      // 排序键 = priority（high 在前）+ 原注册顺序（tiebreak）
      const ordered = allItems.map((it, i) => ({ ...it, i })).sort((a, b) => {
        const pa = a.priority === "high" ? 0 : 1;
        const pb = b.priority === "high" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.i - b.i;
      });

      function pack(budget: number): Set<string> {
        const keys = new Set<string>();
        let used = 0;
        for (const it of ordered) {
          const w = widths.get(it.key) ?? 0;
          const addition = (keys.size > 0 ? gap : 0) + w;
          if (used + addition > budget) break;
          used += addition;
          keys.add(it.key);
        }
        return keys;
      }

      let visible = pack(available);
      let overflow = allItems.filter((it) => !visible.has(it.key)).map((it) => it.key);

      if (overflow.length > 0) {
        visible = pack(available - MORE_BTN_WIDTH - gap);
        overflow = allItems.filter((it) => !visible.has(it.key)).map((it) => it.key);
      }

      setVisibleKeys(visible);
      setOverflowKeys(new Set(overflow));
    }

    recompute();

    const ro = new ResizeObserver(recompute);
    ro.observe(containerEl);
    ro.observe(measureEl);
    const spacerEl = containerEl.nextElementSibling as HTMLElement | null;
    if (spacerEl) ro.observe(spacerEl);

    return () => ro.disconnect();
  }, [allItems]);

  useLayoutEffect(() => {
    if (overflowKeys.size === 0) setMenuOpen(false);
  }, [overflowKeys]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (moreBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
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

  if (allItems.length === 0) {
    return <div className="topbar__tools" ref={containerRef} />;
  }

  const visibleItems = allItems.filter((it) => visibleKeys.has(it.key));
  const overflowItems = allItems.filter((it) => overflowKeys.has(it.key));

  return (
    <div className="topbar__tools" ref={containerRef}>
      {/* 裁剪只作用于这一行，菜单是它的外部兄弟，不会被 overflow:hidden 一起裁掉 */}
      <div className="topbar__tools-row">
        <div className="topbar__tools-measure" aria-hidden ref={measureRef}>
          {allItems.map((it) => (
            <div className="topbar__tools-item" key={it.key} data-key={it.key}>
              {it.node}
            </div>
          ))}
        </div>

        {visibleItems.map((it) => (
          <div className="topbar__tools-item" key={it.key}>
            {it.node}
          </div>
        ))}

        {overflowItems.length > 0 && (
          <button
            ref={moreBtnRef}
            type="button"
            className="topbar__tools-more"
            data-tauri-drag-region="false"
            aria-label="更多工具"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>

      {menuOpen && overflowItems.length > 0 && (
        <div className="topbar__tools-menu" data-tauri-drag-region="false" ref={menuRef}>
          {overflowItems.map((it) => (
            <div className="topbar__tools-menu-row" key={it.key}>
              {it.node}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
