/**
 * 键盘渲染器组件
 * 根据项目自有配列（src/assets/layout/ansi-104.json，见 keyboardLayout.ts）渲染键盘热力图。
 * 每个键：code（身份，用于匹配统计）、几何（x/y/w/h）、印字（lower 基准大字 / upper Shift 小字）。
 *
 * 尺寸模型：1U = KEY_UNIT 固定像素，整体缩放交给外层 transform: scale。
 * - .kle-viewport：横向滚动容器（宽配列缩到下限后可滚动）
 * - .kle-scaler：承担缩放后的实际占位（显式写缩放后宽高，margin:0 auto 居中）
 * - .kle-keyboard：原始尺寸绘制，transform: scale 缩放
 */

import { useState, type CSSProperties, type RefObject } from "react";
import type { LayoutKey } from "../keyboardLayout";
import { bucketByPercentile, intensityVar } from "../analytics";
import { KEY_UNIT, KEY_GAP, SCALER_PAD_X, SCALER_PAD_Y } from "../layouts/metrics";
import {
  lookupTiers,
  fitLabel,
  fitSubLabel,
  usableLabelWidth,
  type FittedLabel,
} from "../layouts/labels";
import KeyCountTooltip, { type KeyCountAnchor } from "./keyboard/KeyCountTooltip";
import { useKeySelection } from "./keyboard/KeySelectionContext";

type KLEKeyboardProps = {
  keys: LayoutKey[];
  keyCounts: Record<string, number>;
  allCounts: number[];
  /** 配列总 U 宽（由 LAYOUT_MAX_X 一次算出） */
  maxX: number;
  /** 配列总 U 高（由 LAYOUT_MAX_Y 一次算出） */
  maxY: number;
  /** 缩放系数（由容器宽度换算，默认 1 = 原始尺寸） */
  scale?: number;
  /** 是否允许横向滚动（仅在缩到 MIN_SCALE 仍放不下时由上层置 true） */
  scrollable?: boolean;
  /** 高亮这些键位下标为最高热力（覆盖对应键的 keyCounts，键位测试页用） */
  pressedIndices?: Set<number>;
  /** 外层用于 ResizeObserver 观测的 .kle-viewport 引用 */
  viewportRef?: RefObject<HTMLDivElement | null>;
};

