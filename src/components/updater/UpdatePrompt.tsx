/**
 * 全局更新提示弹窗。
 *
 * 后端启动 3 秒后会静默检查并限速下载新版，过程中只通过 `updater://state`
 * 广播状态。设置页里已经有一条「检查更新」行，但用户不一定会去设置里看，
 * 所以这里在状态到达 `ready`（Windows，安装包已下好）或 `manual_download`
 * （macOS，只能引导去下载页）时主动弹一次。
 *
 * 刻意不做的事：
 * - 不自己轮询，也不重复请求 latest.json，状态完全以后端为准；
 * - 不在 downloading 阶段弹窗，后台下载本来就该无感；
 * - 「稍后」只在本会话内记住，下次启动若仍未更新会再提醒一次。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { UPDATE_PREVIEW_EVENT, type UpdateState } from "../../updater/types";

/** 状态到达后延迟多久露面：和启动时的其它弹层错开，别抢首屏。 */
const REVEAL_DELAY_MS = 1200;

type ActionableState = Extract<
  UpdateState,
  { status: "ready" | "manual_download" }
>;

function isActionable(state: UpdateState): state is ActionableState {
  return state.status === "ready" || state.status === "manual_download";
}

export default function UpdatePrompt() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  // 只记在内存里：这是「这次先别烦我」，不是永久忽略
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // 订阅后端推送，并补读一次当前状态：关闭设置页不会漏掉已经就绪的更新
  useEffect(() => {
    let alive = true;
    invoke<UpdateState>("get_update_state")
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        // 开发环境 / 非 Tauri 环境没有这个命令，静默即可
      });
    const unlisten = listen<UpdateState>("updater://state", (e) => {
      if (alive) setState(e.payload);
    });
    return () => {
      alive = false;
      void unlisten.then((u) => u()).catch(() => {});
    };
  }, []);

  // 开发预览：Dev →「弹窗预览」会把假状态从这里塞进来。
  // 事件名刻意取得长，正常使用中不可能误触；不额外加环境判断，
  // 让开了 dev_mode 的打包版本也能预览。
  useEffect(() => {
    const onPreview = (e: Event) => {
      const detail = (e as CustomEvent<UpdateState>).detail;
      if (!detail || typeof detail !== "object") return;
      setDismissedVersion(null);
      setVisible(false);
      setState(detail);
    };
    window.addEventListener(UPDATE_PREVIEW_EVENT, onPreview);
    return () => window.removeEventListener(UPDATE_PREVIEW_EVENT, onPreview);
  }, []);

  const actionable = isActionable(state) ? state : null;

  const dismiss = useCallback(() => {
    if (actionable) setDismissedVersion(actionable.version);
    setVisible(false);
  }, [actionable]);

  // 延迟露面；同一版本被「稍后」掉后不再弹，直到出现更新的版本
  useEffect(() => {
    if (!actionable || dismissedVersion === actionable.version) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [actionable, dismissedVersion]);

  // Esc 关闭 + 焦点接管（与更新日志弹窗保持同一套行为）
  useEffect(() => {
    if (!visible) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  async function handlePrimary() {
    if (!actionable || busy) return;
    setBusy(true);
    setError("");
    try {
      if (actionable.status === "ready") {
        // Windows：拉起 pending installer，成功后进程由 NSIS 接管重启
        await invoke("install_pending_update");
      } else {
        await openUrl(actionable.url);
        dismiss();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!visible || !actionable) return null;

  const isReady = actionable.status === "ready";

  return createPortal(
    <div className="update-prompt-overlay" onClick={dismiss}>
      <div
        ref={dialogRef}
        className="update-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-prompt-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="update-prompt-close"
          onClick={dismiss}
          aria-label="关闭"
        >
          <X size={16} strokeWidth={1.8} />
        </button>

        <div className="update-prompt-icon" aria-hidden>
          <RefreshCw size={18} strokeWidth={1.9} />
        </div>

        <h2 id="update-prompt-title" className="update-prompt-title">
          {isReady ? "新版本已就绪" : `发现新版本 v${actionable.version}`}
        </h2>
        <p className="update-prompt-desc">
          {isReady
            ? `v${actionable.version} 已在后台下载并校验完成，重启 Snoop 即可用上新版；选择「稍后」则下次启动时自动安装。`
            : `v${actionable.version} 已经发布，打开下载页获取安装包。`}
        </p>

        {error && <p className="update-prompt-error">{error}</p>}

        <div className="update-prompt-actions">
          <button
            type="button"
            className="update-prompt-btn"
            onClick={dismiss}
            disabled={busy}
          >
            稍后
          </button>
          <button
            type="button"
            className="update-prompt-btn is-primary"
            onClick={() => void handlePrimary()}
            disabled={busy}
          >
            {isReady ? (
              <RefreshCw size={13} className={busy ? "is-spin" : ""} />
            ) : (
              <ExternalLink size={13} />
            )}
            {isReady ? (busy ? "正在重启…" : "重启并安装") : "打开下载页"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
