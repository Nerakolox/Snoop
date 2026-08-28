// 设置 → 分类（分类柜视图）。
//
// 分类柜是「分类」页的默认视图，是操作分类的一等视图（与之并列的「列表」即
// 原有的增删改列表 + 应用归类列表）。它自上而下：待整理区 → 文件夹网格 →
// 已归档折叠区。
//
// 这里只负责**视图**：分类的增删改、颜色算法、归档、AI 批量分类、撤销机制全在
// 父级 Categories.tsx 或 categories/* 里，本组件只消费并触发它们。
//
// 拖拽走 @dnd-kit（core / sortable / modifiers），分两个互不触发的拖拽：
//   - 应用图标归类（useDraggable + 文件夹/待整理区/新建空位/弹层作 useDroppable）；
//   - 文件夹方块重排（useSortable + rectSortingStrategy，写 sortOrder）。
// 悬停弹层由碰撞检测（pointerWithin）驱动：当前碰撞目标持续为某文件夹 0.5s
// 展开，目标离开则收回且不写入。预览统一用 DragOverlay，不用浏览器原生影像。
//
// 配色遵循项目色彩规约：全部走语义 token，此页不出现暖色阶；分类色一律走
// categories/store 的 fillOf（系统分类中性、归档中性），不新建色板、不硬编码。

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, MeasuringStrategy, PointerSensor, pointerWithin,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, Pencil, Plus, Search, Trash2, Undo2,
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

/** 二级子菜单 / 弹层收回前的宽限（毫秒），留给鼠标跨进相邻弹层的间隙。 */
const CLOSE_GRACE_MS = 150;

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

/** useSortable 返回的 transform → CSS translate。 */
function transformToString(
  t: { x: number; y: number; scaleX: number; scaleY: number } | null,
): string | undefined {
  if (!t) return undefined;
  return `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`;
}

/** 拖拽源：应用图标（归类）或文件夹方块本体（重排）。二者必须区分。 */
type DragPayload = { kind: "app"; ids: string[] } | { kind: "folder"; id: string };

export interface DragUndoEntry {
  app: AppCategoryRow;
  origCategory: string | null;
}

