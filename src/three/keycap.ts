// @ts-nocheck
/**
 * 键帽 3D 渲染核心：按 Cherry 原厂高度分行的键帽几何 + 印字图集 + 确定性无光照着色。
 *
 * - 【二】几何：按「行型」生成键帽几何（一种行型一个 BufferGeometry），供该行型下
 *   的 `InstancedMesh` 复用；位置/宽高走实例矩阵，绝不逐键建 mesh。每个行型共享同一
 *   套雕刻参数（高度 / 顶面前倾后仰角 / 柱面碗状凹陷 / 侧壁收窄），集中定义在
 *   `ROW_PROFILES` 一张表里，不散落在几何构建代码中。
 * - 【一】着色：沿用 MeshBasicMaterial 无光照。顶面纯色平涂 + 极轻微固定径向明暗
 *   （只让碗状凹陷可见，对每个键完全相同）；侧面/底面在顶面色基础上按固定比例加深，
 *   比例是常量，对所有键、所有朝向一致，不随位置/朝向/相机变化。无平行光/点光/
 *   镜面高光/法线贴图。
 * - 【五】图集：把整张配列的印字一次性烘到一张 canvas（alpha 字形），`CanvasTexture`
 *   复用；标签颜色不在图集里（图集只存字形透明度），改由 shader 按键帽填充色明暗
 *   现算深/浅两种标签色，主题切换只需换两个 uniform。
 *
 * 图集/几何每次挂载重建、卸载销毁（见 Keyboard3D）。文字测量与适配复用
 * `layouts/labels.ts`，绘制时把字号按 `PX_PER_U * dpr / KEY_UNIT` 放大，
 * 不改 labels 的测量坐标系。
 */

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  LinearFilter,
  MeshBasicMaterial,
} from "three";
import type { LayoutKey } from "../keyboardLayout";
import {
  fitLabel,
  fitSubLabel,
  lookupTiers,
  usableLabelWidth,
  type LabelTiers,
} from "../layouts/labels";
import { KEY_PADDING, KEY_UNIT } from "../layouts/metrics";

// ---------------------------------------------------------------------------
// 着色常量（确定性：常量，不随位置/朝向/视角变化）
// ---------------------------------------------------------------------------

/** 侧面相对顶面的固定加深比例。 */
const SIDE_SHADE = 0.78;
/** 底面相对顶面的固定加深比例。 */
const BOTTOM_SHADE = 0.7;
/** 顶面碗状凹陷的明暗强度：凹陷中心略暗、边缘最亮，让凹陷可见。 */
const DISH_SHADE = 0.07;

// ---------------------------------------------------------------------------
// 几何常量
// ---------------------------------------------------------------------------

