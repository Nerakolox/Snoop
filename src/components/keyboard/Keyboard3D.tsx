/**
 * 键盘 3D 渲染器 —— 输入页主角，取代旧的平面 DOM（KLEKeyboard/KeyboardPanel）。
 *
 * 建模：
 * - 键帽按「行型」分组，一种行型一个 InstancedMesh（≤6 个），逐键 mesh 一律禁止；
 *   雕刻（高度 / 前倾后仰 / 柱面凹陷 / 侧壁收窄）全部烤进几何，实例矩阵只缩 XZ、不缩 Y。
 *   行型判定不依赖固定 y 值：按「该键在本配列里第几行 + 本配列总行数」映射，
 *   覆盖任意行数的配列（见 three/keycap.ts 的 computeRowContext/rowTypeOf）。
 * - 外壳 + 键位格用中性色 token（--kb3d-case/plate），绝取暖色阶；
 *   整块键盘挂在 boardGroup 上绕 X 轴转 6° 打字倾角（前端低、后端高）。
 * - 真实光照：MeshStandardMaterial（PBR）+ 半球光/环境光/主光 + 两盏方向补光，
 *   ACES 色调映射 + PCFSoft 阴影。键帽立体感来自雕刻几何 + 解析法线 + 阴影，
 *   外壳/键位格表面用 roughness 区分塑料与亚光材质，不再烘焙顶点灰度。
 * - 键位格是一整片按配列凿孔的网格：键帽从孔里升起，孔壁与凹槽底接住落影，
 *   键帽抬起时能看到真实的键座凹陷，而不是贴在一块平面上。
 * - 相机自实现（不用 OrbitControls）：默认三分之四视角（俯仰 38°），
 *   俯仰限「俯视 → 与水平约 25°」、水平 ±40°，滚轮缩放限距，带「重置视角」。
 * - 高度编码开关（默认关、localStorage 持久化）：键帽永不离开键位格；计数改由
 *   键帽正上方的悬浮数值牌表达（见 three/plates.ts）——牌子悬空高度 = 固定间距 +
 *   √(计数/p95) 的抬升量，牌面直接写次数，超 95 分位换强调色描边并拉出引导线。
 *   开/关与数据变化都带过渡动画，牌子本体随相机 billboard 朝向。
 * - 标签图集一次烘焙，实例化 UV 取样，主题切换只换标签深浅两个 uniform。
 * - 按需渲染：无常驻 rAF，仅在数据/主题/视角/悬浮/过渡动画变化时渲染一帧。
 *   页面隐藏/最小化时过渡动画循环完全停止。
 * - 自定义 KLE 配列的键可能没有 W3C code（legend→code 映射不在本次范围内）：
 *   无 code 的键按 0 次/无数据处理，不参与热力统计，不影响其它键正常渲染。
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
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { BufferGeometry, CanvasTexture, Texture } from "three";
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
  computeRowContext,
  ROW_PROFILES,
  rowTypeOf,
  type RowType,
} from "../../three/keycap";
import { buildCaseGeometry, buildDeckGeometry, CASE_BEZEL } from "../../three/board";
import {
  buildPlateResources,
  DIGIT_HEIGHT,
  formatCount,
  GUIDE_WIDTH,
  PLATE_GAP,
  PLATE_HEIGHT,
  PLATE_RISE,
  PLATE_WIDTH,
} from "../../three/plates";
import { observeTheme, readThemeColors, type ThemeColors } from "../../three/tokens";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import KeyCountTooltip, { type KeyCountAnchor } from "./KeyCountTooltip";
import { useKeySelection } from "./KeySelectionContext";

// ---- 相机约束 ---------------------------------------------------------------
const TILT_MIN = 0.012; // 最小俯仰（弧度，从正上方向下；略>0 避免 up 向量退化）
const TILT_MAX = (65 * Math.PI) / 180; // 65° from vertical = 25° above horizontal
const TILT_DEFAULT = (38 * Math.PI) / 180; // 默认三分之四视角：能同时看到顶面与前面
const YAW_MAX = (40 * Math.PI) / 180; // 水平 ±40°
const FOV = 45; // 垂直视场角（度）
const FIT_MARGIN = 1.1; // 键盘占视口的余量系数
// 容器高度按「配列 U 宽高比」再除以此系数：配列本身很扁（宽:高 ~3.5:1），
// 直接照搬到 3D 画布会显得矮；相机 fit 逻辑按容器实际宽高比重算距离，
// 加高容器不会裁切或拉伸键盘，只是留出更多竖向空间看清俯仰视角。
const CONTAINER_HEIGHT_BOOST = 1.15;
const RADIUS_MIN_FACTOR = 0.42; // 相对 fit 距离的最小缩放
const RADIUS_MAX_FACTOR = 3.0; // 相对 fit 距离的最大缩放
const ROTATE_YAW_PER_PX = 0.006; // 水平拖拽灵敏度（弧度/像素）
const ROTATE_TILT_PER_PX = 0.0045; // 垂直拖拽灵敏度（弧度/像素）
const ZOOM_PER_PX = 0.0012; // 滚轮缩放灵敏度
const DRAG_THRESHOLD_PX = 4; // 位移超过此值判定为拖拽（否则算点击）
const TRANSITION_MS = 340; // 视角/高度过渡时长

// ---- 整块键盘的打字倾角 / 数值牌 -------------------------------------------
const TYPING_ANGLE = (6 * Math.PI) / 180; // 6° 打字倾角（绕 X，前端低后端高）

// ---- 真实光照（PBR）---------------------------------------------------------
const SHADOW_MAP_SIZE = 2048;
const LIGHT_KEY_COLOR = 0xfff3e6;
const LIGHT_FILL_COLOR = 0xb9c7ff;

// ---- 悬浮高亮 -----------------------------------------------------------------
const HOVER_LIFT = 0.06; // 悬浮键上浮量（U）
const OUTLINE_SCALE = 1.08; // 描边壳外扩比例（XZ）

/** 字形在牌面上的竖向偏移：字体基线落在牌面中线上，视觉居中。 */
const DIGIT_Y_OFFSET = 0.004;

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
  setHeightMode(): void;
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
  keycapMaterial: MeshStandardMaterial;
  setTextColors: ReturnType<typeof buildKeycapMaterial>["setTextColors"];
  atlasTexture: CanvasTexture;
  outlineMaterial: MeshBasicMaterial;
  boardGroup: Group;
  caseMesh: Mesh;
  caseGeometry: BufferGeometry;
  caseMaterial: MeshStandardMaterial;
  deckMesh: Mesh;
  deckGeometry: BufferGeometry;
  deckMaterial: MeshStandardMaterial;
  /** 悬浮数值牌（牌子 / 引导线 / 数字）整组资源。 */
  plates: ReturnType<typeof buildPlateResources>;
  /** 室内环境贴图（PMREM 预滤波）：金属外壳的主要受光来源。 */
  envTexture: Texture;
  pmrem: PMREMGenerator;
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
      if (!k.code) continue;
      const c = keyCounts[k.code] ?? 0;
      if (c > 0 && (!best || c > best.count)) best = { code: k.code, count: c };
    }
    if (!best) return null;
    const key = keys.find((k) => k.code === best!.code);
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
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    const scene = new Scene();
    // 环境反射强度：RoomEnvironment 本身偏亮，压一档免得铝壳发灰、键帽发白。
    scene.environmentIntensity = 0.6;
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
    // 行判定上下文：优先读 key.row，缺失时整体按 y 聚类兜底（见 three/keycap.ts）
    const rowCtx = computeRowContext(keys);
    // 每键键帽顶面高度（行型剖面高）：数值牌的悬空起点，键帽本身不动
    const capTopY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      capTopY[i] = ROW_PROFILES[rowTypeOf(keys[i], rowCtx)].height;
    }

    // 整块键盘（外壳/键位格/键帽/轴柱/标记）的外形尺寸，用于相机 fit
    const boardW = maxX + 2 * CASE_BEZEL;
    const boardH = maxY + 2 * CASE_BEZEL;

    // ---- 场景灯光 --------------------------------------------------------------
    // 环境图接管了大部分漫反射与环境照明，直射光只负责塑形与投影：
    // 暖色主光自左上打下，塑键帽体积与凹槽阴影；冷色补光提亮背光侧面；
    // 后方轮廓光把外壳边缘从背景里勾出来。半球光压到很低，只留一点天地色差。
    scene.add(new HemisphereLight(0xfff8f0, 0x3a3340, 0.22));
    scene.add(new AmbientLight(0xffffff, 0.04));

    const keyLight = new DirectionalLight(LIGHT_KEY_COLOR, 1.9);
    keyLight.position.set(-6, 12, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.01;
    {
      // 阴影正交感光区只需覆盖键盘本身；留一点余量给抬起的键帽。
      const span = Math.max(boardW, boardH) * 0.62 + 1;
      const sc = keyLight.shadow.camera;
      sc.left = -span;
      sc.right = span;
      sc.top = span;
      sc.bottom = -span;
      sc.near = 0.5;
      sc.far = 40;
      sc.updateProjectionMatrix();
    }
    scene.add(keyLight);
    scene.add(keyLight.target);

    const fillLight = new DirectionalLight(LIGHT_FILL_COLOR, 0.55);
    fillLight.position.set(9, 6, -7);
    scene.add(fillLight);

    const rimLight = new DirectionalLight(0xffffff, 0.7);
    rimLight.position.set(0, 4, -12);
    scene.add(rimLight);

    const themeRef: { current: ThemeColors } = { current: readThemeColors() };
    const camRef: { current: CameraState } = { current: { radius: 1, yaw: 0, tilt: TILT_DEFAULT } };
    const camTargetRef: { current: CameraState | null } = { current: null };
    const userAdjustedRef: { current: boolean } = { current: false };
    const riseRef = {
      current: new Float32Array(n),
      target: new Float32Array(n),
    };
    // 数值牌整体可见度（0 → 1）：高度编码开关的淡入淡出，与抬升共用一条过渡动画
    const plateMixRef = { current: 0, target: 0 };
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
      const code = keys[i].code;
      return code ? d.keyCounts[code] ?? 0 : 0;
    };
    const levelOf = (i: number): Intensity => {
      const d = dataRef.current;
      if (d.pressedIndices?.has(i)) return 4;
      return bucketByPercentile(countOf(i), d.allKeyCounts);
    };

    // ---- 相机 ------------------------------------------------------------------
    /** 按当前俯仰估算 fit 距离：斜视时近端前缘离相机更近、远端后缘在屏幕上更高，
     *  只按正投影算会把近端切掉，所以按俯仰补一点余量。 */
    const fitRadius = (tilt: number = camRef.current.tilt) => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      const aspect = w / h;
      const tan = Math.tan(((FOV * Math.PI) / 180) / 2);
      const depth = (boardH / 2) * Math.sin(tilt);
      const rX = (boardW * FIT_MARGIN) / (2 * tan * aspect) + depth * 0.5;
      const rY = (boardH * Math.cos(tilt) * FIT_MARGIN) / (2 * tan);
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
        res.deckMesh.geometry.dispose();
        res.deckMaterial.dispose();
        res.plates.dispose();
        res.envTexture.dispose();
        res.pmrem.dispose();
      } catch {
        /* 上下文已丢失，dispose 可能抛错，忽略 */
      }
      resourcesRef.current = null;
    };

    /** 构建几何 + 图集 + 材质 + 行型网格 + 外壳/键位格/轴柱/标记（首次挂载与上下文恢复共用）。 */
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
        const rt = rowTypeOf(k, rowCtx);
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
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.renderOrder = 0;
        boardGroup.add(mesh);

        const outline = new InstancedMesh(geometry, outlineMaterial, 1);
        outline.instanceMatrix.setUsage(DynamicDrawUsage);
        outline.renderOrder = -1;
        outline.visible = false;
        boardGroup.add(outline);

        groups.push({ rowType, indices, mesh, outline, geometry });
      }

      // 键位格：整片键区凿孔成格，键帽从孔里升起；孔壁与凹槽底接住阴影。
      // 材质读作阳极氧化铝（深色、金属度拉满、粗糙度中等偏低），不是塑料板。
      const deckGeometry = buildDeckGeometry(keys, maxX, maxY);
      const deckMaterial = new MeshStandardMaterial({
        color: themeRef.current.plate,
        roughness: 0.46,
        metalness: 0.9,
      });
      const deckMesh = new Mesh(deckGeometry, deckMaterial);
      deckMesh.receiveShadow = true;
      deckMesh.castShadow = true;
      deckMesh.renderOrder = -3;
      boardGroup.add(deckMesh);

      // 外壳：底部实体 + 顶沿倒角 + 腔体，键位格嵌在腔体里。
      // CNC 一体铝：金属度接近满值、粗糙度偏低但不到镜面，高光宽而柔。
      const caseGeometry = buildCaseGeometry(boardW, boardH, maxX, maxY);
      const caseMaterial = new MeshStandardMaterial({
        color: themeRef.current.caseColor,
        roughness: 0.38,
        metalness: 0.92,
      });
      const caseMesh = new Mesh(caseGeometry, caseMaterial);
      caseMesh.receiveShadow = true;
      caseMesh.castShadow = true;
      caseMesh.renderOrder = -3;
      boardGroup.add(caseMesh);

      // 悬浮数值牌：牌子 + 引导线 + 数字三套实例化网格，整组挂在 boardGroup 下，
      // 随打字倾角一起转；牌面朝向由 writeMatrices 里的 billboard 姿态保证。
      const plateRes = buildPlateResources(n);
      plateRes.setAccent(readAccent());
      boardGroup.add(plateRes.root);

      // 环境反射：室内棚拍环境（三盏柔光箱 + 顶光）预滤波成 PMREM，挂在 scene 上。
      // 金属材质的颜色几乎全部来自环境反射 —— 没有它，高 metalness 的铝壳会塌成
      // 一块纯黑；有了它，侧壁/倒角上会滚过柔光箱的长条高光，才是铝件的样子。
      const pmrem = new PMREMGenerator(renderer);
      const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTexture;

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
        deckMesh,
        deckGeometry,
        deckMaterial,
        plates: plateRes,
        envTexture,
        pmrem,
      };
    };
    buildResources();

    // ---- 矩阵 / 描边 / 渲染 ---------------------------------------------------
    // 数值牌 billboard：牌子挂在 boardGroup 下，boardGroup 有 6° 打字倾角，
    // 所以实例旋转要先把相机朝向换算到 boardGroup 局部空间（inverse(board) × camera）。
    // 相机无 roll，牌的局部 +Y 在屏幕上仍是竖直的，引导线读起来就是一条垂线。
    const _billboard = new Quaternion();
    const _axisZ = new Vector3();
    const _axisX = new Vector3();
    const _negBoardQ = new Quaternion();
    const updateBillboard = () => {
      const res = resourcesRef.current;
      if (!res) return;
      _negBoardQ.copy(res.boardGroup.quaternion).invert();
      _billboard.copy(_negBoardQ).multiply(camera.quaternion);
    };

    /** 一帧内每键只算一次：牌子可见度、悬空高度、牌底/键顶高度。 */
    const plateHeightOf = (i: number): number => {
      const hover = i === hoverRef.current ? HOVER_LIFT : 0;
      // 牌中心 = 键帽顶面 + 悬浮 + 牌高一半 + √(计数/p95) 抬升
      return capTopY[i] + hover + PLATE_GAP + PLATE_HEIGHT / 2 + riseRef.current[i] * plateMixRef.current;
    };

    const writeMatrices = () => {
      const res = resourcesRef.current;
      if (!res) return;
      const mix = plateMixRef.current;
      updateBillboard();

      // 键帽：XZ 缩放按键宽高，Y 恒为 1（雕刻已烤进几何），只留悬浮上浮
      for (const g of res.groups) {
        for (let j = 0; j < g.indices.length; j++) {
          const i = g.indices[j];
          const hover = i === hoverRef.current ? HOVER_LIFT : 0;
          _pos.set(keyCenterX[i], hover, keyCenterZ[i]);
          _scale.set(keyScaleX[i], 1, keyScaleZ[i]);
          _m.compose(_pos, _q, _scale);
          g.mesh.setMatrixAt(j, _m);
        }
        g.mesh.instanceMatrix.needsUpdate = true;
      }

      // 牌子 / 引导线 / 数字：都用同一组大小与姿态
      const plateW = PLATE_WIDTH * mix;
      const plateH = PLATE_HEIGHT * mix;
      let digitCursor = 0;
      for (let i = 0; i < n; i++) {
        const count = countOf(i);
        const visible = mix > 0.001 && count > 0;
        if (!visible) {
          _pos.set(0, 0, 0);
          _scale.set(0, 0, 0);
          _m.compose(_pos, _q, _scale);
          res.plates.plates.setMatrixAt(i, _m);
          res.plates.guides.setMatrixAt(i, _m);
          continue;
        }

        const hover = i === hoverRef.current ? HOVER_LIFT : 0;
        const plateY = plateHeightOf(i);

        // 面板
        _pos.set(keyCenterX[i], plateY, keyCenterZ[i]);
        _scale.set(plateW, plateH, mix);
        _m.compose(_pos, _billboard, _scale);
        res.plates.plates.setMatrixAt(i, _m);

        // 引导线：键帽顶面往上一点 → 牌底；靠键帽一端在着色器里淡出
        const guideBottom = capTopY[i] + hover + 0.03;
        const guideTop = plateY - plateH / 2;
        const guideH = Math.max(0, guideTop - guideBottom);
        if (guideH > 0.004) {
          _pos.set(keyCenterX[i], guideBottom + guideH / 2, keyCenterZ[i]);
          _scale.set(GUIDE_WIDTH * mix, guideH, mix);
          _m.compose(_pos, _billboard, _scale);
        } else {
          _pos.set(0, 0, 0);
          _scale.set(0, 0, 0);
          _m.compose(_pos, _q, _scale);
        }
        res.plates.guides.setMatrixAt(i, _m);

        // 数字：沿牌面局部 X 逐字排布，整体往相机方向推一点点避免与牌面 z-fighting。
        // billboard 姿态取自相机四元数，它的局部 +X 实际指向屏幕左侧，所以偏移取反，
        // 字形才会按左→右的阅读顺序排列。
        const glyphs = res.plates.layout(formatCount(count));
        _axisX.set(-1, 0, 0).applyQuaternion(_billboard);
        _axisZ.set(0, 0, 1).applyQuaternion(_billboard);
        const digitY = plateY + DIGIT_Y_OFFSET;
        for (const gl of glyphs) {
          if (digitCursor >= res.plates.digits.count) break;
          _pos
            .set(keyCenterX[i], digitY, keyCenterZ[i])
            .addScaledVector(_axisX, gl.offset)
            .addScaledVector(_axisZ, 0.004);
          _q.copy(_billboard);
          _scale.set(gl.width * mix, DIGIT_HEIGHT * mix, mix);
          _m.compose(_pos, _q, _scale);
          res.plates.digits.setMatrixAt(digitCursor, _m);
          res.plates.digitUv.setXY(digitCursor, gl.u0, gl.u1);
          res.plates.digitV.setXY(digitCursor, gl.v0, gl.v1);
          digitCursor++;
        }
      }
      res.plates.plates.count = n;
      res.plates.guides.count = n;
      res.plates.digits.count = digitCursor;
      res.plates.plates.instanceMatrix.needsUpdate = true;
      res.plates.guides.instanceMatrix.needsUpdate = true;
      res.plates.digits.instanceMatrix.needsUpdate = true;
      res.plates.digitUv.needsUpdate = true;
      res.plates.plates.visible = mix > 0.001;
      res.plates.guides.visible = mix > 0.001;
      res.plates.digits.visible = mix > 0.001;
    };

    /** 超 95 分位的键在面板/引导线上加强调。数据或高度开关变化时刷新一次即可。 */
    const writeEmphasis = () => {
      const res = resourcesRef.current;
      if (!res) return;
      const p95 = p95Ref.current;
      const plateAttr = res.plates.plateEmphasis;
      const guideAttr = res.plates.guideEmphasis;
      for (let i = 0; i < n; i++) {
        const on = heightModeRef.current && p95 > 0 && countOf(i) > p95 ? 1 : 0;
        plateAttr.setX(i, on);
        guideAttr.setX(i, on);
      }
      plateAttr.needsUpdate = true;
      guideAttr.needsUpdate = true;
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
        _pos.set(keyCenterX[idx], hover, keyCenterZ[idx]);
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
      res.deckMaterial.color.copy(themeRef.current.plate);
      res.plates.setAccent(readAccent());
      render();
    };

    // ---- 数值牌抬升目标 --------------------------------------------------------
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
    /** 每键牌子的抬升量：√(计数/p95) 归一化 —— 平方根压缩了长尾，
     *  高频键之间的小差异仍然拉开，而 1 次和 3 次不会一个贴顶一个贴地。
     *  高度编码关闭时全部归零、牌子整体隐藏。 */
    const computeTargetRise = (): Float32Array => {
      const arr = new Float32Array(n);
      plateMixRef.target = heightModeRef.current ? 1 : 0;
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
        arr[i] = Math.sqrt(Math.min(c / p95, 1)) * PLATE_RISE;
      }
      return arr;
    };

    // ---- 过渡动画（数值牌 + 相机共用一条 rAF 循环） ----------------------------
    const stopAnim = () => {
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
    const startAnim = (duration: number) => {
      stopAnim();
      const startRise = Float32Array.from(riseRef.current);
      const targetRise = riseRef.target;
      const startMix = plateMixRef.current;
      const targetMix = plateMixRef.target;
      const startCam = { ...camRef.current };
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const e = easeInOutCubic(t);
        const cur = riseRef.current;
        for (let i = 0; i < n; i++) {
          cur[i] = startRise[i] + (targetRise[i] - startRise[i]) * e;
        }
        plateMixRef.current = startMix + (targetMix - startMix) * e;
        // 相机目标每帧实时读取：用户拖拽/缩放会把它清空，此时立即放开相机
        const targetCam = camTargetRef.current;
        if (targetCam) {
          camRef.current.radius = startCam.radius + (targetCam.radius - startCam.radius) * e;
          camRef.current.yaw = startCam.yaw + (targetCam.yaw - startCam.yaw) * e;
          camRef.current.tilt = startCam.tilt + (targetCam.tilt - startCam.tilt) * e;
        }
        render();
        if (t < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          animRef.current = null;
          cur.set(targetRise);
          plateMixRef.current = targetMix;
          if (camTargetRef.current) {
            camRef.current = { ...camTargetRef.current };
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
      const label = displayLabel(key);
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
      setTooltip({ label, count, x: clientX, y: clientY });
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
          camTargetRef.current = null; // 用户接管视角，取消未完成的过渡动画目标
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
      camTargetRef.current = null; // 缩放即接管视角，取消未完成的过渡动画目标
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
        // camRef / riseRef / plateMixRef / themeRef / heightMode 是 JS 态，天然保留：
        // 相机角度、缩放、高度开关、牌子抬升与可见度、颜色全数恢复，不重置为默认值。
        applyTheme();
        writeEmphasis();
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
        riseRef.target = computeTargetRise();
        applyColors();
        writeEmphasis();
        if (!heightModeRef.current) {
          // 高度编码关闭：牌子不可见，直接同步（避免无谓动画）
          riseRef.current.set(riseRef.target);
          plateMixRef.current = plateMixRef.target;
          render();
        } else {
          // 高度编码开启：数据变化时平滑过渡到新抬升
          startAnim(TRANSITION_MS);
        }
      },
      applyTheme,
      setHeightMode() {
        riseRef.target = computeTargetRise();
        writeEmphasis();
        camTargetRef.current = null;
        startAnim(TRANSITION_MS);
      },
      setSelected(index: number | null) {
        selectedRef.current = index;
        render();
      },
      resetView() {
        userAdjustedRef.current = false;
        camTargetRef.current = { radius: fitRadius(TILT_DEFAULT), yaw: 0, tilt: TILT_DEFAULT };
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
    camRef.current.radius = fitRadius(TILT_DEFAULT);
    riseRef.current.set(computeTargetRise());
    plateMixRef.current = plateMixRef.target;
    writeEmphasis();
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

  // 数据变化 → 重算颜色 / 数值牌
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
    prevHeightModeRef.current = heightMode;
    try {
      localStorage.setItem("kb3d_height", heightMode ? "1" : "0");
    } catch {
      /* 隐私模式等场景忽略 */
    }
    ctrlRef.current?.setHeightMode();
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
      style={{ aspectRatio: `${maxX} / ${maxY * CONTAINER_HEIGHT_BOOST}` }}
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
        <button className="kb3d-btn" onClick={resetView} title="回到默认视角">
          重置视角
        </button>
        <button
          className={`kb3d-btn${heightMode ? " is-on" : ""}`}
          onClick={() => setHeightMode((v) => !v)}
          title="在键帽上方显示每个键的击键次数"
        >
          显示敲击次数
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
