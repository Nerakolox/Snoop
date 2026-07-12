/**
 * KLE 配列预览图生成器
 * 根据 KLE 数据生成简化的布局预览 SVG
 */

import type { KLEKey } from "../kleParser";

type KLELayoutPreviewProps = {
  keys: KLEKey[];
  width?: number;
  height?: number;
};

export default function KLELayoutPreview({
  keys,
  width = 120,
  height = 48,
}: KLELayoutPreviewProps) {
  if (keys.length === 0) {
    return null;
  }

  // 计算键盘的边界
  const maxX = Math.max(...keys.map((k) => k.x + k.w));
  const maxY = Math.max(...keys.map((k) => k.y + k.h));

  // 缩放比例（让整个键盘适配到指定的宽高）
  const scaleX = width / maxX;
  const scaleY = height / maxY;
  const scale = Math.min(scaleX, scaleY) * 0.95; // 留出 5% 边距

  // 居中偏移
  const offsetX = (width - maxX * scale) / 2;
  const offsetY = (height - maxY * scale) / 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {keys.map((key, index) => {
        const x = key.x * scale + offsetX;
        const y = key.y * scale + offsetY;
        const w = key.w * scale - 1; // 减去间隙
        const h = key.h * scale - 1;

        return (
          <rect
            key={`${key.row}-${key.col}-${index}`}
            x={x}
            y={y}
            width={w}
            height={h}
            rx={1}
            fill="currentColor"
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}