/** 弹层定位结果：left/top 是翻转 + 夹紧后的落点，maxHeight 是限高（内部滚动）。 */
interface MenuPos {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * 弹层落点：优先在锚点（右/下）展开，右/下空间不足翻转到左/上；仍放不下夹紧进
 * 视口；超过视口高度则贴顶限高、内部滚动。
 *
 * `flipLeftX`/`flipUpY` 是翻转后对齐的坐标：主菜单 = 光标点（贴光标左缘/上缘），
 * 子菜单 = 主菜单项的左右边缘（贴边展开）。
 */
function computeMenuPos(
  anchorX: number, anchorY: number,
  flipLeftX: number, flipUpY: number,
  width: number, height: number,
): MenuPos {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchorX;
  if (left + width > vw - margin) left = flipLeftX - width;
  let top = anchorY;
  if (top + height > vh - margin) top = flipUpY - height;

  left = Math.max(margin, Math.min(vw - margin - width, left));
  top = Math.max(margin, Math.min(vh - margin - height, top));

  let maxHeight = height;
  if (height > vh - margin * 2) {
    top = margin;
    maxHeight = vh - margin * 2;
  }
  return { left, top, maxHeight };
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

  // 搜索：就地过滤，不切换视图、不改网格布局。命中集合为 null = 不过滤。
  const matchedIds = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return null;
    return new Set(
      (apps ?? [])
        .filter((a) => a.app_name.toLowerCase().includes(kw))
        .map((a) => a.app_id),
    );
  }, [apps, q]);
  const hasQuery = matchedIds !== null;
  const noMatches = matchedIds !== null && matchedIds.size === 0;

  // ── 选择与拖拽 ──────────────────────────────────────────────────────────────

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const dragRef = useRef<DragPayload | null>(null);
  /** 应用拖拽时当前碰撞命中的文件夹（用于高亮放置目标）。 */
  const [overFolderId, setOverFolderId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function beginDrag(p: DragPayload) {
    dragRef.current = p;
    setDrag(p);
  }
  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    setOverFolderId(null);
    clearHoverTimer();
    cancelClose();
    hoverIdRef.current = null;
    if (openModeRef.current === "hover") closeFloat();
  }

  // ── 悬停弹层 ────────────────────────────────────────────────────────────────

  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [openMode, setOpenMode] = useState<"hover" | "click">("hover");
  const openFolderRef = useRef<string | null>(null);
  const openModeRef = useRef<"hover" | "click">("hover");
  const folderRefs = useRef(new Map<string, HTMLElement>());
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
    }, CLOSE_GRACE_MS);
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

  // ── 右键菜单（主菜单 + 分类选择子菜单） ────────────────────────────────────

  const [menu, setMenu] = useState<{ app: AppCategoryRow; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [submenuPos, setSubmenuPos] = useState<MenuPos | null>(null);
  const submenuTimerRef = useRef<number | null>(null);

  function clearSubmenuTimer() {
    if (submenuTimerRef.current !== null) {
      window.clearTimeout(submenuTimerRef.current);
      submenuTimerRef.current = null;
    }
  }
  function openSubmenu() {
    clearSubmenuTimer();
    setSubmenuOpen(true);
  }
  function scheduleSubmenuClose() {
    clearSubmenuTimer();
    submenuTimerRef.current = window.setTimeout(() => setSubmenuOpen(false), CLOSE_GRACE_MS);
  }
  function cancelSubmenuClose() {
    clearSubmenuTimer();
  }

  // ── 已归档折叠区 ────────────────────────────────────────────────────────────

  const [archivedOpen, setArchivedOpen] = useState(false);

  // ── 固定放置目标（待整理区 / 新建空位） ────────────────────────────────────

  const { setNodeRef: inboxRef } = useDroppable({ id: "inbox" });
  const { setNodeRef: newSlotRef } = useDroppable({ id: "new-category" });

  // 文件夹方块 DOM 的稳定访问器（folderRefs 是 ref，读它的函数身份恒定），
  // 避免每次父级渲染都给 FloatPanel 传一个新函数、触发不必要的重定位。
  const getFolderEl = useCallback((id: string) => folderRefs.current.get(id), []);

  // ── 侧效应：菜单定位 / 点击外部关闭 ─────────────────────────────────────────

  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos(computeMenuPos(menu.x, menu.y, menu.x, menu.y, r.width, r.height));
  }, [menu]);

  useLayoutEffect(() => {
    if (!submenuOpen || !menu) {
      setSubmenuPos(null);
      return;
    }
    const anchor = submenuAnchorRef.current;
    const sub = submenuRef.current;
    if (!anchor || !sub) return;
    const ar = anchor.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    const GAP = 4;
    setSubmenuPos(computeMenuPos(ar.right + GAP, ar.top, ar.left - GAP, ar.bottom, sr.width, sr.height));
  }, [submenuOpen, menu]);

  // 右键菜单：点外部 / Esc 关闭（含子菜单）。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || submenuRef.current?.contains(t)) return;
      setMenu(null);
      setSubmenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(null);
        setSubmenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // ── dnd-kit 拖拽生命周期 ────────────────────────────────────────────────────
  //
  // Esc 取消由 PointerSensor 原生处理（document 级 keydown → handleCancel），
  // 走 onDragCancel 收尾，不写入。

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    if (id.startsWith("app:")) {
      const appId = id.slice(4);
      // 从弹层里拖出：拖出瞬间弹层收回，随后按正常归类流程走。
      if (e.active.data.current?.fromFloat === true) closeFloat();
      const ids = selected.has(appId) ? Array.from(selected) : [appId];
      if (!selected.has(appId)) setSelected(new Set([appId]));
      beginDrag({ kind: "app", ids });
    } else if (id.startsWith("folder:")) {
      beginDrag({ kind: "folder", id: id.slice(7) });
    }
  }

  function onDragOver(e: DragOverEvent) {
    const d = dragRef.current;
    if (!d || d.kind !== "app") return;
    updateAppHover(e.over ? String(e.over.id) : null);
  }

  function onDragEnd(e: DragEndEvent) {
    const d = dragRef.current;
    const overId = e.over ? String(e.over.id) : null;
    if (d?.kind === "app") {
      const list = (apps ?? []).filter((a) => d.ids.includes(a.app_id));
      if (overId?.startsWith("folder:")) {
        void commitMove(list, overId.slice(7));
      } else if (overId?.startsWith("float:")) {
        void commitMove(list, overId.slice(6));
      } else if (overId === "new-category") {
        onCreateFromDrop(list);
      } else if (overId === "inbox") {
        void commitMove(list, null);
      }
    } else if (d?.kind === "folder") {
      if (overId?.startsWith("folder:")) {
        const target = overId.slice(7);
        if (target !== d.id && target !== ID_OTHER) doReorder(d.id, target);
      }
    }
    endDrag();
  }

  function onDragCancel(_e: DragCancelEvent) {
    endDrag();
  }

  // 悬停内探：碰撞目标持续为某文件夹达 0.5s 展开浮层；目标离开（变为其它或空）
  // 则收回且不写入。判定只基于当前碰撞目标，与鼠标在子元素间的进出无关。
  function updateAppHover(overId: string | null) {
    if (overId?.startsWith("folder:")) {
      const id = overId.slice(7);
      cancelClose();
      const cur = openFolderRef.current;
      if (cur !== id) {
        if (cur !== null && openModeRef.current === "hover") closeFloat();
        if (hoverIdRef.current !== id) {
          hoverIdRef.current = id;
          clearHoverTimer();
          hoverTimerRef.current = window.setTimeout(() => {
            if (dragRef.current?.kind === "app" && hoverIdRef.current === id) {
              openFloat(id, "hover");
            }
          }, HOVER_OPEN_MS);
        }
      }
      setOverFolderId(id);
      return;
    }
    if (overId?.startsWith("float:")) {
      cancelClose();
      setOverFolderId(overId.slice(6));
      return;
    }
    clearHoverTimer();
    hoverIdRef.current = null;
    setOverFolderId(null);
    if (openFolderRef.current !== null && openModeRef.current === "hover") {
      scheduleClose();
    }
  }

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
    setMenu({ app, x: e.clientX, y: e.clientY });
    setSubmenuOpen(false);
    setSubmenuPos(null);
  }

  // ── 归类写入 ────────────────────────────────────────────────────────────────

  // 一次拖拽的落点写入：targetId 为 null = 归入待整理（重置为自动），否则归入分类。
  // 过滤掉「本来就在目标里」的条目，避免无意义写入；成功后记撤销条目（按原分类还原）。
  async function commitMove(list: AppCategoryRow[], targetId: string | null) {
    const effective = targetId === null
      ? list.filter((a) => a.category !== null)
      : list.filter((a) => a.category !== targetId);
    if (effective.length === 0) return;
    const ok = targetId === null
      ? await onResetApps(effective)
      : await onAssign(effective, targetId);
    if (ok) {
      const target = targetId ? byId.get(targetId) : undefined;
      setUndoEntry({
        apps: effective.map((a) => ({ app: a, origCategory: a.category })),
        targetName: target?.name ?? "未分类",
        count: effective.length,
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
    setSubmenuOpen(false);
    if (!app) return;
    if (categoryId === null) await onResetApps([app]);
    else await onAssign([app], categoryId);
  }

  function doReorder(fromId: string, targetId: string) {
    // 只在未归档列表里移动，其余（其他 / 未分类 / 已归档）保持原位；语义与列表
    // 视图的 onDrop 完全一致，落库的 sort_order 覆盖整张表。
    const fromIdx = active.findIndex((c) => c.id === fromId);
    const toIdx = active.findIndex((c) => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const list = arrayMove(active, fromIdx, toIdx);
    onReorder(list.map((c) => c.id));
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  if (apps === null || order === null) {
    return <div className="cat-empty">加载中…</div>;
  }

  const openCat = openFolderId ? byId.get(openFolderId) : undefined;
  const dragApps = drag?.kind === "app" ? (apps ?? []).filter((a) => drag.ids.includes(a.app_id)) : [];
  const dragFolder = drag?.kind === "folder" ? byId.get(drag.id) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="cabinet">
        {/* 搜索框：与列表视图共用同一个 q，内容在切换视图时保留；此处就地过滤 */}
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
        <section ref={inboxRef} className="cabinet-inbox">
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
                  matchedIds={matchedIds}
                  fromFloat={false}
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
          {hasQuery && noMatches && (
            <div className="cabinet-no-results">没有匹配的应用</div>
          )}
          <div className="cabinet-grid-inner">
            <SortableContext
              items={gridFolders.map((c) => `folder:${c.id}`)}
              strategy={rectSortingStrategy}
            >
              {gridFolders.map((c) => (
                <FolderSquare
                  key={c.id}
                  cat={c}
                  apps={appsByFolder.get(c.id) ?? []}
                  matchedIds={matchedIds}
                  isOver={overFolderId === c.id}
                  registerRef={(el) => {
                    if (el) folderRefs.current.set(c.id, el);
                    else folderRefs.current.delete(c.id);
                  }}
                  onClick={() => openFloat(c.id, "click")}
                />
              ))}
            </SortableContext>
            {!atLimit && (
              <div ref={newSlotRef} className="cab-folder cab-folder-dashed">
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
                  matchedIds={matchedIds}
                  onEdit={onEdit}
                  onRestore={onRestore}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── 悬停 / 单击弹层 ── */}
        {openCat && (
          <FloatPanel
            folder={openCat}
            apps={appsByFolder.get(openCat.id) ?? []}
            mode={openMode}
            selected={selected}
            matchedIds={matchedIds}
            markers={markers}
            getFolderEl={getFolderEl}
            onClose={closeFloat}
            onEdit={onEdit}
            onArchive={onArchive}
            onAppClick={onAppClick}
            onAppContextMenu={onAppContextMenu}
          />
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

        {/* ── 右键菜单（主菜单 + 分类选择子菜单） ── */}
        {menu &&
          createPortal(
            <>
              <div
                ref={menuRef}
                className="cab-menu"
                role="menu"
                style={{
                  left: menuPos?.left ?? 0,
                  top: menuPos?.top ?? 0,
                  visibility: menuPos ? "visible" : "hidden",
                }}
                onMouseEnter={cancelSubmenuClose}
                onMouseLeave={scheduleSubmenuClose}
              >
                <div className="cab-menu-title" title={menu.app.app_id}>
                  {menu.app.app_name}
                </div>
                <button
                  ref={submenuAnchorRef}
                  type="button"
                  role="menuitem"
                  className="cab-menu-item"
                  onMouseEnter={openSubmenu}
                  onClick={openSubmenu}
                >
                  <span className="cab-menu-name">归入分类</span>
                  <ChevronRight size={13} className="cab-menu-chevron" />
                </button>
                <div className="cab-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="cab-menu-item"
                  onClick={() => pickCategory(null)}
                >
                  <span className="cab-dot" style={{ background: fillOf(ID_UNCATEGORIZED) }} />
                  <span className="cab-menu-name">未分类（重置为自动）</span>
                </button>
              </div>

              {submenuOpen && (
                <div
                  ref={submenuRef}
                  className="cab-submenu"
                  role="menu"
                  style={{
                    left: submenuPos?.left ?? 0,
                    top: submenuPos?.top ?? 0,
                    visibility: submenuPos ? "visible" : "hidden",
                    maxHeight: submenuPos?.maxHeight,
                    overflowY: "auto",
                  }}
                  onMouseEnter={cancelSubmenuClose}
                  onMouseLeave={scheduleSubmenuClose}
                >
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
                </div>
              )}
            </>,
            document.body,
          )}
      </div>

      {/* ── 拖拽预览 ── */}
      <DragOverlay modifiers={[restrictToWindowEdges]} dropAnimation={null}>
        {drag?.kind === "app" ? (
          <AppDragPreview apps={dragApps} />
        ) : drag?.kind === "folder" && dragFolder ? (
          <FolderDragPreview cat={dragFolder} apps={appsByFolder.get(dragFolder.id) ?? []} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ── 应用图标块（待整理区 + 弹层） ─────────────────────────────────────────────

function AppTile({
  app,
  selected,
  marker,
  matchedIds,
  fromFloat,
  onClick,
  onContextMenu,
}: {
  app: AppCategoryRow;
  selected: boolean;
  marker?: string;
  matchedIds: Set<string> | null;
  fromFloat: boolean;
  onClick: (e: React.MouseEvent, app: AppCategoryRow) => void;
  onContextMenu: (e: React.MouseEvent, app: AppCategoryRow) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `app:${app.app_id}`,
    data: { fromFloat },
  });
  const dimmed = matchedIds !== null && !matchedIds.has(app.app_id);
  return (
    <Tooltip content={app.app_id}>
      <div
        ref={setNodeRef}
        className={`cab-app${selected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}${
          dimmed ? " is-dimmed" : ""
        }`}
        {...attributes}
        {...listeners}
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
  matchedIds,
  isOver,
  registerRef,
  onClick,
}: {
  cat: CategoryRow;
  apps: AppCategoryRow[];
  matchedIds: Set<string> | null;
  isOver: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `folder:${cat.id}`,
  });
  // 「其他」不可拖（固定在末尾）但仍是放置目标：useSortable 只要 setNodeRef 就注册
  // 了 droppable，listeners/attributes 不挂即不产生拖拽源。
  const reorderable = cat.id !== ID_OTHER;

  let previewApps: AppCategoryRow[];
  let matchCount: number | null = null;
  if (matchedIds) {
    const matched = apps.filter((a) => matchedIds.has(a.app_id));
    previewApps = [...matched, ...apps.filter((a) => !matchedIds.has(a.app_id))].slice(0, 6);
    matchCount = matched.length;
  } else {
    previewApps = apps.slice(0, 6);
  }

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        registerRef(el);
      }}
      className={`cab-folder${isDragging ? " is-dragging" : ""}${isOver ? " is-over" : ""}${
        cat.id === ID_OTHER ? " is-system" : ""
      }`}
      style={{ transform: isDragging ? undefined : transformToString(transform), transition }}
      onClick={onClick}
      {...(reorderable ? attributes : {})}
      {...(reorderable ? listeners : {})}
    >
      <div className="cab-folder-preview">
        {previewApps.length === 0 ? (
          <span className="cab-folder-preview-empty">空</span>
        ) : (
          previewApps.map((a) => (
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
        {matchCount !== null && matchCount > 0 && (
          <span className="cab-folder-match">{matchCount}</span>
        )}
        <span className="cab-folder-count">{apps.length}</span>
      </div>
    </div>
  );
}

// ── 悬停 / 单击弹层（portal 到 body，本身是应用拖拽的放置目标） ──────────────

function FloatPanel({
  folder,
  apps,
  mode,
  selected,
  matchedIds,
  markers,
  getFolderEl,
  onClose,
  onEdit,
  onArchive,
  onAppClick,
  onAppContextMenu,
}: {
  folder: CategoryRow;
  apps: AppCategoryRow[];
  mode: "hover" | "click";
  selected: Set<string>;
  matchedIds: Set<string> | null;
  markers: Map<string, string>;
  getFolderEl: (id: string) => HTMLElement | undefined;
  onClose: () => void;
  onEdit: (cat: CategoryRow) => void;
  onArchive: (cat: CategoryRow) => void;
  onAppClick: (e: React.MouseEvent, app: AppCategoryRow) => void;
  onAppContextMenu: (e: React.MouseEvent, app: AppCategoryRow) => void;
}) {
  const { setNodeRef } = useDroppable({ id: `float:${folder.id}` });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = getFolderEl(folder.id);
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const r = anchor.getBoundingClientRect();
    const fr = panel.getBoundingClientRect();
    const GAP = 8;
    const MARGIN = 8;
    let left = r.left;
    let top = r.bottom + GAP;
    if (top + fr.height > window.innerHeight - MARGIN) {
      top = r.top - GAP - fr.height;
      if (top < MARGIN) top = MARGIN;
    }
    left = Math.max(MARGIN, Math.min(window.innerWidth - fr.width - MARGIN, left));
    setPos({ left, top });
  }, [folder.id, getFolderEl]);

  // 单击打开的浮层：点外部 / Esc 关闭，不随光标移出收回。
  useEffect(() => {
    if (mode !== "click") return;
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mode, onClose]);

  return createPortal(
    <div
      ref={(el) => {
        setNodeRef(el);
        panelRef.current = el;
      }}
      className={`cab-float is-${mode}`}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="cab-float-head">
        <span className="cab-dot" style={{ background: fillOf(folder.id) }} />
        <span className="cab-float-name" title={folder.name}>{folder.name}</span>
        <span className="cab-float-count">{apps.length} 个应用</span>
        <div className="cab-float-actions">
          <button className="cat-icon-btn" title="改名 / 改色" onClick={() => onEdit(folder)}>
            <Pencil size={13} />
          </button>
          {!folder.is_system && (
            <button className="cat-icon-btn" title="归档" onClick={() => onArchive(folder)}>
              <Archive size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="cab-float-body">
        {apps.length === 0 && <div className="cab-float-empty">这个分类下还没有应用</div>}
        {apps.map((a) => (
          <AppTile
            key={a.app_id}
            app={a}
            selected={selected.has(a.app_id)}
            marker={markers.get(a.app_id)}
            matchedIds={matchedIds}
            fromFloat
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
  );
}

// ── 已归档文件夹方块 ──────────────────────────────────────────────────────────

function ArchivedFolder({
  cat,
  apps,
  matchedIds,
  onEdit,
  onRestore,
  onDelete,
}: {
  cat: CategoryRow;
  apps: AppCategoryRow[];
  matchedIds: Set<string> | null;
  onEdit: (cat: CategoryRow) => void;
  onRestore: (cat: CategoryRow) => void;
  onDelete: (cat: CategoryRow) => void;
}) {
  let previewApps: AppCategoryRow[];
  let matchCount: number | null = null;
  if (matchedIds) {
    const matched = apps.filter((a) => matchedIds.has(a.app_id));
    previewApps = [...matched, ...apps.filter((a) => !matchedIds.has(a.app_id))].slice(0, 6);
    matchCount = matched.length;
  } else {
    previewApps = apps.slice(0, 6);
  }
  return (
    <div className="cab-folder cab-folder-archived">
      <div className="cab-folder-preview">
        {previewApps.length === 0 ? (
          <span className="cab-folder-preview-empty">空</span>
        ) : (
          previewApps.map((a) => (
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
        {matchCount !== null && matchCount > 0 && (
          <span className="cab-folder-match">{matchCount}</span>
        )}
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

// ── 拖拽预览 ──────────────────────────────────────────────────────────────────

function AppDragPreview({ apps }: { apps: AppCategoryRow[] }) {
  const shown = apps.slice(0, 3);
  return (
    <div className="cab-drag-overlay-apps">
      <div className="cab-drag-overlay-stack">
        {shown.map((a) => (
          <div key={a.app_id} className="cab-drag-overlay-icon">
            <AppIcon bundleId={a.app_id} appName={a.app_name} size={34} neutralFallback />
          </div>
        ))}
      </div>
      <div className="cab-drag-overlay-meta">
        <span className="cab-drag-overlay-label">{shown[0]?.app_name ?? ""}</span>
        {apps.length > 1 && <span className="cab-drag-overlay-count">×{apps.length}</span>}
      </div>
    </div>
  );
}

function FolderDragPreview({ cat, apps }: { cat: CategoryRow; apps: AppCategoryRow[] }) {
  return (
    <div className="cab-drag-overlay-folder">
      <span className="cab-dot" style={{ background: fillOf(cat.id) }} />
      <span className="cab-drag-overlay-folder-name">{cat.name}</span>
      <span className="cab-drag-overlay-folder-count">{apps.length}</span>
    </div>
  );
}
