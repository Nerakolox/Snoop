/**
 * 报告 —— 历史日报时间轴。
 * 顶部筛选（全部 / 日 / 周 / 月，周月占位）+ 跳到指定日期；下方是日报卡片列表，
 * 点开在卡片原位展开详情。导出成图是批次 4b，本批只让详情卡固定宽度 + 最小高度、
 * 高度可往下长，结构上支持导出。
 */

import { useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import AppIcon from "../components/AppIcon";
import Tooltip from "../components/shared/Tooltip";
import { useToast } from "../components/shared/Toast";
import { CATEGORY_COLOR, CATEGORY_LABEL } from "../ai/categories";
import { formatDuration } from "../utils/format";
import { getReport, getReportList, regenerateReport } from "../report/client";
import type { ReportMeta, ReportView } from "../report/types";

type Filter = "all" | "day" | "week" | "month";

const FILTERS: { key: Filter; label: string; disabled: boolean }[] = [
  { key: "all", label: "全部", disabled: false },
  { key: "day", label: "日", disabled: false },
  { key: "week", label: "周", disabled: true },
  { key: "month", label: "月", disabled: true },
];

/** 'YYYY-MM-DD' → 「M月D日」。 */
function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  if (!m || !d) return date;
  return `${m}月${d}日`;
}

export default function Report() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportView | null>(null);
  const [jumpDate, setJumpDate] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    getReportList()
      .then((r) => {
        if (alive) setReports(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedDate) {
      setDetail(null);
      return;
    }
    let alive = true;
    getReport(selectedDate)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [selectedDate]);

  const filtered = useMemo(
    () => reports.filter((r) => filter === "all" || r.report_type === filter),
    [reports, filter],
  );

  function openReport(date: string) {
    setSelectedDate(date);
  }

  async function handleRegenerate() {
    if (!selectedDate) return;
    setRegenerating(true);
    try {
      const v = await regenerateReport(selectedDate);
      setDetail(v);
      setReports(await getReportList());
      toast.show({ message: "已重新生成" });
    } catch (e) {
      console.error(e);
      toast.show({ message: "重新生成失败" });
    } finally {
      setRegenerating(false);
    }
  }

  function handleJump() {
    if (!jumpDate) return;
    setSelectedDate(jumpDate);
  }

  return (
    <PageShell className="report-page" header={<ReportHeader />}>
      {/* 筛选 + 日期跳转 */}
      <div className="report-toolbar">
        <div className="report-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`report-filter${filter === f.key ? " is-active" : ""}`}
              disabled={f.disabled}
              title={f.disabled ? "后续批次" : undefined}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="report-jump">
          <input
            type="date"
            className="report-jump-input"
            value={jumpDate}
            onChange={(e) => setJumpDate(e.target.value)}
          />
          <button
            type="button"
            className="report-jump-btn"
            onClick={handleJump}
            disabled={!jumpDate}
          >
            跳到日期
          </button>
        </div>
      </div>

      {/* 时间轴列表 */}
      <div className="report-list">
        {filtered.length === 0 && (
          <p className="report-empty">还没有报告，明天回来看看喵～</p>
        )}
        {filtered.map((r) =>
          r.status === "too_little" ? (
            <div key={r.report_date} className="report-skip-row">
              {dateLabel(r.report_date)} · 记录太少
            </div>
          ) : selectedDate === r.report_date ? (
            <div key={r.report_date} className="report-expanded">
              <button
                type="button"
                className="report-collapse"
                onClick={() => setSelectedDate(null)}
              >
                收起 ↑
              </button>
              <ReportDetail
                detail={detail}
                date={r.report_date}
                onRegenerate={handleRegenerate}
                regenerating={regenerating}
              />
            </div>
          ) : (
            <button
              key={r.report_date}
              type="button"
              className="report-row"
              onClick={() => openReport(r.report_date)}
            >
              <span className="report-row-date">{dateLabel(r.report_date)}</span>
              <span className="report-row-total">{formatDuration(r.active_ms)}</span>
              <span className="report-row-arrow">›</span>
            </button>
          ),
        )}
      </div>
    </PageShell>
  );
}

function ReportHeader() {
  return (
    <div className="report-header">
      <h1 className="report-header-title">报告</h1>
      <p className="report-header-subtitle">回看每一天，为导出成图做准备</p>
    </div>
  );
}

