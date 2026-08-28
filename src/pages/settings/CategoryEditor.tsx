// 新建 / 编辑分类的弹窗 —— 名称、说明、颜色。
//
// 说明字段不是装饰：它会逐条进 AI 分类 prompt，是 AI 判断归属的唯一依据。
// 所以输入框的提示语要把这件事讲清楚，用户才知道该往里写什么。

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Palette, RotateCcw } from "lucide-react";
import {
  forbiddenReason,
  hexToOklch,
  isHueAllowed,
  pickNewHue,
} from "../../categories/color";
import type { CategoryRow } from "../../categories/types";
import CategoryColorPicker from "./CategoryColorPicker";

export interface EditorResult {
  name: string;
  description: string;
  hue: number;
  customColor: string | null;
}

const REASON_TEXT: Record<"intensity" | "accent", string> = {
  intensity: "该色相已被活跃强度色阶占用",
  accent: "该色相已被品牌色占用",
};

export default function CategoryEditor({
  /** null = 新建 */
  editing,
  /** 现有全部分类的色相（**含已归档**），用于给新分类挑一个不撞的色。 */
  existingHues,
  onCancel,
  onSubmit,
}: {
  editing: CategoryRow | null;
  existingHues: number[];
  onCancel: () => void;
  onSubmit: (r: EditorResult) => void;
}) {
  const defaultHue = useMemo(
    () => (editing ? editing.hue : pickNewHue(existingHues)),
    [editing, existingHues],
  );

  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [hue, setHue] = useState(defaultHue);
  const [customColor, setCustomColor] = useState<string | null>(editing?.custom_color ?? null);
  // 用户选了禁区里的颜色 → 先拦一道，讲清楚为什么，坚持要用再存 customColor。
  const [pendingForbidden, setPendingForbidden] = useState<{ hex: string; reason: string } | null>(
    null,
  );

  function applyHue(h: number) {
    setHue(Math.round(h * 10) / 10);
    setCustomColor(null);
    setPendingForbidden(null);
  }

  function handlePick(hex: string) {
    const o = hexToOklch(hex);
    if (!o) return;
    if (isHueAllowed(o.h)) {
      // 落在允许弧内：只取色相存进去，仍然跟随主题（深浅两态自动适配）。
      setHue(Math.round(o.h * 10) / 10);
      setCustomColor(null);
      setPendingForbidden(null);
      return;
    }
    const reason = forbiddenReason(o.h);
    setPendingForbidden({ hex, reason: REASON_TEXT[reason ?? "accent"] });
  }

  function confirmForbidden() {
    if (!pendingForbidden) return;
    setCustomColor(pendingForbidden.hex);
    setPendingForbidden(null);
  }

  function resetColor() {
    setCustomColor(null);
    setHue(pickNewHue(existingHues));
    setPendingForbidden(null);
  }

  const canSubmit = name.trim().length > 0;

  return createPortal(
    <div className="dev-confirm-overlay" onClick={onCancel}>
      <div className="dev-confirm-dialog cat-editor" onClick={(e) => e.stopPropagation()}>
        <div className="dev-confirm-header">
          <Palette size={20} />
          <h3>{editing ? "编辑分类" : "新建分类"}</h3>
        </div>

        <label className="cat-field">
          <span className="cat-field-label">名称</span>
          <input
            className="ai-input"
            value={name}
            autoFocus
            placeholder="如：写作"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="cat-field">
          <span className="cat-field-label">说明</span>
          <textarea
            className="ai-input cat-textarea"
            value={description}
            rows={3}
            placeholder="描述哪些应用属于这一类。AI 自动分类时只看这段说明来判断归属。"
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="cat-field-hint">这段话会进 AI 分类提示词，写得越具体，归类越准。</span>
        </label>

        <div className="cat-field">
          <span className="cat-field-label">颜色</span>
          <div className="cat-color-row">
            <CategoryColorPicker
              hue={hue}
              customColor={customColor}
              existingHues={existingHues}
              onApplyHue={applyHue}
              onPickHex={handlePick}
            />
            <span className="cat-color-meta">
              {customColor ? `自定义 ${customColor}` : `色相 ${hue.toFixed(1)}°`}
            </span>
            <button type="button" className="setting-btn" onClick={resetColor}>
              <RotateCcw size={13} />
              重置为默认色
            </button>
          </div>
          {customColor && (
            <span className="cat-field-hint">
              自定义色不随深浅主题适配，两种主题下都用这一个色值。
            </span>
          )}
        </div>

        {pendingForbidden && (
          <div className="ai-warn cat-color-warn">
            <AlertTriangle size={13} />
            <span>
              {pendingForbidden.reason}。分类色占用它会让读者把「某个分类」误读成
              「活跃强度」或「已选中」。
            </span>
            <button type="button" className="setting-btn" onClick={confirmForbidden}>
              仍要使用
            </button>
          </div>
        )}

        <div className="dev-confirm-actions">
          <button type="button" className="setting-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="setting-btn setting-btn-primary"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({ name: name.trim(), description: description.trim(), hue, customColor })
            }
          >
            {editing ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
