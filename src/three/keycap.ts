// @ts-nocheck
/**
 * 键帽 3D 几何 + 印字图集 + 受光材质。
 *
 * - 几何：按「行型」生成一份键帽几何（一种行型一个 BufferGeometry），供该行型下的
 *   InstancedMesh 复用；位置/宽高走实例矩阵。每个键帽由四段构成：
 *   竖直侧壁 → 顶部倒角圆环（fillet）→ 柱面凹陷的顶面，全部用解析法线，
 *   倒角段法线连续过渡，受光后形成一圈柔和高光边 —— 这是键帽「有体积」的关键。
 * - 材质：MeshStandardMaterial 真实受光（PBR）。立体感来自场景灯光 + 阴影，
 *   不再烘焙顶点明暗；所有键帽颜色一致、朝向一致，光照下读出的明暗也一致。
 * - 图集：整张配列的印字一次性烘到一张 canvas（alpha 字形），实例化 UV 取样；
 *   标签颜色按键帽填充色明暗现算深/浅两档，主题切换只换两个 uniform。
 * - 法线坐标系：键帽整体绕 X 轴倾斜时法线不随行型变化（行型的倾角已烤入几何）。
 *
 * 文字测量与适配复用 `layouts/labels.ts`，绘制时把字号按
 * `PX_PER_U * dpr / KEY_UNIT` 放大，不改 labels 的测量坐标系。
 */

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  LinearFilter,
  MeshStandardMaterial,
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
// 几何常量
// ---------------------------------------------------------------------------

/** 四角圆角系数（相对键宽）。 */
const KEYCAP_CORNER_RADIUS = 0.13;
/** 每个圆角 / 每一圈的弧线段数。 */
const SIDE_SEGMENTS = 6;
/** 顶面倒角段数：4 段已能读出圆弧，再多只是顶点开销。 */
const FILLET_SEGMENTS = 4;
/** 顶面同心环细分环数（柱面凹陷的成形精度）。 */
const DISH_RINGS = 2;

// ---------------------------------------------------------------------------
// 行型参数表（Cherry 原厂高度雕刻，唯一真源，便于后续手感调整）
// ---------------------------------------------------------------------------

export type RowType = "R1" | "R2" | "R3" | "R4" | "R5";

export type RowProfile = {
  /** 键帽顶面边缘最高点（U），底面为 0。凹碗中心比此值低 dish。 */
  height: number;
  /** 顶面前倾角（度）：正 = 向使用者前倾（前端低），负 = 后仰（前端高）。 */
  tiltDeg: number;
  /** 柱面碗状凹陷深度（U），沿 X 轴（左右），中心最低、两侧回平。 */
  dish: number;
  /** 侧壁向上收窄量（每边，相对键宽）。 */
  taper: number;
  /** 顶部倒角半径（U）：侧壁到顶面的圆弧过渡，受光时形成一圈高光边。 */
  fillet: number;
};

/**
 * Cherry Profile 键帽高度（Keychron 厂商参考，非原厂公差规范）。
 * 高度不是单调递减：R3（Home 行）是最低点，R4（底排含空格）比 R3 高，
 * R1（数字/Fn 排）最高 —— 呈前低中低、两端翘起的轮廓。
 *
 * 高度单位：U（1U = 19.05mm 键中心距）
 *   R1 = 9.81mm / 19.05 ≈ 0.515U
 *   R2 = 7.85mm / 19.05 ≈ 0.412U
 *   R3 = 7.22mm / 19.05 ≈ 0.379U  ← 全键盘最低排
 *   R4 = 8.59mm / 19.05 ≈ 0.451U  ← 比 R3 高，空格键所在排
 *
 * 倾角：正 = 键帽向使用者前倾（前端低）；R4 近水平，R1 前倾最大。
 */
