// 设置 → 分类（分类柜视图）。
//
// 分类柜是「分类」页的默认视图，是操作分类的一等视图（与之并列的「列表」即
// 原有的增删改列表 + 应用归类列表）。它自上而下：待整理区 → 文件夹网格 →
// 已归档折叠区。
//
// 这里只负责**视图**：分类的增删改、颜色算法、归档、AI 批量分类、撤销机制全在
// 父级 Categories.tsx 或 categories/* 里，本组件只消费并触发它们。
//
// 配色遵循项目色彩规约：全部走语义 token，此页不出现暖色阶；分类色一律走
// categories/store 的 fillOf（系统分类中性、归档中性），不新建色板、不硬编码。

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive, ArchiveRestore, ChevronDown, Pencil, Plus, Search, Trash2, Undo2,
} from "lucide-react";
import AppIcon from "../../components/AppIcon";
import Tooltip from "../../components/shared/Tooltip";
import type { AppCategoryRow } from "../../ai/types";
import { fillOf } from "../../categories/store";
import { ID_OTHER, ID_UNCATEGORIZED } from "../../categories/constants";
import type { CategoryRow } from "../../categories/types";

/** 第二行区分标记的截断上限：过长保留末尾字符。 */
const MARKER_MAX = 20;

/** 悬停弹开文件夹的延迟（秒 → 毫秒）。 */
const HOVER_OPEN_MS = 500;

