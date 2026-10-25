/**
 * 更新日志弹窗 —— 一条纵向时间线，从最新版本往回读。
 *
 * 版式遵循项目既有语汇：中性色承担信息层级，品牌紫只用来标一处身份
 * （「当前版本」那颗节点）。类型标签（新增/修复/改进）刻意不上色——暖色阶
 * 专属活跃强度，借来标 changelog 会把整套颜色的含义冲淡。
 */

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RefreshCw, X } from "lucide-react";
import { loadChangelog, useChangelog } from "../../changelog/source";
import { compareVersions } from "../../changelog/version";
import type { ChangeKind, ChangeNote } from "../../changelog/types";

const KIND_LABEL: Record<ChangeKind, string> = {
  feat: "新增",
  fix: "修复",
  improve: "改进",
  breaking: "不兼容",
  other: "其他",
};

/** 2026-09-11 → 2026 年 9 月 11 日。手写解析，避免时区把日期挪一天。 */
function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

/**
 * 条目按类型聚成小组：新增在前，修复次之，其余按出现顺序。
 * 一个版本里既有新功能又有修复时，读者想知道「这版加了什么」比
 * 「改了哪几个 bug」更急，所以不做严格的原文顺序。
 */
const KIND_ORDER: ChangeKind[] = ["feat", "improve", "breaking", "fix", "other"];

function groupNotes(notes: ChangeNote[]): { kind: ChangeKind; notes: ChangeNote[] }[] {
  const buckets = new Map<ChangeKind, ChangeNote[]>();
  for (const n of notes) {
    const list = buckets.get(n.kind);
    if (list) list.push(n);
    else buckets.set(n.kind, [n]);
  }
  return KIND_ORDER.filter((k) => buckets.has(k)).map((k) => ({
    kind: k,
    notes: buckets.get(k)!,
  }));
}

export default function ChangelogDialog({
  appVersion,
  onClose,
}: {
  appVersion: string;
  onClose: () => void;
}) {
  const snapshot = useChangelog();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc 关闭 + 焦点接管。打开弹窗时把焦点移进对话框，关闭后浏览器会把焦点
  // 还回触发按钮（portal 卸载时原生行为），所以不必手动记 returnFocus。
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = snapshot?.data;
  const isStale = snapshot !== null && snapshot.source !== "remote";

  const entries = useMemo(() => {
    if (!data) return [];
    return data.releases.map((r) => ({
      release: r,
      isCurrent: appVersion !== "" && compareVersions(r.version, appVersion) === 0,
      groups: groupNotes(r.notes),
    }));
  }, [data, appVersion]);

  const count = data?.releases.length ?? 0;

  return createPortal(
    <div className="changelog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="changelog-head">
          <div className="changelog-head-text">
            <h2 id="changelog-title" className="changelog-title">
              更新日志
            </h2>
            <p className="changelog-sub">
              {appVersion ? `当前 v${appVersion}` : "Snoop"}
              {count > 0 && ` · 共 ${count} 个版本`}
            </p>
          </div>
          <button
            type="button"
            className="changelog-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="changelog-body">
          <ol className="changelog-timeline">
            {entries.map(({ release, isCurrent, groups }) => (
              <li
                key={release.version}
                className={`changelog-entry${isCurrent ? " is-current" : ""}`}
              >
                <span className="changelog-dot" aria-hidden />
                <div className="changelog-card">
                  <div className="changelog-meta">
                    <span className="changelog-version">v{release.version}</span>
                    {isCurrent && (
                      <span className="changelog-current-badge">当前版本</span>
                    )}
                    <time className="changelog-date" dateTime={release.date}>
                      {formatDate(release.date)}
                    </time>
                  </div>

                  {release.tagline && (
                    <p className="changelog-tagline">{release.tagline}</p>
                  )}

                  {groups.map((g) => (
                    <div key={g.kind} className="changelog-group">
                      <div className="changelog-kind">{KIND_LABEL[g.kind]}</div>
                      <ul className="changelog-notes">
                        {g.notes.map((n, i) => (
                          <li key={i} className="changelog-note">
                            <span className="changelog-note-text">{n.text}</span>
                            {n.detail && (
                              <span className="changelog-note-detail">{n.detail}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}

                  {release.links && release.links.length > 0 && (
                    <div className="changelog-links">
                      {release.links.map((l) => (
                        <button
                          key={l.url}
                          type="button"
                          className="changelog-link"
                          onClick={() => openUrl(l.url)}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {entries.length === 0 && (
            <p className="changelog-empty">暂时没有可显示的更新记录。</p>
          )}
        </div>

        <footer className="changelog-foot">
          {isStale ? (
            <>
              <span className="changelog-foot-note">
                {snapshot.source === "cache"
                  ? "显示的是上次获取的内容，可能不是最新。"
                  : "未能从云端获取更新日志，以下内容随本次安装打包。"}
              </span>
              <button
                type="button"
                className="changelog-retry"
                onClick={() => void loadChangelog(true)}
              >
                <RefreshCw size={12} />
                重试
              </button>
            </>
          ) : (
            <span className="changelog-foot-note">
              {data?.updated_at
                ? `内容更新于 ${formatDate(data.updated_at)}`
                : "内容随版本更新"}
            </span>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
