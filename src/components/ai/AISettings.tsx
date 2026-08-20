// AI 设置区块 —— 服务配置 / 数据层级 / 功能开关 / 发送记录。
//
// 全部交互走后端 Rust 命令；API Key 明文只在本地输入框短暂存在，
// 保存即进 OS 原生加密存储，前端拿到的只有 `has_key` 布尔。

import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  KeyRound,
  PlugZap,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  AlertTriangle,
  Server,
  Send,
  Sparkles,
  Tag,
} from "lucide-react";
import {
  getAiConfig,
  saveAiConfig,
  setAiApiKey,
  getAiFeatures,
  testAiConnection,
  queryAiAudit,
  exportAiAudit,
  clearAiAudit,
  classifyApps,
  getClassifyStatus,
} from "../../ai/client";
import type { AiConfigView, AuditRecord, ClassifyStatus, FeatureDecl, Tier } from "../../ai/types";

const TIER_ORDER: Tier[] = ["T0", "T1", "T2", "T3"];

function tierAtLeast(a: Tier, b: Tier): boolean {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b);
}

const TIER_META: Record<"T0" | "T1" | "T2", { name: string; desc: string }> = {
  T0: { name: "T0 · 不调 AI", desc: "全部走本地模板，不发任何请求" },
  T1: { name: "T1 · 仅数字", desc: "只发时长 / 次数等统计，应用用代号表示" },
  T2: { name: "T2 · 数字 + 应用名", desc: "在 T1 基础上发送真实应用名" },
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AISettings() {
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [features, setFeatures] = useState<FeatureDecl[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [auditMsg, setAuditMsg] = useState("");

  // 服务配置的表单草稿（base_url / model 受控，blur 时落库）
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [testState, setTestState] = useState<
    { status: "idle" } | { status: "testing" } | { status: "done"; ok: boolean; message: string }
  >({ status: "idle" });

  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmClearAudit, setConfirmClearAudit] = useState(false);

  // 应用分类：队列状态 + 「立即分类」按钮
  const [classify, setClassify] = useState<ClassifyStatus | null>(null);
  const [classifyMsg, setClassifyMsg] = useState("");
  const [classifying, setClassifying] = useState(false);

  const featureLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of features) m.set(f.id, f.label);
    m.set("ai.test-connection", "测试连接");
    return m;
  }, [features]);

  async function reloadAudit() {
    try {
      setAudit(await queryAiAudit(100));
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    getAiConfig()
      .then((c) => {
        setConfig(c);
        setBaseUrl(c.base_url);
        setModel(c.model);
      })
      .catch(console.error);
    getAiFeatures().then(setFeatures).catch(console.error);
    getClassifyStatus().then(setClassify).catch(console.error);
    reloadAudit();
  }, []);

  const configured = !!(config && config.has_key && config.model.trim());

  function persist(patch: Partial<AiConfigView>) {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    const { has_key: _hk, ...cfg } = next;
    saveAiConfig(cfg).catch(console.error);
  }

  function commitService() {
    if (!config) return;
    const base = baseUrl.trim();
    const m = model.trim();
    // 与草稿同步回 config，再落库（base_url 留空则后端走默认 OpenAI 地址）
    const next = { ...config, base_url: base, model: m };
    setConfig(next);
    const { has_key: _hk, ...cfg } = next;
    saveAiConfig(cfg).catch(console.error);
  }

  async function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    try {
      await setAiApiKey(k);
      setKeyInput("");
      const c = await getAiConfig();
      setConfig(c);
    } catch (e) {
      console.error(e);
    }
  }

  async function clearKey() {
    try {
      await setAiApiKey(null);
      const c = await getAiConfig();
      setConfig(c);
    } catch (e) {
      console.error(e);
    }
  }

  async function runTest() {
    if (testState.status === "testing") return;
    setTestState({ status: "testing" });
    try {
      const r = await testAiConnection();
      setTestState({ status: "done", ok: r.ok, message: r.message });
    } catch (e) {
      setTestState({ status: "done", ok: false, message: String(e) });
    }
  }

  function toggleFeature(id: string, v: boolean) {
    persist({ enabled_features: { ...(config?.enabled_features ?? {}), [id]: v } });
  }

  async function runClassify() {
    if (classifying) return;
    setClassifying(true);
    setClassifyMsg("");
    try {
      const r = await classifyApps(true);
      setClassifyMsg(r.message);
      setClassify(await getClassifyStatus());
      reloadAudit();
    } catch (e) {
      setClassifyMsg(String(e));
    } finally {
      setClassifying(false);
    }
  }

  const classifyDesc = classifyMsg
    ? classifyMsg
    : classify
      ? classify.queue_len === 0
        ? "暂无待分类的应用"
        : `待分类 ${classify.queue_len} 个应用${
            classify.last_classified_at_ms
              ? ` · 上次 ${fmtTime(classify.last_classified_at_ms)}`
              : ""
          }`
      : "加载中…";

  async function handleExportAudit() {
    try {
      const rows = await exportAiAudit();
      const json = JSON.stringify(rows, null, 2);
      const path = await save({
        defaultPath: "snoop-ai-audit.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) await writeTextFile(path, json);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleClearAudit() {
    if (!confirmClearAudit) {
      setConfirmClearAudit(true);
      return;
    }
    try {
      const n = await clearAiAudit();
      setAuditMsg(`已清除 ${n} 条记录`);
      setConfirmClearAudit(false);
      reloadAudit();
      window.setTimeout(() => setAuditMsg(""), 2000);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <>
      {/* ── 服务配置 ─────────────────────────────────────────── */}
      <div className="settings-group">
        <div className="settings-group-title">AI 服务</div>

        {!configured && (
          <div className="ai-hint">
            <AlertTriangle size={14} />
            <span>尚未配置 AI 服务：填写 API Key 与模型后，下方功能开关才会启用。</span>
          </div>
        )}

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">服务地址</span>
            <span className="setting-row-desc">OpenAI v1 兼容端点，默认 api.openai.com/v1</span>
          </div>
          <div className="ai-row-right">
            <Server size={14} className="ai-field-icon" />
            <input
              className="ai-input"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={commitService}
            />
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">API Key</span>
            <span className="setting-row-desc">存于系统原生加密存储（DPAPI / Keychain），不落明文</span>
          </div>
          <div className="ai-row-right">
            <KeyRound size={14} className="ai-field-icon" />
            <input
              className="ai-input"
              type={showKey ? "text" : "password"}
              value={keyInput}
              placeholder={config?.has_key ? "已保存 · 输入新 Key 覆盖" : "sk-…"}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
            />
            <button
              className="ai-icon-btn"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "隐藏" : "显示"}
            >
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button className="setting-btn" onClick={saveKey} disabled={!keyInput.trim()}>
              保存
            </button>
            {config?.has_key && (
              <button className="setting-btn setting-btn-danger" onClick={clearKey}>
                清除
              </button>
            )}
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">模型</span>
            <span className="setting-row-desc">自由填写，如 gpt-4o-mini / deepseek-chat</span>
          </div>
          <div className="ai-row-right">
            <Sparkles size={14} className="ai-field-icon" />
            <input
              className="ai-input"
              value={model}
              placeholder="gpt-4o-mini"
              onChange={(e) => setModel(e.target.value)}
              onBlur={commitService}
            />
          </div>
        </div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">测试连接</span>
            <span className="setting-row-desc">发一个最小请求验证配置可用</span>
          </div>
          <div className="ai-row-right">
            {testState.status === "done" && (
              <span className={`ai-test-msg${testState.ok ? " is-ok" : " is-err"}`}>
                {testState.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {testState.message}
              </span>
            )}
            <button
              className="setting-btn"
              onClick={runTest}
              disabled={testState.status === "testing"}
            >
              {testState.status === "testing" ? (
                <Loader2 size={13} className="is-spin" />
              ) : (
                <PlugZap size={13} />
              )}
              {testState.status === "testing" ? "测试中…" : "测试连接"}
            </button>
          </div>
        </div>
      </div>

      {/* ── 数据层级 ─────────────────────────────────────────── */}
      <div className="settings-group">
        <div className="settings-group-title">AI 数据层级</div>

        <div className="ai-tier-grid">
          {(["T0", "T1", "T2"] as const).map((t) => {
            const active = config?.tier === t;
            const available = features.filter((f) => tierAtLeast(t, f.required_tier));
            const locked = features.filter((f) => !tierAtLeast(t, f.required_tier));
            return (
              <button
                key={t}
                className={`ai-tier-card${active ? " is-active" : ""}`}
                onClick={() => config && persist({ tier: t })}
                disabled={!config}
              >
                <div className="ai-tier-head">
                  <span className="ai-tier-name">{TIER_META[t].name}</span>
                  {active && <CheckCircle2 size={14} className="ai-tier-check" />}
                </div>
                <span className="ai-tier-desc">{TIER_META[t].desc}</span>
                <div className="ai-tier-feats">
                  {available.map((f) => (
                    <span key={f.id} className="ai-feat-chip is-ok">
                      {f.label}
                    </span>
                  ))}
                  {locked.map((f) => (
                    <span key={f.id} className="ai-feat-chip is-lock">
                      <Lock size={10} />
                      {f.label}
                    </span>
                  ))}
                  {features.length === 0 && <span className="ai-tier-desc">加载中…</span>}
                </div>
              </button>
            );
          })}
        </div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">窗口标题（T3）</span>
            <span className="setting-row-desc">在 T2 之上额外发送窗口标题，可被用于推断你在看的具体内容</span>
          </div>
          <div className="ai-row-right">
            <button
              className={`setting-toggle${config?.window_titles_enabled ? " is-on" : ""}`}
              onClick={() => config && persist({ window_titles_enabled: !config.window_titles_enabled })}
              role="switch"
              aria-checked={!!config?.window_titles_enabled}
              disabled={!config}
            >
              <span className="setting-toggle-thumb" />
            </button>
          </div>
        </div>
        {config?.window_titles_enabled && (
          <div className="ai-warn">
            <AlertTriangle size={13} />
            <span>已开启窗口标题发送：这会暴露更具体的活动内容，建议仅在需要时开启。</span>
          </div>
        )}
      </div>

      {/* ── 功能开关 ─────────────────────────────────────────── */}
      <div className="settings-group">
        <div className="settings-group-title">AI 功能</div>

        {features.map((f) => {
          const overTier = config ? !tierAtLeast(config.tier, f.required_tier) : true;
          const enabled = config ? (config.enabled_features[f.id] ?? true) : false;
          return (
            <div key={f.id} className={`ai-row${overTier ? " is-disabled" : ""}`}>
              <div className="ai-row-left">
                <span className="setting-row-label">{f.label}</span>
                <span className="setting-row-desc">{f.description}</span>
              </div>
              <div className="ai-row-right">
                {overTier && (
                  <span className="ai-lock-badge">
                    <Lock size={10} />
                    需要 {f.required_tier}
                  </span>
                )}
                <button
                  className={`setting-toggle${enabled ? " is-on" : ""}`}
                  onClick={() => toggleFeature(f.id, !enabled)}
                  role="switch"
                  aria-checked={enabled}
                  disabled={!config || overTier}
                >
                  <span className="setting-toggle-thumb" />
                </button>
              </div>
            </div>
          );
        })}
        {features.length === 0 && (
          <div className="ai-row">
            <span className="setting-row-desc">加载中…</span>
          </div>
        )}

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">应用分类</span>
            <span className="setting-row-desc">{classifyDesc}</span>
          </div>
          <div className="ai-row-right">
            <button
              className="setting-btn"
              onClick={runClassify}
              disabled={classifying || !configured || classify?.running === true}
            >
              {classifying ? <Loader2 size={13} className="is-spin" /> : <Tag size={13} />}
              {classifying ? "分类中…" : "立即分类"}
            </button>
          </div>
        </div>
      </div>

      {/* ── 发送记录 ─────────────────────────────────────────── */}
      <div className="settings-group">
        <div className="settings-group-title">发送记录</div>

        <div className="ai-row">
          <div className="ai-row-left">
            <span className="setting-row-label">审计日志</span>
            <span className="setting-row-desc">每次 AI 调用的原始请求、结果与耗时，保留 30 天</span>
          </div>
          <div className="ai-row-right">
            {auditMsg && <span className="setting-hint">{auditMsg}</span>}
            <button className="setting-btn" onClick={handleExportAudit}>
              <Download size={13} />
              导出
            </button>
            <button
              className={`setting-btn setting-btn-danger${confirmClearAudit ? " is-confirm" : ""}`}
              onClick={handleClearAudit}
            >
              <Trash2 size={13} />
              {confirmClearAudit ? "确认清空" : "清空"}
            </button>
            {confirmClearAudit && (
              <button className="setting-btn" onClick={() => setConfirmClearAudit(false)}>
                取消
              </button>
            )}
          </div>
        </div>

        <div className="ai-audit-list">
          {audit.length === 0 && (
            <div className="ai-audit-empty">
              <Send size={16} />
              <span>暂无发送记录</span>
            </div>
          )}
          {audit.map((r) => (
            <div key={r.id} className="ai-audit-item">
              <button
                className="ai-audit-head"
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                <span className={`ai-audit-status${r.success ? " is-ok" : " is-err"}`}>
                  {r.success ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                </span>
                <span className="ai-audit-feature">{featureLabel.get(r.feature_id) ?? r.feature_id}</span>
                <span className="ai-audit-tier">{r.tier}</span>
                <span className="ai-audit-time">{fmtTime(r.created_at_ms)}</span>
                {r.sent ? (
                  <span className="ai-audit-meta">
                    {r.total_tokens != null ? `${r.total_tokens} tok` : ""}
                    {r.duration_ms != null ? ` · ${r.duration_ms} ms` : ""}
                  </span>
                ) : (
                  <span className="ai-audit-meta is-muted">未发送</span>
                )}
              </button>
              {expanded === r.id && (
                <div className="ai-audit-detail">
                  {r.error_kind && (
                    <div className="ai-audit-detail-row">
                      <span className="ai-audit-detail-key">错误</span>
                      <span className="ai-audit-detail-val">{r.error_kind}</span>
                    </div>
                  )}
                  <div className="ai-audit-detail-row">
                    <span className="ai-audit-detail-key">请求原文</span>
                  </div>
                  <pre className="ai-audit-json">
                    {r.request_json ? JSON.stringify(JSON.parse(r.request_json), null, 2) : "(未发送请求)"}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
