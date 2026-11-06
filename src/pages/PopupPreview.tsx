/**
 * Dev · 弹窗预览
 *
 * 只在开发模式（侧栏「开发」分组）出现。两个弹层平时都要等真实事件才会露面：
 * 更新日志要等「版本变了」，更新提示要等后端静默下载完，辅助功能横幅要等真实
 * 权限状态变化。做版式时不想为了看一眼去改 latest.json / 重装 / 拔权限，所以
 * 在这里放几个按钮直接触发。
 *
 * 这里只做「展示」，不改任何业务状态；「清除升级 / 已读记录」是例外，
 * 它明确会动 localStorage，方便重启后验证真实的自动弹窗路径。
 */

import { useState } from "react";
import PageShell from "../components/PageShell";
import { useChangelogDialog } from "../components/changelog/ChangelogProvider";
import { UPDATE_PREVIEW_EVENT, type UpdateState } from "../updater/types";
import {
  ACCESSIBILITY_PREVIEW_EVENT,
  type AccessibilityPreviewDetail,
} from "../accessibility/types";

/** 用一个一眼假的版本号，免得截图时被误认成真实版本。 */
const PREVIEW_VERSION = "9.9.9";
const PREVIEW_URL = "https://github.com/Nerakolox/Snoop/releases";

export default function PopupPreview() {
  const { previewUpgrade, open: openChangelog } = useChangelogDialog();
  const [hint, setHint] = useState<string | null>(null);

  function showUpdate(kind: "ready" | "manual_download") {
    const detail: UpdateState =
      kind === "ready"
        ? { status: "ready", version: PREVIEW_VERSION }
        : { status: "manual_download", version: PREVIEW_VERSION, url: PREVIEW_URL };
    window.dispatchEvent(new CustomEvent(UPDATE_PREVIEW_EVENT, { detail }));
    setHint(
      kind === "ready"
        ? "1.2 秒后出现「新版本已就绪」提示。"
        : "1.2 秒后出现「发现新版本」提示（macOS 分支）。",
    );
  }

  function previewAccessibility(detail: AccessibilityPreviewDetail, label: string) {
    window.dispatchEvent(new CustomEvent(ACCESSIBILITY_PREVIEW_EVENT, { detail }));
    setHint(label);
  }

  function resetUpgradeRecord() {
    try {
      localStorage.removeItem("snoop.app.lastRunVersion");
      localStorage.removeItem("snoop.changelog.seen");
    } catch {
      // 隐私模式等写不进去，不影响预览
    }
    setHint("已清除升级 / 已读记录。重启应用后会按「刚升级」逻辑自动弹一次更新日志。");
  }

  return (
    <PageShell
      className="dev-page"
      header={
        <div className="dev-header">
          <h2>Dev · 弹窗预览</h2>
        </div>
      }
    >
      <p className="dev-note">
        这里手动触发两个全局弹层，方便核对版式与动效。真实触发条件分别是
        「升级后首次启动」和「后端发现并下载完新版本」。
      </p>

      <section className="dev-section">
        <h3>升级后自动弹一次（更新日志）</h3>
        <p className="dev-note">
          复用更新日志弹窗，但只展示刚安装的这一版。启动后延迟 1.4 秒出现；
          点下面的按钮会先关掉已有弹窗，再完整走一遍这段延迟。
        </p>
        <div className="dev-actions">
          <button className="dev-action-btn" onClick={previewUpgrade}>
            模拟升级弹窗（延迟 1.4 秒）
          </button>
          <button className="dev-action-btn" onClick={openChangelog}>
            打开完整更新日志
          </button>
          <button className="dev-action-btn" onClick={resetUpgradeRecord}>
            清除升级 / 已读记录
          </button>
        </div>
      </section>

      <section className="dev-section">
        <h3>更新提示弹窗</h3>
        <p className="dev-note">
          Windows 分支在安装包下好并校验完成后出现；macOS 只能引导去下载页。
          预览里点「重启并安装」会真的调用安装命令，没有待安装包时会显示错误，
          这是预期行为，不是预览坏了。
        </p>
        <div className="dev-actions">
          <button className="dev-action-btn" onClick={() => showUpdate("ready")}>
            Windows · 新版本已就绪
          </button>
          <button className="dev-action-btn" onClick={() => showUpdate("manual_download")}>
            macOS · 发现新版本
          </button>
        </div>
      </section>

      <section className="dev-section">
        <h3>辅助功能权限横幅</h3>
        <p className="dev-note">
          横幅固定在顶栏下方，是全局组件。这里只改前端显示状态；「前往授权」会真实调用后端
          跳转命令，可用来验证不同 macOS 版本的落地页。非 macOS 上点它会走错误提示。
        </p>
        <div className="dev-actions">
          <button
            className="dev-action-btn"
            onClick={() =>
              previewAccessibility(
                { granted: false, reason: "untrusted" },
                "横幅显示「未获得辅助功能权限」，「前往授权」按钮会真实跳转。",
              )
            }
          >
            模拟未授权
          </button>
          <button
            className="dev-action-btn"
            onClick={() =>
              previewAccessibility(
                { granted: false, reason: "listener_stopped" },
                "横幅显示「键鼠监听已停止」，不出现授权按钮。",
              )
            }
          >
            模拟监听已停止
          </button>
          <button
            className="dev-action-btn"
            onClick={() =>
              previewAccessibility(
                { granted: true, reason: "granted" },
                "横幅已隐藏 —— 预览「已授权」时横幅消失是预期。",
              )
            }
          >
            模拟已授权（隐藏横幅）
          </button>
          <button
            className="dev-action-btn"
            onClick={() =>
              previewAccessibility(
                null,
                "已退出预览，横幅按真实权限状态显示（会重新向后端查询一次）。",
              )
            }
          >
            恢复真实状态
          </button>
        </div>
      </section>

      {hint && <p className="dev-hint">{hint}</p>}
    </PageShell>
  );
}
