/**
 * 键盘 3D 渲染器
 *
 * TODO: 3D 视图存在渲染问题，暂时回退到平面热力图（KeyboardPanel）发版。
 * 修复完成后：
 *   1. 将 Keyboard.tsx 中的 <KeyboardPanel> 替换回 <Keyboard3D>，
 *      同时恢复 invertDragX / invertDragY props 的读取与监听逻辑。
 *   2. Settings.tsx「键盘配列」组里恢复拖拽翻转两个 SettingRow 开关
 *      （kb3d_invert_drag_x / kb3d_invert_drag_y，localStorage 持久化）。
 *   3. 此文件本身无需改动，完整实现已保留在此。
 *
 * 此文件当前未被任何模块 import，不参与构建，仅作备份保留。
 *
 * ---- 原始文档 ---------------------------------------------------------------
 * 键盘 3D 渲染器 —— 输入页主角，取代旧的平面 DOM（KLEKeyboard/KeyboardPanel）。
 *
 * 建模（对应工单【一】~【六】）：
 * - 键帽按「行型」分组，一种行型一个 InstancedMesh（≤6 个），逐键 mesh 一律禁止；
 *   雕刻（高度 / 前倾后仰 / 柱面凹陷 / 侧壁收窄）全部烤进几何，实例矩阵只缩 XZ、不缩 Y。
 * - 外壳 + 定位板 + 轴柱 + 标记用中性色 token（--kb3d-case/plate/stem），绝取暖色阶；
 *   整块键盘挂在 boardGroup 上绕 X 轴转 6° 打字倾角（前端低、后端高）。
 * - MeshBasicMaterial 无光照：键帽立体感来自雕刻 + 键缝 + 固定比例侧面加深，同色键帽
 *   显示色严格一致，不接任何方向光/高光/法线贴图。外壳/定位板用顶点灰度 × 材质色。
 * - 相机自实现（不用 OrbitControls）：默认俯视，俯仰限「俯视 → 与水平约 25°」、
 *   水平 ±40°，滚轮缩放限距，带「重置视角」。
 * - 高度编码开关（默认关、localStorage 持久化）：关=键帽落回定位板、保留行高差；
 *   开=键帽下方生成本周期计数归一化的「轴柱」顶起，上界取 95 分位，超过者顶到最高
 *   并在轴柱上打标记。开启且相机仍在默认俯视时自动过渡到 45°。
 * - 标签图集一次烘焙，实例化 UV 取样，主题切换只换标签深浅两个 uniform。
 * - 按需渲染：无常驻 rAF，仅在数据/主题/视角/悬浮/过渡动画变化时渲染一帧。
 *   页面隐藏/最小化时过渡动画循环完全停止。
 *
 * 生命周期与 WebGL 上下文：
 * - canvas 由 renderer 自建：卸载时 renderer.domElement 从 DOM 移除、渲染资源全
 *   dispose、renderer.dispose + forceContextLoss 显式释放上下文。
 * - 严格模式双重挂载：清理与初始化严格对称、renderer ref 守卫防重复初始化。
 * - 上下文丢失/恢复：监听 webglcontextlost / restored，丢失期间停渲染、显示提示；
 *   恢复后整体重建，相机与高度开关状态保留；短时间反复丢失超阈值则停止重试。
 * - 卸载时销毁场景/几何/材质/纹理/WebGL 上下文；不支持 WebGL 时回落文字。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { BufferGeometry, CanvasTexture } from "three";
import type { LayoutKey } from "../../keyboardLayout";
import { displayLabel } from "../../keyboardLayout";
import { bucketByPercentile } from "../../analytics";
import type { Intensity } from "../../analytics";
import { KEY_GAP, KEY_UNIT } from "../../layouts/metrics";
import {
  applyAtlasUvAttributes,
  buildKeycapAtlas,
  buildKeycapGeometry,
  buildKeycapMaterial,
  ROW_PROFILES,
  rowTypeOf,
  type RowType,
} from "../../three/keycap";
import {
  buildCaseGeometry,
  buildMarkerGeometry,
  buildPlateGeometry,
  buildStemGeometry,
  CASE_BEZEL,
  MARKER_RADIUS,
  PLATE_MARGIN,
  STEM_MAX_W,
  STEM_MIN_W,
} from "../../three/board";
import { observeTheme, readThemeColors, type ThemeColors } from "../../three/tokens";
import KeyCountTooltip, { type KeyCountAnchor } from "./KeyCountTooltip";
import { useKeySelection } from "./KeySelectionContext";

// ---- 相机约束 ---------------------------------------------------------------
const TILT_MIN = 0.012; // 最小俯仰（弧度，从正上方向下；略>0 避免 up 向量退化）
const TILT_MAX = (65 * Math.PI) / 180; // 65° from vertical = 25° above horizontal
const TILT_AUTO = (45 * Math.PI) / 180; // 开启高度编码时自动倾斜到的角度
const YAW_MAX = (40 * Math.PI) / 180; // 水平 ±40°
const FOV = 45; // 垂直视场角（度）
const FIT_MARGIN = 1.1; // 键盘占视口的余量系数
const RADIUS_MIN_FACTOR = 0.42; // 相对 fit 距离的最小缩放
const RADIUS_MAX_FACTOR = 3.0; // 相对 fit 距离的最大缩放
const ROTATE_YAW_PER_PX = 0.006; // 水平拖拽灵敏度（弧度/像素）
const ROTATE_TILT_PER_PX = 0.0045; // 垂直拖拽灵敏度（弧度/像素）
const ZOOM_PER_PX = 0.0012; // 滚轮缩放灵敏度
const DRAG_THRESHOLD_PX = 4; // 位移超过此值判定为拖拽（否则算点击）
const TRANSITION_MS = 340; // 视角/高度过渡时长

// ---- 整块键盘的打字倾角 / 高度编码 -----------------------------------------
const TYPING_ANGLE = (6 * Math.PI) / 180; // 6° 打字倾角（绕 X，前端低后端高）
const MAX_LIFT = 1.1; // 高度编码时轴柱最大抬升（U）
const CASE_SINK = 0.004; // 外壳顶面相对定位板的下沉量，避免共面 z-fighting

// ---- 悬浮高亮 -----------------------------------------------------------------
const HOVER_LIFT = 0.06; // 悬浮键上浮量（U）
const OUTLINE_SCALE = 1.08; // 描边壳外扩比例（XZ）

const ACCENT_FALLBACK = "#7C5CFF";

// ---- 上下文丢失恢复 -----------------------------------------------------------
const MAX_LOSSES = 3; // 短时间内「超过三次」丢失（第 4 次）即放弃自动恢复
const LOSS_WINDOW_MS = 10000; // 判定「短时间内」的滑动窗口

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 读 --color-accent（描边/标记色），主题切换后重读。 */
function readAccent(): Color {
  if (typeof document === "undefined") return new Color(ACCENT_FALLBACK);
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
  return v ? new Color(v) : new Color(ACCENT_FALLBACK);
}