export const ROW_PROFILES: Record<RowType, RowProfile> = {
  // 倾角：本代码 R1 = 最顶排（Fn/数字），正值 = 前端低（向用户前倾）；
  //   Fn 排前倾最大（8°），空格排近水平（0°）——与 KeyV2 行号方向相反，不可直接套用。
  // 凹陷深度：Cherry 柱面凹碗 0.65mm / 19.05mm·U⁻¹ = 0.0341U。
  R1: { height: 0.515, tiltDeg: 8, dish: 0.0341, taper: 0.02, fillet: 0.07 },
  R2: { height: 0.412, tiltDeg: 6, dish: 0.0341, taper: 0.02, fillet: 0.07 },
  R3: { height: 0.379, tiltDeg: 3, dish: 0.0341, taper: 0.02, fillet: 0.07 },
  R4: { height: 0.451, tiltDeg: 0, dish: 0.0341, taper: 0.02, fillet: 0.07 },
  R5: { height: 0.451, tiltDeg: 0, dish: 0.0341, taper: 0.02, fillet: 0.07 },
};

const ROW_TYPES: RowType[] = ["R1", "R2", "R3", "R4", "R5"];

/** 一个配列内「行序号 → 行型」的判定上下文，覆盖任意行数（不限 104/87 的固定 6 行）。 */
export type RowContext = {
  /** 取某个键在本配列里的行序号（从上往下，0-based）。 */
  rowOf: (key: LayoutKey) => number;
  /** 本配列总行数。 */
  totalRows: number;
};

/**
 * 按「本配列总行数」把行序号映射到 Cherry 行型。
 *
 * 6 排是标准配列，直接按 Cherry 规格映射：R1 / R1 / R2 / R3 / R4 / R4
 * （数字排与 Fn 排共用 R1，底排与空格排共用 R4）—— 不能线性均分，
 * 否则空格行会落到 R5 被压塌。
 *
 * 其余行数仍走线性映射（夹取到端点），保证 60%/40% 等配列也有合理档位。
 */
export function rowTypeForIndex(rowIndex: number, totalRows: number): RowType {
  if (totalRows <= 1) return "R3";
  if (totalRows === 6) {
    const sixRow: RowType[] = ["R1", "R1", "R2", "R3", "R4", "R4"];
    return sixRow[Math.max(0, Math.min(5, rowIndex))];
  }
  const t = rowIndex / (totalRows - 1);
  const level = Math.round(t * (ROW_TYPES.length - 1));
  return ROW_TYPES[Math.max(0, Math.min(ROW_TYPES.length - 1, level))];
}

/**
 * 算出一个配列的行判定上下文：优先用键上的 `row` 字段；配列里任何键缺这个字段
 * （旧数据 / 未跑过迁移），整体按 y 值聚类兜底，不因缺字段而炸。
 */
export function computeRowContext(keys: LayoutKey[]): RowContext {
  if (keys.length > 0 && keys.every((k) => typeof k.row === "number")) {
    const maxRow = keys.reduce((m, k) => Math.max(m, k.row as number), 0);
    return { rowOf: (k) => k.row as number, totalRows: maxRow + 1 };
  }
  const ys = [...new Set(keys.map((k) => Math.round(k.y * 2) / 2))].sort((a, b) => a - b);
  const indexByY = new Map(ys.map((y, i) => [y, i]));
  return {
    rowOf: (k) => indexByY.get(Math.round(k.y * 2) / 2) ?? 0,
    totalRows: Math.max(1, ys.length),
  };
}

/** 取一个键所属的行型，需先用 `computeRowContext(keys)` 算出上下文。 */
export function rowTypeOf(key: LayoutKey, ctx: RowContext): RowType {
  return rowTypeForIndex(ctx.rowOf(key), ctx.totalRows);
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

/**
 * 校正三角形绕序：每个三角形的几何法线（叉积）若与三个顶点的平均解析法线反向，
 * 就交换后两个索引。环带索引是手写生成的，靠这一步统一到正面朝向，
 * 材质才能用默认的 FrontSide（背面剔除）。
 */
export function fixWinding(
  positions: number[],
  normals: number[],
  indices: number[]
): void {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax;
    const uy = positions[b * 3 + 1] - ay;
    const uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax;
    const vy = positions[c * 3 + 1] - ay;
    const vz = positions[c * 3 + 2] - az;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const nx = normals[a * 3] + normals[b * 3] + normals[c * 3];
    const ny = normals[a * 3 + 1] + normals[b * 3 + 1] + normals[c * 3 + 1];
    const nz = normals[a * 3 + 2] + normals[b * 3 + 2] + normals[c * 3 + 2];
    if (gx * nx + gy * ny + gz * nz < 0) {
      indices[t + 1] = c;
      indices[t + 2] = b;
    }
  }
}

