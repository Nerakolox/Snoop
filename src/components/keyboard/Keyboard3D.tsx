/**
 * 键盘 3D 视图 —— 框架版（CSS perspective + DOM 键帽）
 *
 * Three.js 建模已移除，保留：
 *   - 拖拽旋转（水平 yaw ±40°，俯仰 tilt 5-65°）
 *   - 滚轮缩放
 *   - 重置视角
 *   - 热力色阶 + tooltip + 键位选中
 *   - invertDragX / invertDragY props
 *
 * 键帽几何（3D 模型）待后续接入，当前每键为 flat 彩色方块。
 * Props 接口与旧 Three.js 版完全一致，Keyboard.tsx 接入点不变。
 */

import { useEffect, useRef, useState, useMemo } from "react";
import type { LayoutKey } from "../../keyboardLayout";
import { displayLabel } from "../../keyboardLayout";
import { bucketByPercentile, intensityVar } from "../../analytics";
import type { Intensity } from "../../analytics";
import { KEY_UNIT, KEY_GAP } from "../../layouts/metrics";
import { useKeySelection } from "./KeySelectionContext";
import KeyCountTooltip, { type KeyCountAnchor } from "./KeyCountTooltip";

// ---- 相机约束 ---------------------------------------------------------------
const TILT_MIN = 5;
const TILT_MAX = 65;
const TILT_DEFAULT = 30;
const YAW_MAX = 40;
const YAW_DEFAULT = 0;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.8;
const ZOOM_DEFAULT = 1.0;
const DRAG_THRESHOLD_PX = 4;
const ROTATE_PER_PX = 0.35;

type Props = {
  keys: LayoutKey[];
  keyCounts: Record<string, number>;
  allKeyCounts: number[];
  maxX: number;
  maxY: number;
  /** 键位测试页用：高亮这些下标为最高热力（覆盖 keyCounts）。 */
  pressedIndices?: Set<number>;
  /** 翻转上下拖拽方向；true = 原始方向，false（默认）= 反转。 */
  invertDragX?: boolean;
  /** 翻转左右拖拽方向；true = 原始方向，false（默认）= 反转。 */
  invertDragY?: boolean;
};

export default function Keyboard3D({
  keys,
  keyCounts,
  allKeyCounts,
  maxX,
  maxY,
  pressedIndices,
  invertDragX = false,
  invertDragY = false,
}: Props) {
  const { onKeyClick, selectedIndex } = useKeySelection();

  const [tilt, setTilt] = useState(TILT_DEFAULT);
  const [yaw, setYaw] = useState(YAW_DEFAULT);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltip, setTooltip] = useState<KeyCountAnchor | null>(null);

  const dragRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  });
  // 避免 useEffect([]) 闭包拿到过期的 invertDrag 值
  const invertRef = useRef({ invertDragX, invertDragY });
  invertRef.current = { invertDragX, invertDragY };

  const containerRef = useRef<HTMLDivElement>(null);

  // ---- 热力分档 ---------------------------------------------------------------
  const levels = useMemo<Intensity[]>(() => {
    return keys.map((k, i) => {
      if (pressedIndices && pressedIndices.size > 0) {
        return pressedIndices.has(i) ? 4 : 0;
      }
      const count = keyCounts[k.code] ?? 0;
      return bucketByPercentile(count, allKeyCounts);
    });
  }, [keys, keyCounts, allKeyCounts, pressedIndices]);

  // ---- 拖拽 / 滚轮 -----------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      dragRef.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
      };
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (
        !d.moved &&
        Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD_PX
      ) {
        d.moved = true;
        setIsDragging(true);
      }
      if (d.moved) {
        const { invertDragX: ix, invertDragY: iy } = invertRef.current;
        const signX = iy ? 1 : -1; // 左右拖动 → yaw
        const signY = ix ? 1 : -1; // 上下拖动 → tilt
        setYaw((prev) =>
          Math.max(-YAW_MAX, Math.min(YAW_MAX, prev + dx * signX * ROTATE_PER_PX))
        );
        setTilt((prev) =>
          Math.max(TILT_MIN, Math.min(TILT_MAX, prev + dy * signY * ROTATE_PER_PX))
        );
      }
    };

    const onPointerUp = () => {
      dragRef.current.active = false;
      setIsDragging(false);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((prev) =>
        Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev - e.deltaY * 0.0008))
      );
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointerleave", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointerleave", onPointerUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const resetView = () => {
    setTilt(TILT_DEFAULT);
    setYaw(YAW_DEFAULT);
    setZoom(ZOOM_DEFAULT);
  };

  const boardW = maxX * KEY_UNIT;
  const boardH = maxY * KEY_UNIT;

  return (
    <div
      className="kb3d-shell"
      ref={containerRef}
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    >
      <div
        className="kb3d-scene"
        style={{ perspective: "1100px", perspectiveOrigin: "50% 25%" }}
      >
        <div
          className="kb3d-board"
          style={{
            width: boardW,
            height: boardH,
            transform: `scale(${zoom}) rotateX(${tilt}deg) rotateY(${yaw}deg)`,
          }}
        >
          {keys.map((key, i) => {
            const kx = key.x * KEY_UNIT + KEY_GAP / 2;
            const ky = key.y * KEY_UNIT + KEY_GAP / 2;
            const kw = key.w * KEY_UNIT - KEY_GAP;
            const kh = key.h * KEY_UNIT - KEY_GAP;
            const level = levels[i];
            const isSelected = selectedIndex === i;
            const count = keyCounts[key.code] ?? 0;
            const label = displayLabel(key);

            return (
              <button
                key={key.code}
                className={`kb3d-key${isSelected ? " is-selected" : ""}${count === 0 ? " is-empty" : ""}`}
                style={{
                  left: kx,
                  top: ky,
                  width: kw,
                  height: kh,
                  background: count > 0 ? intensityVar(level) : undefined,
                }}
                onClick={() => {
                  if (!dragRef.current.moved) onKeyClick?.(key);
                }}
                onMouseEnter={(e) =>
                  setTooltip({ label, count, x: e.clientX, y: e.clientY })
                }
                onMouseMove={(e) =>
                  setTooltip((prev) =>
                    prev ? { ...prev, x: e.clientX, y: e.clientY } : prev
                  )
                }
                onMouseLeave={() => setTooltip(null)}
                aria-label={`${label}, ${count} 次`}
                aria-pressed={isSelected}
              >
                <span className="kb3d-key-label">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="kb3d-controls">
        <button className="kb3d-btn" onClick={resetView}>
          重置视角
        </button>
      </div>

      {tooltip && <KeyCountTooltip anchor={tooltip} />}
    </div>
  );
}