/** 四角圆角系数（相对键宽）。0.1 是轻微的圆角，键缝观感自然。 */
const KEYCAP_CORNER_RADIUS = 0.1;
/** 每个圆角的弧线段数。越大越圆，4 段已足够顺滑且顶点少。 */
const SIDE_SEGMENTS = 4;
/** 顶面同心环细分环数：柱面碗状凹陷需要比单一扇形更多的细分才能成形。 */
const DISH_RINGS = 3;
/** 图集每 U 的基础像素，乘以 dpr（上限 2）得到实际光栅分辨率。 */
const PX_PER_U = 96;
/** 与 labels.ts 的测量字体一致，保证适配结果和绘制宽度吻合。 */
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif`;

// ---------------------------------------------------------------------------
// 行型参数表（Cherry 原厂高度雕刻，唯一真源，便于后续手感调整）
// ---------------------------------------------------------------------------

export type RowType = "R1" | "R2" | "R3" | "R4" | "R5";

export type RowProfile = {
  /** 键帽顶面中心高度（U），底面为 0。 */
  height: number;
  /** 顶面前倾角（度）：正 = 向使用者前倾（前端低），负 = 后仰（前端高）。 */
  tiltDeg: number;
  /** 柱面碗状凹陷深度（U），沿 X 轴（左右），中心最低。 */
  dish: number;
  /** 侧壁向上收窄量（每边，相对键宽）。 */
  taper: number;
};

/**
 * 配列 y → 行型。主键区自上而下：
 * - 功能键行与数字行同型（R1，最高、前倾最大）；
 * - 字母上排（Q）次之（R2）；home 行最低最平（R3）；
 * - 字母下排（Z）后仰（R4）；底行（空格）后仰更大（R5）。
 * 整体形成朝向手指的凹陷弧面。
 */
const ROW_TYPE_BY_Y: Record<number, RowType> = {
  0: "R1",
  1.5: "R1",
  2.5: "R2",
  3.5: "R3",
  4.5: "R4",
  5.5: "R5",
};

export const ROW_PROFILES: Record<RowType, RowProfile> = {
  R1: { height: 0.32, tiltDeg: 5, dish: 0.035, taper: 0.06 },
  R2: { height: 0.29, tiltDeg: 2.5, dish: 0.035, taper: 0.06 },
  R3: { height: 0.26, tiltDeg: 0, dish: 0.035, taper: 0.06 },
  R4: { height: 0.29, tiltDeg: -2.5, dish: 0.035, taper: 0.06 },
  R5: { height: 0.32, tiltDeg: -5, dish: 0.035, taper: 0.06 },
};

/** 取一个键所属的行型（配列未覆盖的 y 一律落到 home 行型，不报错）。 */
export function rowTypeOf(key: LayoutKey): RowType {
  return ROW_TYPE_BY_Y[key.y] ?? "R3";
}

// ---------------------------------------------------------------------------
// 圆角矩形外轮廓（键帽 / 外壳 / 定位板共用）
// ---------------------------------------------------------------------------

/** 生成圆角矩形外轮廓（平面 XZ 上的周界点，未闭合但首尾接一条直边）。 */
export function roundedRectOutline(
  hx: number,
  hz: number,
  r: number,
  seg: number
): Float32Array {
  const r2 = Math.min(r, hx, hz);
  const cx = [-(hx - r2), hx - r2, hx - r2, -(hx - r2)];
  const cz = [-(hz - r2), -(hz - r2), hz - r2, hz - r2];
  const a0 = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5];
  const a1 = [Math.PI * 1.5, Math.PI * 2, Math.PI * 0.5, Math.PI];
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i <= seg; i++) {
      const a = a0[c] + (a1[c] - a0[c]) * (i / seg);
      out.push(cx[c] + r2 * Math.cos(a), cz[c] + r2 * Math.sin(a));
    }
  }
  return new Float32Array(out);
}

// ---------------------------------------------------------------------------
// 键帽几何（单位坐标 X/Z ∈ [-0.5, 0.5]，Y ∈ [0, height]；雕刻已烤入几何，
// 实例矩阵只缩放 XZ、不再缩放 Y）
// ---------------------------------------------------------------------------

/**
 * 构建某一行型的键帽几何。顶面是「前倾/后仰的斜平面」再减一个沿 X 的柱面凹陷，
 * 侧壁向上收窄（顶面轮廓小于底面轮廓），前壁与后壁高度差由倾角决定。
 * 顶面 UV 映到 [0,1]：u 随 X 左→右，v 随 Z 后→前（v=0 为远离用户的键帽上缘）。
 */
export function buildKeycapGeometry(profile: RowProfile): BufferGeometry {
  const half = 0.5;
  const topHalf = half - profile.taper;
  const topExtent = topHalf * 2;
  const tiltSlope = Math.tan((profile.tiltDeg * Math.PI) / 180);
  const cornerTop = KEYCAP_CORNER_RADIUS * topHalf;
  const cornerBot = KEYCAP_CORNER_RADIUS * half;

  const positions: number[] = [];
  const uvs: number[] = [];
  const isTop: number[] = [];
  const shade: number[] = [];
  const indices: number[] = [];

  const push = (x: number, y: number, z: number, u: number, v: number, it: number, s: number) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    isTop.push(it);
    shade.push(s);
  };

  // 顶面 Y（单位坐标）：高度 − 前倾/后仰线性项 − 柱面凹陷（沿 X，中心最低）。
  const topY = (x: number, z: number) =>
    profile.height - tiltSlope * z - profile.dish * (1 - (x / topHalf) * (x / topHalf));
  // 顶面明暗：凹陷中心（x=0）略暗、边缘最亮，每个键完全相同的固定调制。
  const topShade = (x: number) => 1 - DISH_SHADE * (1 - (x / topHalf) * (x / topHalf));

  const botOutline = roundedRectOutline(half, half, cornerBot, SIDE_SEGMENTS);
  const topOutline = roundedRectOutline(topHalf, topHalf, cornerTop, SIDE_SEGMENTS);
  const M = botOutline.length / 2;

  // ---- 顶面（中心 + 同心环细分，让柱面凹陷成形） ---------------------------
  const ringBase: number[] = [];
  const ringSize: number[] = [];
  // 环 0：中心点
  {
    const base = positions.length / 3;
    push(0, topY(0, 0), 0, 0.5, 0.5, 1, topShade(0));
    ringBase.push(base);
    ringSize.push(1);
  }
  for (let r = 1; r <= DISH_RINGS + 1; r++) {
    const t = r / (DISH_RINGS + 1);
    const outline =
      r === DISH_RINGS + 1
        ? topOutline
        : roundedRectOutline(topHalf * t, topHalf * t, cornerTop * t, SIDE_SEGMENTS);
    const base = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = outline[i * 2];
      const z = outline[i * 2 + 1];
      push(x, topY(x, z), z, (x + topHalf) / topExtent, (z + topHalf) / topExtent, 1, topShade(x));
    }
    ringBase.push(base);
    ringSize.push(M);
  }
  for (let r = 1; r < ringBase.length; r++) {
    const a = ringBase[r - 1];
    const aN = ringSize[r - 1];
    const b = ringBase[r];
    const bN = ringSize[r];
    if (aN === 1) {
      for (let i = 0; i < bN; i++) {
        indices.push(a, b + i, b + ((i + 1) % bN));
      }
    } else {
      for (let i = 0; i < bN; i++) {
        const a0 = a + i;
        const a1 = a + ((i + 1) % bN);
        const b0 = b + i;
        const b1 = b + ((i + 1) % bN);
        indices.push(a0, a1, b1, a0, b1, b0);
      }
    }
  }

  // ---- 底面 cap（isTop=0，均匀 BOTTOM_SHADE） -----------------------------
  const botBase = positions.length / 3;
  push(0, 0, 0, 0, 0, 0, BOTTOM_SHADE);
  for (let i = 0; i < M; i++) {
    push(botOutline[i * 2], 0, botOutline[i * 2 + 1], 0, 0, 0, BOTTOM_SHADE);
  }
  for (let i = 0; i < M; i++) {
    indices.push(botBase, botBase + 1 + i, botBase + 1 + ((i + 1) % M));
  }

  // ---- 侧面（上边缘复用顶面边缘环、下边缘取底轮廓，均匀 SIDE_SHADE） -------
  const sideBase = positions.length / 3;
  for (let i = 0; i < M; i++) {
    const x = topOutline[i * 2];
    const z = topOutline[i * 2 + 1];
    push(x, topY(x, z), z, 0, 0, 0, SIDE_SHADE);
    push(botOutline[i * 2], 0, botOutline[i * 2 + 1], 0, 0, 0, SIDE_SHADE);
  }
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    const t0 = sideBase + i * 2;
    const b0 = sideBase + i * 2 + 1;
    const t1 = sideBase + i2 * 2;
    const b1 = sideBase + i2 * 2 + 1;
    indices.push(t0, t1, b1, t0, b1, b0);
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aIsTop", new Float32BufferAttribute(isTop, 1));
  geo.setAttribute("aShade", new Float32BufferAttribute(shade, 1));
  geo.setIndex(indices);
  return geo;
}

// ---------------------------------------------------------------------------
// 印字图集（一次烘焙全配列标签，UV 偏移经实例属性下发）
// ---------------------------------------------------------------------------

export type AtlasCell = { u0: number; v0: number; scaleU: number; scaleV: number };

export type KeycapAtlas = {
  texture: CanvasTexture;
  /** 与传入 keys 同序，每键一个图集单元（UV 偏移 + 缩放）。 */
  cells: AtlasCell[];
};

function tiersFor(raw: string): LabelTiers {
  return lookupTiers(raw) ?? { full: raw, abbr: raw };
}

/** 在一个图集单元里画某个键的印字（单印字居中，双印字上小下大、靠左）。 */
function drawKeyLabel(
  ctx: CanvasRenderingContext2D,
  key: LayoutKey,
  cell: { x: number; y: number; w: number; h: number },
  s: number
): void {
  const usable = usableLabelWidth(key.w);
  const main = fitLabel(tiersFor(key.lower), usable);
  const pad = KEY_PADDING * s;
  const hasUpper = key.upper !== "";

  ctx.save();
  ctx.beginPath();
  ctx.rect(cell.x, cell.y, cell.w, cell.h);
  ctx.clip();
  // 只取 alpha 通道当字形蒙版，rgb 用纯白占位，颜色由 shader 现算
  ctx.fillStyle = "#fff";

  if (!hasUpper) {
    ctx.font = `600 ${main.fontSize * s}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(main.text, cell.x + cell.w / 2, cell.y + cell.h / 2);
  } else {
    const sub = fitSubLabel(tiersFor(key.upper), usable);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `500 ${sub.fontSize * s}px ${FONT_FAMILY}`;
    ctx.fillText(sub.text, cell.x + pad, cell.y + pad);
    ctx.textBaseline = "bottom";
    ctx.font = `600 ${main.fontSize * s}px ${FONT_FAMILY}`;
    ctx.fillText(main.text, cell.x + pad, cell.y + cell.h - pad);
  }
  ctx.restore();
}