// ---------------------------------------------------------------------------
// 键帽几何（单位坐标 X/Z ∈ [-0.5, 0.5]，Y ∈ [0, height]；雕刻已烤入几何，
// 实例矩阵只缩放 XZ、不再缩放 Y）
// ---------------------------------------------------------------------------

/**
 * 构建某一行型的键帽几何。纵向剖面（自下而上）：
 *   底环 Y=0（完整尺寸）
 *   → 侧壁（轻微向上收窄）
 *   → 倒角圆环：一段 1/4 圆弧，法线从水平连续转到顶面法线
 *   → 顶面：前倾/后仰的斜平面再减沿 X 的柱面凹陷
 * 顶面 UV 映到 [0,1]：u 随 X 左→右，v 随 Z 后→前（v=0 为远离用户的键帽上缘）。
 *
 * `widthU` 是键帽的真实宽度（U）：宽键按此宽度直接生成几何，**不靠实例矩阵沿 X
 * 等比拉伸**。锥度、四角圆角、顶部倒角都是绝对量（U），所以 6.25U 空格的侧壁厚度、
 * 转角圆角与 1U 完全一致，只有顶面沿 X 变长 —— 等比拉伸会把圆角抻成椭圆、锥度放大
 * 六倍，读起来就是「一块被拉长的塑料片」。
 */
