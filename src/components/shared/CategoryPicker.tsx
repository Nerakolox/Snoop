/**
 * 就地改分类 —— App 排行行上的次级操作。
 *
 * 形态选的是「悬停出现的小按钮 + 下拉」而不是右键菜单：`main.tsx` 全局
 * `preventDefault` 掉了 contextmenu（整个应用没有一处右键菜单），为一个次级操作
 * 破例会让右键在这一行忽然有反应、别处没反应。小按钮在概览与规律两页共用本组件，
 * 形态天然一致。
 *
 * 写入走 set_app_category，即 source=manual。后端的优先级硬规则是
 * manual(3) > builtin(2) > ai(1)，所以用户在这里改一次就永久压过内置规则与 AI，
 * 除非他自己在分类页「重置为自动」，或跑一次「全部（覆盖手动）」的批量分类。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Settings2, Tag } from "lucide-react";
import { listClassifiedApps, setAppCategory } from "../../ai/client";
import { assignableCategories, fillOf, invalidateCategories, labelOf, useCategories } from "../../categories/store";
import { useContextActions } from "../../store/context";
import { positionTooltip } from "./tooltipPosition";

const GAP = 6;

export default function CategoryPicker({
  appId,
  appName,
}: {
  appId: string;
  appName: string;
}) {
  const cats = useCategories();
  const actions = useContextActions();
  const assignable = assignableCategories(cats);

  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 打开时读一次当前归类。没有「查单个 App」的命令，就用整表那一个——本地
  // SQLite 一次读，点开的瞬间完成；不做缓存，保证每次点开看到的都是最新状态。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listClassifiedApps()
      .then((rows) => {
        if (cancelled) return;
        setCur(rows.find((r) => r.app_id === appId)?.category ?? null);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appId]);

  // 定位：挂载后量出真实尺寸再摆，避免先在左上角闪一下。锚点取按钮下沿中点。
  useLayoutEffect(() => {
    if (!open || !popRef.current || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos(
      positionTooltip(popRef.current, r.left + r.width / 2, r.bottom, GAP, {
        placement: "bottom",
      }),
    );
  }, [open, assignable.length, loading, err]);

  // 外部点击 / Esc 关闭，与 TopBar 的应用筛选下拉同一套。
  // 另外滚动与改窗口尺寸也关：菜单 portal 到 body 且 position:fixed，不跟着页面滚，
  // 不关的话会浮在半空跟原来那一行脱节（Tooltip 用的是同一条策略）。
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    const close = () => setOpen(false);
    // 菜单自己那个可滚动的分类列表不算「页面滚了」，否则滚一下列表菜单就没了。
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  async function pick(categoryId: string) {
    if (busy || categoryId === cur) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await setAppCategory(appId, appName, categoryId);
      // 作废按分类聚合的缓存并重拉分类表。调用方页面不用自己接回调：它们订阅了
      // useCategories，快照一换就重渲染，按分类聚合的 effect 也随之重跑。
      await invalidateCategories();
      setCur(categoryId);
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function manage() {
    setOpen(false);
    actions.navigate({ page: "settings", settingsSub: "categories", focusCategory: null });
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cat-pick-btn${open ? " is-open" : ""}`}
        title={`改分类：${appName}`}
        aria-label={`改分类：${appName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Tag size={12} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="cat-pick-menu"
            role="menu"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <div className="cat-pick-head">
              <span className="cat-pick-app">{appName}</span>
              <span className="cat-pick-cur">
                {busy ? (
                  <Loader2 size={12} className="is-spin" />
                ) : loading ? (
                  "读取中…"
                ) : cur ? (
                  labelOf(cur)
                ) : (
                  "未分类"
                )}
              </span>
            </div>

            {err && <div className="cat-pick-err">{err}</div>}

            <div className="cat-pick-list">
              {assignable.length === 0 && <div className="cat-pick-empty">没有可用分类</div>}
              {assignable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  className={`cat-pick-item${c.id === cur ? " is-active" : ""}`}
                  disabled={busy}
                  onClick={() => pick(c.id)}
                >
                  <span className="cat-pick-dot" style={{ background: fillOf(c.id) }} />
                  <span className="cat-pick-name">{c.name}</span>
                  {busy ? null : c.id === cur ? <Check size={12} /> : null}
                </button>
              ))}
            </div>

            <button type="button" className="cat-pick-manage" onClick={manage}>
              <Settings2 size={12} />
              管理分类
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