/** 简单 shelf 装箱：按高度降序逐行放置，够近方形的紧凑图集。 */
function packShelf(rects: { w: number; h: number }[]): {
  W: number;
  H: number;
  placed: { x: number; y: number; w: number; h: number }[];
} {
  const order = rects
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => b.h - a.h || b.w - a.w);
  const totalArea = rects.reduce((acc, r) => acc + r.w * r.h, 0);
  const targetW = Math.max(1, Math.ceil(Math.sqrt(totalArea) * 1.35));
  const placed = new Array<{ x: number; y: number; w: number; h: number }>(rects.length);
  let shelfY = 0;
  let shelfH = 0;
  let shelfX = 0;
  let maxRowW = 0;
  for (const r of order) {
    if (shelfX > 0 && shelfX + r.w > targetW) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    placed[r.i] = { x: shelfX, y: shelfY, w: r.w, h: r.h };
    shelfX += r.w;
    shelfH = Math.max(shelfH, r.h);
    maxRowW = Math.max(maxRowW, shelfX);
  }
  return { W: Math.max(1, maxRowW), H: Math.max(1, shelfY + shelfH), placed };
}

/**
 * 烘焙整张配列的印字图集。每键单元外留 1px 透明边距，避免线性采样在
 * 相邻单元之间渗色。`dpr` 建议取 `Math.min(devicePixelRatio, 2)`。
 */
