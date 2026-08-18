/**
 * KLE 键盘渲染器组件
 * 根据 KLE 格式的键位数据渲染键盘热力图。
 *
 * 尺寸模型：1U = KEY_UNIT 固定像素，整体缩放交给外层 transform: scale。
 * - .kle-viewport：横向滚动容器（宽配列缩到下限后可滚动）
 * - .kle-scaler：承担缩放后的实际占位（显式写缩放后宽高，margin:0 auto 居中）
 * - .kle-keyboard：原始尺寸绘制，transform: scale 缩放
 */

import { useState, type CSSProperties, type RefObject } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as solidIcons from "@fortawesome/free-solid-svg-icons";
import type { KLEKey } from "../kleParser";
import { parseLabelParts, extractFAIcon, FA_CLASS_TO_ICON_NAME } from "../kleParser";
import { bucketByPercentile, intensityVar } from "../analytics";
import { KEY_UNIT, KEY_GAP, SCALER_PAD_X } from "../layouts/metrics";
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
  keys: KLEKey[];
  keyCounts: Record<string, number>;
  allCounts: number[];
  /** 配列总 U 宽（由 parseKLE 一次算出） */
  maxX: number;
  /** 配列总 U 高（由 parseKLE 一次算出） */
  maxY: number;
  /** 缩放系数（由容器宽度换算，默认 1 = 原始尺寸） */
  scale?: number;
  /** 是否允许横向滚动（仅在缩到 MIN_SCALE 仍放不下时由上层置 true） */
  scrollable?: boolean;
  /** When provided, highlight these key indices at max intensity (overrides keyCounts for those keys) */
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
  const { onKeyClick, selectedIndex, mergedIndices, keyTitles } = useKeySelection();

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
          // box-sizing 全局为 border-box：显式 width 含 padding，故 +2*SCALER_PAD_X，
          // 使内容区（承载缩放后键盘）仍恰为 Math.round(layoutWidth * scale)。
          width: Math.round(layoutWidth * scale) + SCALER_PAD_X * 2,
          height: Math.round(layoutHeight * scale),
          // 左右留白容纳 hover box-shadow 外扩，避免被 viewport 裁切
          paddingLeft: SCALER_PAD_X,
          paddingRight: SCALER_PAD_X,
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
            const { main, sub } = parseLabelParts(key.label);

            // decal 键：不画键帽背景/边框、不参与热力、不 hover、不显示 tooltip，仅渲染文字
            const pressed = !key.decal && pressedIndices?.has(index);
            const count = key.decal ? 0 : pressed ? 1 : (keyCounts[key.label] ?? 0);
            const level = key.decal ? 0 : pressed ? 4 : bucketByPercentile(count, allCounts);

            // 计算键位的像素位置和尺寸（扣除间隙）
            const left = key.x * KEY_UNIT;
            const top = key.y * KEY_UNIT;
            const width = key.w * KEY_UNIT - KEY_GAP;
            const height = key.h * KEY_UNIT - KEY_GAP;

            // 检查是否有 FA 图标（图标键维持现状，不参与标签降级）
            const faIconClass = extractFAIcon(key.label);
            const hasIcon = faIconClass && FA_CLASS_TO_ICON_NAME[faIconClass];
            const hasDualLabel = !hasIcon && sub && sub.length > 0;

            const usable = usableLabelWidth(key.w);
            // 命名键取三级表，裸标签退化为单档（full=abbr=原文）
            const tiersFor = (raw: string) =>
              lookupTiers(raw) ?? { full: raw, abbr: raw };

            // 主标签（单行=main；双行的主标签是 sub，即 parts[1]，渲染在下方）
            let primaryFit: FittedLabel | null = null;
            let secondaryFit: FittedLabel | null = null;
            if (!hasIcon) {
              if (hasDualLabel) {
                primaryFit = fitLabel(tiersFor(sub!), usable);
                secondaryFit = fitSubLabel(tiersFor(main), usable);
              } else {
                primaryFit = fitLabel(tiersFor(main), usable);
              }
            }
            const readableLabel = hasDualLabel ? sub! : main;

            const isMerged = !key.decal && (mergedIndices?.has(index) ?? false);
            const clickable = !key.decal && !!onKeyClick && !isMerged;

            const keyStyle: CSSProperties = {
              position: "absolute",
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
              background: key.decal ? "transparent" : intensityVar(level),
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

            const hoverable = !key.decal && count > 0;
            const setTip = (e: React.MouseEvent) =>
              setHovered({ label: readableLabel, count, x: e.clientX, y: e.clientY });

            return (
              <div
                key={`${key.row}-${key.col}-${index}`}
                className={`kle-key${key.decal ? " kle-key--decal" : ""}${selectedIndex === index ? " kle-key--selected" : ""}`}
                style={keyStyle}
                aria-label={key.decal ? readableLabel : `${readableLabel}, ${count} 次`}
                title={keyTitles?.[index]}
                onClick={clickable ? () => onKeyClick!(index, key) : undefined}
                onMouseEnter={hoverable ? setTip : undefined}
                onMouseMove={hoverable ? setTip : undefined}
                onMouseLeave={hoverable ? () => setHovered(null) : undefined}
              >
                {hasIcon ? (
                  <span className="kle-key-label">
                    {(() => {
                      const iconName = FA_CLASS_TO_ICON_NAME[faIconClass!];
                      const icon = (solidIcons as any)[iconName];
                      return icon ? <FontAwesomeIcon icon={icon} /> : main;
                    })()}
                  </span>
                ) : hasDualLabel ? (
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
