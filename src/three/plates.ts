/**
 * 键帽上方的悬浮数值牌（高度编码）。
 *
 * 高度编码不再用「把键帽顶起来的轴柱」：键帽永远落在键位格里，计数改由键帽
 * 正上方一块始终朝向相机的数值牌表达 —— 牌子的高度 = 固定悬空 + √(计数/p95)
 * 的抬升量，牌面上直接写次数。这样数值本身可读，高度仍保留「谁高谁低」的
 * 排序感，而且整块键盘不会被抬得像在漂浮。
 *
 * 三套实例化网格：
 * - plates：圆角面板，深色半透明底 + 细描边，超 95 分位换成强调色描边；
 * - guides：从键帽顶面拉到牌底的一条极细引导线，靠近键帽一端淡出；
 * - digits：数字字形（图集取样），比例宽度 + 逐字偏移，牌面居中排布。
 *
 * 朝向不在这里算：调用方把相机四元数换算到 boardGroup 局部空间后，作为
 * 每实例的旋转矩阵传进来，三套网格共用同一个 billboard 姿态。
 */

import {
  CanvasTexture,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
} from "three";

// ---- 尺寸常量（U） ---------------------------------------------------------

/** 数值牌宽度。 */
export const PLATE_WIDTH = 0.62;
/** 数值牌高度。 */
export const PLATE_HEIGHT = 0.27;
/** 键帽顶面到牌底的最小悬空量。 */
export const PLATE_GAP = 0.14;
/** 高度编码的最大抬升量：计数达到 95 分位时牌子再多升起这么多。 */
export const PLATE_RISE = 0.82;
/** 牌面圆角半径。 */
const PLATE_RADIUS = 0.055;
/** 牌面描边宽度。 */
const PLATE_BORDER = 0.012;
/** 引导线宽度。 */
export const GUIDE_WIDTH = 0.014;
/** 字形墨高（U）。图集只截字形墨迹框，这个值就是数字实际在牌面上占的高度。 */
export const DIGIT_HEIGHT = 0.155;
/** 字间距（U）。 */
const DIGIT_TRACKING = 0.02;
/** 单键最多字形数（"999.9k" 为 6 个）。 */
export const MAX_DIGITS = 6;

// ---- 字形图集 ---------------------------------------------------------------

/** 图集包含的字形，顺序即图集单元顺序。 */
const GLYPHS = "0123456789.k万";
const CELL_W = 76;
const CELL_H = 64;
const FONT_PX = 52;
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif`;

type GlyphMetric = {
  /** 图集内 u 范围（只取墨迹的左右边界）。 */
  u0: number;
  u1: number;
  /** 图集内 v 范围（只取墨迹的上下边界；v 已按平面 UV 的 y 向上换算好）。 */
  v0: number;
  v1: number;
  /** 墨迹宽 / 墨迹高 —— 按它排宽度，字形不会被拉伸。 */
  ratio: number;
};

export type GlyphPlacement = {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  width: number;
  offset: number;
};

/** 计数 → 牌面文字：万以内原样，之上用 k / 万 压缩到 6 个字形以内。 */
export function formatCount(c: number): string {
  if (c <= 0) return "0";
  const n = Math.round(c);
  if (n < 10000) return String(n);
  if (n < 100000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n / 1000)}k`;
}

function buildGlyphAtlas(): { texture: CanvasTexture; metrics: Map<string, GlyphMetric> } {
  const canvas = document.createElement("canvas");
  canvas.width = GLYPHS.length * CELL_W;
  canvas.height = CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for plate glyph atlas");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `600 ${FONT_PX}px ${FONT_FAMILY}`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i], i * CELL_W + CELL_W / 2, CELL_H / 2);
  }

  // 逐个单元扫 alpha，量出字形墨迹的包围盒。整格映射到牌面上会把字形缩到
  // 六成左右、四周全是空白，牌面上的数字又小又糊；只取墨迹框，墨高才等于 DIGIT_HEIGHT。
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const metrics = new Map<string, GlyphMetric>();
  for (let i = 0; i < GLYPHS.length; i++) {
    const x0 = i * CELL_W;
    let minX = CELL_W;
    let maxX = -1;
    let minY = CELL_H;
    let maxY = -1;
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        if (data[(y * canvas.width + x0 + x) * 4 + 3] < 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      // 空格字形（理论上没有）：退回整格，免得后面除零。
      minX = 0;
      maxX = CELL_W - 1;
      minY = 0;
      maxY = CELL_H - 1;
    }
    // 墨高按像素行数算；v 用 1 - y/H 换算，因为图集 flipY = false（y 向下）。
    const inkH = maxY - minY + 1;
    const inkW = maxX - minX + 1;
    metrics.set(GLYPHS[i], {
      u0: (x0 + minX) / canvas.width,
      u1: (x0 + maxX + 1) / canvas.width,
      v0: 1 - (maxY + 1) / CELL_H,
      v1: 1 - minY / CELL_H,
      ratio: inkW / inkH,
    });
  }

  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, metrics };
}

