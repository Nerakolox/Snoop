/**
 * 键帽上方的热度柱（高度编码）。
 *
 * 每个键一根方柱，从键帽顶面垂直升起，高度 = √(count/max) * MAX_RISE。
 * 截面 0.18U 圆角方形，顶部一圈 45° 倒角（受光成一条亮线）。
 * 颜色用 intensity 阶色（与键帽同域，但独立网格独立材质）。
 * 开关时用 plateMix（0→1）做整体缩放，从帽面长出/缩回。
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
} from "three";

// ---- 尺寸常量（U） --------------------------------------------------------

/** 柱子截面边长（U）。 */
export const PILLAR_SIZE = 0.18;
/** 顶部倒角高度（U）：受光成一条细亮线，与外壳分模线同语言。 */
const PILLAR_CHAMFER = 0.022;
/** 最大柱高（U）：count = max 时的高度。 */
export const PILLAR_MAX_RISE = 1.2;
/** 柱底嵌入键帽顶面多少（U）：0 会留缝；略微嵌入消除浮空感。 */
export const PILLAR_SINK = 0.012;

// ---- 几何 ------------------------------------------------------------------

/**
 * 构建单根单位高度的柱体几何（Y 轴：0 → 1，X/Z 中心在原点）。
 * 实例矩阵按 (pos, quat, scale) 合成：scale.y = 柱实际高度。
 *
 * 形状：正方截面 + 顶部四棱台倒角。
 */
export function buildPillarGeometry(): BufferGeometry {
  const s = PILLAR_SIZE / 2;          // 截面半宽
  const c = PILLAR_CHAMFER;           // 倒角
  const cs = s - c;                   // 倒角顶面半宽

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const v = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const len = Math.hypot(nx, ny, nz) || 1;
    positions.push(x, y, z);
    normals.push(nx / len, ny / len, nz / len);
  };

  // 底面（y=0，朝下，一个方形 cap）
  {
    const b = positions.length / 3;
    v(-s, 0,  s, 0, -1, 0); // 0
    v( s, 0,  s, 0, -1, 0); // 1
    v( s, 0, -s, 0, -1, 0); // 2
    v(-s, 0, -s, 0, -1, 0); // 3
    indices.push(b, b+2, b+1, b, b+3, b+2);
  }

  // 四个侧面（从 y=0 到 y=1−c）
  const sides: Array<[number, number, number, number, number, number, number, number]> = [
    // [x0,z0, x1,z1, nx, nz, ...] each face 0-height quad
    [-s,  s,  s,  s,  0,  1, 0, 0],
    [ s,  s,  s, -s,  1,  0, 0, 0],
    [ s, -s, -s, -s,  0, -1, 0, 0],
    [-s, -s, -s,  s, -1,  0, 0, 0],
  ];
  for (const [x0, z0, x1, z1, nx, nz] of sides) {
    const b = positions.length / 3;
    v(x0, 0,   z0, nx, 0, nz);
    v(x1, 0,   z1, nx, 0, nz);
    v(x1, 1-c, z1, nx, 0, nz);
    v(x0, 1-c, z0, nx, 0, nz);
    indices.push(b, b+1, b+2, b, b+2, b+3);
  }

  // 四个倒角斜面（从 y=1−c,±s 到 y=1,±(s−c)）
  const INV = 1 / Math.SQRT2;
  // 斜面：每面 4 顶点梯形
  const chamferFaces: Array<[number,number,number,number, number,number,number,number, number,number]> = [
    [-s,  s,  s,  s, -cs,  cs,  cs,  cs,  0,  INV],  // +Z 面
    [ s,  s,  s, -s,  cs,  cs,  cs, -cs,  INV, 0],   // +X 面
    [ s, -s, -s, -s,  cs, -cs, -cs, -cs,  0, -INV],  // -Z 面
    [-s, -s, -s,  s, -cs, -cs, -cs,  cs, -INV, 0],   // -X 面
  ];
  for (const [bx0,bz0, bx1,bz1, tx0,tz0, tx1,tz1, cnx,cnz] of chamferFaces) {
    const b = positions.length / 3;
    const cny = INV;
    v(bx0, 1-c, bz0, cnx, cny, cnz);
    v(bx1, 1-c, bz1, cnx, cny, cnz);
    v(tx1, 1,   tz1, cnx, cny, cnz);
    v(tx0, 1,   tz0, cnx, cny, cnz);
    indices.push(b, b+1, b+2, b, b+2, b+3);
  }

  // 顶面（y=1，小方形，朝上）
  {
    const b = positions.length / 3;
    v(-cs, 1,  cs, 0, 1, 0);
    v( cs, 1,  cs, 0, 1, 0);
    v( cs, 1, -cs, 0, 1, 0);
    v(-cs, 1, -cs, 0, 1, 0);
    indices.push(b, b+1, b+2, b, b+2, b+3);
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new Float32BufferAttribute(normals,   3));
  geo.setIndex(indices);
  return geo;
}

// ---- 实例化资源 ------------------------------------------------------------

export type PillarResources = {
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  /** 每键目标高度（U），由调用方写入后调 mesh.instanceMatrix.needsUpdate。 */
  targetHeights: Float32Array;
  dispose: () => void;
};

/**
 * 构建 n 个键的柱体实例化资源。
 * 材质：磨砂半透明，颜色由调用方 setColorAt 写入。
 */
export function buildPillarResources(n: number): PillarResources {
  const geometry = buildPillarGeometry();
  const material = new MeshStandardMaterial({
    roughness: 0.72,
    metalness: 0.0,
    transparent: true,
    opacity: 0.82,
  });
  const mesh = new InstancedMesh(geometry, material, Math.max(1, n));
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // 初始全部缩放为 0，不可见
  mesh.count = n;

  const targetHeights = new Float32Array(n);

  return {
    mesh,
    geometry,
    material,
    targetHeights,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