type CameraState = { radius: number; yaw: number; tilt: number };

/** WebGL 运行态：ok 正常 / failed 初始化失败 / lost 丢失待恢复 / dead 放弃重试。 */
type GlStatus = "ok" | "failed" | "lost" | "dead";

type Props = {
  keys: LayoutKey[];
  keyCounts: Record<string, number>;
  allKeyCounts: number[];
  maxX: number;
  maxY: number;
  /** 键位测试页用：高亮这些下标为最高热力（覆盖 keyCounts）。 */
  pressedIndices?: Set<number>;
  /** 翻转上下拖拽（X 轴倾斜）方向；true = 原始方向，false（默认）= 反转。 */
  invertDragX?: boolean;
  /** 翻转左右拖拽（Y 轴旋转）方向；true = 原始方向，false（默认）= 反转。 */
  invertDragY?: boolean;
};

/** 挂载时创建的控制器句柄，供组件层的各 effect 调用。 */
type Keyboard3DController = {
  updateData(): void;
  applyTheme(): void;
  setHeightMode(on: boolean, wasOff: boolean): void;
  setSelected(index: number | null): void;
  resetView(): void;
};

/** 某一行型下的键帽网格 + 描边壳 + 其覆盖的全局键下标。 */
type KeyGroup = {
  rowType: RowType;
  /** 本网格实例 j 对应的全局键下标。 */
  indices: number[];
  mesh: InstancedMesh;
  outline: InstancedMesh;
  geometry: BufferGeometry;
};

/** 可整体销毁再重建的 GL 资源（上下文恢复时用）。 */
type GLResources = {
  groups: KeyGroup[];
  keycapMaterial: MeshBasicMaterial;
  setTextColors: ReturnType<typeof buildKeycapMaterial>["setTextColors"];
  atlasTexture: CanvasTexture;
  outlineMaterial: MeshBasicMaterial;
  boardGroup: Group;
  caseMesh: Mesh;
  caseGeometry: BufferGeometry;
  caseMaterial: MeshBasicMaterial;
  plateMesh: Mesh;
  plateGeometry: BufferGeometry;
  plateMaterial: MeshBasicMaterial;
  stemMesh: InstancedMesh;
  stemGeometry: ReturnType<typeof buildStemGeometry>;
  stemMaterial: MeshBasicMaterial;
  markerMesh: InstancedMesh;
  markerGeometry: ReturnType<typeof buildMarkerGeometry>;
  markerMaterial: MeshBasicMaterial;
};

