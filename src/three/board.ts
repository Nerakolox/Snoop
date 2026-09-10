// @ts-nocheck
/**
 * 3D 键盘的外壳 / 定位板 / 轴柱 / 标记几何。
 *
 * 全部用中性色 token（见 tokens.ts 的 plate / caseColor / stem），绝不取暖色阶
 * --intensity-*，避免与「活跃强度」编码混淆。几何用「顶点灰度明暗 + 材质颜色相乘」
 * 做出确定性的体感（顶面最亮、侧面/倒角略暗、底面最暗），不接任何灯光/高光/法线，
 * 不随相机角度变化。
 */

import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  SphereGeometry,
} from "three";
import { roundedRectOutline } from "./keycap";

// ---- 尺寸常量（U，1U ≈ 一个键宽） -----------------------------------------

/** 外壳超出定位板每边的宽度（U）。 */
export const CASE_BEZEL = 0.55;
/** 外壳高度（底座厚，U）。 */
export const CASE_HEIGHT = 0.3;
/** 外壳圆角半径（U）。 */
export const CASE_CORNER = 0.32;
/** 外壳顶沿倒角宽度（U）。 */
export const CASE_BEVEL = 0.09;
/** 定位板超出键帽区每边的宽度（U）。 */
export const PLATE_MARGIN = 0.3;
/** 定位板厚度（U）。 */
export const PLATE_THICKNESS = 0.04;
/** 轴柱最大宽度（U）：宽键（空格/回车等）的轴柱封顶成居中开关状，避免整段宽块。 */
export const STEM_MAX_W = 1.4;
/** 轴柱相对键帽的最小/比例宽度（键帽 XZ 的 0.5 倍，夹在 0.18..STEM_MAX_W 之间）。 */
export const STEM_MIN_W = 0.18;
/** 超 95 分位标记球的半径（U）。 */
export const MARKER_RADIUS = 0.085;

// 圆角轮廓的弧线段数（与键帽一致）。
const SEG = 4;

// 顶点明暗（灰度；最终色 = 材质 color × 顶点色）。
const SHADE_TOP = 1.0;
const SHADE_SIDE = 0.86;
const SHADE_BOTTOM = 0.78;

function finish(positions: number[], colors: number[], indices: number[]): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

/** 定位板：一块圆角矩形薄板，顶面 Y=0、底面 Y=-PLATE_THICKNESS。 */
export function buildPlateGeometry(w: number, h: number): BufferGeometry {
  const hx = w / 2;
  const hz = h / 2;
  const out = roundedRectOutline(hx, hz, CASE_CORNER, SEG);
  const M = out.length / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, s: number) => {
    positions.push(x, y, z);
    colors.push(s, s, s);
  };

  // 顶面 cap（Y=0）
  const top = positions.length / 3;
  push(0, 0, 0, SHADE_TOP);
  for (let i = 0; i < M; i++) push(out[i * 2], 0, out[i * 2 + 1], SHADE_TOP);
  for (let i = 0; i < M; i++) indices.push(top, top + 1 + i, top + 1 + ((i + 1) % M));

  // 底面 cap（Y=-PLATE_THICKNESS，反向绕序）
  const bot = positions.length / 3;
  push(0, -PLATE_THICKNESS, 0, SHADE_BOTTOM);
  for (let i = 0; i < M; i++) push(out[i * 2], -PLATE_THICKNESS, out[i * 2 + 1], SHADE_BOTTOM);
  for (let i = 0; i < M; i++) indices.push(bot, bot + 1 + ((i + 1) % M), bot + 1 + i);

  // 侧壁
  const side = positions.length / 3;
  for (let i = 0; i < M; i++) {
    push(out[i * 2], 0, out[i * 2 + 1], SHADE_SIDE);
    push(out[i * 2], -PLATE_THICKNESS, out[i * 2 + 1], SHADE_SIDE);
  }
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    const t0 = side + i * 2;
    const b0 = side + i * 2 + 1;
    const t1 = side + i2 * 2;
    const b1 = side + i2 * 2 + 1;
    indices.push(t0, t1, b1, t0, b1, b0);
  }

  return finish(positions, colors, indices);
}

/**
 * 外壳：圆角盒 + 顶沿倒角。顶面（Y=0，尺寸 w×h）→ 倒角带（Y=-CASE_BEVEL，外扩
 * CASE_BEVEL）→ 直壁（Y=-CASE_HEIGHT），底面封口。倒角避免生硬直角。
 */
export function buildCaseGeometry(w: number, h: number): BufferGeometry {
  const topHx = w / 2;
  const topHz = h / 2;
  const bevHx = topHx + CASE_BEVEL;
  const bevHz = topHz + CASE_BEVEL;
  const top = roundedRectOutline(topHx, topHz, CASE_CORNER, SEG);
  const bev = roundedRectOutline(bevHx, bevHz, CASE_CORNER + CASE_BEVEL, SEG);
  const M = top.length / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, s: number) => {
    positions.push(x, y, z);
    colors.push(s, s, s);
  };

  // 顶面 cap（Y=0）
  const cap = positions.length / 3;
  push(0, 0, 0, SHADE_TOP);
  for (let i = 0; i < M; i++) push(top[i * 2], 0, top[i * 2 + 1], SHADE_TOP);
  for (let i = 0; i < M; i++) indices.push(cap, cap + 1 + i, cap + 1 + ((i + 1) % M));

  // 倒角带（Y=0 → Y=-CASE_BEVEL）
  const bevTop = positions.length / 3;
  for (let i = 0; i < M; i++) push(top[i * 2], 0, top[i * 2 + 1], SHADE_SIDE);
  const bevBot = positions.length / 3;
  for (let i = 0; i < M; i++) push(bev[i * 2], -CASE_BEVEL, bev[i * 2 + 1], SHADE_SIDE);
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    const a0 = bevTop + i;
    const a1 = bevTop + i2;
    const b0 = bevBot + i;
    const b1 = bevBot + i2;
    indices.push(a0, a1, b1, a0, b1, b0);
  }

  // 直壁（Y=-CASE_BEVEL → Y=-CASE_HEIGHT，复用倒带下环顶点）
  const wallTop = bevBot;
  const wallBot = positions.length / 3;
  for (let i = 0; i < M; i++) push(bev[i * 2], -CASE_HEIGHT, bev[i * 2 + 1], SHADE_SIDE);
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    const a0 = wallTop + i;
    const a1 = wallTop + i2;
    const b0 = wallBot + i;
    const b1 = wallBot + i2;
    indices.push(a0, a1, b1, a0, b1, b0);
  }

  // 底面 cap（Y=-CASE_HEIGHT，反向绕序）
  const bot = positions.length / 3;
  push(0, -CASE_HEIGHT, 0, SHADE_BOTTOM);
  for (let i = 0; i < M; i++) push(bev[i * 2], -CASE_HEIGHT, bev[i * 2 + 1], SHADE_BOTTOM);
  for (let i = 0; i < M; i++) indices.push(bot, bot + 1 + ((i + 1) % M), bot + 1 + i);

  return finish(positions, colors, indices);
}

/** 轴柱：单位立方体（原点居中）。实例矩阵把它平移/缩放到键帽正下方。 */
export function buildStemGeometry(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

/** 超 95 分位标记：小圆球（原点居中），放在轴柱顶端。 */
export function buildMarkerGeometry(): SphereGeometry {
  return new SphereGeometry(MARKER_RADIUS, 8, 8);
}