export function buildKeycapAtlas(keys: LayoutKey[], dpr: number): KeycapAtlas {
  const s = (PX_PER_U * dpr) / KEY_UNIT;
  const rects = keys.map((k) => ({
    w: Math.ceil(k.w * PX_PER_U * dpr) + 2,
    h: Math.ceil(k.h * PX_PER_U * dpr) + 2,
  }));
  const { W, H, placed } = packShelf(rects);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for keycap atlas");
  ctx.clearRect(0, 0, W, H);

  const cells: AtlasCell[] = new Array(keys.length);
  keys.forEach((key, i) => {
    const p = placed[i];
    const innerX = p.x + 1;
    const innerY = p.y + 1;
    const innerW = p.w - 2;
    const innerH = p.h - 2;
    drawKeyLabel(ctx, key, { x: innerX, y: innerY, w: innerW, h: innerH }, s);
    cells[i] = { u0: innerX / W, v0: innerY / H, scaleU: innerW / W, scaleV: innerH / H };
  });

  const texture = new CanvasTexture(canvas);
  // flipY=false：让 UV v 直接对应画布 y（v=0 在键帽上缘），标签方向与图集绘制一致
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, cells };
}

/** 把图集单元写进几何的实例属性 aUvOffset / aUvScale（与 cells 同序）。 */
export function applyAtlasUvAttributes(geometry: BufferGeometry, cells: AtlasCell[]): void {
  const n = cells.length;
  const offsets = new Float32Array(n * 2);
  const scales = new Float32Array(n * 2);
  cells.forEach((c, i) => {
    offsets[i * 2] = c.u0;
    offsets[i * 2 + 1] = c.v0;
    scales[i * 2] = c.scaleU;
    scales[i * 2 + 1] = c.scaleV;
  });
  geometry.setAttribute("aUvOffset", new InstancedBufferAttribute(offsets, 2));
  geometry.setAttribute("aUvScale", new InstancedBufferAttribute(scales, 2));
}

