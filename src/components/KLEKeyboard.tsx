/**
 * KLE 键盘渲染器组件
 * 根据 KLE 格式的键位数据渲染键盘热力图
 */

import type { CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as solidIcons from "@fortawesome/free-solid-svg-icons";
import type { KLEKey } from "../kleParser";
import { parseLabelParts, extractFAIcon, FA_CLASS_TO_ICON_NAME } from "../kleParser";

type Intensity = 0 | 1 | 2 | 3 | 4;

type KLEKeyboardProps = {
  keys: KLEKey[];
  keyCounts: Record<string, number>;
  allCounts: number[];
  unitSize?: number;
  /** When provided, highlight these key indices at max intensity (overrides keyCounts for those keys) */
  pressedIndices?: Set<number>;
};

/**
 * 按分位数分档，避免极值压垮
 */
function bucketByPercentile(n: number, allCounts: number[]): Intensity {
  if (n <= 0) return 0;
  const nonZero = allCounts.filter((c) => c > 0);
  if (nonZero.length === 0) return 0;

  const sorted = [...nonZero].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  const p40 = sorted[Math.floor(sorted.length * 0.4)];
  const p60 = sorted[Math.floor(sorted.length * 0.6)];
  const p80 = sorted[Math.floor(sorted.length * 0.8)];

  if (n >= p80) return 4;
  if (n >= p60) return 3;
  if (n >= p40) return 2;
  if (n >= p20) return 1;
  return 1;
}

function intensityVar(level: Intensity) {
  return `var(--intensity-${level})`;
}

export default function KLEKeyboard({
  keys,
  keyCounts,
  allCounts,
  unitSize = 48,
  pressedIndices,
}: KLEKeyboardProps) {
  // 计算键盘整体尺寸
  const maxX = Math.max(...keys.map((k) => k.x + k.w));
  const maxY = Math.max(...keys.map((k) => k.y + k.h));

  const containerWidth = maxX * unitSize;
  const containerHeight = maxY * unitSize;

  // 键间隙（像素）
  const gap = 6;

  return (
    <div
      className="kle-keyboard"
      style={{
        width: containerWidth,
        height: containerHeight,
        position: "relative",
      }}
    >
      {keys.map((key, index) => {
        const pressed = pressedIndices?.has(index);
        const count = pressed ? 1 : (keyCounts[key.label] ?? 0);
        const level = pressed ? 4 : bucketByPercentile(count, allCounts);
        const { main, sub } = parseLabelParts(key.label);

        // 计算键位的像素位置和尺寸（扣除间隙）
        const left = key.x * unitSize;
        const top = key.y * unitSize;
        const width = key.w * unitSize - gap;
        const height = key.h * unitSize - gap;

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
          fontSize: `${Math.round(unitSize * (key.w >= 2 ? 0.22 : 0.25))}px`,
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
              // 渲染双字符（主+副）
              <div className="kle-key-dual">
                <span className="kle-key-sub">{sub}</span>
                <span className="kle-key-main">{main}</span>
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
  );
}