export function buildKeycapGeometry(profile: RowProfile, widthU = 1, depthU = 1): BufferGeometry {
  const halfW = Math.max(0.55, widthU) / 2;
  const halfZ = Math.max(0.55, depthU) / 2;
  const topHalfW = Math.max(0.2, halfW - profile.taper);
  const topHalfZ = Math.max(0.2, halfZ - profile.taper);
  const tiltSlope = Math.tan((profile.tiltDeg * Math.PI) / 180);
  const fillet = Math.min(profile.fillet, Math.min(topHalfW, topHalfZ) * 0.4);
  const innerHalfW = topHalfW - fillet;
  const innerHalfZ = topHalfZ - fillet;
  const innerExtentW = innerHalfW * 2;
  const innerExtentZ = innerHalfZ * 2;
  const cornerTop = KEYCAP_CORNER_RADIUS * topHalfZ;
  const cornerBot = KEYCAP_CORNER_RADIUS * halfZ;
  const cornerInner = Math.max(0.01, cornerTop - fillet);

  // 顶面高度场：高度 − 倾角线性项 − 柱面凹陷（沿 X，中心最低，两侧回平）。
  const crownY = (x: number, z: number) =>
    profile.height - tiltSlope * z - profile.dish * (1 - (x / topHalfW) * (x / topHalfW));
  // 顶面解析法线（未归一）：n = (∂y/∂x, 1, ∂y/∂z) 是朝上的，取 (dish 项, 1, −slope)。
  const dishGrad = 2 * profile.dish;
  const crownNormal = (x: number) => {
    const nx = -(dishGrad * x) / (topHalfW * topHalfW);
    const len = Math.hypot(nx, 1, tiltSlope);
    return [nx / len, 1 / len, -tiltSlope / len];
  };

  const botOutline = roundedRectOutline(halfW, halfZ, cornerBot, SIDE_SEGMENTS);
  const wallOutline = roundedRectOutline(topHalfW, topHalfZ, cornerTop, SIDE_SEGMENTS);
  const M = botOutline.length / 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const isTop: number[] = [];
  const indices: number[] = [];

  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    it: number
  ) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    isTop.push(it);
  };
  // 通用环带连接：a（下环）→ b（上环）。所有环节点按逆时针排列，统一绕序。
  const band = (aBase: number, bBase: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const i2 = (i + 1) % count;
      const a0 = aBase + i;
      const a1 = aBase + i2;
      const b0 = bBase + i;
      const b1 = bBase + i2;
      indices.push(a0, a1, b1, a0, b1, b0);
    }
  };

  // ---- 底环（Y=0，法线朝下/外侧） -----------------------------------------
  for (let i = 0; i < M; i++) {
    const x = botOutline[i * 2];
    const z = botOutline[i * 2 + 1];
    const len = Math.hypot(x, z) || 1;
    push(x, 0, z, x / len, 0, z / len, 0, 0, 0);
  }

  // ---- 侧壁（底环 → 倒角起点，法线朝外） -----------------------------------
  const wallBase = positions.length / 3;
  const wallNormal = (x: number, z: number) => {
    // 侧壁在收窄时本身带内倾，法线略向上；内倾量小于倒角，按主方向近似即可。
    const len = Math.hypot(x, z) || 1;
    return [x / len, 0.08, z / len];
  };
  const wallTop: number[] = [];
  for (let i = 0; i < M; i++) {
    const x = wallOutline[i * 2];
    const z = wallOutline[i * 2 + 1];
    const y = crownY(x, z) - fillet;
    wallTop.push(y);
    const [nx, ny, nz] = wallNormal(x, z);
    push(x, y, z, nx, ny, nz, 0, 0, 0);
  }
  // 侧壁底环顶点与底环位置相同但法线不同（侧壁法线水平），故另建一份。
  const wallBotBase = positions.length / 3;
  for (let i = 0; i < M; i++) {
    const x = botOutline[i * 2];
    const z = botOutline[i * 2 + 1];
    const [nx, ny, nz] = wallNormal(x, z);
    push(x, 0, z, nx, ny, nz, 0, 0, 0);
  }
  band(wallBotBase, wallBase, M);

  // ---- 倒角圆环（wallBase → fillet 各段 → 顶面外环） ------------------------
  // 每段：沿外法线向内 offset = fillet·(1−cosφ)，高度 + fillet·sinφ；
  // 法线 = 外法线·cosφ + up·sinφ，与侧壁、顶面无缝相接。
  let prevBase = wallBase;
  for (let k = 1; k <= FILLET_SEGMENTS; k++) {
    const phi = (Math.PI / 2) * (k / FILLET_SEGMENTS);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const curBase = positions.length / 3;
    const isLast = k === FILLET_SEGMENTS;
    for (let i = 0; i < M; i++) {
      const ox = wallOutline[i * 2];
      const oz = wallOutline[i * 2 + 1];
      const len = Math.hypot(ox, oz) || 1;
      const ex = ox / len;
      const ez = oz / len;
      const off = fillet * (1 - c);
      const x = ox - ex * off;
      const z = oz - ez * off;
      // 用弧点处实际 crownY 计算高度，避免大碗深时 fillet 中间步出现折棱。
      const yBase = crownY(x, z) - fillet * (1 - s);
      const [cnx, cny, cnz] = crownNormal(x);
      const nx = ex * c * 1 + cnx * s;
      const ny = cny * s;
      const nz = ez * c * 1 + cnz * s;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const u = isLast ? (x + innerHalfW) / innerExtentW : 0;
      const v = isLast ? (z + innerHalfZ) / innerExtentZ : 0;
      push(x, yBase, z, nx / nl, ny / nl, nz / nl, u, v, isLast ? 1 : 0);
    }
    band(prevBase, curBase, M);
    prevBase = curBase;
  }
  const topEdgeBase = prevBase;

  // ---- 顶面（外环 → 同心环 → 中心点），UV 铺满 [0,1] ----------------------
  const ringBase: number[] = [topEdgeBase];
  const ringSize: number[] = [M];
  for (let r = 1; r <= DISH_RINGS; r++) {
    const t = 1 - r / (DISH_RINGS + 1);
    const outline = roundedRectOutline(
      innerHalfW * t,
      innerHalfZ * t,
      cornerInner * t,
      SIDE_SEGMENTS
    );
    const base = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = outline[i * 2];
      const z = outline[i * 2 + 1];
      const [nx, ny, nz] = crownNormal(x);
      push(
        x,
        crownY(x, z),
        z,
        nx,
        ny,
        nz,
        (x + innerHalfW) / innerExtentW,
        (z + innerHalfZ) / innerExtentZ,
        1
      );
    }
    ringBase.push(base);
    ringSize.push(M);
  }
  const centerBase = positions.length / 3;
  {
    const [nx, ny, nz] = crownNormal(0);
    push(0, crownY(0, 0), 0, nx, ny, nz, 0.5, 0.5, 1);
  }
  // 环 → 环
  for (let r = 1; r < ringBase.length; r++) {
    band(ringBase[r - 1], ringBase[r], M);
  }
  // 最内环 → 中心点
  const lastBase = ringBase[ringBase.length - 1];
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    indices.push(lastBase + i, lastBase + i2, centerBase);
  }

  // ---- 底面 cap（法线朝下，反向绕序） --------------------------------------
  const capBase = positions.length / 3;
  push(0, 0, 0, 0, -1, 0, 0, 0, 0);
  for (let i = 0; i < M; i++) {
    push(botOutline[i * 2], 0, botOutline[i * 2 + 1], 0, -1, 0, 0, 0, 0);
  }
  for (let i = 0; i < M; i++) {
    indices.push(capBase, capBase + 1 + ((i + 1) % M), capBase + 1 + i);
  }

  fixWinding(positions, normals, indices);

  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aIsTop", new Float32BufferAttribute(isTop, 1));
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

