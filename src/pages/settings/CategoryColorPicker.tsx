// 分类取色器 —— 自建取色弹层，替代原生 <input type="color">。
//
// 原生取色器弹系统层、样式不可控、还会遮住对话框的取消/保存按钮，必须换掉。
// 这里分两部分：
//   1. 推荐色（主路径，默认展示）：从允许色相弧上按最大间隙取 8 个未占用色相，
//      走 categoryColor 同一套推导渲染为当前主题下的实际显示色，点选即应用。
//   2. 自定义（次路径，默认收起）：色相滑条（只调 hue，L/C 由主题层给）+ HEX 输入。
//      禁区标在滑条上；落入禁区或 HEX 落入禁区都走 CategoryEditor 的 handlePick
//      同一套判定/提示/坚持流程——本组件不重写那段逻辑。
//
// 弹层 portal 到 body、打开方向默认向上（避免盖住对话框底部的取消/保存），
// 撞边自动翻转 + clamp 进视口，复用 Tooltip 的 positionTooltip 算法。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  categoryColor,
  forbiddenArcs,
  hexToOklch,
  hueToHex,
  isHueAllowed,
  pickRecommendedHues,
  type Arc,
} from "../../categories/color";
import { positionTooltip } from "../../components/shared/tooltipPosition";

const GAP = 6;
const RECOMMENDED_COUNT = 8;

/** 把一段（可能跨 0 度的）禁区弧拆成 [0,360) 内的若干段，供滑条上画禁区。 */
function bandsInRange(arc: Arc): { start: number; end: number }[] {
  let s = arc.start % 360;
  if (s < 0) s += 360;
  const width = arc.end - arc.start;
  const e = s + width;
  if (e <= 360) return [{ start: s, end: e }];
  return [
    { start: s, end: 360 },
    { start: 0, end: e - 360 },
  ];
}

export default function CategoryColorPicker({
  hue,
  customColor,
  existingHues,
  onApplyHue,
  onPickHex,
}: {
  hue: number;
  customColor: string | null;
  /** 其它分类的色相（含已归档），推荐色避开它们。 */
  existingHues: number[];
  /** 选中允许弧内的色相：直接存 hue（推荐色点选 / 滑条落入允许区）。 */
  onApplyHue: (hue: number) => void;
  /** 走 HEX/禁区判定（复用 CategoryEditor 的 handlePick）。 */
  onPickHex: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [sliderHue, setSliderHue] = useState(hue);
  const [hex, setHex] = useState(customColor ?? hueToHex(hue));

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const recommended = useMemo(
    () => pickRecommendedHues(existingHues, RECOMMENDED_COUNT),
    [existingHues],
  );
  const forbiddenBands = useMemo(() => forbiddenArcs().flatMap(bandsInRange), []);

  // 外部 hue/customColor 变化（点推荐色、重置为默认色）时，让滑条与 HEX 跟上。
  useEffect(() => {
    setSliderHue(hue);
    setHex(customColor ?? hueToHex(hue));
  }, [hue, customColor]);

  // 定位：挂载后量出真实尺寸再摆（避免左上角闪一下）。锚点取色块上沿中点、默认向上弹。
  useLayoutEffect(() => {
    if (!open || !popRef.current || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos(
      positionTooltip(popRef.current, r.left + r.width / 2, r.top, GAP, { placement: "top" }),
    );
  }, [open, customOpen]);

  // 外部点击 / Esc / 滚动 / 改尺寸关闭，与 CategoryPicker 同一套。
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, { capture: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function applyRec(h: number) {
    onApplyHue(h);
    setOpen(false);
  }

  function onSlider(v: number) {
    setSliderHue(v);
    if (isHueAllowed(v)) onApplyHue(v);
    else onPickHex(hueToHex(v));
  }

  function commitHex() {
    const v = hex.trim();
    if (!v || !hexToOklch(v)) {
      // 空或非法输入：回退到当前实际色，别让框里留着一个解释不了的字符串。
      setHex(customColor ?? hueToHex(hue));
      return;
    }
    onPickHex(v);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`cat-color-swatch${open ? " is-open" : ""}`}
        style={{ background: categoryColor(hue, customColor) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="选择颜色"
        title="选择颜色"
        onClick={() => setOpen((v) => !v)}
      />

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="cat-color-pop"
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
          >
            {/* 推荐色（主路径，默认展示） */}
            <div className="cat-color-pop-title">推荐颜色</div>
            <div className="cat-color-swatches">
              {recommended.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`cat-color-rec${
                    !customColor && Math.abs(h - hue) < 0.05 ? " is-active" : ""
                  }`}
                  style={{ background: categoryColor(h) }}
                  title={`色相 ${h.toFixed(1)}°`}
                  onClick={() => applyRec(h)}
                />
              ))}
            </div>

            {/* 自定义（次路径，默认收起） */}
            <button
              type="button"
              className="cat-color-custom-head"
              onClick={() => setCustomOpen((v) => !v)}
            >
              {customOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              自定义
            </button>
            {customOpen && (
              <div className="cat-color-custom">
                <div className="cat-color-hue-label">
                  色相 <b>{sliderHue.toFixed(1)}°</b>
                </div>
                <div className="cat-color-slider">
                  <div className="cat-color-slider-track">
                    {forbiddenBands.map((b, i) => (
                      <span
                        key={i}
                        className="cat-color-slider-forbidden"
                        style={{
                          left: `${(b.start / 360) * 100}%`,
                          width: `${((b.end - b.start) / 360) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                  <input
                    type="range"
                    className="cat-color-slider-range"
                    min={0}
                    max={360}
                    step={1}
                    value={sliderHue}
                    onInput={(e) => onSlider(Number(e.currentTarget.value))}
                  />
                </div>
                <div className="cat-color-hex">
                  <span className="cat-color-hex-label">HEX</span>
                  <input
                    className="cat-color-hex-input"
                    value={hex}
                    placeholder="#RRGGBB"
                    spellCheck={false}
                    onChange={(e) => setHex(e.target.value)}
                    onBlur={commitHex}
                    onKeyDown={(e) => e.key === "Enter" && commitHex()}
                  />
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
