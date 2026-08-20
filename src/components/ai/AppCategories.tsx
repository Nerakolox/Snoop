// 应用分类管理（Task 3）—— 设置页里列出全部应用及其生效分类，
// 支持手动改类（source=manual，永久）与「重置为自动」，以及「待确认」筛选。

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import {
  listClassifiedApps,
  setAppCategory,
  resetAppCategory,
} from "../../ai/client";
import type { AppCategoryRow } from "../../ai/types";

// 与后端 Category 枚举严格对齐（as_str / label）。改枚举必须同步这里。
const CATEGORIES = [
  { value: "development", label: "开发" },
  { value: "communication", label: "沟通" },
  { value: "browsing", label: "浏览" },
  { value: "entertainment", label: "娱乐" },
  { value: "design", label: "设计" },
  { value: "document", label: "文档" },
  { value: "system", label: "系统" },
  { value: "remote", label: "远程控制" },
  { value: "download", label: "下载工具" },
  { value: "other", label: "其他" },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  builtin: "内置",
  ai: "AI",
};

type Filter = "all" | "confirm";

export default function AppCategories() {
  const [rows, setRows] = useState<AppCategoryRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    listClassifiedApps().then(setRows).catch(console.error);
  }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    return filter === "confirm" ? rows.filter((r) => r.needs_confirmation) : rows;
  }, [rows, filter]);

  const confirmCount = useMemo(
    () => (rows ? rows.filter((r) => r.needs_confirmation).length : 0),
    [rows],
  );

  function patchRow(updated: AppCategoryRow) {
    setRows((rs) => rs?.map((x) => (x.app_id === updated.app_id ? updated : x)) ?? null);
  }

  async function changeCategory(r: AppCategoryRow, category: string) {
    if (busyId) return;
    setBusyId(r.app_id);
    try {
      patchRow(await setAppCategory(r.app_id, r.app_name, category));
    } catch (e) {
      console.error(e);
    } finally {
      setBusyId(null);
    }
  }

  async function reset(r: AppCategoryRow) {
    if (busyId) return;
    setBusyId(r.app_id);
    try {
      patchRow(await resetAppCategory(r.app_id, r.app_name));
    } catch (e) {
      console.error(e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="cat-panel">
      <div className="cat-toolbar">
        <div className="setting-segmented">
          <button
            className={`setting-seg-btn${filter === "all" ? " is-active" : ""}`}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          <button
            className={`setting-seg-btn${filter === "confirm" ? " is-active" : ""}`}
            onClick={() => setFilter("confirm")}
          >
            待确认{confirmCount > 0 ? ` · ${confirmCount}` : ""}
          </button>
        </div>
      </div>

      {rows === null ? (
        <div className="cat-empty">加载中…</div>
      ) : shown.length === 0 ? (
        <div className="cat-empty">
          {filter === "confirm" ? "没有待确认的应用" : "暂无应用记录"}
        </div>
      ) : (
        <div className="cat-list">
          {shown.map((r) => (
            <div key={r.app_id} className="cat-row">
              <div className="cat-app">
                <span className="cat-app-name">{r.app_name}</span>
                <span className="cat-app-id" title={r.app_id}>
                  {r.app_id}
                </span>
              </div>

              <div className="cat-meta">
                {r.source && (
                  <span className={`cat-source is-${r.source}`}>
                    {SOURCE_LABEL[r.source] ?? r.source}
                  </span>
                )}
                {r.source === "ai" && r.confidence != null && (
                  <span className="cat-confidence">{Math.round(r.confidence * 100)}%</span>
                )}
                {r.needs_confirmation && <TriangleAlert size={13} className="cat-warn" />}
              </div>

              <div className="cat-actions">
                <select
                  className="cat-select"
                  value={r.category ?? ""}
                  onChange={(e) => e.target.value && changeCategory(r, e.target.value)}
                  disabled={busyId === r.app_id}
                >
                  <option value="" disabled>
                    未分类
                  </option>
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {r.source === "manual" && (
                  <button
                    className="cat-reset"
                    onClick={() => reset(r)}
                    disabled={busyId === r.app_id}
                    title="重置为自动"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
