// 设置 → 分类（二级页）。主导航栏不新增入口，只能从设置页进来。
//
// 页面分两半：
//   上半 = 分类目录（新建 / 编辑 / 归档 / 拖拽排序 + 已归档折叠区）
//   下半 = 应用归类（搜索 / 筛选 / 下拉直接改类 + 批量 AI 分类与一键撤销）
//
// 配色遵循项目色彩规约：全部走语义 token，无硬编码色值；**此页不出现暖色阶**
// （--intensity-* 是活跃强度的专属编码，跟分类管理没有关系）。分类自身的色点
// 走 categories/color.ts 的 OKLCH，L/C 由主题层给。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, ArchiveRestore, ChevronDown, ChevronLeft, GripVertical,
  Loader2, Pencil, Plus, RotateCcw, Search, Tag, Trash2, Undo2, Archive,
} from "lucide-react";
import AppIcon from "../../components/AppIcon";
import PageShell from "../../components/PageShell";
import { classifyApps, getClassifyStatus, listClassifiedApps, resetAppCategory, setAppCategory, undoClassifyBatch } from "../../ai/client";
import type { AppCategoryRow, ClassifyStatus } from "../../ai/types";
import {
  createCategory, deleteCategory, getCategoryDeleteImpact,
  reorderCategories, setCategoryArchived, updateCategory,
} from "../../categories/client";
import { categoryColor, isSystemCategoryId } from "../../categories/color";
import { assignableCategories, fillOf, invalidateCategories, useCategories } from "../../categories/store";
import type { CategoryRow, ClassifyScope, DeleteImpact } from "../../categories/types";
import { ID_UNCATEGORIZED, MAX_ACTIVE_CATEGORIES } from "../../categories/constants";
import CategoryEditor, { type EditorResult } from "./CategoryEditor";
import CategoryCabinet, { type DragUndoEntry } from "./CategoryCabinet";

/** 分类页视图选择（分类柜 / 列表）的 localStorage 键。 */
const VIEW_KEY = "snoop_category_view";

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  builtin: "内置规则",
  ai: "AI",
};

const SCOPE_OPTIONS: { value: ClassifyScope; label: string; desc: string }[] = [
  { value: "unclassified", label: "仅未分类", desc: "只处理还没有归类的应用" },
  { value: "all_skip_manual", label: "全部（跳过手动）", desc: "重分全部应用，但不动你手改过的" },
  { value: "all_override", label: "全部（覆盖手动）", desc: "重分全部应用，手改的决定也会被覆盖" },
];

/**
 * 目录里那个色点。
 *
 * 系统分类（其他 / 未分类）走和数据页一致的中性色——它们没有身份色，这里也不该
 * 亮出一个彩点。其余分类**包括已归档的**都显示自己的真实颜色：归档只是从统计里
 * 隐身，你仍然要能在这里看到并改它的色，恢复后就是这个色。
 */
function listDot(c: CategoryRow): string {
  return isSystemCategoryId(c.id) ? fillOf(c.id) : categoryColor(c.hue, c.custom_color);
}

