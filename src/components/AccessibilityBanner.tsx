import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type Payload = { granted: boolean; reason: string };

const ACCESSIBILITY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/**
 * 辅助功能权限常驻横幅（macOS 键鼠采集的先决条件）。
 * 仅在「未授权 / 监听已停止」时显示，已授权则不渲染任何东西。
 * 未授权时提供按钮直接跳系统设置的「辅助功能」页。
 */
export default function AccessibilityBanner() {
  const [status, setStatus] = useState<Payload | null>(null);

  useEffect(() => {
    let disposed = false;

    // 启动时主动查一次，避免错过后端线程启动前就推送的状态
    invoke<Payload>("get_accessibility_status")
      .then((s) => {
        if (!disposed) setStatus(s);
      })
      .catch(() => {});

    // 后端在「未授权 / 授权 / 监听停止」时推送，实时驱动横幅显隐
    const unlistenPromise = listen<Payload>("accessibility-permission", ({ payload }) => {
      setStatus(payload);
    });

    return () => {
      disposed = true;
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  // 已授权（或还没收到状态）时不显示
  if (!status || status.granted) return null;

  const isUntrusted = status.reason === "untrusted";

  return (
    <div className="accessibility-banner" role="alert">
      <div className="accessibility-banner__text">
        <strong>{isUntrusted ? "未获得辅助功能权限" : "键鼠监听已停止"}</strong>
        <span>
          {isUntrusted
            ? "键鼠输入无法记录 —— 授权后会自动开始采集，无需重启应用。"
            : "输入监听意外退出，键鼠数据已停止记录。"}
        </span>
      </div>
      {isUntrusted && (
        <button
          type="button"
          className="accessibility-banner__button"
          onClick={() => openUrl(ACCESSIBILITY_URL)}
        >
          前往授权
        </button>
      )}
    </div>
  );
}
