/**
 * 报告 —— 历史日报 / 周报 / 月报的「刊物归档」。
 *
 * 页面本身是杂志式的目录：页头一期一号，列表是一条条「本期刊物」；
 * 点开某一份，原位展开完整杂志跨页（`ReportSheet`），同一份版式也就是导出的海报。
 *
 * 全局 (kind, anchor) 决定列表显示哪种报、以及滚动定位到哪一期。三种报按日期倒序，
 * 展开、生成、导出、灯箱都围绕当前选中的那一份。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronUp,
  Download,
  Maximize2,
  RefreshCw,
} from "lucide-react";
import PageShell from "../components/PageShell";
import { useToast } from "../components/shared/Toast";
import { formatDuration } from "../utils/format";
import { getReport, getReportList, regenerateReport } from "../report/client";
import { dateLabel, monthLabel, weekRangeLabel } from "../report/format";
import { useReportIcons } from "../report/icons";
import ReportSheet from "../report/sheet/ReportSheet";
import Lightbox from "../report/Lightbox";
import ExportDialog from "../report/ExportDialog";
import type { ReportKind, ReportMeta, ReportView } from "../report/types";
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
  // 海报灯箱：点「全屏」打开，展示当前详情那份完整海报。
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 生成当前 anchor 对应的那份报告。
  const [generating, setGenerating] = useState(false);
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);

  // 详情卡与导出成图共用同一套预解析 app 图标。
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
    getReport(selected.date, selected.type as ReportKind)
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
      const v = await regenerateReport(selected.date, selected.type as ReportKind);
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

  // 手动生成某个周期。anchor 已按 kind 归一到周期起点；「记录太少」占位行也可点此生成。
  async function generateOne(type: ReportKind, date: string) {
    setGenerating(true);
    try {
      await regenerateReport(date, type);
      setReports(await getReportList());
      toast.show({ message: "已生成" });
      setSelected({ type, date });
    } catch (e) {
      console.error(e);
      toast.show({ message: `生成失败：${String(e)}` });
    } finally {
      setGenerating(false);
    }
  }

  function handleGenerate() {
    return generateOne(kind, anchor);
  }

  return (
    <>
      <PageShell className="report-page" header={<ReportHeader count={filtered.length} kind={kind} />}>
        <div className="report-list" ref={listRef}>
          {!hasCurrent && (
            <div className="report-generate">
              <div className="report-generate__main">
                <span className="report-generate__eyebrow">NO ISSUE YET</span>
                <p className="report-generate-text">
                  {filtered.length === 0
                    ? `还没有${KIND_LABEL[kind]}报`
                    : `${rowTitle(kind, anchor)} 还没有报告`}
                </p>
                <span className="report-generate-hint">
                  {generating ? "AI 正在写这一期的正文与旁批…" : "生成后会收进下面的归档。"}
                </span>
              </div>
              <button
                type="button"
                className="report-generate-btn"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? "生成中…" : "生成这份报告"}
              </button>
            </div>
          )}

          {filtered.map((r) => {
            const key = reportKey(r.report_type, r.report_date);
            if (r.status === "too_little") {
              return (
                <button
                  key={key}
                  type="button"
                  data-report-key={key}
                  className="report-skip-row"
                  onClick={() => generateOne(r.report_type as ReportKind, r.report_date)}
                  disabled={generating}
                  title="手动生成这份报告"
                >
                  <span className="report-skip-row__date">{rowTitle(r.report_type, r.report_date)}</span>
                  <span className="report-skip-row__note">记录太少，这一期没有成刊</span>
                  <span className="report-skip-row__action">
                    点此生成 <RefreshCw size={12} />
                  </span>
                </button>
              );
            }
            if (selected && reportKey(selected.type, selected.date) === key) {
              if (!detail) {
                return (
                  <div key={key} className="report-card-loading">
                    正在翻到这一期…
                  </div>
                );
              }
              return (
                <div key={key} data-report-key={key} className="report-detail">
                  <div className="report-detail__bar">
                    <div className="report-detail__label">
                      <span>{KIND_LABEL[r.report_type]}</span>
                      <b>{rowTitle(r.report_type, r.report_date)}</b>
                    </div>
                    <div className="report-detail__actions">
                      <button type="button" onClick={() => setSelected(null)}>
                        <ChevronUp size={15} />
                        收起
                      </button>
                      <button
                        type="button"
                        onClick={handleRegenerate}
                        disabled={regenerating}
                      >
                        <RefreshCw size={15} className={regenerating ? "is-spinning" : undefined} />
                        {regenerating ? "重生成中…" : "重新生成"}
                      </button>
                      <button type="button" onClick={() => setExporting(detail)}>
                        <Download size={15} />
                        导出成图
                      </button>
                      <button type="button" onClick={() => setLightboxOpen(true)}>
                        <Maximize2 size={15} />
                        全屏
                      </button>
                    </div>
                  </div>
                  <div className="report-detail__paper">
                    <ReportSheet detail={detail} icons={reportIcons} />
                  </div>
                </div>
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
                <span className="report-row-main">
                  <span className="report-row-date">{rowTitle(r.report_type, r.report_date)}</span>
                  <span className="report-row-headline">
                    {r.headline?.trim() || metaSubline(r)}
                  </span>
                </span>
                <span className="report-row-total">{formatDuration(r.active_ms)}</span>
                <ChevronRight size={16} className="report-row-arrow" />
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
  day: "日报",
  week: "周刊",
  month: "月刊",
};

function rowTitle(type: ReportMeta["report_type"], date: string): string {
  if (type === "week") return weekRangeLabel(date);
  if (type === "month") return monthLabel(date);
  return dateLabel(date);
}

/** 历史报告没有 AI 标题时，列表第二行给一个由数据得到的事实句。 */
function metaSubline(r: ReportMeta): string {
  const pct =
    r.foreground_ms > 0 ? Math.round((r.active_ms / r.foreground_ms) * 100) : 0;
  return `输入活跃占前台的 ${pct}%`;
}

function ReportHeader({ count, kind }: { count: number; kind: ReportKind }) {
  return (
    <div className="report-header">
      <div className="report-header__main">
        <p className="report-header-eyebrow">Snoop / ARCHIVE</p>
        <h1 className="report-header-title">报告</h1>
        <p className="report-header-subtitle">日 · 周 · 月，三种尺度回看自己</p>
      </div>
      <div className="report-header__meta">
        <b>{count}</b>
        <span>{KIND_LABEL[kind]}归档</span>
      </div>
    </div>
  );
}