/** 图集每 U 的基础像素，乘以 dpr（上限 2）得到实际光栅分辨率。 */
const PX_PER_U = 96;
/** 与 labels.ts 的测量字体一致，保证适配结果和绘制宽度吻合。 */
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif`;

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
// 受光材质（MeshStandardMaterial + onBeforeCompile 注入印字）
// ---------------------------------------------------------------------------

const VERT_PRELUDE = /* glsl */ `
attribute float aIsTop;
attribute vec2 aUvOffset;
attribute vec2 aUvScale;
varying float vIsTop;
varying vec2 vTopUv;
`;

const VERT_MAIN = /* glsl */ `
vIsTop = aIsTop;
vTopUv = aUvOffset + uv * aUvScale;
`;

const FRAG_PRELUDE = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uTextDark;
uniform vec3 uTextLight;
varying float vIsTop;
varying vec2 vTopUv;
`;

/**
 * 在实例色（instanceColor）与材质色都合成进 diffuseColor 之后、进入光照之前
 * 叠印字：图集只存字形 alpha，颜色按当前填充色明暗取深/浅两档，
 * 这样印字跟着键帽一起受光，而不是浮在受光结果之上。
 */
const FRAG_LABEL = /* glsl */ `
{
  float glyph = vIsTop * texture2D( uAtlas, vTopUv ).a;
  if ( glyph > 0.001 ) {
    float lum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
    // 浅色键帽（lum ≥ 0.5）用深字，深色键帽用浅字
    vec3 textColor = mix( uTextLight, uTextDark, step( 0.5, lum ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, textColor, glyph );
  }
}
`;

export type KeycapMaterialHandle = {
  material: MeshStandardMaterial;
  /** 主题切换后更新标签深浅色（就地改 uniform 引用，无需重编译）。 */
  setTextColors: (dark: Color, light: Color) => void;
};

/** 构建受光键帽材质：PBT 质感的哑光塑料（粗糙度高、不反金属光）。
 *  PBT 的观感是「细颗粒哑光」：高光被打散成一大片很弱的漫反射，没有 ABS 打油后
 *  那种窄而亮的高光条。所以 roughness 拉到接近全漫反射（0.88），并压低环境反射
 *  （envMapIntensity 0.5）—— 保留一点天空光的体积感，但不让它读成塑料膜反光。 */
export function buildKeycapMaterial(atlas: CanvasTexture): KeycapMaterialHandle {
  const darkText = new Color("#2A2730");
  const lightText = new Color("#FFFFFF");
  const material = new MeshStandardMaterial({
    roughness: 0.88,
    metalness: 0,
    envMapIntensity: 0.5,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas };
    shader.uniforms.uTextDark = { value: darkText };
    shader.uniforms.uTextLight = { value: lightText };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERT_PRELUDE + "\n#include <common>")
      .replace("#include <begin_vertex>", VERT_MAIN + "\n#include <begin_vertex>");

    // 注入点在 color_fragment 之后：此时 diffuseColor 已乘上材质色与实例色，
    // 但还没进光照 —— 印字是 albedo，跟着键帽一起被照亮，而不是浮在受光结果上。
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", FRAG_PRELUDE + "\n#include <common>")
      .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_LABEL);
  };

  return {
    material,
    setTextColors: (dark, light) => {
      darkText.copy(dark);
      lightText.copy(light);
    },
  };
}
