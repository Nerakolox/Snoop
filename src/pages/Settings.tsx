import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import {
  Sun, Moon, Monitor, Power, Minimize2,
  Download, Trash2, RefreshCw, Plus, X, ExternalLink, Code,
} from "lucide-react";
import { resetAppIconCache } from "../components/AppIcon";

type ThemeMode = "system" | "light" | "dark";
type CloseMode = "tray" | "quit";
type SnarkyLevel = "mild" | "normal" | "savage";

interface AppSettings {
  collection_paused: boolean;
  ignore_list: string[];
  close_to_tray: boolean;
}

interface DbInfo {
  path: string;
  size_bytes: number;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function SettingRow({
  label, desc, children,
}: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-left">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <div className="setting-row-right">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`setting-toggle${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="setting-toggle-thumb" />
    </button>
  );
}

function SegmentedControl<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string; icon?: React.ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="setting-segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={`setting-seg-btn${value === o.value ? " is-active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span className="setting-seg-icon">{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>({
    collection_paused: false,
    ignore_list: [],
    close_to_tray: true,
  });
  const [theme, setTheme] = useState<ThemeMode>(() =>
    (localStorage.getItem("theme") as ThemeMode) ?? "system"
  );
  const [snarky, setSnarky] = useState<SnarkyLevel>(() =>
    (localStorage.getItem("snarky") as SnarkyLevel) ?? "normal"
  );
  const [catEnabled, setCatEnabled] = useState(() =>
    localStorage.getItem("cat_enabled") !== "false"
  );
  const [devMode, setDevMode] = useState(() =>
    localStorage.getItem("dev_mode") === "true"
  );
  const [pageTransition, setPageTransition] = useState(() =>
    localStorage.getItem("page_transition_enabled") !== "false"
  );
  const [showDevConfirm, setShowDevConfirm] = useState(false);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [newApp, setNewApp] = useState("");
  const [recentApps, setRecentApps] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearMsg, setClearMsg] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartMsg, setAutostartMsg] = useState("");
  const [iconRefreshState, setIconRefreshState] = useState<
    | { status: "idle" }
    | { status: "running"; done: number; total: number }
    | { status: "done"; count: number }
  >({ status: "idle" });

  useEffect(() => {
    invoke<AppSettings>("get_settings").then(setSettings).catch(console.error);
    invoke<DbInfo>("get_db_info").then(setDbInfo).catch(console.error);
    invoke<string[]>("get_recent_apps").then(setRecentApps).catch(console.error);
    // 以系统实际注册状态为准显示开关初始值，避免本地布尔和真实注册项漂移
    isAutostartEnabled().then(setAutostart).catch(console.error);

    // 监听系统主题变化（仅当用户选择"跟随系统"时生效）
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      const savedTheme = localStorage.getItem("theme") as ThemeMode;
      if (savedTheme === "system") {
        applyTheme("system");
      }
    };
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  function applyTheme(t: ThemeMode) {
    setTheme(t);
    localStorage.setItem("theme", t);
    const root = document.documentElement;

    if (t === "system") {
      // 跟随系统：读取系统 prefers-color-scheme 并设置对应的 data-theme
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", isDark ? "dark" : "light");
    } else {
      // 手动选择：直接设置 data-theme
      root.setAttribute("data-theme", t);
    }
  }

  function saveSettings(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    invoke("save_settings", { settings: next }).catch(console.error);
  }

  function saveCat(v: boolean) {
    setCatEnabled(v);
    localStorage.setItem("cat_enabled", String(v));
  }

  function saveSnarky(v: SnarkyLevel) {
    setSnarky(v);
    localStorage.setItem("snarky", v);
  }

  async function toggleAutostart(v: boolean) {
    if (autostartBusy) return;
    setAutostartBusy(true);
    setAutostartMsg("");
    // 乐观更新，失败再回滚，避免开关点击后没反馈
    setAutostart(v);
    try {
      if (v) await enableAutostart();
      else await disableAutostart();
      // 以插件回读为准，防止系统层拒写导致状态漂移
      const actual = await isAutostartEnabled();
      setAutostart(actual);
      setAutostartMsg(actual === v ? (v ? "已开启" : "已关闭") : "状态与预期不符");
    } catch (e) {
      console.error(e);
      setAutostart(!v);
      setAutostartMsg("操作失败");
    } finally {
      setAutostartBusy(false);
      window.setTimeout(() => setAutostartMsg(""), 2000);
    }
  }

  function savePageTransition(v: boolean) {
    setPageTransition(v);
    localStorage.setItem("page_transition_enabled", String(v));
    window.dispatchEvent(new CustomEvent("page-transition-change", { detail: v }));
  }

  function toggleDevMode(v: boolean) {
    if (v && !devMode) {
      // 开启开发模式：显示确认弹窗
      setShowDevConfirm(true);
    } else {
      // 关闭开发模式：直接关
      setDevMode(false);
      localStorage.setItem("dev_mode", "false");
      window.dispatchEvent(new CustomEvent("dev-mode-change", { detail: false }));
    }
  }

  function confirmDevMode() {
    setDevMode(true);
    localStorage.setItem("dev_mode", "true");
    setShowDevConfirm(false);
    window.dispatchEvent(new CustomEvent("dev-mode-change", { detail: true }));
  }

  function cancelDevMode() {
    setShowDevConfirm(false);
  }

  function addIgnore(app: string) {
    const trimmed = app.trim();
    if (!trimmed || settings.ignore_list.includes(trimmed)) return;
    saveSettings({ ignore_list: [...settings.ignore_list, trimmed] });
    setNewApp("");
  }

  function removeIgnore(app: string) {
    saveSettings({ ignore_list: settings.ignore_list.filter((a) => a !== app) });
  }

  async function handleExport() {
    try {
      const rows = await invoke<any[]>("export_data", { startMs: null, endMs: null });
      const json = JSON.stringify(rows, null, 2);
      const path = await save({ defaultPath: "snoop-export.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        await writeTextFile(path, json);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function handleClear() {
    if (!confirmClear) { setConfirmClear(true); return; }
    try {
      const n = await invoke<number>("clear_data", { range: { start_ms: null, end_ms: null } });
      setClearMsg(`已清除 ${n} 条记录`);
      setConfirmClear(false);
      invoke<DbInfo>("get_db_info").then(setDbInfo);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleRefreshIcons() {
    if (iconRefreshState.status === "running") return;
    try {
      await invoke("clear_icon_cache");
      resetAppIconCache();
      const bundleIds = await invoke<string[]>("list_all_bundle_ids");
      const total = bundleIds.length;
      if (total === 0) {
        setIconRefreshState({ status: "done", count: 0 });
        return;
      }
      setIconRefreshState({ status: "running", done: 0, total });

      let done = 0;
      let extracted = 0;
      const CONCURRENCY = 4;
      let cursor = 0;

      async function worker() {
        while (cursor < bundleIds.length) {
          const idx = cursor++;
          const bid = bundleIds[idx];
          try {
            const res = await invoke<string | null>("get_app_icon", { bundleId: bid });
            if (res) extracted++;
          } catch (e) {
            console.warn("refresh icon failed:", bid, e);
          }
          done++;
          setIconRefreshState({ status: "running", done, total });
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
      );

      // 后端已重建，让前端组件重新拉一遍以更新 UI
      resetAppIconCache();
      setIconRefreshState({ status: "done", count: extracted });
    } catch (e) {
      console.error(e);
      setIconRefreshState({ status: "idle" });
    }
  }

  const version = "0.1.0";

  return (
    <div className="settings-page">

      <div className="settings-group">
        <div className="settings-group-title">通用</div>

        <SettingRow label="外观" desc="深浅色模式">
          <SegmentedControl<ThemeMode>
            value={theme}
            onChange={applyTheme}
            options={[
              { value: "system", label: "跟随系统", icon: <Monitor size={13} /> },
              { value: "light", label: "浅色", icon: <Sun size={13} /> },
              { value: "dark", label: "深色", icon: <Moon size={13} /> },
            ]}
          />
        </SettingRow>

        <SettingRow label="开机自启" desc="开机时自动在后台启动 Snoop，不弹出主窗口">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {autostartMsg && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-3)" }}>
                {autostartMsg}
              </span>
            )}
            <Toggle checked={autostart} onChange={toggleAutostart} />
          </div>
        </SettingRow>

        <SettingRow label="关闭按钮行为" desc="点击窗口关闭按钮时的动作">
          <SegmentedControl<CloseMode>
            value={settings.close_to_tray ? "tray" : "quit"}
            onChange={(v) => saveSettings({ close_to_tray: v === "tray" })}
            options={[
              { value: "tray", label: "缩到托盘", icon: <Minimize2 size={13} /> },
              { value: "quit", label: "直接退出", icon: <Power size={13} /> },
            ]}
          />
        </SettingRow>

        <SettingRow label="页面切换动画" desc="切换页面时的淡入过渡；系统开启减少动态效果时自动禁用">
          <Toggle checked={pageTransition} onChange={savePageTransition} />
        </SettingRow>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">采集</div>

        <SettingRow label="采集开关" desc="暂停后停止记录键鼠和 App 活动">
          <Toggle
            checked={!settings.collection_paused}
            onChange={(v) => saveSettings({ collection_paused: !v })}
          />
        </SettingRow>

        <SettingRow label="忽略名单" desc="列表内的 App 不被记录">
          <div className="setting-ignore-list">
            {settings.ignore_list.map((app) => (
              <span key={app} className="setting-ignore-tag">
                {app}
                <button className="setting-ignore-remove" onClick={() => removeIgnore(app)}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <div className="setting-ignore-add">
              <input
                className="setting-ignore-input"
                placeholder="App 名或 bundle id"
                value={newApp}
                onChange={(e) => setNewApp(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addIgnore(newApp)}
                list="recent-apps"
              />
              <datalist id="recent-apps">
                {recentApps.map((a) => <option key={a} value={a} />)}
              </datalist>
              <button className="setting-ignore-btn" onClick={() => addIgnore(newApp)}>
                <Plus size={13} />
              </button>
            </div>
          </div>
        </SettingRow>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">猫</div>

        <SettingRow label="吐槽开关" desc="关闭后各页面不显示猫的吐槽">
          <Toggle checked={catEnabled} onChange={saveCat} />
        </SettingRow>

        <SettingRow label="毒舌程度" desc="影响吐槽文案的风格">
          <SegmentedControl<SnarkyLevel>
            value={snarky}
            onChange={saveSnarky}
            options={[
              { value: "mild", label: "温和" },
              { value: "normal", label: "正常" },
              { value: "savage", label: "毒舌" },
            ]}
          />
        </SettingRow>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">数据</div>

        {dbInfo && (
          <SettingRow label="存储信息">
            <div className="setting-db-info">
              <span className="setting-db-path">{dbInfo.path}</span>
              <span className="setting-db-size">{formatBytes(dbInfo.size_bytes)}</span>
            </div>
          </SettingRow>
        )}

        <SettingRow label="导出数据" desc="导出全部记录为 JSON">
          <button className="setting-btn" onClick={handleExport}>
            <Download size={13} />
            导出
          </button>
        </SettingRow>

        <SettingRow label="清除数据" desc="删除全部采集记录，不可恢复">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {clearMsg && <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-3)" }}>{clearMsg}</span>}
            {confirmClear && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--intensity-4)" }}>确认清除全部数据？</span>
            )}
            <button
              className={`setting-btn setting-btn-danger${confirmClear ? " is-confirm" : ""}`}
              onClick={handleClear}
            >
              <Trash2 size={13} />
              {confirmClear ? "确认清除" : "清除数据"}
            </button>
            {confirmClear && (
              <button className="setting-btn" onClick={() => setConfirmClear(false)}>取消</button>
            )}
          </div>
        </SettingRow>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">开发者</div>

        <SettingRow label="开发模式" desc="显示原始数据、键盘映射测试等调试功能">
          <Toggle checked={devMode} onChange={toggleDevMode} />
        </SettingRow>

        {devMode && (
          <SettingRow
            label="刷新 App 图标"
            desc="清空图标缓存并重新提取所有 App 的图标"
          >
            <div className="setting-row-actions">
              {iconRefreshState.status === "done" && (
                <span className="setting-hint">已刷新 {iconRefreshState.count} 个图标</span>
              )}
              <button
                className="setting-btn"
                onClick={handleRefreshIcons}
                disabled={iconRefreshState.status === "running"}
              >
                <RefreshCw
                  size={13}
                  className={iconRefreshState.status === "running" ? "is-spin" : ""}
                />
                {iconRefreshState.status === "running"
                  ? `正在刷新… ${iconRefreshState.done}/${iconRefreshState.total}`
                  : "刷新"}
              </button>
            </div>
          </SettingRow>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title">关于</div>

        <SettingRow label="版本">
          <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-2)", fontVariantNumeric: "tabular-nums" }}>
            v{version}
          </span>
        </SettingRow>

        <SettingRow label="开源仓库">
          <button
            className="setting-btn"
            onClick={() => openUrl("https://github.com/Nerakolox/Snoop")}
          >
            <ExternalLink size={13} />
            GitHub
          </button>
        </SettingRow>

        <SettingRow label="检查更新" desc="当前已是最新版本">
          <button className="setting-btn" disabled>
            <RefreshCw size={13} />
            检查更新
          </button>
        </SettingRow>
      </div>

      {showDevConfirm && createPortal(
        <div className="dev-confirm-overlay" onClick={cancelDevMode}>
          <div className="dev-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dev-confirm-header">
              <Code size={20} />
              <h3>开启开发者模式</h3>
            </div>
            <p className="dev-confirm-desc">
              这是面向开发者的调试功能，包含原始数据表格、键盘映射测试等技术信息。
              这些功能可能显示未加工的底层数据，仅供开发和调试使用。
            </p>
            <div className="dev-confirm-actions">
              <button className="setting-btn" onClick={cancelDevMode}>取消</button>
              <button className="setting-btn setting-btn-primary" onClick={confirmDevMode}>
                确认开启
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
