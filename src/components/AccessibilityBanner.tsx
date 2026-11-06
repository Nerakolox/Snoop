import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "./shared/Toast";
import {
  ACCESSIBILITY_PREVIEW_EVENT,
  type AccessibilityPreviewDetail,
  type AccessibilityStatus,
} from "../accessibility/types";

/**
 * 辅助功能权限常驻横幅（macOS 键鼠采集的先决条件）。
 * 仅在「未授权 / 监听已停止」时显示，已授权则不渲染任何东西。
 * 未授权时提供按钮直接跳系统设置的「辅助功能」页。
 */
export default function AccessibilityBanner() {
  const toast = useToast();
  const [realStatus, setRealStatus] = useState<AccessibilityStatus | null>(null);
  // Dev →「弹窗预览」塞进来的假状态；null 表示按真实状态显示
  const [previewStatus, setPreviewStatus] = useState<AccessibilityStatus | null>(null);

  useEffect(() => {
    let disposed = false;

    // 启动时主动查一次，避免错过后端线程启动前就推送的状态
    invoke<AccessibilityStatus>("get_accessibility_status")
      .then((s) => {
        if (!disposed) setRealStatus(s);
      })
      .catch(() => {});

    // 后端在「未授权 / 授权 / 监听停止」时推送，实时驱动横幅显隐
    const unlistenPromise = listen<AccessibilityStatus>(
      "accessibility-permission",
      ({ payload }) => {
        setRealStatus(payload);
      },
    );

    return () => {
      disposed = true;
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  // 开发预览：detail 为 null 时退出预览并重新向后端查询真实状态
  useEffect(() => {
    let disposed = false;

    function onPreview(event: Event) {
      const { detail } = event as CustomEvent<AccessibilityPreviewDetail>;
      if (detail) {
        setPreviewStatus(detail);
        return;
      }
      setPreviewStatus(null);
      invoke<AccessibilityStatus>("get_accessibility_status")
        .then((s) => {
          if (!disposed) setRealStatus(s);
        })
        .catch(() => {});
    }

    window.addEventListener(ACCESSIBILITY_PREVIEW_EVENT, onPreview);
    return () => {
      disposed = true;
      window.removeEventListener(ACCESSIBILITY_PREVIEW_EVENT, onPreview);
    };
  }, []);

  async function handleOpenSettings() {
    try {
      await invoke("open_accessibility_settings");
    } catch {
      toast.show({
        message: "无法打开系统设置，请手动在「系统设置 › 隐私与安全性」中找到 Snoop 并授权",
      });
    }
  }

  const status = previewStatus ?? realStatus;

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
          onClick={handleOpenSettings}
        >
          前往授权
        </button>
      )}
    </div>
  );
}
