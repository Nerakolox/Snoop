/**
 * 报告 —— 历史日报 / 周报 / 月报时间轴。
 * 消费全局 (kind, anchor)：顶栏的日/周/月 筛列表显示的报类型，日期导航滚到并高亮
 * 对应周期那份报告。三种报按日期倒序，点开在卡片原位展开。
 *
 * 展开是「摘要 + 缩略图」双栏（<ReportSummary>）：左栏为屏幕重排的紧凑摘要，
 * 右栏是海报缩略图 + 导出成图 / 重新生成。完整海报只在灯箱与导出时出现。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import PageShell from "../components/PageShell";
import { useToast } from "../components/shared/Toast";
import { formatDuration } from "../utils/format";
import { getReport, getReportList, regenerateReport } from "../report/client";
import { dateLabel, monthLabel, weekRangeLabel } from "../report/format";
import { useReportIcons } from "../report/icons";
import ReportSummary from "../report/ReportSummary";
import Lightbox from "../report/Lightbox";
import ExportDialog from "../report/ExportDialog";
import type { ReportMeta, ReportView } from "../report/types";
import { useContextState } from "../store/context";

function reportKey(type: string, date: string): string {
  return `${type}:${date}`;
}

export default function Report() {
  const { kind, anchor } = useContextState();
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [selected, setSelected] = useState<{ type: ReportMeta["report_type"]; date: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<ReportView | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // 导出成图对话框：挂当前详情那份报告，null 表示关闭。
  const [exporting, setExporting] = useState<ReportView | null>(null);
  // 海报灯箱：点缩略图打开，展示当前详情那份完整海报。
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 生成当前 anchor 对应的那份报告。
  const [generating, setGenerating] = useState(false);
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);

  // 详情卡的 app 图标：与导出成图共用同一套预解析结果。
  const reportIcons = useReportIcons(detail);

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
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    getReport(selected.date, selected.type as import("../report/types").ReportKind)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [selected]);

  const filtered = useMemo(
    () => reports.filter((r) => r.report_type === kind),
    [reports, kind],
  );

  // 当前全局 (kind, anchor) 对应的那份报告。anchor 恒已按 kind 归一化（当天/周一/月首）。
  const currentKey = reportKey(kind, anchor);
  // 该周期报告是否已存在（含「记录太少」）：决定列表位显示空状态还是「生成这份报告」。
  const hasCurrent = reports.some((r) => reportKey(r.report_type, r.report_date) === currentKey);

  // anchor 变化（或列表初次就绪）时，滚动定位到当前周期那份报告，只滚一次。
  const scrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledKeyRef.current === currentKey) return;
    const el = listRef.current?.querySelector(`[data-report-key="${currentKey}"]`);
    if (!el) return; // 目标还没渲染（列表未就绪 / 该周期无报告），等下一次
    scrolledKeyRef.current = currentKey;
    (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentKey, filtered]);

  function openReport(type: ReportMeta["report_type"], date: string) {
    setSelected({ type, date });
  }

  // 灯箱左右方向键：在「当前报型」的列表里切换相邻报告，加载其详情。到边界时静默不动。
  function navigateLightbox(dir: -1 | 1) {
    if (!selected) return;
    const idx = filtered.findIndex(
      (r) => reportKey(r.report_type, r.report_date) === reportKey(selected.type, selected.date),
    );
    if (idx === -1) return;
    const next = filtered[idx + dir];
    if (!next) return;
    openReport(next.report_type, next.report_date);
  }

  async function handleRegenerate() {
    if (!selected) return;
    setRegenerating(true);
    try {
      const v = await regenerateReport(
        selected.date,
        selected.type as import("../report/types").ReportKind,
      );
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

  // 生成当前 anchor 对应的那份报告（anchor 已按 kind 归一到周期起点）。
  // 「记录太少」不是失败——后端已落库一行 too_little，这里明确告诉用户原因。
  async function handleGenerate() {
    const reportDate = anchor;
    setGenerating(true);
    try {
      const v = await regenerateReport(reportDate, kind);
      setReports(await getReportList());
      if (v.status === "too_little") {
        toast.show({ message: TOO_LITTLE_MSG[kind] });
        setSelected(null);
      } else {
        toast.show({ message: "已生成" });
        setSelected({ type: kind, date: reportDate });
      }
    } catch (e) {
      console.error(e);
      toast.show({ message: `生成失败：${String(e)}` });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <PageShell className="report-page" header={<ReportHeader />}>
      <div className="report-list" ref={listRef}>
        {!hasCurrent && (
          <div className="report-generate">
            <p className="report-generate-text">
              {filtered.length === 0
                ? `还没有${KIND_LABEL[kind]}报`
                : `${rowTitle(kind, anchor)} 还没有报告`}
            </p>
            <button
              type="button"
              className="report-generate-btn"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? "生成中…" : "生成这份报告"}
            </button>
            {generating && <span className="report-generate-hint">AI 生成中，稍等…</span>}
          </div>
        )}
        {filtered.map((r) => {
          const key = reportKey(r.report_type, r.report_date);
          if (r.status === "too_little") {
            return (
              <div key={key} className="report-skip-row" data-report-key={key}>
                {rowTitle(r.report_type, r.report_date)} · 记录太少
              </div>
            );
          }
          if (selected && reportKey(selected.type, selected.date) === key) {
            if (!detail) {
              return <div key={key} className="report-card-loading">加载中…</div>;
            }
            return (
              <ReportSummary
                key={key}
                detail={detail}
                icons={reportIcons}
                onRegenerate={handleRegenerate}
                regenerating={regenerating}
                onExport={() => setExporting(detail)}
                onOpenLightbox={() => setLightboxOpen(true)}
                onCollapse={() => setSelected(null)}
              />
            );
          }
          return (
            <button
              key={key}
              type="button"
              data-report-key={key}
              className={`report-row${key === currentKey ? " is-current" : ""}`}
              onClick={() => openReport(r.report_type, r.report_date)}
            >
              <span className={`report-row-kind report-row-kind--${r.report_type}`}>
                {KIND_LABEL[r.report_type]}
              </span>
              <span className="report-row-date">{rowTitle(r.report_type, r.report_date)}</span>
              <span className="report-row-total">{formatDuration(r.active_ms)}</span>
              <span className="report-row-arrow">›</span>
            </button>
          );
        })}
      </div>
      </PageShell>
      {exporting && <ExportDialog detail={exporting} onClose={() => setExporting(null)} />}
      {lightboxOpen && detail && (
        <Lightbox
          detail={detail}
          icons={reportIcons}
          onClose={() => setLightboxOpen(false)}
          onExport={() => {
            setLightboxOpen(false);
            setExporting(detail);
          }}
          onNavigate={navigateLightbox}
        />
      )}
    </>
  );
}

const KIND_LABEL: Record<ReportMeta["report_type"], string> = {
  day: "日",
  week: "周",
  month: "月",
};

/** 手动生成落到「记录太少」时的说明。阈值与后端 report 模块一致，这里只做提示文案。 */
const TOO_LITTLE_MSG: Record<ReportMeta["report_type"], string> = {
  day: "该日活跃时长不足 30 分钟，已记为「记录太少」",
  week: "该周有活跃记录不足 3 天，已记为「记录太少」",
  month: "该月有活跃记录不足 10 天，已记为「记录太少」",
};

function rowTitle(type: ReportMeta["report_type"], date: string): string {
  if (type === "week") return weekRangeLabel(date);
  if (type === "month") return monthLabel(date);
  return dateLabel(date);
}

function ReportHeader() {
  return (
    <div className="report-header">
      <h1 className="report-header-title">报告</h1>
      <p className="report-header-subtitle">日 · 周 · 月，三种尺度回看自己</p>
    </div>
  );
}