/** 最宽的一串数字允许占牌宽的多少（左右各留 0.07U 边距）。 */
const MAX_TEXT_WIDTH = PLATE_WIDTH - 0.14;

/** 把一串文字排成居中、等墨高的字形列表（宽度按各字形实际比例）。 */
function layoutGlyphs(text: string, metrics: Map<string, GlyphMetric>): GlyphPlacement[] {
  const items = [...text].map((ch) => metrics.get(ch) ?? metrics.get("0")!);
  const widths = items.map((m) => m.ratio * DIGIT_HEIGHT);
  let total = widths.reduce((a, b) => a + b, 0) + DIGIT_TRACKING * (items.length - 1);
  // 长串（如 "12.3万"）等比压窄，保证不出牌；短串不受影响。
  const fit = total > MAX_TEXT_WIDTH ? MAX_TEXT_WIDTH / total : 1;
  total *= fit;
  const out: GlyphPlacement[] = [];
  let x = -total / 2;
  items.forEach((m, i) => {
    const w = widths[i] * fit;
    out.push({ u0: m.u0, u1: m.u1, v0: m.v0, v1: m.v1, width: w, offset: x + w / 2 });
    x += w + DIGIT_TRACKING * fit;
  });
  return out;
}

// ---- 着色器 -----------------------------------------------------------------

const BILLBOARD_EMPHASIS_VERT = /* glsl */ `
attribute float aEmphasis;
varying vec2 vUv;
varying float vEmphasis;
void main() {
  vUv = uv;
  vEmphasis = aEmphasis;
  #ifdef USE_INSTANCING
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
`;

// 面板：在 U 空间里做圆角矩形 SDF，描边宽度是真实尺寸而不是 UV 比例，
// 牌面被拉成 0.62 × 0.27 的扁长条时四角和描边仍然均匀。
const PLATE_FRAG = /* glsl */ `
uniform vec3 uFill;
uniform vec3 uStroke;
uniform vec3 uAccent;
uniform vec2 uHalf;
uniform float uRadius;
uniform float uBorder;
varying vec2 vUv;
varying float vEmphasis;

float roundedBox( vec2 p, vec2 halfSize, float r ) {
  vec2 q = abs( p ) - halfSize + r;
  return length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r;
}

void main() {
  vec2 p = ( vUv - 0.5 ) * uHalf * 2.0;
  float d = roundedBox( p, uHalf, uRadius );
  float aa = max( fwidth( d ) * 1.4, 0.0008 );
  float body = 1.0 - smoothstep( -aa, aa, d );
  // 描边：d 落在 [−uBorder, 0] 的环带
  float ring = smoothstep( -uBorder - aa, -uBorder + aa, d );
  vec3 strokeColor = mix( uStroke, uAccent, vEmphasis );
  vec3 color = mix( uFill, strokeColor, ring );
  float alpha = body * mix( 0.82, 0.9, vEmphasis );
  if ( alpha < 0.002 ) discard;
  gl_FragColor = vec4( color, alpha );
  #include <colorspace_fragment>
}
`;

const GUIDE_FRAG = /* glsl */ `
uniform vec3 uNeutral;
uniform vec3 uAccent;
uniform float uOpacity;
varying vec2 vUv;
varying float vEmphasis;
void main() {
  // vUv.y = 1 在牌底、= 0 在键帽；靠近键帽一端淡出，线不会像一根硬棍插在键上
  float a = uOpacity * mix( 0.12, 0.85, vUv.y );
  vec3 color = mix( uNeutral, uAccent, vEmphasis );
  gl_FragColor = vec4( color, a );
  #include <colorspace_fragment>
}
`;

const DIGIT_VERT = /* glsl */ `
attribute vec2 aUvRange;   // x = u0, y = u1
attribute vec2 aVRange;    // x = v0, y = v1（已按平面 UV 的 y 向上换算过）
varying vec2 vUv;
void main() {
  // 图集按 canvas 坐标上传（flipY = false，y 向下），而平面 UV 原点在左下，
  // 所以 v 要翻一次，否则字形上下颠倒。u / v 都只取墨迹范围。
  vUv = vec2( mix( aUvRange.x, aUvRange.y, uv.x ), mix( aVRange.x, aVRange.y, uv.y ) );
  #ifdef USE_INSTANCING
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
`;