export default function Categories({
  onBack,
  focusId,
}: {
  onBack: () => void;
  /** 深链定位到的分类 id（从概览 / 报告的分类 chip 跳进来时带上）。null = 不定位。 */
  focusId?: string | null;
}) {
  const stored = useCategories();
  /** 本地顺序副本：拖拽时先动这里，松手再落库。 */
  const [order, setOrder] = useState<CategoryRow[] | null>(null);
  useEffect(() => setOrder(stored), [stored]);

  // 视图切换：分类柜是默认视图，选择持久化，重进分类页时还原。
  const [view, setView] = useState<"cabinet" | "list">(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cabinet",
  );
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  // 深链定位到的分类只在列表视图里有对应行：带 focusId 就切到列表，否则定位无处可滚。
  useEffect(() => {
    if (focusId) setView("list");
  }, [focusId]);

  const [apps, setApps] = useState<AppCategoryRow[] | null>(null);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  // 分类柜「拖入应用以新建分类」：先记下待归类应用，弹出新建分类编辑器，
  // 提交后拿新分类 id 再批量归类。
  const [pendingDropApps, setPendingDropApps] = useState<AppCategoryRow[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  // undefined = 弹窗关闭；null = 新建；CategoryRow = 编辑
  const [editing, setEditing] = useState<CategoryRow | null | undefined>(undefined);
  const [confirmArchive, setConfirmArchive] = useState<CategoryRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ cat: CategoryRow; impact: DeleteImpact } | null>(null);
  const [err, setErr] = useState("");

  const [dragId, setDragId] = useState<string | null>(null);

  // 批量分类
  const [scope, setScope] = useState<ClassifyScope>("unclassified");
  const [status, setStatus] = useState<ClassifyStatus | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState("");
  const [confirmOverride, setConfirmOverride] = useState(false);

  // 筛选
  const [q, setQ] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [filterSrc, setFilterSrc] = useState("all");

  const active = useMemo(() => (order ?? []).filter((c) => !c.is_archived), [order]);
  const archived = useMemo(() => (order ?? []).filter((c) => c.is_archived), [order]);
  const byId = useMemo(() => new Map((order ?? []).map((c) => [c.id, c])), [order]);
  /** 可作为归类目标的分类。与各数据页的就地改分类下拉共用同一条筛选。 */
  const assignable = useMemo(() => assignableCategories(order), [order]);

  // ── 深链定位 ──────────────────────────────────────────────────────────────
  const focusRef = useRef<HTMLDivElement | null>(null);

  // 目标在「已归档」折叠区里就先展开：不展开的话滚过去也是一片空白。
  useEffect(() => {
    if (!focusId || !order) return;
    if (order.find((c) => c.id === focusId)?.is_archived) setArchivedOpen(true);
  }, [focusId, order]);

  // 依赖 archivedOpen：展开动作会改变布局，要等它落定后再滚。
  // 依赖 view：分类柜视图里没有可滚的目标行，切到列表后才滚。
  useEffect(() => {
    if (!focusId || view !== "list") return;
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, order, archivedOpen, view]);

  async function reloadApps() {
    try {
      setApps(await listClassifiedApps());
    } catch (e) {
      console.error(e);
    }
  }

  async function reloadStatus() {
    try {
      setStatus(await getClassifyStatus());
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    reloadApps();
    reloadStatus();
  }, []);

  /** 分类表变更后的统一收尾：作废按分类聚合的缓存、重拉分类与应用列表。 */
  async function afterMutation() {
    await invalidateCategories();
    await reloadApps();
    await reloadStatus();
  }

  async function guard(fn: () => Promise<void>) {
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    }
  }

  // ── 分类目录操作 ──────────────────────────────────────────────────────────

  async function submitEditor(r: EditorResult) {
    const target = editing;
    const pending = pendingDropApps;
    setEditing(undefined);
    setPendingDropApps(null);
    await guard(async () => {
      let createdId: string | null = null;
      if (target) {
        await updateCategory(target.id, r.name, r.description, r.hue, r.customColor);
      } else {
        createdId = (await createCategory(r.name, r.description, r.hue, r.customColor)).id;
      }
      await afterMutation();
      // 分类柜「拖入应用以新建分类」：新建成功后把待归类应用一次性归到新分类下。
      if (createdId && pending && pending.length > 0) {
        await assignApps(pending, createdId);
      }
    });
  }

  async function doArchive(cat: CategoryRow) {
    setConfirmArchive(null);
    await guard(async () => {
      await setCategoryArchived(cat.id, true);
      await afterMutation();
    });
  }

  async function doRestore(cat: CategoryRow) {
    await guard(async () => {
      await setCategoryArchived(cat.id, false);
      await afterMutation();
    });
  }

  async function askDelete(cat: CategoryRow) {
    await guard(async () => {
      setConfirmDelete({ cat, impact: await getCategoryDeleteImpact(cat.id) });
    });
  }

  async function doDelete(cat: CategoryRow) {
    setConfirmDelete(null);
    await guard(async () => {
      await deleteCategory(cat.id);
      await afterMutation();
    });
  }

  // 拖拽排序：只在未归档列表内部拖；落库时把归档项按原相对顺序接在后面，
  // 保证 sort_order 在整张表上仍然是连续的。
  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId || !order) return;
    const list = [...active];
    const from = list.findIndex((c) => c.id === dragId);
    const to = list.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    setOrder([...list, ...archived]);
    setDragId(null);
    const ids = [...list, ...archived].map((c) => c.id);
    guard(async () => {
      await reorderCategories(ids);
      await invalidateCategories();
    });
  }

  // ── 应用归类操作 ──────────────────────────────────────────────────────────

  async function changeAppCategory(r: AppCategoryRow, categoryId: string) {
    if (busyApp) return;
    setBusyApp(r.app_id);
    try {
      const updated = await setAppCategory(r.app_id, r.app_name, categoryId);
      setApps((rs) => rs?.map((x) => (x.app_id === updated.app_id ? updated : x)) ?? null);
      // 手改会作废撤销入口，也会改变各分类的 App 数量。
      await invalidateCategories();
      await reloadStatus();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyApp(null);
    }
  }

  async function resetApp(r: AppCategoryRow) {
    if (busyApp) return;
    setBusyApp(r.app_id);
    try {
      const updated = await resetAppCategory(r.app_id, r.app_name);
      setApps((rs) => rs?.map((x) => (x.app_id === updated.app_id ? updated : x)) ?? null);
      await invalidateCategories();
      await reloadStatus();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyApp(null);
    }
  }

  // ── 分类柜：多应用批量写入 ────────────────────────────────────────────────
  //
  // 分类柜的拖拽 / 右键 / 撤销一次可能涉及多个应用。这里按顺序逐个写（SQLite
  // 串行更稳），全部成功后再统一作废分类缓存并重拉状态，避免每个应用都触发一次
  // 全量刷新。每个入口返回是否成功，分类柜据此决定要不要记录 / 清除撤销条目。

  async function applyAppWrites(tasks: (() => Promise<AppCategoryRow>)[]): Promise<boolean> {
    try {
      const updated: AppCategoryRow[] = [];
      for (const t of tasks) updated.push(await t());
      const byIdMap = new Map(updated.map((u) => [u.app_id, u]));
      setApps((rs) => rs?.map((x) => byIdMap.get(x.app_id) ?? x) ?? null);
      await invalidateCategories();
      await reloadStatus();
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  async function assignApps(list: AppCategoryRow[], categoryId: string): Promise<boolean> {
    return applyAppWrites(list.map((r) => () => setAppCategory(r.app_id, r.app_name, categoryId)));
  }

  async function resetApps(list: AppCategoryRow[]): Promise<boolean> {
    return applyAppWrites(list.map((r) => () => resetAppCategory(r.app_id, r.app_name)));
  }

  async function undoDrag(entries: DragUndoEntry[]): Promise<boolean> {
    return applyAppWrites(entries.map((e) => () =>
      e.origCategory === null
        ? resetAppCategory(e.app.app_id, e.app.app_name)
        : setAppCategory(e.app.app_id, e.app.app_name, e.origCategory),
    ));
  }

  function createAndAssign(apps: AppCategoryRow[]) {
    setPendingDropApps(apps);
    setEditing(null);
  }

  async function reorderFolders(newActiveIds: string[]) {
    await guard(async () => {
      await reorderCategories([...newActiveIds, ...archived.map((c) => c.id)]);
      await invalidateCategories();
    });
  }

  // 分类柜的搜索框：与列表共用同一个 q。在分类柜里输入非空关键词就切到列表
  // 视图（那里有筛选下拉和完整列表），清空不自动切回。
  function onCabinetSearch(v: string) {
    setQ(v);
    if (v.trim() && view === "cabinet") setView("list");
  }

  // ── 批量分类 ──────────────────────────────────────────────────────────────

  async function runClassify(s: ClassifyScope) {
    setConfirmOverride(false);
    if (classifying) return;
    setClassifying(true);
    setClassifyMsg("");
    try {
      const r = await classifyApps(true, s);
      setClassifyMsg(r.message);
      await afterMutation();
    } catch (e) {
      setClassifyMsg(String(e));
    } finally {
      setClassifying(false);
    }
  }

  async function undoBatch() {
    await guard(async () => {
      const n = await undoClassifyBatch();
      setClassifyMsg(`已撤销，还原 ${n} 个应用`);
      await afterMutation();
    });
  }

  // ── 应用列表筛选 ──────────────────────────────────────────────────────────

  const shownApps = useMemo(() => {
    if (!apps) return [];
    const kw = q.trim().toLowerCase();
    return apps.filter((r) => {
      if (kw && !r.app_name.toLowerCase().includes(kw)) return false;
      if (filterSrc !== "all") {
        const src = r.source ?? "none";
        if (src !== filterSrc) return false;
      }
      if (filterCat !== "all") {
        const cur = r.category ?? ID_UNCATEGORIZED;
        if (filterCat === "archived") {
          if (!r.category || !byId.get(r.category)?.is_archived) return false;
        } else if (cur !== filterCat) return false;
      }
      return true;
    });
  }, [apps, q, filterCat, filterSrc, byId]);

  const atLimit = active.length >= MAX_ACTIVE_CATEGORIES;

  return (
    <PageShell
      className="categories-page"
      stickyHeader
      header={
        <div className="cat-page-header">
          <button className="cat-back" onClick={onBack}>
            <ChevronLeft size={15} />
            设置
          </button>
          <span className="cat-page-title">分类</span>
          <div className="cat-view-toggle" role="tablist">
            <button
              type="button"
              className={view === "cabinet" ? "is-active" : ""}
              onClick={() => setView("cabinet")}
            >
              分类柜
            </button>
            <button
              type="button"
              className={view === "list" ? "is-active" : ""}
              onClick={() => setView("list")}
            >
              列表
            </button>
          </div>
        </div>
      }
    >
      {err && (
        <div className="ai-warn">
          <AlertTriangle size={13} />
          <span>{err}</span>
        </div>
      )}

      {/* ── 分类目录（仅列表视图；分类柜走 CategoryCabinet） ─────────────────── */}
      {view === "list" && (
      <div className="settings-group">
        <div className="settings-group-title">
          分类
          <button
            className="setting-btn cat-new-btn"
            onClick={() => setEditing(null)}
            disabled={atLimit}
            title={atLimit ? `未归档分类已达上限 ${MAX_ACTIVE_CATEGORIES} 个` : undefined}
          >
            <Plus size={13} />
            新建分类
          </button>
        </div>
        {atLimit && (
          <div className="cat-limit-hint">
            未归档分类已达上限 {MAX_ACTIVE_CATEGORIES} 个，归档或删除一个后才能再建。
          </div>
        )}

        <div className="cat-cat-list">
          {order === null && <div className="cat-empty">加载中…</div>}
          {active.map((c) => (
            <div
              key={c.id}
              ref={c.id === focusId ? focusRef : undefined}
              className={`cat-cat-row${dragId === c.id ? " is-dragging" : ""}${
                c.id === focusId ? " is-focused" : ""
              }`}
              draggable
              onDragStart={() => setDragId(c.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(c.id)}
            >
              <span className="cat-drag" title="拖拽排序">
                <GripVertical size={14} />
              </span>
              <span className="cat-dot" style={{ background: listDot(c) }} />
              <div className="cat-cat-main">
                <span className="cat-cat-name">{c.name}</span>
                <span className="cat-cat-desc">{c.description || "（无说明，AI 无从判断归属）"}</span>
              </div>
              <span className="cat-cat-count">{c.app_count} 个应用</span>
              <div className="cat-cat-actions">
                <button className="cat-icon-btn" title="编辑" onClick={() => setEditing(c)}>
                  <Pencil size={13} />
                </button>
                {/* 系统分类是聚合逻辑的结构依赖，不显示归档入口 */}
                {!c.is_system && (
                  <button
                    className="cat-icon-btn"
                    title="归档"
                    onClick={() => setConfirmArchive(c)}
                  >
                    <Archive size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 已归档折叠区 */}
        <button className="cat-archived-head" onClick={() => setArchivedOpen((v) => !v)}>
          <ChevronDown size={14} className={archivedOpen ? "" : "is-collapsed"} />
          已归档{archived.length > 0 ? ` · ${archived.length}` : ""}
        </button>
        {archivedOpen && (
          <div className="cat-cat-list cat-archived-list">
            {archived.length === 0 && <div className="cat-empty">没有已归档的分类</div>}
            {archived.map((c) => (
              <div
                key={c.id}
                ref={c.id === focusId ? focusRef : undefined}
                className={`cat-cat-row${c.id === focusId ? " is-focused" : ""}`}
              >
                <span className="cat-dot" style={{ background: listDot(c) }} />
                <div className="cat-cat-main">
                  <span className="cat-cat-name">{c.name}</span>
                  <span className="cat-cat-desc">
                    其下 {c.app_count} 个应用已并入「其他」；恢复后自动回来
                  </span>
                </div>
                <div className="cat-cat-actions">
                  <button className="cat-icon-btn" title="改名 / 改色" onClick={() => setEditing(c)}>
                    <Pencil size={13} />
                  </button>
                  <button className="cat-icon-btn" title="恢复" onClick={() => doRestore(c)}>
                    <ArchiveRestore size={13} />
                  </button>
                  <button
                    className="cat-icon-btn is-danger"
                    title="永久删除"
                    onClick={() => askDelete(c)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ── 批量 AI 分类 ───────────────────────────────────────────── */}
      <div className="settings-group">
        <div className="settings-group-title">自动分类</div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">范围</span>
            <span className="setting-row-desc">
              {SCOPE_OPTIONS.find((o) => o.value === scope)?.desc}
            </span>
          </div>
          <div className="ai-row-right">
            <div className="setting-segmented">
              {SCOPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={`setting-seg-btn${scope === o.value ? " is-active" : ""}`}
                  onClick={() => setScope(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">批量分类</span>
            <span className="setting-row-desc">
              {classifyMsg
                ? classifyMsg
                : status
                  ? `待分类 ${status.queue_len} 个 · 共 ${status.total_apps} 个应用 · 手动指定 ${status.manual_count} 个`
                  : "加载中…"}
            </span>
          </div>
          <div className="ai-row-right">
            {status?.undo && (
              <button className="setting-btn" onClick={undoBatch}>
                <Undo2 size={13} />
                撤销本次分类（{status.undo.affected} 个）
              </button>
            )}
            <button
              className="setting-btn"
              disabled={classifying || status?.running === true}
              onClick={() =>
                scope === "all_override" ? setConfirmOverride(true) : runClassify(scope)
              }
            >
              {classifying ? <Loader2 size={13} className="is-spin" /> : <Tag size={13} />}
              {classifying ? "分类中…" : "开始分类"}
            </button>
          </div>
        </div>
      </div>

      {/* ── 应用归类（列表视图）/ 分类柜（默认视图） ─────────────────────────── */}
      {view === "list" ? (
      <div className="settings-group">
        <div className="settings-group-title">应用归类</div>

        <div className="cat-filters">
          <div className="cat-search">
            <Search size={13} className="cat-search-icon" />
            <input
              className="ai-input"
              placeholder="搜索应用名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className="cat-select"
            value={filterCat}
            onChange={(e) => setFilterCat(e.target.value)}
          >
            <option value="all">全部分类</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            <option value="archived">已归档分类下的应用</option>
          </select>
          <select
            className="cat-select"
            value={filterSrc}
            onChange={(e) => setFilterSrc(e.target.value)}
          >
            <option value="all">全部来源</option>
            <option value="manual">手动</option>
            <option value="ai">AI</option>
            <option value="builtin">内置规则</option>
            <option value="none">未分类</option>
          </select>
        </div>

        {apps === null ? (
          <div className="cat-empty">加载中…</div>
        ) : shownApps.length === 0 ? (
          <div className="cat-empty">没有符合条件的应用</div>
        ) : (
          <div className="cat-list">
            {shownApps.map((r) => {
              const cur = r.category ? byId.get(r.category) : undefined;
              const archivedOrigin = cur?.is_archived ? cur : null;
              return (
                <div key={r.app_id} className="cat-row">
                  <AppIcon bundleId={r.app_id} appName={r.app_name} size={20} />
                  <div className="cat-app">
                    <span className="cat-app-name">{r.app_name}</span>
                    <span className="cat-app-id" title={r.app_id}>{r.app_id}</span>
                  </div>

                  <span className={`cat-source is-${r.source ?? "none"}`}>
                    {r.source ? SOURCE_LABEL[r.source] ?? r.source : "未分类"}
                  </span>

                  <div className="cat-actions">
                    <select
                      className="cat-select"
                      value={archivedOrigin ? "__archived__" : r.category ?? ""}
                      onChange={(e) => e.target.value && changeAppCategory(r, e.target.value)}
                      disabled={busyApp === r.app_id}
                    >
                      <option value="" disabled>未分类</option>
                      {/* 指向已归档分类时，如实显示折叠去向与原分类，而不是假装它还在 */}
                      {archivedOrigin && (
                        <option value="__archived__" disabled>
                          其他（原{archivedOrigin.name}，已归档）
                        </option>
                      )}
                      {assignable.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {r.source === "manual" && (
                      <button
                        className="cat-icon-btn"
                        onClick={() => resetApp(r)}
                        disabled={busyApp === r.app_id}
                        title="重置为自动"
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      ) : (
        <CategoryCabinet
          apps={apps}
          order={order}
          atLimit={atLimit}
          q={q}
          onSearch={onCabinetSearch}
          onEdit={(cat) => setEditing(cat)}
          onArchive={(cat) => setConfirmArchive(cat)}
          onRestore={doRestore}
          onDelete={askDelete}
          onCreateFromDrop={createAndAssign}
          onAssign={assignApps}
          onResetApps={resetApps}
          onReorder={reorderFolders}
          onUndoDrag={undoDrag}
        />
      )}

      {editing !== undefined && (
        <CategoryEditor
          editing={editing}
          // 含已归档：归档只是隐藏，恢复后会重新出现，那时再撞色就晚了。
          // 但要排掉正在编辑的这一个——「重置为默认色」问的是「系统会给它挑哪个
          // 色」，它自己当前的（可能还是 customColor 下的陈旧）色相不该把自己挤开。
          existingHues={(order ?? []).filter((c) => c.id !== editing?.id).map((c) => c.hue)}
          onCancel={() => {
            setEditing(undefined);
            setPendingDropApps(null);
          }}
          onSubmit={submitEditor}
        />
      )}

      {confirmArchive &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setConfirmArchive(null)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <Archive size={20} />
                <h3>归档「{confirmArchive.name}」</h3>
              </div>
              <p className="dev-confirm-desc">
                归档后，这个分类下的 <b>{confirmArchive.app_count}</b> 个应用会在统计里并入
                「其他」，不再单独占一行；它也不会再出现在 AI 分类和改分类的下拉里。
                <br />
                应用的归类数据不会被改动——随时恢复，它们就自动回到这个分类下。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setConfirmArchive(null)}>取消</button>
                <button
                  className="setting-btn setting-btn-primary"
                  onClick={() => doArchive(confirmArchive)}
                >
                  归档
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {confirmDelete &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setConfirmDelete(null)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <Trash2 size={20} />
                <h3>永久删除「{confirmDelete.cat.name}」</h3>
              </div>
              <p className="dev-confirm-desc">
                将影响 <b>{confirmDelete.impact.app_count}</b> 个应用（归类改为「未分类」），
                清除 <b>{confirmDelete.impact.manual_count}</b> 条手动覆盖
                与 <b>{confirmDelete.impact.rule_count}</b> 条内置规则。
                <br />
                <b>此操作不可撤销。</b>如果只是想让它从统计里消失，用「归档」。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setConfirmDelete(null)}>取消</button>
                <button
                  className="setting-btn setting-btn-danger is-confirm"
                  onClick={() => doDelete(confirmDelete.cat)}
                >
                  永久删除
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {confirmOverride &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setConfirmOverride(false)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <AlertTriangle size={20} />
                <h3>覆盖手动分类</h3>
              </div>
              <p className="dev-confirm-desc">
                这一轮会重分全部 <b>{status?.total_apps ?? 0}</b> 个应用，
                其中 <b>{status?.manual_count ?? 0}</b> 条你手动指定的分类会被 AI 结果覆盖。
                <br />
                跑完可以用「撤销本次分类」一键还原，包括这些手动决定。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setConfirmOverride(false)}>取消</button>
                <button
                  className="setting-btn setting-btn-primary"
                  onClick={() => runClassify("all_override")}
                >
                  确认覆盖
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </PageShell>
  );
}
