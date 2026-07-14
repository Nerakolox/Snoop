import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  bundleId: string;
  appName: string;
  size?: number;
  className?: string;
};

// 全局图标缓存，避免重复请求
const iconCache = new Map<string, string | null>();

// 缓存 reset 事件：AppIcon 组件监听后重新 invoke
const RESET_EVENT = "app-icon-cache-reset";

/** 清空前端 iconCache 并通知所有渲染中的 AppIcon 重新拉取（后端缓存另行清空）。 */
export function resetAppIconCache() {
  iconCache.clear();
  window.dispatchEvent(new CustomEvent(RESET_EVENT));
}

export default function AppIcon({ bundleId, appName, size = 20, className = "" }: Props) {
  const [iconData, setIconData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onReset = () => setTick((t) => t + 1);
    window.addEventListener(RESET_EVENT, onReset);
    return () => window.removeEventListener(RESET_EVENT, onReset);
  }, []);

  useEffect(() => {
    // 检查缓存
    if (iconCache.has(bundleId)) {
      setIconData(iconCache.get(bundleId) || null);
      setLoading(false);
      return;
    }

    setLoading(true);

    // 异步获取图标
    invoke<string | null>("get_app_icon", { bundleId })
      .then((base64) => {
        iconCache.set(bundleId, base64 || null);
        setIconData(base64 || null);
      })
      .catch((err) => {
        console.warn(`Failed to get icon for ${bundleId}:`, err);
        iconCache.set(bundleId, null);
        setIconData(null);
      })
      .finally(() => setLoading(false));
  }, [bundleId, tick]);

  // 提取 App 名首字母作兜底
  const firstLetter = appName.charAt(0).toUpperCase() || "?";

  // 为首字母占位生成主题色
  const colorFromName = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 60%, 55%)`;
  };

  if (loading) {
    // 加载中占位：灰色圆角块
    return (
      <div
        className={`app-icon-placeholder ${className}`}
        style={{
          width: size,
          height: size,
          backgroundColor: "var(--color-border)",
          borderRadius: "20%",
        }}
      />
    );
  }

  if (iconData) {
    // 显示真实图标
    return (
      <img
        src={`data:image/png;base64,${iconData}`}
        alt={appName}
        className={`app-icon ${className}`}
        style={{
          width: size,
          height: size,
          borderRadius: "20%",
          objectFit: "contain",
        }}
      />
    );
  }

  // 兜底：首字母 + 主题色圆角块
  return (
    <div
      className={`app-icon-fallback ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: colorFromName(appName),
        borderRadius: "20%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontSize: size * 0.5,
        fontWeight: 600,
        userSelect: "none",
      }}
    >
      {firstLetter}
    </div>
  );
}