const DIGIT_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float a = texture2D( uAtlas, vUv ).a;
  if ( a < 0.02 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <colorspace_fragment>
}
`;

// ---- 资源 -------------------------------------------------------------------

export type PlateResources = {
  root: Group;
  plates: InstancedMesh;
  guides: InstancedMesh;
  digits: InstancedMesh;
  plateMaterial: ShaderMaterial;
  guideMaterial: ShaderMaterial;
  digitMaterial: ShaderMaterial;
  plateGeometry: PlaneGeometry;
  guideGeometry: PlaneGeometry;
  digitGeometry: PlaneGeometry;
  glyphTexture: CanvasTexture;
  glyphMetrics: Map<string, GlyphMetric>;
  layout: (text: string) => GlyphPlacement[];
  /** 每键强调标记（超 95 分位 = 1），面板 / 引导线各一份，由调用方按数据写入。 */
  plateEmphasis: InstancedBufferAttribute;
  guideEmphasis: InstancedBufferAttribute;
  /** 每字形实例的图集墨迹范围（u 2 float / 字形，v 2 float / 字形，各一份属性）。 */
  digitUv: InstancedBufferAttribute;
  digitV: InstancedBufferAttribute;
  /** 主题强调色（超 95 分位的描边 + 引导线）。 */
  setAccent: (color: Color) => void;
  dispose: () => void;
};

export function buildPlateResources(n: number): PlateResources {
  const { texture, metrics } = buildGlyphAtlas();

  const plateGeometry = new PlaneGeometry(1, 1);
  const plateMaterial = new ShaderMaterial({
    vertexShader: BILLBOARD_EMPHASIS_VERT,
    fragmentShader: PLATE_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uFill: { value: new Color("#141319") },
      uStroke: { value: new Color("#FFFFFF") },
      uAccent: { value: new Color("#8B7CF0") },
      uHalf: { value: new Vector2(PLATE_WIDTH / 2, PLATE_HEIGHT / 2) },
      uRadius: { value: PLATE_RADIUS },
      uBorder: { value: PLATE_BORDER },
    },
  });
  const plates = new InstancedMesh(plateGeometry, plateMaterial, Math.max(1, n));
  plates.frustumCulled = false;
  plates.renderOrder = 8;

  const guideGeometry = new PlaneGeometry(1, 1);
  const guideMaterial = new ShaderMaterial({
    vertexShader: BILLBOARD_EMPHASIS_VERT,
    fragmentShader: GUIDE_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uNeutral: { value: new Color("#B7B2BE") },
      uAccent: { value: new Color("#8B7CF0") },
      uOpacity: { value: 0.5 },
    },
  });
  const guides = new InstancedMesh(guideGeometry, guideMaterial, Math.max(1, n));
  guides.frustumCulled = false;
  guides.renderOrder = 7;

  const digitGeometry = new PlaneGeometry(1, 1);
  const digitMaterial = new ShaderMaterial({
    vertexShader: DIGIT_VERT,
    fragmentShader: DIGIT_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uAtlas: { value: texture },
      uColor: { value: new Color("#F4F1E9") },
    },
  });
  const digits = new InstancedMesh(digitGeometry, digitMaterial, Math.max(1, n * MAX_DIGITS));
  digits.frustumCulled = false;
  digits.renderOrder = 9;

  // 每键的强调标记（超 95 分位 = 1），面板/引导线各一份实例属性
  const plateEmphasis = new Float32Array(Math.max(1, n));
  plates.geometry.setAttribute("aEmphasis", new InstancedBufferAttribute(plateEmphasis, 1));
  const guideEmphasis = new Float32Array(Math.max(1, n));
  guides.geometry.setAttribute("aEmphasis", new InstancedBufferAttribute(guideEmphasis, 1));

  // 每字形的图集墨迹范围：2 float（u）+ 2 float（v）
  const uvRanges = new Float32Array(Math.max(1, n * MAX_DIGITS) * 2);
  const digitUv = new InstancedBufferAttribute(uvRanges, 2);
  digitGeometry.setAttribute("aUvRange", digitUv);
  const vRanges = new Float32Array(Math.max(1, n * MAX_DIGITS) * 2);
  const digitV = new InstancedBufferAttribute(vRanges, 2);
  digitGeometry.setAttribute("aVRange", digitV);

  const root = new Group();
  root.add(guides, plates, digits);

  const layout = (text: string) => layoutGlyphs(text, metrics);
  const setAccent = (color: Color) => {
    plateMaterial.uniforms.uAccent.value.copy(color);
    guideMaterial.uniforms.uAccent.value.copy(color);
  };

  return {
    root,
    plates,
    guides,
    digits,
    plateMaterial,
    guideMaterial,
    digitMaterial,
    plateGeometry,
    guideGeometry,
    digitGeometry,
    glyphTexture: texture,
    glyphMetrics: metrics,
    layout,
    plateEmphasis: plates.geometry.getAttribute("aEmphasis") as InstancedBufferAttribute,
    guideEmphasis: guides.geometry.getAttribute("aEmphasis") as InstancedBufferAttribute,
    digitUv,
    digitV,
    setAccent,
    dispose: () => {
      plateGeometry.dispose();
      guideGeometry.dispose();
      digitGeometry.dispose();
      plateMaterial.dispose();
      guideMaterial.dispose();
      digitMaterial.dispose();
      texture.dispose();
      plates.dispose();
      guides.dispose();
      digits.dispose();
    },
  };
}
