/**
 * 报告海报灯箱 —— 自研，不引第三方库。
 *
 * 现成 lightbox 库（PhotoSwipe / viewerjs 等）都为 <img> 设计，海报是 DOM 节点不是图片，
 * 用它们得先截图再喂进去；panzoom 那类只做变换，工具栏 / 遮罩 / 动画仍要自己写。加起来
 * 自己写也就几十行，不值得引依赖。
 *
 * 交互模型：纸张定宽 1080px、高度按内容自适应。平移只改 `transform: translate(tx,ty)`
 * （tx/ty 即纸张左上角在视口的坐标）；缩放提交时写内层 `transform: scale()`（<100%）或
 * CSS `zoom`（≥100%），原因见 writeDom。
 *
 * 缩放分两段渲染，避免逐帧重排：
 *   - 手势进行中（滚轮 / 拖拽）：只在纸张上叠一个合成层 `transform: scale()`（相对上一次
 *     提交的倍率差），平移也直接写 DOM。这一路不碰 React state，整张海报不重渲染、不重排版。
 *   - 手势停下（滚轮停止 180ms、拖拽松手）：一次性提交。≥100% 时把 transform 换成 CSS
 *     `zoom`，浏览器只重排一次，文字恢复清晰；<100% 时保持 transform（WKWebView 的最小
 *     字号钳制会让 CSS zoom 缩小时重排错乱）。提交后才同步 React state（百分比 / 按钮禁用态）。
 * 代价是 ≥100% 时手势期间文字会暂时发虚，停下即恢复；<100% 则一直由合成层降采样
 * （排版保持 1080px，缩略查看本来也不需要逐字清晰）。
 *
 * 缩放：滚轮以鼠标为锚点。macOS 上按滚动距离指数缩放（触控板 / MX Master 这类高频小
 * delta 设备不会一滚就飞），并限制单次手势总量；触控板捏合手势（gesture*）直接缩放；
 * 海报超出视口时，两指上下滚 / 滚轮改为平移（macOS 原生滚动习惯），⌘/Ctrl+滚轮始终缩放。
 * 其它平台仍是一格 ×1.2。工具栏 −/%/+ 按钮，点 % 回「适应窗口」；
 * 双击在「适应窗口 ↔ 100%」间切换；范围 0.25–3.0。
 * 平移：按住拖动（grab/grabbing），只在海报超出视口时可拖，拖到边界夹住不丢。
 * 其余：Esc / +-0 / 左右方向键切换相邻报告；打开/关闭 150ms 淡入淡出 + 轻微缩放；
 * 工具栏半透明深色渐变，鼠标静止 2s 淡出、移动淡入；打开锁 body 滚动、关闭恢复。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Download, Minus, Plus, X } from "lucide-react";
import type { ReportView } from "./types";
import type { ResolvedIconMap } from "./icons";
import ReportSheet from "./sheet/ReportSheet";
import { EXPORT_WIDTH } from "./export";
import { dateLabel, monthLabel, weekRangeLabel } from "./format";
import "./lightbox.css";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 1.2; // 乘法步进，大倍率下才跟手
const FIT_PAD = 48; // 「适应窗口」时海报四周留白
const ANIM_MS = 150; // 打开/关闭过渡
const TOOLBAR_IDLE_MS = 2000; // 工具栏静止淡出
const DRAG_THRESHOLD = 3; // 位移超过算拖拽，抑制随后的 click
const ZOOM_SETTLE_MS = 180; // 滚轮停止多久后提交（≥100% 时这一次才重排）

// macOS 的触控板 / 高分辨率滚轮（如 MX Master 的平滑滚动）一次手势会连发几十个 delta
// 很小的 wheel 事件；按事件固定 ×1.2 会让倍率随事件数指数爆炸。改为按滚动距离缩放：
// 经验值 40px ≈ 老式滚轮一格（WKWebView 把 1 line 翻译成 40px），取 e^(0.0033×px)，
// 一格约 1.14 倍（比上一版快 50%）；再给单事件 / 单次手势封顶，惯性滚动也不会滚过头。
const WHEEL_RATE_MAC = 0.0033; // 每 px 滚动量的指数系数
const WHEEL_EVENT_MAX = 1.25; // 单个 wheel 事件的倍率上限
const WHEEL_GESTURE_MAX = 2.5; // 一次连续滚动（含惯性）的累计倍率上限
const WHEEL_GESTURE_GAP_MS = 140; // 事件间隔超过它算新手势
const PINCH_SPEED = 1.5; // 触控板捏合：手指张合比例取 1.5 次方（比 1:1 快 50%）

const POSTER_W = EXPORT_WIDTH; // 1080

// macOS 上跑的是 WKWebView；平台标记由 main.tsx 在挂载 React 前写入 body。
function isMacWebKit(): boolean {
  return document.body.dataset.platform === "macos";
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

// Safari / WKWebView 的非标准触控板捏合事件；lib.dom 里没有类型。
interface GestureLikeEvent extends UIEvent {
  scale?: number;
  clientX?: number;
  clientY?: number;
}

function lightboxTitle(detail: ReportView): string {
  if (detail.report_type === "day") return `${dateLabel(detail.data.date)} · 日报`;
  if (detail.report_type === "week") return `${weekRangeLabel(detail.data.week_start)} · 周报`;
  return `${monthLabel(detail.data.month_start)} · 月报`;
}

function computeFitScale(cardH: number, vw: number, vh: number): number {
  if (cardH <= 0) return 1;
  const s = Math.min((vw - FIT_PAD * 2) / POSTER_W, (vh - FIT_PAD * 2) / cardH);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

export default function Lightbox({
  detail,
  icons,
  onClose,
  onExport,
  onNavigate,
}: {
  detail: ReportView;
  icons: ResolvedIconMap | null;
  onClose: () => void;
  onExport: () => void;
  onNavigate?: (dir: -1 | 1) => void;
}) {
  // —— 变换状态：transformRef 是数学真源；state 只在提交时更新（% / 禁用态 / 写 DOM）——
  const [transform, _setTransform] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const transformRef = useRef(transform);
  const setTransform = useCallback((t: Transform) => {
    transformRef.current = t;
    _setTransform(t);
  }, []);

  const [cardH, setCardH] = useState(0);
  const cardHRef = useRef(0);

  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);

  const cardRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const scaledRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // —— 缩放的「预览层」状态：手势期间只写 DOM，停下再提交 ——
  const liveRef = useRef(false); // true = 纸张当前用 transform 预览，zoom 尚未提交
  const baseZoomRef = useRef(1); // 纸张当前的排版基准：走 zoom 时等于提交倍率，走 transform 时恒为 1
  const commitTimerRef = useRef<number | undefined>(undefined);
  // macOS 滚轮手势状态：factor 是本手势已施加的缩放倍率；at 是上一个 wheel 事件时间，
  // 间隔超过阈值算新手势（惯性滚动会连续几秒，不能一直累加）；mode 在每次手势开始时
  // 定一次「缩放还是平移」，避免一次连续滚动中途从缩放突然变成平移。
  const wheelGestureRef = useRef<{ factor: number; at: number; mode: "zoom" | "pan" | null }>({
    factor: 1,
    at: 0,
    mode: null,
  });
  // 触控板捏合手势：active 期间忽略浏览器合成的 ctrl+wheel，last 记录已施加的累计比例。
  const pinchRef = useRef({ active: false, last: 1, at: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(
    null,
  );
  const suppressClickRef = useRef(false);
  const closingRef = useRef(false);
  const toolbarTimerRef = useRef<number | undefined>(undefined);
  const refitRef = useRef(true);

  // 父级回调存进 ref，stable 处理器（键盘/关闭/导出）拿到的永远是最新引用。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onExportRef = useRef(onExport);
  onExportRef.current = onExport;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // —— 变换写 DOM（规格化后直接写 style，绕开 React 重渲染）——
  // preview=true：手势进行中。保持上次提交的 zoom 不变，只叠一层相对倍率的 transform；
  // preview=false：提交。≥100% 写 CSS zoom（这一次才会重排），<100% 保持 transform。
  const writeDom = useCallback((t: Transform, preview: boolean) => {
    const scaled = scaledRef.current;
    if (scaled) {
      const translate = `translate(${t.tx}px, ${t.ty}px)`;
      if (scaled.style.transform !== translate) scaled.style.transform = translate;
    }
    const paper = paperRef.current;
    if (!paper) return;
    if (preview) {
      const ratio = t.scale / baseZoomRef.current;
      const transform = `scale(${ratio})`;
      if (paper.style.transformOrigin !== "0 0") paper.style.transformOrigin = "0 0";
      if (paper.style.transform !== transform) paper.style.transform = transform;
    } else {
      // WKWebView 对 CSS zoom 有一条约 9px 的最小字号钳制：14px 正文在 27% 下会被按
      // 33px 排版，整张海报重排成每行一两个字（Chromium/WebView2 没有这个行为）。
      // 所以 <100% 时不提交 zoom，改用 transform 等比缩小：排版保持 1080px 不重排，
      // 缩放交给合成层降采样；≥100% 仍提交 CSS zoom，让文字按目标尺寸重新栅格化。
      if (t.scale < 1 && isMacWebKit()) {
        if (paper.style.transformOrigin !== "0 0") paper.style.transformOrigin = "0 0";
        const transform = `scale(${t.scale})`;
        if (paper.style.transform !== transform) paper.style.transform = transform;
        if (paper.style.zoom !== "1") paper.style.zoom = "1";
        baseZoomRef.current = 1;
      } else {
        if (paper.style.transform) paper.style.transform = "";
        const zoom = String(t.scale);
        if (paper.style.zoom !== zoom) paper.style.zoom = zoom;
        baseZoomRef.current = t.scale;
      }
    }
  }, []);

  // —— 手势结束：把预览用的 transform 换成 CSS zoom，并同步 React（百分比 / 禁用态）——
  const commitZoom = useCallback(() => {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = undefined;
    }
    if (!liveRef.current) return;
    liveRef.current = false;
    const t = transformRef.current;
    writeDom(t, false);
    setTransform(t);
  }, [setTransform, writeDom]);

  const clearCommitTimer = useCallback(() => {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = undefined;
    }
  }, []);

  const applyTransform = useCallback(
    (t: Transform, preview: boolean) => {
      transformRef.current = t;
      if (preview) {
        liveRef.current = true;
        writeDom(t, true);
        // 滚轮连发时不断顺延；停手 ZOOM_SETTLE_MS 后才做那一次重排。
        clearCommitTimer();
        commitTimerRef.current = window.setTimeout(commitZoom, ZOOM_SETTLE_MS);
      } else {
        liveRef.current = false;
        clearCommitTimer();
        writeDom(t, false);
        setTransform(t);
      }
    },
    [writeDom, commitZoom, clearCommitTimer, setTransform],
  );

  // —— 变换运算（只读 ref，供 once 绑定的监听器稳定调用）——
  const clampAndSet = useCallback(
    (scale: number, tx: number, ty: number, preview = false) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const ch = cardHRef.current;
      const sw = scale * POSTER_W;
      const sh = scale * ch;
      let x = tx;
      let y = ty;
      // 该方向没超出视口 → 居中（锁住不拖）；超出 → 夹在 [视口-海报, 0]，不留空白也不丢出屏。
      if (sw <= vw) x = (vw - sw) / 2;
      else x = Math.min(0, Math.max(vw - sw, x));
      if (sh <= vh) y = (vh - sh) / 2;
      else y = Math.min(0, Math.max(vh - sh, y));
      applyTransform({ scale, tx: x, ty: y }, preview);
    },
    [applyTransform],
  );

  const zoomAt = useCallback(
    (ax: number, ay: number, factor: number, preview = false) => {
      const t = transformRef.current;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, t.scale * factor));
      if (Math.abs(next - t.scale) < 1e-4) return;
      // 锚点缩放：保持鼠标下的海报点不动。
      const px = (ax - t.tx) / t.scale;
      const py = (ay - t.ty) / t.scale;
      clampAndSet(next, ax - next * px, ay - next * py, preview);
    },
    [clampAndSet],
  );

  const zoomCenter = useCallback(
    (factor: number) => zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor),
    [zoomAt],
  );

  const zoomToFit = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fit = computeFitScale(cardHRef.current, vw, vh);
    applyTransform(
      {
        scale: fit,
        tx: (vw - fit * POSTER_W) / 2,
        ty: (vh - fit * cardHRef.current) / 2,
      },
      false,
    );
  }, [applyTransform]);

  // 首帧 / 每次提交后的 transform state 变化 → 写入 DOM（预览期间 state 不变，不会被覆盖）。
  useLayoutEffect(() => {
    writeDom(transform, false);
  }, [transform, writeDom]);

  // —— 关闭 / 导出：先播退出动画，150ms 后交还父级 ——
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    window.setTimeout(() => onCloseRef.current(), ANIM_MS);
  }, []);

  const handleExport = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    window.setTimeout(() => onExportRef.current(), ANIM_MS);
  }, []);

  // —— 打开：入场动画 + 锁 body 滚动 ——
  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // —— 灯箱打开期间禁用外壳的窗口拖拽区 ——
  // 侧栏整列与顶栏都挂了 data-tauri-drag-region（Tauri 在 document 上监听 mousedown，
  // 命中就在左侧把整个窗口拖走）以及 -webkit-app-region: drag。全屏看海报时这些区域
  // 不该还能拖窗口：临时把属性改成 "false"，配合 lightbox.css 的 no-drag 规则，关闭时原样恢复。
  useEffect(() => {
    const previous = new Map<Element, string | null>();
    document.querySelectorAll("[data-tauri-drag-region]").forEach((el) => {
      previous.set(el, el.getAttribute("data-tauri-drag-region"));
      el.setAttribute("data-tauri-drag-region", "false");
    });
    document.body.classList.add("is-lightbox-open");
    return () => {
      previous.forEach((value, el) => {
        if (value === null) el.removeAttribute("data-tauri-drag-region");
        else el.setAttribute("data-tauri-drag-region", value);
      });
      document.body.classList.remove("is-lightbox-open");
    };
  }, []);

  // —— 工具栏静止淡出 ——
  const pokeToolbar = useCallback(() => {
    setToolbarVisible(true);
    if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = window.setTimeout(() => setToolbarVisible(false), TOOLBAR_IDLE_MS);
  }, []);

  useEffect(() => {
    pokeToolbar();
    return () => {
      if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
    };
  }, [pokeToolbar]);

  // 卸载时丢掉未完成的缩放提交计时器。
  useEffect(() => clearCommitTimer, [clearCommitTimer]);

  // —— 测海报高度并（重新）适应窗口 ——
  useLayoutEffect(() => {
    refitRef.current = true; // 换报告（detail 变化）→ 回适应窗口
  }, [detail]);

  useLayoutEffect(() => {
    const el = cardRef.current?.querySelector<HTMLElement>(".rsheet");
    if (!el) return;
    const measure = () => {
      // 预览期间纸张的尺寸由 transform 表达，zoom 保持上次提交值；此时不需要（也不该）测量。
      if (liveRef.current) return;
      // offsetHeight 是否包含 CSS zoom 在各引擎上不一致。测量时先把 zoom 临时归 1，
      // 保证 cardH 始终是「未缩放的排版高度」，与 transformRef 里 scale × 尺寸的数学同一坐标系。
      const paper = paperRef.current;
      const prevZoom = paper?.style.zoom ?? "";
      if (paper) paper.style.zoom = "1";
      const h = el.offsetHeight;
      if (paper) paper.style.zoom = prevZoom;
      cardHRef.current = h;
      setCardH(h);
      if (refitRef.current) {
        refitRef.current = false;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const fit = computeFitScale(h, vw, vh);
        applyTransform({ scale: fit, tx: (vw - fit * POSTER_W) / 2, ty: (vh - fit * h) / 2 }, false);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [detail, applyTransform]);

  // —— 触控板捏合缩放（macOS 原生手势）——
  // WKWebView / Safari 的 pinch 走 gesturestart/gesturechange/gestureend，scale 是相对
  // 手势起点的累计值。两指上下滚 → 平移（见 wheel），捏合 → 缩放，和 macOS 原生预览一致。
  useEffect(() => {
    if (!isMacWebKit()) return;
    // 挂 document：有的 WebKit 版本把 gesture* 直接派发到文档，不一定从舞台元素冒泡上来。
    const el = document;
    const stop = (ev: Event) => {
      if (ev.cancelable) ev.preventDefault();
    };
    const onStart = (ev: Event) => {
      stop(ev);
      pinchRef.current.active = true;
      pinchRef.current.last = 1;
      pinchRef.current.at = performance.now();
    };
    const onChange = (ev: Event) => {
      stop(ev);
      const e = ev as GestureLikeEvent;
      const raw = typeof e.scale === "number" && e.scale > 0 ? e.scale : 1;
      // 指尖张合比例 → 缩放比例；用 1.5 次方让放大/缩小在比例上对称（线性映射缩小时会归零）。
      const effective = Math.pow(raw, PINCH_SPEED);
      const factor = effective / pinchRef.current.last;
      pinchRef.current.last = effective;
      pinchRef.current.at = performance.now();
      if (Math.abs(factor - 1) < 1e-4) return;
      const ax = typeof e.clientX === "number" ? e.clientX : window.innerWidth / 2;
      const ay = typeof e.clientY === "number" ? e.clientY : window.innerHeight / 2;
      zoomAt(ax, ay, factor, true);
    };
    const onEnd = (ev: Event) => {
      stop(ev);
      pinchRef.current.active = false;
      commitZoom();
    };
    el.addEventListener("gesturestart", onStart);
    el.addEventListener("gesturechange", onChange);
    el.addEventListener("gestureend", onEnd);
    return () => {
      el.removeEventListener("gesturestart", onStart);
      el.removeEventListener("gesturechange", onChange);
      el.removeEventListener("gestureend", onEnd);
    };
  }, [zoomAt, commitZoom]);

  // —— 滚轮缩放 / 平移（原生监听，passive:false 才能 preventDefault）——
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const mac = isMacWebKit();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 非 macOS 保持原手感：一格滚轮一步 ×1.2（Windows 每格一个离散事件，本来就正常）。
      if (!mac) {
        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        // 滚轮是高频输入：只走预览层，停手后再提交 CSS zoom。
        zoomAt(e.clientX, e.clientY, factor, true);
        return;
      }
      const now = performance.now();
      // 部分 WebKit 版本会把 pinch 同时合成为 ctrl+wheel；进行中的捏合手势优先。
      // 用 500ms 兜底：万一 gestureend 没到，滚动不会被永久吞掉。
      if (pinchRef.current.active && now - pinchRef.current.at < 500) return;
      // deltaMode：0=像素、1=行、2=页，先统一成像素，不同鼠标/驱动才有一致手感。
      const unit = (page: number) => (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? page : 1);
      const dx = e.deltaX * unit(window.innerWidth);
      const dy = e.deltaY * unit(window.innerHeight);
      if (!dx && !dy) return;

      const g = wheelGestureRef.current;
      const fresh = now - g.at > WHEEL_GESTURE_GAP_MS;
      g.at = now;
      if (fresh) {
        g.factor = 1;
        g.mode = null;
      }

      // 按滚动距离算倍率：同一段手势，事件拆得再碎，缩放总量也只跟滚了多少有关。
      const zoomByWheel = () => {
        const step = Math.min(
          WHEEL_EVENT_MAX,
          Math.max(1 / WHEEL_EVENT_MAX, Math.exp(-dy * WHEEL_RATE_MAC)),
        );
        // 惯性滚动会持续几秒：给一次手势的累计倍率封顶，避免从 27% 一路冲到 300%。
        const total = Math.min(
          WHEEL_GESTURE_MAX,
          Math.max(1 / WHEEL_GESTURE_MAX, g.factor * step),
        );
        const factor = total / g.factor;
        g.factor = total;
        if (Math.abs(factor - 1) < 1e-4) return;
        zoomAt(e.clientX, e.clientY, factor, true);
      };

      // ⌘/Ctrl + 滚轮：无论海报多大都缩放（鼠标用户放大细节的通道）。
      if (e.metaKey || e.ctrlKey) {
        g.mode = "zoom";
        zoomByWheel();
        return;
      }

      const t = transformRef.current;
      if (!g.mode) {
        // 手势开始时一次定调：海报在主滚动方向上超出视口 → 原生平移；否则滚轮缩放。
        // 中途不再切换，否则「从适应窗口滚到放大」会滚到一半突然变成平移。
        const vertical = Math.abs(dy) >= Math.abs(dx);
        const canPan = vertical
          ? t.scale * cardHRef.current > window.innerHeight
          : t.scale * POSTER_W > window.innerWidth;
        g.mode = canPan ? "pan" : "zoom";
      }
      if (g.mode === "pan") {
        clampAndSet(t.scale, t.tx - dx, t.ty - dy, true);
        return;
      }
      if (dy) zoomByWheel();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, clampAndSet]);

  // —— 键盘 ——
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") return requestClose();
      if (e.key === "+" || e.key === "=") return zoomCenter(ZOOM_STEP);
      if (e.key === "-" || e.key === "_") return zoomCenter(1 / ZOOM_STEP);
      if (e.key === "0") return zoomToFit();
      if (e.key === "ArrowLeft") return onNavigateRef.current?.(-1);
      if (e.key === "ArrowRight") return onNavigateRef.current?.(1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose, zoomCenter, zoomToFit]);

  // —— 窗口缩放时重新夹住，别让海报飘走 ——
  useEffect(() => {
    function onResize() {
      const t = transformRef.current;
      clampAndSet(t.scale, t.tx, t.ty);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampAndSet]);

  // —— 拖拽平移（只在超出视口时可拖）——
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    suppressClickRef.current = false;
    const t = transformRef.current;
    const sw = t.scale * POSTER_W;
    const sh = t.scale * cardHRef.current;
    if (sw <= window.innerWidth && sh <= window.innerHeight) return; // 没超出，锁住不动
    dragRef.current = { startX: e.clientX, startY: e.clientY, startTx: t.tx, startTy: t.ty };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) suppressClickRef.current = true;
    const t = transformRef.current;
    // 拖拽同样走预览层：只改 translate，不触发海报重渲染。
    clampAndSet(t.scale, d.startTx + dx, d.startTy + dy, true);
  }

  function onPointerUp() {
    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
      commitZoom(); // 松手后同步一次 React state（也会顺带提交未完成的预览）
    }
  }

  // 单击海报以外的空白 → 关闭（刚拖完不算，双击也不算）。
  function onStageClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (suppressClickRef.current) return;
    const t = transformRef.current;
    const left = t.tx;
    const top = t.ty;
    const right = left + t.scale * POSTER_W;
    const bottom = top + t.scale * cardHRef.current;
    if (e.clientX < left || e.clientX > right || e.clientY < top || e.clientY > bottom) {
      requestClose();
    }
  }

  // 双击在「适应窗口 ↔ 100%」间切换（以双击点为锚点）。
  function onDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    suppressClickRef.current = true;
    const t = transformRef.current;
    if (Math.abs(t.scale - 1) < 1e-3) zoomToFit();
    else zoomAt(e.clientX, e.clientY, 1 / t.scale);
  }

  const canDrag =
    transform.scale * POSTER_W > window.innerWidth ||
    transform.scale * cardH > window.innerHeight;

  // portal 挂 document.body（同导出对话框）：.page-layer 含 transform 会构成 containing block，
  // fixed 子元素若留在页内会相对主内容区而非视口定位。
  return createPortal(
    <div className={`lightbox${visible ? " is-visible" : ""}`} onPointerMove={pokeToolbar}>
      <div
        ref={stageRef}
        className={`lightbox__stage${dragging ? " is-dragging" : ""}${canDrag ? " is-draggable" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="lightbox__motion">
          {/* translate / zoom 全部由 writeDom 直接写入 style，React 只在提交时更新 state，
              避免手势期间重渲染把预览中的 transform 覆盖回去。 */}
          <div ref={scaledRef} className="lightbox__scaled">
            <div ref={paperRef} className="lightbox__paper">
              <div ref={cardRef}>
                <ReportSheet detail={detail} icons={icons} width={POSTER_W} showFooter />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`lightbox__bar${toolbarVisible ? "" : " is-hidden"}`}>
        <span className="lightbox__title">{lightboxTitle(detail)}</span>
        <div className="lightbox__controls">
          <button
            type="button"
            onClick={() => zoomCenter(1 / ZOOM_STEP)}
            disabled={transform.scale <= ZOOM_MIN + 1e-4}
            aria-label="缩小"
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className="lightbox__zoom"
            onClick={zoomToFit}
            title="重置到适应窗口"
          >
            {Math.round(transform.scale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomCenter(ZOOM_STEP)}
            disabled={transform.scale >= ZOOM_MAX - 1e-4}
            aria-label="放大"
          >
            <Plus size={16} />
          </button>
          <button type="button" className="lightbox__export" onClick={handleExport}>
            <Download size={16} />
            导出成图
          </button>
          <button type="button" className="lightbox__close" onClick={requestClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