// ── 同名标记 ──────────────────────────────────────────────────────────────────
//
// 不做应用合并的前提下，同一可执行文件的不同路径各占一个独立图标。当一组图标
// 同名时，比对这些条目的完整路径（Windows 上 app_id 即 exe 路径），取**第一处
// 出现差异的路径段**作为第二行标记；该段过长则保留末尾。不同名的应用不显示。

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function tailTruncate(s: string, max = MARKER_MAX): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - (max - 1))}`;
}

function buildMarkers(apps: AppCategoryRow[]): Map<string, string> {
  const byName = new Map<string, AppCategoryRow[]>();
  for (const a of apps) {
    const key = a.app_name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(a);
    byName.set(key, list);
  }
  const out = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const paths = group.map((a) => pathSegments(a.app_id));
    const maxLen = Math.max(...paths.map((p) => p.length));
    let idx = -1;
    for (let i = 0; i < maxLen; i++) {
      const segs = new Set(paths.map((p) => p[i] ?? ""));
      if (segs.size > 1) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    for (const a of group) {
      const seg = pathSegments(a.app_id)[idx] ?? "";
      if (seg) out.set(a.app_id, tailTruncate(seg));
    }
  }
  return out;
}

function rectContains(el: HTMLElement, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** 拖拽源：应用图标（归类）或文件夹方块本体（重排）。二者必须区分。 */
type DragPayload = { kind: "app"; ids: string[] } | { kind: "folder"; id: string };

export interface DragUndoEntry {
  app: AppCategoryRow;
  origCategory: string | null;
}

export default function CategoryCabinet({
  apps,
  order,
  atLimit,
  q,
  onSearch,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onAssign,
  onResetApps,
  onCreateFromDrop,
  onReorder,
  onUndoDrag,
}: {
  apps: AppCategoryRow[] | null;
  order: CategoryRow[] | null;
  atLimit: boolean;
  q: string;
  onSearch: (q: string) => void;
  onEdit: (cat: CategoryRow) => void;
  onArchive: (cat: CategoryRow) => void;
  onRestore: (cat: CategoryRow) => void;
  onDelete: (cat: CategoryRow) => void;
  onAssign: (apps: AppCategoryRow[], categoryId: string) => Promise<boolean>;
  onResetApps: (apps: AppCategoryRow[]) => Promise<boolean>;
  onCreateFromDrop: (apps: AppCategoryRow[]) => void;
  onReorder: (newActiveIds: string[]) => void;
  onUndoDrag: (entries: DragUndoEntry[]) => Promise<boolean>;
}) {
  const byId = useMemo(() => new Map((order ?? []).map((c) => [c.id, c])), [order]);
  const active = useMemo(() => (order ?? []).filter((c) => !c.is_archived), [order]);
  const archived = useMemo(() => (order ?? []).filter((c) => c.is_archived), [order]);
  /** 网格里的文件夹：未归档、排除「未分类」，「其他」固定在末尾。 */
  const gridFolders = useMemo(() => {
    const reorderable = active.filter((c) => c.id !== ID_UNCATEGORIZED && c.id !== ID_OTHER);
    const other = active.find((c) => c.id === ID_OTHER);
    return other ? [...reorderable, other] : reorderable;
  }, [active]);
  const assignable = useMemo(() => active.filter((c) => c.id !== ID_UNCATEGORIZED), [active]);

  const uncategorizedApps = useMemo(
    () => (apps ?? []).filter((a) => !a.category || !byId.has(a.category)),
    [apps, byId],
  );
  const appsByFolder = useMemo(() => {
    const m = new Map<string, AppCategoryRow[]>();
    for (const a of apps ?? []) {
      if (!a.category || !byId.has(a.category)) continue;
      const list = m.get(a.category) ?? [];
      list.push(a);
      m.set(a.category, list);
    }
    return m;
  }, [apps, byId]);

  const markers = useMemo(() => buildMarkers(apps ?? []), [apps]);

  // ── 选择与拖拽 ──────────────────────────────────────────────────────────────

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [dragging, setDraggingState] = useState<DragPayload | null>(null);
  const draggingRef = useRef<DragPayload | null>(null);
  function setDrag(p: DragPayload | null) {
    draggingRef.current = p;
    setDraggingState(p);
  }

  // ── 悬停弹层 ────────────────────────────────────────────────────────────────

  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [openMode, setOpenMode] = useState<"hover" | "click">("hover");
  const openFolderRef = useRef<string | null>(null);
  const openModeRef = useRef<"hover" | "click">("hover");
  const [floatPos, setFloatPos] = useState<{ left: number; top: number } | null>(null);
  const folderRefs = useRef(new Map<string, HTMLElement>());
  const floatRef = useRef<HTMLDivElement | null>(null);
  const dashedRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const hoverIdRef = useRef<string | null>(null);

  function openFloat(id: string, mode: "hover" | "click") {
    openFolderRef.current = id;
    openModeRef.current = mode;
    setOpenFolderId(id);
    setOpenMode(mode);
  }
  function closeFloat() {
    openFolderRef.current = null;
    setOpenFolderId(null);
    setFloatPos(null);
  }
  function clearHoverTimer() {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }
  function scheduleClose() {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeFloat();
      hoverIdRef.current = null;
    }, 150);
  }
  function cancelClose() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  // ── 撤销提示条 ──────────────────────────────────────────────────────────────

  const [undoEntry, setUndoEntry] = useState<{
    apps: DragUndoEntry[];
    targetName: string;
    count: number;
  } | null>(null);

  // ── 右键菜单 ────────────────────────────────────────────────────────────────

  const [menu, setMenu] = useState<{ app: AppCategoryRow; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ── 已归档折叠区 ────────────────────────────────────────────────────────────

  const [archivedOpen, setArchivedOpen] = useState(false);

  // ── 侧效应：弹层定位 / 点击外部关闭 ─────────────────────────────────────────

  useLayoutEffect(() => {
    if (!openFolderId) return;
    const el = folderRefs.current.get(openFolderId);
    const fl = floatRef.current;
    if (!el || !fl) return;
    const r = el.getBoundingClientRect();
    const fr = fl.getBoundingClientRect();
    const GAP = 8;
    const MARGIN = 8;
    let left = r.left;
    let top = r.bottom + GAP;
    if (top + fr.height > window.innerHeight - MARGIN) {
      top = r.top - GAP - fr.height;
      if (top < MARGIN) top = MARGIN;
    }
    left = Math.max(MARGIN, Math.min(window.innerWidth - fr.width - MARGIN, left));
    setFloatPos({ left, top });
  }, [openFolderId]);

  // 单击打开的浮层：点外部 / Esc 关闭，不随光标移出收回。
  useEffect(() => {
    if (openFolderId === null || openMode !== "click") return;
    function onMouseDown(e: MouseEvent) {
      if (floatRef.current?.contains(e.target as Node)) return;
      closeFloat();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeFloat();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openFolderId, openMode]);

  // 右键菜单：点外部 / Esc 关闭。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // ── 拖拽生命周期 ────────────────────────────────────────────────────────────

  function startAppDrag(e: React.DragEvent, app: AppCategoryRow) {
    const ids = selected.has(app.app_id) ? Array.from(selected) : [app.app_id];
    if (!selected.has(app.app_id)) setSelected(new Set([app.app_id]));
    e.dataTransfer.setData("application/x-snoop-apps", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    setDrag({ kind: "app", ids });
  }

  function startFolderDrag(e: React.DragEvent, cat: CategoryRow) {
    e.dataTransfer.setData("application/x-snoop-folder", cat.id);
    e.dataTransfer.effectAllowed = "move";
    setDrag({ kind: "folder", id: cat.id });
  }

  function finishDrag() {
    if (!draggingRef.current) return;
    setDrag(null);
    clearHoverTimer();
    cancelClose();
    hoverIdRef.current = null;
    if (openModeRef.current === "hover") closeFloat();
  }

  // dragend 永远在拖拽源上触发，且会冒泡到 document——无论源是待整理区图标、
  // 文件夹方块，还是从浮层里拖出来的图标（浮层是 portal，不在根容器内），都能靠
  // 这一个全局监听兜底收尾：Esc 取消、拖到柜外松手都不会留下卡住的拖拽态。
  useEffect(() => {
    document.addEventListener("dragend", finishDrag);
    return () => document.removeEventListener("dragend", finishDrag);
  }, []);

  // ── 选择交互 ────────────────────────────────────────────────────────────────

  function onAppClick(e: React.MouseEvent, app: AppCategoryRow) {
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(app.app_id)) n.delete(app.app_id);
        else n.add(app.app_id);
        return n;
      });
      anchorRef.current = app.app_id;
    } else if (e.shiftKey) {
      // 范围选中：在待整理区 + 网格 + 归档展开区的展开顺序里取区间。
      const flat = [
        ...uncategorizedApps,
        ...gridFolders.flatMap((c) => appsByFolder.get(c.id) ?? []),
        ...archived.flatMap((c) => appsByFolder.get(c.id) ?? []),
      ].map((a) => a.app_id);
      const a = anchorRef.current ? flat.indexOf(anchorRef.current) : -1;
      const b = flat.indexOf(app.app_id);
      if (a < 0 || b < 0) {
        setSelected(new Set([app.app_id]));
      } else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected((prev) => {
          const n = new Set(prev);
          for (let i = lo; i <= hi; i++) n.add(flat[i]);
          return n;
        });
      }
      anchorRef.current = app.app_id;
    } else {
      setSelected(new Set([app.app_id]));
      anchorRef.current = app.app_id;
    }
  }

  function onAppContextMenu(e: React.MouseEvent, app: AppCategoryRow) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      app,
      x: Math.min(e.clientX, window.innerWidth - 224),
      y: Math.min(e.clientY, window.innerHeight - 320),
    });
  }

  // ── 归类写入 ────────────────────────────────────────────────────────────────

  async function doAssign(categoryId: string, list: AppCategoryRow[]) {
    const target = byId.get(categoryId);
    const ok = await onAssign(list, categoryId);
    if (ok) {
      setUndoEntry({
        apps: list.map((a) => ({ app: a, origCategory: a.category })),
        targetName: target?.name ?? categoryId,
        count: list.length,
      });
    }
  }

  async function doUndo() {
    if (!undoEntry) return;
    const ok = await onUndoDrag(undoEntry.apps);
    if (ok) setUndoEntry(null);
  }

  async function pickCategory(categoryId: string | null) {
    const app = menu?.app;
    setMenu(null);
    if (!app) return;
    if (categoryId === null) await onResetApps([app]);
    else await onAssign([app], categoryId);
  }

  function doReorder(fromId: string, targetId: string) {
    const reorderable = gridFolders.filter((c) => c.id !== ID_OTHER);
    const fromIdx = reorderable.findIndex((c) => c.id === fromId);
    const toIdx = reorderable.findIndex((c) => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const list = [...reorderable];
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    onReorder([...list.map((c) => c.id), ID_OTHER, ID_UNCATEGORIZED]);
  }

  // ── 拖拽悬浮 / 自动滚动 / 落点判定（根容器统一处理） ────────────────────────

  function autoScroll(clientY: number) {
    const scroller = rootRef.current?.closest(".app-main") as HTMLElement | null;
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    const THRESH = 64;
    const STEP = 14;
    if (clientY < r.top + THRESH) scroller.scrollTop -= STEP;
    else if (clientY > r.bottom - THRESH) scroller.scrollTop += STEP;
  }

  function updateHover(x: number, y: number) {
    let overId: string | null = null;
    for (const c of gridFolders) {
      const el = folderRefs.current.get(c.id);
      if (el && rectContains(el, x, y)) {
        overId = c.id;
        break;
      }
    }
    const overFloat =
      openFolderRef.current !== null &&
      floatRef.current != null &&
      rectContains(floatRef.current, x, y);

    if (overId) {
      cancelClose();
      const cur = openFolderRef.current;
      if (cur === overId) return;
      if (cur !== null && openModeRef.current === "hover") closeFloat();
      if (hoverIdRef.current !== overId) {
        hoverIdRef.current = overId;
        clearHoverTimer();
        hoverTimerRef.current = window.setTimeout(() => {
          if (draggingRef.current?.kind === "app" && hoverIdRef.current === overId) {
            openFloat(overId, "hover");
          }
        }, HOVER_OPEN_MS);
      }
      return;
    }

    clearHoverTimer();
    hoverIdRef.current = null;
    if (openFolderRef.current !== null && openModeRef.current === "hover" && !overFloat) {
      scheduleClose();
    }
  }

  function onRootDragOver(e: React.DragEvent) {
    const d = draggingRef.current;
    if (!d) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    autoScroll(e.clientY);
    if (d.kind === "app") updateHover(e.clientX, e.clientY);
  }

  function findFolderUnder(x: number, y: number): string | null {
    for (const c of gridFolders) {
      const el = folderRefs.current.get(c.id);
      if (el && rectContains(el, x, y)) return c.id;
    }
    return null;
  }

  function onRootDrop(e: React.DragEvent) {
    const d = draggingRef.current;
    if (!d) return;
    e.preventDefault();
    if (d.kind === "app") {
      const list = (apps ?? []).filter((a) => d.ids.includes(a.app_id));
      const x = e.clientX;
      const y = e.clientY;
      if (openFolderRef.current && floatRef.current && rectContains(floatRef.current, x, y)) {
        doAssign(openFolderRef.current, list);
        finishDrag();
        return;
      }
      const folder = findFolderUnder(x, y);
      if (folder) {
        doAssign(folder, list);
        finishDrag();
        return;
      }
      if (dashedRef.current && rectContains(dashedRef.current, x, y)) {
        onCreateFromDrop(list);
        finishDrag();
        return;
      }
      finishDrag();
    } else {
      const target = findFolderUnder(e.clientX, e.clientY);
      if (target && target !== d.id && target !== ID_OTHER) doReorder(d.id, target);
      finishDrag();
    }
  }

  function onFloatDragOver(e: React.DragEvent) {
    if (draggingRef.current?.kind !== "app") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cancelClose();
  }
  function onFloatDragLeave() {
    if (draggingRef.current?.kind !== "app") return;
    scheduleClose();
  }
  function onFloatDrop(e: React.DragEvent) {
    const d = draggingRef.current;
    if (!d || d.kind !== "app" || !openFolderRef.current) return;
    e.preventDefault();
    const list = (apps ?? []).filter((a) => d.ids.includes(a.app_id));
    doAssign(openFolderRef.current, list);
    finishDrag();
  }

  // 浮层里的应用图标拖出：拖出动作开始的瞬间浮层收回，随后按正常拖拽流程处理。
  function onFloatAppDragStart(e: React.DragEvent, app: AppCategoryRow) {
    startAppDrag(e, app);
    window.setTimeout(() => closeFloat(), 0);
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  if (apps === null || order === null) {
    return <div className="cat-empty">加载中…</div>;
  }

  const openCat = openFolderId ? byId.get(openFolderId) : undefined;

  return (
    <div className="cabinet" ref={rootRef} onDragOver={onRootDragOver} onDrop={onRootDrop}>
      {/* 搜索框：与列表视图共用同一个 q，内容在切换视图时保留 */}
      <div className="cabinet-search">
        <Search size={13} className="cabinet-search-icon" />
        <input
          className="ai-input"
          placeholder="搜索应用名"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      {/* ── 待整理区 ── */}
      <section className="cabinet-inbox">
        <div className="cabinet-section-title">
          待整理
          <span className="cabinet-section-count">{uncategorizedApps.length}</span>
        </div>
        {uncategorizedApps.length === 0 ? (
          <div className="cabinet-inbox-empty">没有未分类的应用</div>
        ) : (
          <div className="cabinet-inbox-grid">
            {uncategorizedApps.map((a) => (
              <AppTile
                key={a.app_id}
                app={a}
                selected={selected.has(a.app_id)}
                marker={markers.get(a.app_id)}
                onDragStart={startAppDrag}
                onClick={onAppClick}
                onContextMenu={onAppContextMenu}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 文件夹网格 ── */}
      <section className="cabinet-grid">
        <div className="cabinet-section-title">分类</div>
        <div className="cabinet-grid-inner">
          {gridFolders.map((c) => (
            <FolderSquare
              key={c.id}
              cat={c}
              apps={appsByFolder.get(c.id) ?? []}
              isDragging={dragging?.kind === "folder" && dragging.id === c.id}
              registerRef={(el) => {
                if (el) folderRefs.current.set(c.id, el);
                else folderRefs.current.delete(c.id);
              }}
              onDragStart={(e) => startFolderDrag(e, c)}
              onClick={() => openFloat(c.id, "click")}
            />
          ))}
          {!atLimit && (
            <div ref={dashedRef} className="cab-folder cab-folder-dashed">
              <Plus size={16} />
              <span className="cab-folder-dashed-text">拖入应用以新建分类</span>
            </div>
          )}
        </div>
      </section>

      {/* ── 已归档折叠区 ── */}
      <section className="cabinet-archived">
        <button
          type="button"
          className="cabinet-archived-head"
          onClick={() => setArchivedOpen((v) => !v)}
        >
          <ChevronDown size={14} className={archivedOpen ? "" : "is-collapsed"} />
          已归档{archived.length > 0 ? ` · ${archived.length}` : ""}
        </button>
        {archivedOpen && (
          <div className="cabinet-grid-inner">
            {archived.length === 0 && (
              <div className="cabinet-inbox-empty">没有已归档的分类</div>
            )}
            {archived.map((c) => (
              <ArchivedFolder
                key={c.id}
                cat={c}
                apps={appsByFolder.get(c.id) ?? []}
                onEdit={onEdit}
                onRestore={onRestore}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 悬停 / 单击弹层 ── */}
      {openCat &&
        createPortal(
          <div
            ref={floatRef}
            className={`cab-float is-${openMode}`}
            style={{
              left: floatPos?.left ?? 0,
              top: floatPos?.top ?? 0,
              visibility: floatPos ? "visible" : "hidden",
            }}
            onDragOver={onFloatDragOver}
            onDragLeave={onFloatDragLeave}
            onDrop={onFloatDrop}
          >
            <div className="cab-float-head">
              <span className="cab-dot" style={{ background: fillOf(openCat.id) }} />
              <span className="cab-float-name" title={openCat.name}>{openCat.name}</span>
              <span className="cab-float-count">
                {(appsByFolder.get(openCat.id) ?? []).length} 个应用
              </span>
              <div className="cab-float-actions">
                <button
                  className="cat-icon-btn"
                  title="改名 / 改色"
                  onClick={() => onEdit(openCat)}
                >
                  <Pencil size={13} />
                </button>
                {!openCat.is_system && (
                  <button
                    className="cat-icon-btn"
                    title="归档"
                    onClick={() => onArchive(openCat)}
                  >
                    <Archive size={13} />
                  </button>
                )}
              </div>
            </div>
            <div className="cab-float-body">
              {(appsByFolder.get(openCat.id) ?? []).length === 0 && (
                <div className="cab-float-empty">这个分类下还没有应用</div>
              )}
              {(appsByFolder.get(openCat.id) ?? []).map((a) => (
                <AppTile
                  key={a.app_id}
                  app={a}
                  selected={selected.has(a.app_id)}
                  marker={markers.get(a.app_id)}
                  onDragStart={onFloatAppDragStart}
                  onClick={onAppClick}
                  onContextMenu={onAppContextMenu}
                />
              ))}
              <div className="cab-float-drop-slot">
                <Plus size={13} />
                放到这里
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ── 撤销提示条 ── */}
      {undoEntry &&
        createPortal(
          <div className="cab-undo-bar">
            <span className="cab-undo-msg">
              已归类 {undoEntry.count} 个应用到「{undoEntry.targetName}」
            </span>
            <button type="button" className="setting-btn" onClick={doUndo}>
              <Undo2 size={13} />
              撤销
            </button>
            <button
              type="button"
              className="cab-undo-close"
              onClick={() => setUndoEntry(null)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>,
          document.body,
        )}

      {/* ── 右键菜单 ── */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="cab-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <div className="cab-menu-title" title={menu.app.app_id}>
              {menu.app.app_name}
            </div>
            {assignable.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className="cab-menu-item"
                onClick={() => pickCategory(c.id)}
              >
                <span className="cab-dot" style={{ background: fillOf(c.id) }} />
                <span className="cab-menu-name">{c.name}</span>
              </button>
            ))}
            <div className="cab-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="cab-menu-item"
              onClick={() => pickCategory(null)}
            >
              <span className="cab-dot" style={{ background: "var(--neutral-5)" }} />
              <span className="cab-menu-name">未分类（重置为自动）</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── 应用图标块 ────────────────────────────────────────────────────────────────

function AppTile({
  app,
  selected,
  marker,
  onDragStart,
  onClick,
  onContextMenu,
}: {
  app: AppCategoryRow;
  selected: boolean;
  marker?: string;
  onDragStart: (e: React.DragEvent, app: AppCategoryRow) => void;
  onClick: (e: React.MouseEvent, app: AppCategoryRow) => void;
  onContextMenu: (e: React.MouseEvent, app: AppCategoryRow) => void;
}) {
  return (
    <Tooltip content={app.app_id}>
      <div
        className={`cab-app${selected ? " is-selected" : ""}`}
        draggable
        onDragStart={(e) => onDragStart(e, app)}
        onClick={(e) => onClick(e, app)}
        onContextMenu={(e) => onContextMenu(e, app)}
      >
        <AppIcon bundleId={app.app_id} appName={app.app_name} size={30} neutralFallback />
        <span className="cab-app-name">{app.app_name}</span>
        {marker && <span className="cab-app-marker">{marker}</span>}
      </div>
    </Tooltip>
  );
}

// ── 文件夹方块 ────────────────────────────────────────────────────────────────

function FolderSquare({
  cat,
  apps,
  isDragging,
  registerRef,
  onDragStart,
  onClick,
}: {
  cat: CategoryRow;
  apps: AppCategoryRow[];
  isDragging: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onDragStart: (e: React.DragEvent) => void;
  onClick: () => void;
}) {
  return (
    <div
      ref={registerRef}
      className={`cab-folder${isDragging ? " is-dragging" : ""}${
        cat.id === ID_OTHER ? " is-system" : ""
      }`}
      draggable={cat.id !== ID_OTHER}
      onDragStart={onDragStart}
      onClick={onClick}
    >
      <div className="cab-folder-preview">
        {apps.length === 0 ? (
          <span className="cab-folder-preview-empty">空</span>
        ) : (
          apps.slice(0, 6).map((a) => (
            <AppIcon
              key={a.app_id}
              bundleId={a.app_id}
              appName={a.app_name}
              size={22}
              neutralFallback
            />
          ))
        )}
      </div>
      <div className="cab-folder-label">
        <span className="cab-dot" style={{ background: fillOf(cat.id) }} />
        <span className="cab-folder-name" title={cat.name}>{cat.name}</span>
        <span className="cab-folder-count">{apps.length}</span>
      </div>
    </div>
  );
}

// ── 已归档文件夹方块 ──────────────────────────────────────────────────────────

function ArchivedFolder({
  cat,
  apps,
  onEdit,
  onRestore,
  onDelete,
}: {
  cat: CategoryRow;
  apps: AppCategoryRow[];
  onEdit: (cat: CategoryRow) => void;
  onRestore: (cat: CategoryRow) => void;
  onDelete: (cat: CategoryRow) => void;
}) {
  return (
    <div className="cab-folder cab-folder-archived">
      <div className="cab-folder-preview">
        {apps.length === 0 ? (
          <span className="cab-folder-preview-empty">空</span>
        ) : (
          apps.slice(0, 6).map((a) => (
            <AppIcon
              key={a.app_id}
              bundleId={a.app_id}
              appName={a.app_name}
              size={22}
              neutralFallback
            />
          ))
        )}
      </div>
      <div className="cab-folder-label">
        <span className="cab-dot" style={{ background: fillOf(cat.id) }} />
        <span className="cab-folder-name" title={cat.name}>{cat.name}</span>
        <span className="cab-folder-count">{apps.length}</span>
      </div>
      <div className="cab-folder-actions">
        <button className="cat-icon-btn" title="改名 / 改色" onClick={() => onEdit(cat)}>
          <Pencil size={13} />
        </button>
        <button className="cat-icon-btn" title="恢复" onClick={() => onRestore(cat)}>
          <ArchiveRestore size={13} />
        </button>
        <button className="cat-icon-btn is-danger" title="永久删除" onClick={() => onDelete(cat)}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