export default function KLEKeyboard({
  keys,
  keyCounts,
  allCounts,
  maxX,
  maxY,
  scale = 1,
  scrollable = false,
  pressedIndices,
  viewportRef,
}: KLEKeyboardProps) {
  // 单键下钻的交互状态经 Context 传入，见 KeySelectionContext.tsx 顶部注释
  const { onKeyClick, selectedIndex } = useKeySelection();

  const layoutWidth = maxX * KEY_UNIT;
  const layoutHeight = maxY * KEY_UNIT;
  // 击键数 tooltip：hover 键时记录标签/次数 + 光标坐标，Portal 挂 body（脱离缩放层）
  const [hovered, setHovered] = useState<KeyCountAnchor | null>(null);

  return (
    <>
    <div
      ref={viewportRef}
      className={`kle-viewport${scrollable ? " kle-viewport--scrollable" : ""}`}
    >
      <div
        className="kle-scaler"
        style={{
          // 用 Math.round 写入整数尺寸，避免非整数宽高引入亚像素抖动。
          // box-sizing 全局为 border-box：显式 width/height 含 padding，故各 +2*SCALER_PAD，
          // 使内容区（承载缩放后键盘）仍恰为 Math.round(layout 尺寸 * scale)。
          width: Math.round(layoutWidth * scale) + SCALER_PAD_X * 2,
          height: Math.round(layoutHeight * scale) + SCALER_PAD_Y * 2,
          // 四周留白容纳键 hover 时向外扩散的 box-shadow，避免被 .kle-viewport 裁切
          paddingLeft: SCALER_PAD_X,
          paddingRight: SCALER_PAD_X,
          paddingTop: SCALER_PAD_Y,
          paddingBottom: SCALER_PAD_Y,
          margin: "0 auto",
        }}
      >
        <div
          className="kle-keyboard"
          style={{
            width: layoutWidth,
            height: layoutHeight,
            position: "relative",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            willChange: "transform",
          }}
        >
          {keys.map((key, index) => {
            // upper 非空 → 双行（上排小字 upper / 下排大字 lower）；否则单行只显示 lower。
            const hasDualLabel = key.upper !== "";

            const pressed = pressedIndices?.has(index);
            const count = pressed ? 1 : (keyCounts[key.code] ?? 0);
            const level = pressed ? 4 : bucketByPercentile(count, allCounts);

            // 计算键位的像素位置和尺寸（扣除间隙）
            const left = key.x * KEY_UNIT;
            const top = key.y * KEY_UNIT;
            const width = key.w * KEY_UNIT - KEY_GAP;
            const height = key.h * KEY_UNIT - KEY_GAP;

            const usable = usableLabelWidth(key.w);
            // 命名键取三级表，裸标签退化为单档（full=abbr=原文）
            const tiersFor = (raw: string) =>
              lookupTiers(raw) ?? { full: raw, abbr: raw };

            // 双行的主标签是 lower（下排基准字符，大字），副标签是 upper（上排 Shift，小字）
            let primaryFit: FittedLabel | null = null;
            let secondaryFit: FittedLabel | null = null;
            if (hasDualLabel) {
              primaryFit = fitLabel(tiersFor(key.lower), usable);
              secondaryFit = fitSubLabel(tiersFor(key.upper), usable);
            } else {
              primaryFit = fitLabel(tiersFor(key.lower), usable);
            }
            const readableLabel = key.lower;

            const clickable = !!onKeyClick;

            const keyStyle: CSSProperties = {
              position: "absolute",
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
              background: intensityVar(level),
              color: level >= 3 ? "#fff" : "var(--color-text-2)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              alignItems: hasDualLabel ? "flex-end" : "center",
              justifyContent: hasDualLabel ? "flex-start" : "center",
              fontWeight: 600,
              letterSpacing: "0.01em",
              cursor: clickable ? "pointer" : "default",
              padding: hasDualLabel ? "4px 6px" : "0",
              backfaceVisibility: "hidden",
              transition:
                "box-shadow var(--dur-fast) var(--ease-smooth), background var(--dur-fast) var(--ease-smooth)",
            };

            const hoverable = count > 0;
            const setTip = (e: React.MouseEvent) =>
              setHovered({ label: readableLabel, count, x: e.clientX, y: e.clientY });

            return (
              <div
                key={key.code}
                className={`kle-key${selectedIndex === index ? " kle-key--selected" : ""}`}
                style={keyStyle}
                aria-label={`${readableLabel}, ${count} 次`}
                onClick={clickable ? () => onKeyClick!(key) : undefined}
                onMouseEnter={hoverable ? setTip : undefined}
                onMouseMove={hoverable ? setTip : undefined}
                onMouseLeave={hoverable ? () => setHovered(null) : undefined}
              >
                {hasDualLabel ? (
                  <div className="kle-key-dual">
                    <span
                      className={`kle-key-sub${secondaryFit!.truncated ? " kle-key-label--truncated" : ""}`}
                      style={{ fontSize: secondaryFit!.fontSize }}
                    >
                      {secondaryFit!.text}
                    </span>
                    <span
                      className={`kle-key-main${primaryFit!.truncated ? " kle-key-label--truncated" : ""}`}
                      style={{ fontSize: primaryFit!.fontSize }}
                    >
                      {primaryFit!.text}
                    </span>
                  </div>
                ) : (
                  <span
                    className={`kle-key-label${primaryFit!.truncated ? " kle-key-label--truncated" : ""}`}
                    style={{ fontSize: primaryFit!.fontSize }}
                  >
                    {primaryFit!.text}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    {hovered && <KeyCountTooltip anchor={hovered} />}
    </>
  );
}