// ---------------------------------------------------------------------------
// 无光照实例化着色器（MeshBasicMaterial + onBeforeCompile）
// ---------------------------------------------------------------------------

const VERT_PRELUDE = /* glsl */ `
attribute float aIsTop;
attribute float aShade;
attribute vec2 aUvOffset;
attribute vec2 aUvScale;
varying float vIsTop;
varying float vShade;
varying vec2 vTopUv;
`;

const VERT_MAIN = /* glsl */ `
vIsTop = aIsTop;
vShade = aShade;
vTopUv = aUvOffset + uv * aUvScale;
`;

const FRAG_PRELUDE = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uTextDark;
uniform vec3 uTextLight;
varying float vIsTop;
varying float vShade;
varying vec2 vTopUv;
`;

const FRAG_COLOR = /* glsl */ `
// 确定性着色：只按固定比例的 aShade 压暗（顶面近 1 + 轻微径向、侧面/底面固定比例），
// 不做任何方向性明暗，不随相机角度变化
diffuseColor.rgb *= vShade;
// 顶面叠印字：图集只存字形 alpha，颜色按当前填充色明暗取深/浅两档
float glyph = vIsTop * texture2D( uAtlas, vTopUv ).a;
float lum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
vec3 textColor = mix( uTextDark, uTextLight, step( 0.5, lum ) );
diffuseColor.rgb = mix( diffuseColor.rgb, textColor, glyph );
`;

export type KeycapMaterialHandle = {
  material: MeshBasicMaterial;
  /** 主题切换后更新标签深浅色（就地改 uniform 引用，无需重编译）。 */
  setTextColors: (dark: Color, light: Color) => void;
};

/** 构建无光照键帽材质，注入实例化图集取样与标签着色。 */
export function buildKeycapMaterial(atlas: CanvasTexture): KeycapMaterialHandle {
  const darkText = new Color("#2A2730");
  const lightText = new Color("#FFFFFF");
  const material = new MeshBasicMaterial({ side: DoubleSide });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas };
    shader.uniforms.uTextDark = { value: darkText };
    shader.uniforms.uTextLight = { value: lightText };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERT_PRELUDE + "\n#include <common>")
      .replace("#include <begin_vertex>", VERT_MAIN + "\n#include <begin_vertex>");

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", FRAG_PRELUDE + "\n#include <common>")
      .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_COLOR);
  };

  return {
    material,
    setTextColors: (dark, light) => {
      darkText.copy(dark);
      lightText.copy(light);
    },
  };
}
