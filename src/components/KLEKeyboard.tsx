/**
 * KLE 键盘渲染器组件
 * 根据 KLE 格式的键位数据渲染键盘热力图。
 *
 * 尺寸模型：1U = KEY_UNIT 固定像素，整体缩放交给外层 transform: scale。
 * - .kle-viewport：横向滚动容器（宽配列缩到下限后可滚动）
 * - .kle-scaler：承担缩放后的实际占位（显式写缩放后宽高，margin:0 auto 居中）
 * - .kle-keyboard：原始尺寸绘制，transform: scale 缩放
 */

import type { CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as solidIcons from "@fortawesome/free-solid-svg-icons";
import type { KLEKey } from "../kleParser";
import { parseLabelParts, extractFAIcon, FA_CLASS_TO_ICON_NAME } from "../kleParser";
import { bucketByPercentile, intensityVar } from "../analytics";
import { KEY_UNIT, KEY_GAP } from "../layouts/metrics";

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
  /** When provided, highlight these key indices at max intensity (overrides keyCounts for those keys) */
  pressedIndices?: Set<number>;
};

export default function KLEKeyboard({
  keys,
  keyCounts,
  allCounts,
  maxX,
  maxY,
  scale = 1,
  pressedIndices,
}: KLEKeyboardProps) {
  const layoutWidth = maxX * KEY_UNIT;
  const layoutHeight = maxY * KEY_UNIT;

  return (
    <div className="kle-viewport">
      <div
        className="kle-scaler"
        style={{
          width: layoutWidth * scale,
          height: layoutHeight * scale,
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
          }}
        >
          {keys.map((key, index) => {
            const pressed = pressedIndices?.has(index);
            const count = pressed ? 1 : (keyCounts[key.label] ?? 0);
            const level = pressed ? 4 : bucketByPercentile(count, allCounts);
            const { main, sub } = parseLabelParts(key.label);

            // 计算键位的像素位置和尺寸（扣除间隙）
            const left = key.x * KEY_UNIT;
            const top = key.y * KEY_UNIT;
            const width = key.w * KEY_UNIT - KEY_GAP;
            const height = key.h * KEY_UNIT - KEY_GAP;

            // 检查是否有 FA 图标
            const faIconClass = extractFAIcon(key.label);
            const hasIcon = faIconClass && FA_CLASS_TO_ICON_NAME[faIconClass];

            // 检查是否有双字符（主+副）
            const hasDualLabel = !hasIcon && sub && sub.length > 0;

            // 键位样式
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
              fontSize: `${Math.round(KEY_UNIT * (key.w >= 2 ? 0.22 : 0.25))}px`,
              fontWeight: 600,
              letterSpacing: "0.01em",
              cursor: "default",
              overflow: "visible",
              padding: hasDualLabel ? "4px 6px" : "0",
              transition:
                "transform var(--dur-fast) var(--ease-smooth), box-shadow var(--dur-fast) var(--ease-smooth)",
            };

            // 修饰键样式调整
            const isModifier =
              !hasIcon &&
              !hasDualLabel &&
              main.length > 1 &&
              !main.match(/^[A-Z0-9]$/) &&
              !["PgUp", "PgDn", "Home", "End", "Ins", "Del"].includes(main);

            if (isModifier) {
              keyStyle.fontSize = "10px";
              keyStyle.letterSpacing = "0.04em";
              keyStyle.textTransform = "uppercase";
            }

            return (
              <div
                key={`${key.row}-${key.col}-${index}`}
                className="kle-key"
                style={keyStyle}
                aria-label={`${main}, ${count} 次`}
              >
                {hasIcon ? (
                  // 渲染 FA 图标
                  <span className="kle-key-label">
                    {(() => {
                      const iconName = FA_CLASS_TO_ICON_NAME[faIconClass!];
                      const icon = (solidIcons as any)[iconName];
                      return icon ? <FontAwesomeIcon icon={icon} /> : main;
                    })()}
                  </span>
                ) : hasDualLabel ? (
                  // 渲染双字符：main 是 \n 前的顶部副标签，sub 是 \n 后的底部主标签
                  <div className="kle-key-dual">
                    <span className="kle-key-sub">{main}</span>
                    <span className="kle-key-main">{sub}</span>
                  </div>
                ) : (
                  // 渲染单字符
                  <span className="kle-key-label">{main}</span>
                )}
                {count > 0 && (
                  <span className="kle-key-count">
                    {count.toLocaleString()} 次
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
