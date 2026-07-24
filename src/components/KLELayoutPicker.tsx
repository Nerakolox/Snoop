/**
 * KLE 配列选择器
 * 内置配列构建期内联；用户可从 keyboard-layout-editor.com 导出的 JSON 导入自定义配列。
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseKLE, type KLEKey } from "../kleParser";
import KLELayoutPreview from "./KLELayoutPreview";
import {
  getAllLayouts,
  getLayoutById,
  addCustomLayout,
  removeCustomLayout,
  validateKleJson,
  getSavedLayoutId,
  saveLayoutId,
  type LayoutEntry,
} from "../layouts";

type KLELayoutPickerProps = {
  value: string;
  onChange: (layoutId: string) => void;
};

type ImportDraft = {
  data: any[];
  suggestedName: string;
  previewKeys: KLEKey[];
  unsupportedFeatures: string[];
};

export default function KLELayoutPicker({ value, onChange }: KLELayoutPickerProps) {
  const [layouts, setLayouts] = useState<LayoutEntry[]>(() => getAllLayouts());
  const [currentPage, setCurrentPage] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [showImportIntro, setShowImportIntro] = useState(false);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const itemsPerPage = 5;
  const totalPages = Math.max(1, Math.ceil(layouts.length / itemsPerPage));
  const visibleLayouts = layouts.slice(
    currentPage * itemsPerPage,
    (currentPage + 1) * itemsPerPage
  );

  // 预览缓存：id → KLEKey[]
  const previews = useMemo(() => {
    const map = new Map<string, KLEKey[]>();
    for (const l of layouts) {
      try {
        map.set(l.id, parseKLE(l.data).keys);
      } catch {
        map.set(l.id, []);
      }
    }
    return map;
  }, [layouts]);

  // 选中项翻页
  useEffect(() => {
    const index = layouts.findIndex((l) => l.id === value);
    if (index >= 0) {
      setCurrentPage(Math.floor(index / itemsPerPage));
    }
  }, [value, layouts]);

  function refreshLayouts() {
    setLayouts(getAllLayouts());
  }

  function openImportIntro() {
    setImportError(null);
    setShowImportIntro(true);
  }

  function proceedToFilePicker() {
    setShowImportIntro(false);
    // 等 overlay 卸载后再打开系统文件框，避免 blur/focus 冲突
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许下次选同一文件
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = validateKleJson(json);
      if (!result.ok) {
        setImportError(`不是有效的 KLE 配列文件：${result.reason}`);
        return;
      }
      const suggested = file.name.replace(/\.json$/i, "");
      setImportDraft({
        data: json,
        suggestedName: suggested,
        previewKeys: result.keys,
        unsupportedFeatures: result.unsupportedFeatures,
      });
      setDraftName(suggested);
    } catch (err) {
      setImportError(`无法解析 JSON：${(err as Error).message ?? err}`);
    }
  }

  function confirmImport() {
    if (!importDraft) return;
    const entry = addCustomLayout(draftName, importDraft.data);
    setImportDraft(null);
    setDraftName("");
    refreshLayouts();
    onChange(entry.id);
  }

  function cancelImport() {
    setImportDraft(null);
    setDraftName("");
  }

  function askDelete(id: string) {
    setConfirmDelete(id);
  }

  function doDelete(id: string) {
    removeCustomLayout(id);
    setConfirmDelete(null);
    // 如果删除的是当前选中项，回落到第一个内置
    if (value === id) {
      const remaining = getAllLayouts();
      const fallback = remaining.find((l) => l.source === "builtin") ?? remaining[0];
      if (fallback) onChange(fallback.id);
    }
    refreshLayouts();
  }

  function goToPrevPage() {
    setCurrentPage((p) => Math.max(0, p - 1));
  }

  function goToNextPage() {
    setCurrentPage((p) => Math.min(totalPages - 1, p + 1));
  }

  return (
    <div className="kle-layout-picker">
      <label className="kle-layout-label">配列</label>
      <div className="kle-layout-carousel">
        {totalPages > 1 && (
          <button
            type="button"
            className="kle-carousel-btn"
            onClick={goToPrevPage}
            disabled={currentPage === 0}
            title="上一页"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="kle-layout-options">
          {visibleLayouts.map((layout) => {
            const previewKeys = previews.get(layout.id) || [];
            const isCustom = layout.source === "custom";
            return (
              <div
                key={layout.id}
                className={`kle-layout-option${value === layout.id ? " is-active" : ""}${isCustom ? " is-custom" : ""}`}
              >
                <button
                  type="button"
                  className="kle-layout-option-btn"
                  onClick={() => onChange(layout.id)}
                  title={layout.name}
                >
                  <div className="kle-layout-preview">
                    {previewKeys.length > 0 ? (
                      <KLELayoutPreview keys={previewKeys} width={64} height={26} />
                    ) : (
                      <div style={{ width: 64, height: 26 }} />
                    )}
                  </div>
                  <div className="kle-layout-name">
                    {isCustom && <span className="kle-layout-badge" title="自定义">·</span>}
                    {layout.name}
                  </div>
                </button>
                {isCustom && (
                  <button
                    type="button"
                    className="kle-layout-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      askDelete(layout.id);
                    }}
                    title="删除自定义配列"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {totalPages > 1 && (
          <button
            type="button"
            className="kle-carousel-btn"
            onClick={goToNextPage}
            disabled={currentPage >= totalPages - 1}
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        )}
        <button
          type="button"
          className="kle-carousel-btn kle-import-btn"
          onClick={openImportIntro}
          title="导入 KLE 配列（keyboard-layout-editor.com 导出的 JSON）"
        >
          <Plus size={16} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFileSelected}
        style={{ display: "none" }}
      />

      {showImportIntro &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setShowImportIntro(false)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <h3>导入自定义配列</h3>
              </div>
              <p className="dev-confirm-desc">
                Snoop 支持导入 keyboard-layout-editor.com 制作的配列。前往下方网站编辑好配列后，点右上角
                「Download JSON」下载 JSON 文件，再回到这里选中导入。
              </p>
              <button
                className="setting-btn"
                onClick={() => openUrl("https://www.keyboard-layout-editor.com")}
                style={{ alignSelf: "flex-start" }}
              >
                <ExternalLink size={13} />
                keyboard-layout-editor.com
              </button>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setShowImportIntro(false)}>
                  取消
                </button>
                <button className="setting-btn setting-btn-primary" onClick={proceedToFilePicker}>
                  选择 JSON 文件
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {importError &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setImportError(null)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <h3>导入失败</h3>
              </div>
              <p className="dev-confirm-desc">{importError}</p>
              <p className="dev-confirm-desc" style={{ fontSize: "var(--text-xs)" }}>
                请从 keyboard-layout-editor.com 制作后导出 JSON（Download JSON），再导入到 Snoop。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn setting-btn-primary" onClick={() => setImportError(null)}>
                  好的
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {importDraft &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={cancelImport}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <h3>导入配列</h3>
              </div>
              <p className="dev-confirm-desc">
                已识别到 {importDraft.previewKeys.length} 个键位，给这个配列起个名字：
              </p>
              {importDraft.unsupportedFeatures.length > 0 && (
                <p
                  className="dev-confirm-desc"
                  style={{ fontSize: "var(--text-xs)", color: "var(--color-text-3)" }}
                >
                  注意：当前不支持异形键（ISO 大回车、阶梯 CapsLock）与旋转配列
                  （检测到 {importDraft.unsupportedFeatures.join("、")}），这些键将按矩形近似渲染。
                  不影响导入，其余键位正常显示。
                </p>
              )}
              <input
                className="setting-ignore-input"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmImport();
                  if (e.key === "Escape") cancelImport();
                }}
                placeholder="配列名"
                style={{ width: "100%" }}
              />
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={cancelImport}>
                  取消
                </button>
                <button className="setting-btn setting-btn-primary" onClick={confirmImport}>
                  导入
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {confirmDelete &&
        createPortal(
          <div className="dev-confirm-overlay" onClick={() => setConfirmDelete(null)}>
            <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dev-confirm-header">
                <Trash2 size={18} />
                <h3>删除自定义配列</h3>
              </div>
              <p className="dev-confirm-desc">
                确认删除「{getLayoutById(confirmDelete)?.name ?? "该配列"}」？此操作不可撤销。
              </p>
              <div className="dev-confirm-actions">
                <button className="setting-btn" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
                <button
                  className="setting-btn setting-btn-danger"
                  onClick={() => doDelete(confirmDelete)}
                >
                  删除
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

// ---- 兼容旧调用点（页面在使用这几个导出） ----

export function getSavedLayout(): string {
  return getSavedLayoutId();
}

export function saveLayout(layoutId: string): void {
  saveLayoutId(layoutId);
}

/**
 * 加载配列 JSON（现从内置/自定义注册中心取，不再走 fetch）。
 */
export async function loadLayoutJSON(layoutId: string): Promise<any> {
  const entry = getLayoutById(layoutId);
  if (!entry) throw new Error(`Layout not found: ${layoutId}`);
  return entry.data;
}