export default function Keyboard3D({
  keys,
  keyCounts,
  allKeyCounts,
  maxX,
  maxY,
  pressedIndices,
  invertDragX = false,
  invertDragY = false,
}: Props) {
  const { onKeyClick, selectedIndex } = useKeySelection();

  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);

  const [heightMode, setHeightMode] = useState(() => {
    try {
      return localStorage.getItem("kb3d_height") === "1";
    } catch {
      return false;
    }
  });
  const [glStatus, setGlStatus] = useState<GlStatus>("ok");
  const [tooltip, setTooltip] = useState<KeyCountAnchor | null>(null);

  // 变化较频繁的 props 放进 ref，供挂载时创建的控制器实时读取（避免陈旧闭包）
  const dataRef = useRef({ keyCounts, allKeyCounts, pressedIndices });
  dataRef.current = { keyCounts, allKeyCounts, pressedIndices };
  const heightModeRef = useRef(heightMode);
  heightModeRef.current = heightMode;
  // 拖拽方向翻转同样用 ref，避免 useEffect([]) 闭包拿到旧值
  const dragInvertRef = useRef({ invertDragX, invertDragY });
  dragInvertRef.current = { invertDragX, invertDragY };

  const ctrlRef = useRef<Keyboard3DController | null>(null);

  // 高度图例：当前周期最高次数键 + 次数（仅在高度编码开启时显示）
  const heightLegend = useMemo(() => {
    if (!heightMode) return null;
    let best: { code: string; count: number } | null = null;
    for (const k of keys) {
      const c = keyCounts[k.code] ?? 0;
      if (c > 0 && (!best || c > best.count)) best = { code: k.code, count: c };
    }
    if (!best) return null;
    const key = keys.find((k) => k.code === best.code);
    return { name: key ? displayLabel(key) : best.code, count: best.count };
  }, [heightMode, keys, keyCounts]);

  // 挂载：搭场景 / 相机 / 网格 / 事件，返回控制器与清理函数。
  // 一个 effect 内创建的所有资源，由同一个清理函数销毁（严格对称，勿分散）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 守卫：renderer 已存在则不再初始化（异常路径下清理未跑时的最后防线）
    if (rendererRef.current) return;

    let renderer: WebGLRenderer;
    try {
      // canvas 由 renderer 自建：每次挂载都是全新 canvas，严格模式双重挂载
      // 不会复用上一个已被 forceContextLoss 丢失上下文的 canvas。
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      setGlStatus("failed");
      return;
    }
    rendererRef.current = renderer;
    const canvas = renderer.domElement;
    canvas.className = "kb3d-canvas";
    container.appendChild(canvas);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0); // 透明背景，透出页面 token 底色

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);

    // 上下文丢失/恢复状态（effect 作用域内的 let，事件处理器闭包实时共享）
    let contextLost = false;
    let gaveUp = false;
    let lossTimes: number[] = [];

    // 每键的几何中心与 XZ 缩放（高度 Y 已烤进几何，实例矩阵不再缩 Y）
    const gapU = KEY_GAP / KEY_UNIT;
    const n = keys.length;
    const keyCenterX = new Float32Array(n);
    const keyCenterZ = new Float32Array(n);
    const keyScaleX = new Float32Array(n);
    const keyScaleZ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      keyCenterX[i] = k.x + k.w / 2 - maxX / 2;
      keyCenterZ[i] = k.y + k.h / 2 - maxY / 2;
      keyScaleX[i] = k.w - gapU;
      keyScaleZ[i] = k.h - gapU;
    }

    // 整块键盘（外壳/定位板/键帽/轴柱/标记）的外形尺寸，用于相机 fit
    const plateW = maxX + 2 * PLATE_MARGIN;
    const plateH = maxY + 2 * PLATE_MARGIN;
    const boardW = plateW + 2 * CASE_BEZEL;
    const boardH = plateH + 2 * CASE_BEZEL;

    const themeRef: { current: ThemeColors } = { current: readThemeColors() };
    const camRef: { current: CameraState } = { current: { radius: 1, yaw: 0, tilt: TILT_MIN } };
    const camTargetRef: { current: CameraState | null } = { current: null };
    const userAdjustedRef: { current: boolean } = { current: false };
    const liftRef = {
      current: new Float32Array(n),
      target: new Float32Array(n),
    };
    const p95Ref: { current: number } = { current: 0 }; // 当前周期 95 分位（高度编码上界）
    const hoverRef: { current: number | null } = { current: null };
    const selectedRef: { current: number | null } = { current: null };
    const animRef: { current: number | null } = { current: null };
    const dragRef = {
      active: false,
      moved: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
    };
    const lastTooltipKeyRef = { current: "" };

    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const _pos = new Vector3();
    const _scale = new Vector3();
    const _q = new Quaternion();
    const _m = new Matrix4();

    // ---- 每键计数 / 档位 ------------------------------------------------------
    const countOf = (i: number): number => {
      const d = dataRef.current;
      if (d.pressedIndices?.has(i)) return 1;
      return d.keyCounts[keys[i].code] ?? 0;
    };
    const levelOf = (i: number): Intensity => {
      const d = dataRef.current;
      if (d.pressedIndices?.has(i)) return 4;
      return bucketByPercentile(countOf(i), d.allKeyCounts);
    };

    // ---- 相机 ------------------------------------------------------------------
    const fitRadius = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      const aspect = w / h;
      const tan = Math.tan(((FOV * Math.PI) / 180) / 2);
      const rY = (boardH * FIT_MARGIN) / (2 * tan);
      const rX = (boardW * FIT_MARGIN) / (2 * tan * aspect);
      return Math.max(rY, rX);
    };
    const applyCamera = () => {
      const { radius, yaw, tilt } = camRef.current;
      const st = Math.sin(tilt);
      camera.position.set(radius * st * Math.sin(yaw), radius * Math.cos(tilt), radius * st * Math.cos(yaw));
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
    };

    // ---- 可重建 GL 资源 --------------------------------------------------------
    const resourcesRef: { current: GLResources | null } = { current: null };

    /** 销毁当前 GL 资源（几何/材质/纹理/网格）并从场景移除。上下文已丢失时
     *  这些 dispose 是 no-op，仍走一遍以保证 JS 引用释放；失败忽略。 */
    const disposeResources = () => {
      const res = resourcesRef.current;
      if (!res) return;
      try {
        scene.remove(res.boardGroup);
        for (const g of res.groups) {
          g.mesh.dispose();
          g.outline.dispose();
          g.geometry.dispose();
        }
        res.keycapMaterial.dispose();
        res.atlasTexture.dispose();
        res.outlineMaterial.dispose();
        res.caseMesh.geometry.dispose();
        res.caseMaterial.dispose();
        res.plateMesh.geometry.dispose();
        res.plateMaterial.dispose();
        res.stemMesh.dispose();
        res.stemGeometry.dispose();
        res.stemMaterial.dispose();
        res.markerMesh.dispose();
        res.markerGeometry.dispose();
        res.markerMaterial.dispose();
      } catch {
        /* 上下文已丢失，dispose 可能抛错，忽略 */
      }
      resourcesRef.current = null;
    };

    /** 构建几何 + 图集 + 材质 + 行型网格 + 外壳/定位板/轴柱/标记（首次挂载与上下文恢复共用）。 */
    const buildResources = () => {
      const atlas = buildKeycapAtlas(keys, dpr);
      const { material, setTextColors } = buildKeycapMaterial(atlas.texture);
      const outlineMaterial = new MeshBasicMaterial({
        color: readAccent(),
        side: DoubleSide,
        depthWrite: false,
      });

      const boardGroup = new Group();
      boardGroup.rotation.x = TYPING_ANGLE;
      scene.add(boardGroup);

      // 键帽按行型分组 → 每行型一个 InstancedMesh + 一个描边壳
      const byRow = new Map<RowType, number[]>();
      keys.forEach((k, i) => {
        const rt = rowTypeOf(k);
        const list = byRow.get(rt);
        if (list) list.push(i);
        else byRow.set(rt, [i]);
      });
      const groups: KeyGroup[] = [];
      for (const [rowType, indices] of byRow) {
        const geometry = buildKeycapGeometry(ROW_PROFILES[rowType]);
        applyAtlasUvAttributes(geometry, indices.map((gi) => atlas.cells[gi]));
        const mesh = new InstancedMesh(geometry, material, indices.length);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.renderOrder = 0;
        boardGroup.add(mesh);

        const outline = new InstancedMesh(geometry, outlineMaterial, 1);
        outline.instanceMatrix.setUsage(DynamicDrawUsage);
        outline.renderOrder = -1;
        outline.visible = false;
        boardGroup.add(outline);

        groups.push({ rowType, indices, mesh, outline, geometry });
      }

      // 外壳（四周边框 + 底座）与定位板（键缝露出的深中性表面）
      const plateGeometry = buildPlateGeometry(plateW, plateH);
      const plateMaterial = new MeshBasicMaterial({ vertexColors: true, color: themeRef.current.plate });
      const plateMesh = new Mesh(plateGeometry, plateMaterial);
      plateMesh.renderOrder = -3;
      boardGroup.add(plateMesh);

      const caseGeometry = buildCaseGeometry(boardW, boardH);
      const caseMaterial = new MeshBasicMaterial({ vertexColors: true, color: themeRef.current.caseColor });
      const caseMesh = new Mesh(caseGeometry, caseMaterial);
      caseMesh.position.y = -CASE_SINK;
      caseMesh.renderOrder = -3;
      boardGroup.add(caseMesh);

      // 轴柱（高度编码把键帽顶起的中性柱体）与超 95 分位标记
      const stemGeometry = buildStemGeometry();
      const stemMaterial = new MeshBasicMaterial({ color: themeRef.current.stem });
      const stemMesh = new InstancedMesh(stemGeometry, stemMaterial, n);
      stemMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      stemMesh.renderOrder = -2;
      boardGroup.add(stemMesh);

      const markerGeometry = buildMarkerGeometry();
      const markerMaterial = new MeshBasicMaterial({ color: readAccent() });
      const markerMesh = new InstancedMesh(markerGeometry, markerMaterial, n);
      markerMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      markerMesh.renderOrder = 0;
      boardGroup.add(markerMesh);

      resourcesRef.current = {
        groups,
        keycapMaterial: material,
        setTextColors,
        atlasTexture: atlas.texture,
        outlineMaterial,
        boardGroup,
        caseMesh,
        caseGeometry,
        caseMaterial,
        plateMesh,
        plateGeometry,
        plateMaterial,
        stemMesh,
        stemGeometry,
        stemMaterial,
        markerMesh,
        markerGeometry,
        markerMaterial,
      };
    };
    buildResources();

    // ---- 矩阵 / 描边 / 渲染 ---------------------------------------------------
    const writeMatrices = () => {
      const res = resourcesRef.current;
      if (!res) return;
      const p95 = p95Ref.current;

      // 键帽：XZ 缩放按键宽高，Y 恒为 1（雕刻已烤进几何），Y 位置 = 轴柱抬升 + 悬浮
      for (const g of res.groups) {
        for (let j = 0; j < g.indices.length; j++) {
          const i = g.indices[j];
          const hover = i === hoverRef.current ? HOVER_LIFT : 0;
          _pos.set(keyCenterX[i], liftRef.current[i] + hover, keyCenterZ[i]);
          _scale.set(keyScaleX[i], 1, keyScaleZ[i]);
          _m.compose(_pos, _q, _scale);
          g.mesh.setMatrixAt(j, _m);
        }
        g.mesh.instanceMatrix.needsUpdate = true;
      }

      // 轴柱：居中的中性柱体，从定位板顶到抬升高度；抬升为 0 时全零缩放隐藏
      const stem = res.stemMesh;
      for (let i = 0; i < n; i++) {
        const lift = liftRef.current[i];
        const sw = Math.max(STEM_MIN_W, Math.min(STEM_MAX_W, Math.min(keyScaleX[i], keyScaleZ[i]) * 0.5));
        if (lift <= 0) {
          _pos.set(0, 0, 0);
          _scale.set(0, 0, 0);
        } else {
          _pos.set(keyCenterX[i], lift / 2, keyCenterZ[i]);
          _scale.set(sw, lift, sw);
        }
        _m.compose(_pos, _q, _scale);
        stem.setMatrixAt(i, _m);
      }
      stem.instanceMatrix.needsUpdate = true;

      // 标记：高度编码开启且计数超过 95 分位 → 轴柱前端一个小球；否则全零缩放隐藏
      const marker = res.markerMesh;
      for (let i = 0; i < n; i++) {
        const exceed = heightModeRef.current && p95 > 0 && countOf(i) > p95;
        if (!exceed) {
          _pos.set(0, 0, 0);
          _scale.set(0, 0, 0);
        } else {
          const lift = liftRef.current[i];
          const sw = Math.max(STEM_MIN_W, Math.min(STEM_MAX_W, Math.min(keyScaleX[i], keyScaleZ[i]) * 0.5));
          _pos.set(keyCenterX[i], lift - MARKER_RADIUS, keyCenterZ[i] + sw / 2 + MARKER_RADIUS * 0.3);
          _scale.set(1, 1, 1);
        }
        _m.compose(_pos, _q, _scale);
        marker.setMatrixAt(i, _m);
      }
      marker.instanceMatrix.needsUpdate = true;
    };
    const updateOutline = () => {
      const res = resourcesRef.current;
      if (!res) return;
      const idx = hoverRef.current ?? selectedRef.current;
      for (const g of res.groups) {
        if (idx == null || !g.indices.includes(idx)) {
          g.outline.visible = false;
          continue;
        }
        g.outline.visible = true;
        const hover = idx === hoverRef.current ? HOVER_LIFT : 0;
        _pos.set(keyCenterX[idx], liftRef.current[idx] + hover, keyCenterZ[idx]);
        // 只外扩 XZ、不抬高 Y：描边只在四周形成一圈，不从键帽顶上冒出来
        _scale.set(keyScaleX[idx] * OUTLINE_SCALE, 1, keyScaleZ[idx] * OUTLINE_SCALE);
        _m.compose(_pos, _q, _scale);
        g.outline.setMatrixAt(0, _m);
        g.outline.instanceMatrix.needsUpdate = true;
      }
    };
    /** 渲染前校验上下文有效，丢失/无资源/渲染器失效则跳过，不抛错。 */
    const contextOk = (): boolean => {
      if (contextLost || !resourcesRef.current) return false;
      try {
        const gl = renderer.getContext();
        return !(gl && typeof gl.isContextLost === "function" && gl.isContextLost());
      } catch {
        return false;
      }
    };
    const render = () => {
      if (!contextOk()) return;
      applyCamera();
      writeMatrices();
      updateOutline();
      try {
        renderer.render(scene, camera);
      } catch {
        /* 上下文丢失瞬间抛错则跳过本帧 */
      }
    };

    // ---- 颜色 ------------------------------------------------------------------
    const applyColors = () => {
      const res = resourcesRef.current;
      if (!res) return;
      const theme = themeRef.current;
      for (const g of res.groups) {
        for (let j = 0; j < g.indices.length; j++) {
          g.mesh.setColorAt(j, theme.intensity[levelOf(g.indices[j])]);
        }
        g.mesh.instanceColor!.needsUpdate = true;
      }
    };
    const applyTheme = () => {
      if (!resourcesRef.current) return;
      const res = resourcesRef.current;
      themeRef.current = readThemeColors();
      applyColors();
      res.setTextColors(themeRef.current.darkText, themeRef.current.lightText);
      res.outlineMaterial.color.copy(readAccent());
      res.caseMaterial.color.copy(themeRef.current.caseColor);
      res.plateMaterial.color.copy(themeRef.current.plate);
      res.stemMaterial.color.copy(themeRef.current.stem);
      res.markerMaterial.color.copy(readAccent());
      render();
    };

    // ---- 轴柱抬升目标 ----------------------------------------------------------
    /** 当前周期非零计数的 95 分位（高度编码上界）。 */
    const computeP95 = (): number => {
      const arr: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = countOf(i);
        if (c > 0) arr.push(c);
      }
      if (arr.length === 0) return 0;
      arr.sort((a, b) => a - b);
      return arr[Math.floor(arr.length * 0.95)];
    };
    const computeTargetLift = (): Float32Array => {
      const arr = new Float32Array(n);
      if (!heightModeRef.current) {
        p95Ref.current = 0;
        return arr;
      }
      const p95 = computeP95();
      p95Ref.current = p95;
      if (p95 <= 0) return arr;
      for (let i = 0; i < n; i++) {
        const c = countOf(i);
        if (c <= 0) continue;
        arr[i] = Math.min(c / p95, 1) * MAX_LIFT;
      }
      return arr;
    };

    // ---- 过渡动画（轴柱 + 相机共用一条 rAF 循环） ------------------------------
    const stopAnim = () => {
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
    const startAnim = (duration: number) => {
      stopAnim();
      const startLift = Float32Array.from(liftRef.current);
      const targetLift = liftRef.target;
      const startCam = { ...camRef.current };
      const hasCamTarget = camTargetRef.current != null;
      const targetCam = camTargetRef.current ?? startCam;
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const e = easeInOutCubic(t);
        const cur = liftRef.current;
        for (let i = 0; i < n; i++) {
          cur[i] = startLift[i] + (targetLift[i] - startLift[i]) * e;
        }
        if (hasCamTarget) {
          camRef.current.radius = startCam.radius + (targetCam.radius - startCam.radius) * e;
          camRef.current.yaw = startCam.yaw + (targetCam.yaw - startCam.yaw) * e;
          camRef.current.tilt = startCam.tilt + (targetCam.tilt - startCam.tilt) * e;
        }
        render();
        if (t < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          animRef.current = null;
          cur.set(targetLift);
          if (hasCamTarget) {
            camRef.current = { ...targetCam };
            camTargetRef.current = null;
          }
          render();
        }
      };
      animRef.current = requestAnimationFrame(step);
    };

    // ---- 悬浮 / 拾取 -----------------------------------------------------------
    const pickKey = (clientX: number, clientY: number): number | null => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const res = resourcesRef.current;
      if (!res) return null;
      let best: { id: number; distance: number } | null = null;
      for (const g of res.groups) {
        const hits = raycaster.intersectObject(g.mesh, false);
        for (const h of hits) {
          if (h.instanceId == null) continue;
          if (!best || h.distance < best.distance) {
            best = { id: g.indices[h.instanceId], distance: h.distance };
          }
        }
      }
      return best ? best.id : null;
    };
    const setHover = (idx: number | null) => {
      if (hoverRef.current === idx) return;
      hoverRef.current = idx;
      render();
    };
    const updateTooltip = (idx: number | null, clientX: number, clientY: number) => {
      if (idx == null) {
        if (lastTooltipKeyRef.current !== "") {
          lastTooltipKeyRef.current = "";
          setTooltip(null);
        }
        return;
      }
      const key = keys[idx];
      const name = displayLabel(key);
      const count = countOf(idx);
      const level = levelOf(idx);
      const exceedsScale = heightModeRef.current && p95Ref.current > 0 && count > p95Ref.current;
      const tkey = `${idx}|${count}|${level}|${exceedsScale}`;
      if (lastTooltipKeyRef.current === tkey) {
        // 内容没变，仅光标移动时同步坐标，避免每帧重建 tooltip 状态
        setTooltip((prev) => (prev ? { ...prev, x: clientX, y: clientY } : prev));
        return;
      }
      lastTooltipKeyRef.current = tkey;
      setTooltip({ name, count, level, exceedsScale, x: clientX, y: clientY });
    };

    // ---- 指针 / 滚轮 -----------------------------------------------------------
    const onPointerDown = (e: PointerEvent) => {
      dragRef.active = true;
      dragRef.moved = false;
      dragRef.startX = e.clientX;
      dragRef.startY = e.clientY;
      dragRef.lastX = e.clientX;
      dragRef.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const idx = pickKey(e.clientX, e.clientY);
      if (dragRef.active) {
        const dx = e.clientX - dragRef.lastX;
        const dy = e.clientY - dragRef.lastY;
        dragRef.lastX = e.clientX;
        dragRef.lastY = e.clientY;
        if (!dragRef.moved && Math.hypot(e.clientX - dragRef.startX, e.clientY - dragRef.startY) > DRAG_THRESHOLD_PX) {
          dragRef.moved = true;
        }
        if (dragRef.moved) {
          userAdjustedRef.current = true;
          const { invertDragX: ix, invertDragY: iy } = dragInvertRef.current;
          // 默认（false）= 反转；true = 原始方向
          const signX = iy ? 1 : -1;
          const signY = ix ? 1 : -1;
          camRef.current.yaw = Math.max(-YAW_MAX, Math.min(YAW_MAX, camRef.current.yaw + dx * signX * ROTATE_YAW_PER_PX));
          camRef.current.tilt = Math.max(TILT_MIN, Math.min(TILT_MAX, camRef.current.tilt + dy * signY * ROTATE_TILT_PER_PX));
          render();
        }
      } else {
        setHover(idx);
        updateTooltip(idx, e.clientX, e.clientY);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      dragRef.active = false;
      if (!dragRef.moved && onKeyClick) {
        const idx = pickKey(e.clientX, e.clientY);
        if (idx != null) onKeyClick(keys[idx]);
      }
      dragRef.moved = false;
    };
    const onPointerLeave = () => {
      setHover(null);
      updateTooltip(null, 0, 0);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userAdjustedRef.current = true;
      const fit = fitRadius();
      const factor = Math.exp(e.deltaY * ZOOM_PER_PX);
      const next = Math.max(fit * RADIUS_MIN_FACTOR, Math.min(fit * RADIUS_MAX_FACTOR, camRef.current.radius * factor));
      camRef.current.radius = next;
      render();
    };

    // ---- 上下文丢失 / 恢复 -----------------------------------------------------
    const onContextLost = (e: Event) => {
      e.preventDefault(); // 不调用则上下文永久丢失、无法恢复
      if (gaveUp) return;
      contextLost = true;
      stopAnim(); // 立即停渲染循环，不再调用任何 GL 方法
      const now = performance.now();
      lossTimes = lossTimes.filter((t) => now - t < LOSS_WINDOW_MS);
      lossTimes.push(now);
      if (lossTimes.length > MAX_LOSSES) {
        gaveUp = true;
        setGlStatus("dead"); // 反复丢失：停止重试，显示持久提示
      } else {
        setGlStatus("lost");
      }
    };
    const onContextRestored = () => {
      if (gaveUp) return; // 已放弃，不再重建
      try {
        disposeResources();
        buildResources();
        contextLost = false;
        // camRef / liftRef / themeRef / heightMode 是 JS 态，天然保留：
        // 相机角度、缩放、高度开关、轴柱抬升、颜色全数恢复，不重置为默认值。
        applyColors();
        resourcesRef.current!.setTextColors(themeRef.current.darkText, themeRef.current.lightText);
        resourcesRef.current!.caseMaterial.color.copy(themeRef.current.caseColor);
        resourcesRef.current!.plateMaterial.color.copy(themeRef.current.plate);
        resourcesRef.current!.stemMaterial.color.copy(themeRef.current.stem);
        resourcesRef.current!.markerMaterial.color.copy(readAccent());
        writeMatrices();
        setGlStatus("ok");
        render();
      } catch {
        gaveUp = true;
        setGlStatus("dead"); // 重建失败：停止重试，显示持久提示
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    // ---- 尺寸 / 可见性 ---------------------------------------------------------
    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userAdjustedRef.current) {
        camRef.current.radius = fitRadius();
      }
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    const onVisibility = () => {
      if (document.hidden) stopAnim();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // ---- 控制器（供其它 effect 调用） -----------------------------------------
    const controller: Keyboard3DController = {
      updateData() {
        liftRef.target = computeTargetLift();
        applyColors();
        if (!heightModeRef.current) {
          // 高度编码关闭：轴柱抬升恒 0，直接同步（避免无谓动画）
          liftRef.current.set(liftRef.target);
          render();
        } else {
          // 高度编码开启：数据变化时平滑过渡到新抬升
          startAnim(TRANSITION_MS);
        }
      },
      applyTheme,
      setHeightMode(on: boolean, wasOff: boolean) {
        liftRef.target = computeTargetLift();
        if (on && wasOff && !userAdjustedRef.current) {
          // 从「关闭」切到「开启」，且相机仍在默认俯视 → 自动过渡到 45° 倾斜
          camTargetRef.current = { radius: camRef.current.radius, yaw: camRef.current.yaw, tilt: TILT_AUTO };
        } else {
          camTargetRef.current = null;
        }
        startAnim(TRANSITION_MS);
      },
      setSelected(index: number | null) {
        selectedRef.current = index;
        render();
      },
      resetView() {
        userAdjustedRef.current = false;
        camTargetRef.current = { radius: fitRadius(), yaw: 0, tilt: TILT_MIN };
        startAnim(TRANSITION_MS);
      },
    };
    ctrlRef.current = controller;

    // ---- 初始状态 --------------------------------------------------------------
    const initW = container.clientWidth || 1;
    const initH = container.clientHeight || 1;
    renderer.setSize(initW, initH, false);
    camera.aspect = initW / initH;
    camera.updateProjectionMatrix();
    camRef.current.radius = fitRadius();
    liftRef.current.set(computeTargetLift());
    applyColors();
    resourcesRef.current!.setTextColors(themeRef.current.darkText, themeRef.current.lightText);
    render();

    // ---- 清理（同步，与初始化严格配对） ----------------------------------------
    return () => {
      ctrlRef.current = null;
      stopAnim(); // 取消未完成的 rAF
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      disposeResources(); // geometry/material/texture 全 dispose + 网格从场景移除
      renderer.dispose();
      try {
        renderer.forceContextLoss(); // 显式释放 WebGL 上下文
      } catch {
        /* 已释放，忽略 */
      }
      canvas.remove(); // renderer.domElement 从 DOM 移除
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变化 → 重算颜色/轴柱
  useEffect(() => {
    ctrlRef.current?.updateData();
  }, [keyCounts, allKeyCounts, pressedIndices]);

  // 主题变化 → 重读 token
  useEffect(() => {
    return observeTheme(() => ctrlRef.current?.applyTheme());
  }, []);

  // 高度编码开关（跳过挂载首跑；挂载时初始轴柱已在 setup 里算好）
  const prevHeightModeRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevHeightModeRef.current === null) {
      prevHeightModeRef.current = heightMode;
      return;
    }
    if (prevHeightModeRef.current === heightMode) return;
    const wasOff = prevHeightModeRef.current === false;
    prevHeightModeRef.current = heightMode;
    try {
      localStorage.setItem("kb3d_height", heightMode ? "1" : "0");
    } catch {
      /* 隐私模式等场景忽略 */
    }
    ctrlRef.current?.setHeightMode(heightMode, wasOff);
  }, [heightMode]);

  // 选中态变化 → 刷新描边
  useEffect(() => {
    ctrlRef.current?.setSelected(selectedIndex ?? null);
  }, [selectedIndex]);

  const resetView = () => ctrlRef.current?.resetView();

  return (
    <div
      className="kb3d"
      ref={containerRef}
      style={{ aspectRatio: `${maxX} / ${maxY}` }}
    >
      {glStatus !== "ok" && (
        <div className="kb3d-fallback">
          {glStatus === "failed"
            ? "此环境不支持 WebGL，无法渲染 3D 键盘"
            : glStatus === "lost"
              ? "渲染上下文丢失，正在恢复…"
              : "渲染上下文反复丢失，已停止重试，请刷新页面"}
        </div>
      )}
      <div className="kb3d-controls">
        <button className="kb3d-btn" onClick={resetView} title="回到默认俯视视角">
          重置视角
        </button>
        <button
          className={`kb3d-btn${heightMode ? " is-on" : ""}`}
          onClick={() => setHeightMode((v) => !v)}
          title="用键帽高度编码击键次数"
        >
          显示敲击次数高度
        </button>
      </div>
      {heightMode && heightLegend && (
        <div className="kb3d-height-legend">
          最高 <span className="kb3d-legend-key">{heightLegend.name}</span>
          <span className="kb3d-legend-num">{heightLegend.count.toLocaleString()} 次</span>
        </div>
      )}
      {tooltip && <KeyCountTooltip anchor={tooltip} />}
    </div>
  );
}