function ReportDetail({
  detail,
  date,
  onRegenerate,
  regenerating,
}: {
  detail: ReportView | null;
  date: string;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  if (!detail) {
    return <div className="report-card report-card--loading">加载中…</div>;
  }
  const d = detail.data;
  const maxAppMs = Math.max(...d.top_apps.map((a) => a.active_ms), 1);
  const maxHourMs = Math.max(...d.hourly.map((h) => h.active_ms), 1);
  const tooLittle = detail.narrative === null;

  if (tooLittle) {
    return <div className="report-card">{dateLabel(date)} · 记录太少，未生成完整报告</div>;
  }

  return (
    <div className="report-card">
      {/* ① 日期 + 总时长 + 口径副行 */}
      <div className="report-card-head">
        <div className="report-card-date">{dateLabel(date)}</div>
        <div className="report-card-active">{formatDuration(d.active_ms)}</div>
        <div className="report-card-sub">
          活跃时长 {formatDuration(d.active_ms)} · 前台 {formatDuration(d.foreground_ms)}
        </div>
      </div>

      {/* ② 叙事 */}
      <p className="report-card-narrative">
        {detail.narrative}
        {detail.narrative_source && (
          <span className="report-card-source">
            {detail.narrative_source === "ai" ? "由 AI 生成" : "本地模板"}
          </span>
        )}
      </p>

      {/* ③ 应用 Top 5 */}
      <section className="report-section">
        <h4 className="report-section-title">应用 Top 5</h4>
        {d.top_apps.length === 0 ? (
          <p className="report-empty-inline">无数据</p>
        ) : (
          <div className="report-apps">
            {d.top_apps.map((a) => (
              <div key={a.bundle_id} className="report-app-row">
                <div className="report-app-name">
                  <AppIcon bundleId={a.bundle_id} appName={a.name} size={16} />
                  <span>{a.name}</span>
                </div>
                <div className="report-app-track">
                  <div
                    className="report-app-fill"
                    style={{ width: `${(a.active_ms / maxAppMs) * 100}%` }}
                  />
                </div>
                <div className="report-app-time">{formatDuration(a.active_ms)}</div>
                <div className="report-app-pct">{a.share_pct.toFixed(0)}%</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ④ 分类占比 */}
      <section className="report-section">
        <h4 className="report-section-title">分类占比</h4>
        {d.categories.length === 0 ? (
          <p className="report-empty-inline">无数据</p>
        ) : (
          <>
            <div className="report-cat-stack">
              {d.categories.map((c) => (
                <div
                  key={c.category}
                  className="report-cat-seg"
                  style={{
                    width: `${c.share_pct}%`,
                    background: CATEGORY_COLOR[c.category] ?? "#94a3b8",
                  }}
                  title={`${CATEGORY_LABEL[c.category] ?? c.category} · ${c.share_pct.toFixed(1)}%`}
                />
              ))}
            </div>
            <div className="report-cat-legend">
              {d.categories.map((c) => (
                <div key={c.category} className="report-cat-row">
                  <span
                    className="report-cat-swatch"
                    style={{ background: CATEGORY_COLOR[c.category] ?? "#94a3b8" }}
                  />
                  <span className="report-cat-label">
                    {CATEGORY_LABEL[c.category] ?? c.category}
                  </span>
                  <span className="report-cat-time">{formatDuration(c.active_ms)}</span>
                  <span className="report-cat-pct">{c.share_pct.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ⑤ 24 小时节奏 */}
      <section className="report-section">
        <h4 className="report-section-title">24 小时节奏</h4>
        <div className="report-rhythm">
          {d.hourly.map((h) => (
            <Tooltip key={h.hour} content={`${h.hour}:00 · ${formatDuration(h.active_ms)}`}>
              <div className="report-rhythm-col">
                <div
                  className="report-rhythm-bar"
                  style={{
                    height: `${Math.max((h.active_ms / maxHourMs) * 100, h.active_ms > 0 ? 4 : 0)}%`,
                  }}
                />
              </div>
            </Tooltip>
          ))}
        </div>
        <div className="report-rhythm-scale">
          <span>0</span>
          <span>6</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      </section>

      {/* ⑥ 近 7 天对比 */}
      <section className="report-section">
        <h4 className="report-section-title">近 7 天对比</h4>
        {d.vs_7d.avg_active_ms > 0 ? (
          <div className="report-compare">
            <CompareDelta label="活跃时长" pct={d.vs_7d.active_delta_pct} />
            <CompareDelta label="切换次数" pct={d.vs_7d.switch_delta_pct} />
          </div>
        ) : (
          <p className="report-empty-inline">还没有足够的历史数据对比</p>
        )}
      </section>

      {/* 重新生成 */}
      <button
        type="button"
        className="report-regen"
        onClick={onRegenerate}
        disabled={regenerating}
      >
        {regenerating ? "重新生成中…" : "重新生成"}
      </button>
    </div>
  );
}

function CompareDelta({ label, pct }: { label: string; pct: number }) {
  const up = pct >= 0;
  return (
    <div className="report-compare-item">
      <span className="report-compare-label">{label}</span>
      <span className="report-compare-value">
        {up ? "↑" : "↓"} {Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  );
}
