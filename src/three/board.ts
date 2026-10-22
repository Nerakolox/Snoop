// @ts-nocheck
/**
 * 3D 键盘的外壳 / 键位格 / 轴柱 / 标记几何。
 *
 * 形状语言是一条纵向剖面：整块圆角外壳（外壁 → 顶沿倒角 → 顶面环带 → 腔体内壁 →
 * 腔底），腔体里嵌一层「键位格」—— 每个键一格，格子顶面在键帽底面附近，中间凿出
 * 比键帽足迹略大的圆角方孔，孔壁斜切一圈后下探到凹槽底。键帽底面陷进孔里，
 * 侧壁从凹槽中升起、四周留一圈缝，读起来就是「键座在壳里」，而不是一块贴纸板。
 *
 * 所有几何都用解析法线 + fixWinding 校正绕序，交给真实光照（MeshStandardMaterial）
 * 塑形，不再烘焙顶点灰度。颜色取自中性色 token：外壳 caseColor、键位格 plate、
 * 轴柱 stem，绝不取暖色阶 --intensity-*。
 *
 * 坐标约定：键帽底面为 Y=0（向上为正），配列坐标以配列中心为原点。
 */

import { BufferGeometry, Float32BufferAttribute } from "three";
import type { LayoutKey } from "../keyboardLayout";
import { KEY_GAP, KEY_UNIT } from "../layouts/metrics";
import { fixWinding, roundedRectOutline } from "./keycap";

// ---- 尺寸常量（U，1U ≈ 一个键宽） -----------------------------------------

/** 外壳超出键区每边的宽度（U）：铝坨坨的边框收紧，45mm 左右一条。 */
export const CASE_BEZEL = 0.52;
/** 外壳总高度（U）：自键帽底面往下。整块铣出来的厚铝，侧壁要压得住场。 */
export const CASE_HEIGHT = 0.52;
/** 外壳圆角半径（U）：只留铣刀的极限圆角，转角干脆、不圆润。 */
export const CASE_CORNER = 0.12;
/** 外壳顶沿高度（U）：略高于键位格顶面，形成一圈低矮的托边。 */
export const CASE_TOP = 0.03;
/** 顶沿倒角宽度（U）：外壁向内收拢的那圈 45° 斜面，受光成一条细亮线。 */
export const CASE_CHAMFER = 0.004;
/** 上下壳分模线的位置（U，自键帽底面往下）。 */
const CASE_SEAM_Y = -0.1;
/** 分模线凹槽的纵向高度（U）。 */
const CASE_SEAM_W = 0.018;
/** 分模线凹槽的深度（U）。 */
const CASE_SEAM_INSET = 0.011;
/** 外壳腔底高度（U）：远低于凹槽底，只兜住键区缝隙里的视线。 */
export const CASE_FLOOR = -0.17;
/** 腔体开口相对键区的外扩量（U）：留一条缝，避免与键位格边缘共面。 */
const CASE_OPENING_PAD = 0.006;
/** 外壳的圆角弧线段数：外框只有一份，给足分段。 */
const CASE_SEG = 24;

/** 键位格顶面高度（U）：比键帽底面高一点，键帽下缘因此陷进孔里。 */
export const DECK_TOP = 0.012;
/** 凹槽底高度（U）：键帽底面之下，接受阴影。 */
export const DECK_FLOOR = -0.063;
/** 键位格底面高度（U）：藏在外壳腔体里，只用来封闭格子。 */
const DECK_BOTTOM = -0.12;
/** 键帽足迹四周的缝宽（U，每边）。 */
const DECK_CLEARANCE = 0.022;
/** 孔口斜切宽度（U）：受光时在孔沿形成一圈细高光。 */
const DECK_CHAMFER = 0.012;
/** 键位格的圆角弧线段数（每格顶点数 = 4 × (2 × seg + 1)）。 */
const DECK_SEG = 3;
/** 格子外轮廓的圆角半径（U）：极小，只为避免尖角处的退化三角形。 */
const CELL_CORNER = 0.005;
/** 凹孔圆角半径（U）：跟键帽底缘圆角接近，四周缝宽看起来均匀。 */
const HOLE_CORNER = 0.045;

function finish(positions: number[], normals: number[], indices: number[]): BufferGeometry {
  fixWinding(positions, normals, indices);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/** 通用环带连接：a（下环）→ b（上环），绕序由 fixWinding 统一校正。 */
function band(
  indices: number[],
  aBase: number,
  bBase: number,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    const i2 = (i + 1) % count;
    const a0 = aBase + i;
    const a1 = aBase + i2;
    const b0 = bBase + i;
    const b1 = bBase + i2;
    indices.push(a0, a1, b1, a0, b1, b0);
  }
}

/**
 * 外壳：一整块圆角实体，顶面留一个矩形开口，开口往下是一圈腔体内壁和腔底。
 *
 * 形状按「CNC 一体成型铝坨坨」来做：侧壁近乎直立、转角只留铣刀圆角、顶沿一圈
 * 45° 倒角受光成亮线，侧壁中部一道极窄的上下壳分模线凹槽 —— 这几条硬棱线是
 * 铝件和塑料托盘拉开差距的地方。腔体本身看不见（被键位格盖住），作用只是让
 * 键位格的凹孔下方没有封板，从而能真的「凿下去」。
 */
export function buildCaseGeometry(
  w: number,
  h: number,
  openingW: number,
  openingH: number
): BufferGeometry {
  const hx = w / 2;
  const hz = h / 2;
  const outer = roundedRectOutline(hx, hz, CASE_CORNER, CASE_SEG);
  const rim = roundedRectOutline(
    hx - CASE_CHAMFER,
    hz - CASE_CHAMFER,
    Math.max(0.01, CASE_CORNER - CASE_CHAMFER),
    CASE_SEG
  );
  // 分模线凹槽的内缩环：沿外法线整体内收 SEAM_INSET，形成一道细槽
  const seamInner = roundedRectOutline(
    hx - CASE_SEAM_INSET,
    hz - CASE_SEAM_INSET,
    Math.max(0.01, CASE_CORNER - CASE_SEAM_INSET),
    CASE_SEG
  );
  const open = roundedRectOutline(
    openingW / 2 + CASE_OPENING_PAD,
    openingH / 2 + CASE_OPENING_PAD,
    0.12,
    CASE_SEG
  );
  const M = outer.length / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };
  const outward = (x: number, z: number) => {
    const len = Math.hypot(x, z) || 1;
    return [x / len, z / len] as const;
  };
  /** 把一圈轮廓（XZ 点对）整体压到指定高度，法线取固定值或沿外法线。 */
  const ringAt = (
    outline: Float32Array,
    y: number,
    normal: (ex: number, ez: number) => readonly [number, number, number]
  ): number => {
    const base = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = outline[i * 2];
      const z = outline[i * 2 + 1];
      const [ex, ez] = outward(x, z);
      const [nx, ny, nz] = normal(ex, ez);
      push(x, y, z, nx, ny, nz);
    }
    return base;
  };

  const wallNormal = (ex: number, ez: number) => [ex, 0.02, ez] as const;
  const up = () => [0, 1, 0] as const;
  const down = () => [0, -1, 0] as const;
  const CHAMFER_INV = 1 / Math.SQRT2;
  const chamferNormal = (ex: number, ez: number) =>
    [ex * CHAMFER_INV, CHAMFER_INV, ez * CHAMFER_INV] as const;

  const seamBottom = CASE_SEAM_Y - CASE_SEAM_W / 2;
  const seamTop = CASE_SEAM_Y + CASE_SEAM_W / 2;

  // 底面（朝下）
  const bot = positions.length / 3;
  push(0, -CASE_HEIGHT, 0, 0, -1, 0);
  for (let i = 0; i < M; i++) push(outer[i * 2], -CASE_HEIGHT, outer[i * 2 + 1], 0, -1, 0);
  for (let i = 0; i < M; i++) {
    indices.push(bot, bot + 1 + i, bot + 1 + ((i + 1) % M));
  }

  // 外壁下半段：底面 → 分模线下缘
  const wallLowBase = ringAt(outer, -CASE_HEIGHT, wallNormal);
  const wallLowTop = ringAt(outer, seamBottom, wallNormal);
  band(indices, wallLowBase, wallLowTop, M);

  // 分模线下唇：外壁 → 槽底，朝上
  const seamInnerLow = ringAt(seamInner, seamBottom, up);
  band(indices, wallLowTop, seamInnerLow, M);

  // 槽壁：往下退进一个槽深，法线朝外（槽内侧壁）
  const seamInnerHigh = ringAt(seamInner, seamTop, wallNormal);
  band(indices, seamInnerLow, seamInnerHigh, M);

  // 分模线上唇：槽底 → 外壁，朝下
  const wallHighBase = ringAt(outer, seamTop, down);
  band(indices, seamInnerHigh, wallHighBase, M);

  // 外壁上半段：分模线上缘 → 顶沿倒角下缘
  const wallHighTop = ringAt(outer, CASE_TOP - CASE_CHAMFER, wallNormal);
  band(indices, wallHighBase, wallHighTop, M);

  // 顶沿倒角：外壁顶 → 顶面环带外沿，法线 45° 斜朝上外
  const rimBase = ringAt(rim, CASE_TOP, chamferNormal);
  band(indices, wallHighTop, rimBase, M);

  // 顶面环带：外壳顶 → 腔体开口，朝上
  const openTop = ringAt(open, CASE_TOP, up);
  band(indices, rimBase, openTop, M);

  // 腔体内壁：开口顶 → 腔底，法线朝内
  const openFloor = ringAt(open, CASE_FLOOR, (ex, ez) => [-ex, 0, -ez] as const);
  band(indices, openTop, openFloor, M);

  // 腔底（朝上）：键区缝隙里看到的就是这块暗面
  const floorCap = positions.length / 3;
  push(0, CASE_FLOOR, 0, 0, 1, 0);
  for (let i = 0; i < M; i++) push(open[i * 2], CASE_FLOOR, open[i * 2 + 1], 0, 1, 0);
  for (let i = 0; i < M; i++) {
    indices.push(floorCap, floorCap + 1 + i, floorCap + 1 + ((i + 1) % M));
  }

  return finish(positions, normals, indices);
}

/**
 * 键位格：把整个键区按配列格切成一块块实心格，每格顶面凿一个圆角方孔，
 * 孔壁斜切后一路下探到凹槽底。所有格合并成一份几何（一个 draw call），
 * 相邻格的边缘在配列坐标里天然对齐。
 *
 * 每格的环（自顶向下）：
 *   cell 顶外沿 → hole 孔沿（顶面环带）
 *   → 斜切（孔沿 → 斜面底）
 *   → 直壁（斜面底 → 凹槽底）
 *   → 孔底封口（凹槽底）
 *   → cell 底外沿 → cell 顶外沿（外壁，藏在外壳腔体里）
 */
export function buildDeckGeometry(
  keys: LayoutKey[],
  maxX: number,
  maxY: number
): BufferGeometry {
  const gapU = KEY_GAP / KEY_UNIT;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };

  for (const k of keys) {
    const cx = k.x + k.w / 2 - maxX / 2;
    const cz = k.y + k.h / 2 - maxY / 2;
    const holeHx = (k.w - gapU) / 2 + DECK_CLEARANCE;
    const holeHz = (k.h - gapU) / 2 + DECK_CLEARANCE;
    const cell = roundedRectOutline(k.w / 2, k.h / 2, CELL_CORNER, DECK_SEG);
    const hole = roundedRectOutline(holeHx, holeHz, HOLE_CORNER, DECK_SEG);
    const inner = roundedRectOutline(
      holeHx - DECK_CHAMFER,
      holeHz - DECK_CHAMFER,
      Math.max(0.01, HOLE_CORNER - DECK_CHAMFER),
      DECK_SEG
    );
    const M = cell.length / 2;
    const inv = 1 / Math.SQRT2;

    // 顶面环带：格子外沿与孔沿同高，朝上
    const cellTop = positions.length / 3;
    for (let i = 0; i < M; i++) {
      push(cx + cell[i * 2], DECK_TOP, cz + cell[i * 2 + 1], 0, 1, 0);
    }
    const holeTop = positions.length / 3;
    for (let i = 0; i < M; i++) {
      push(cx + hole[i * 2], DECK_TOP, cz + hole[i * 2 + 1], 0, 1, 0);
    }
    band(indices, cellTop, holeTop, M);

    // 孔口斜切：孔沿 → 内收 DECK_CHAMFER、下降 DECK_CHAMFER，法线朝孔内上方
    const chamferBase = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = inner[i * 2];
      const z = inner[i * 2 + 1];
      const len = Math.hypot(x, z) || 1;
      push(cx + x, DECK_TOP - DECK_CHAMFER, cz + z, (-x / len) * inv, inv, (-z / len) * inv);
    }
    band(indices, holeTop, chamferBase, M);

    // 孔壁：斜面底 → 凹槽底，法线朝孔内
    const wallFloor = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = inner[i * 2];
      const z = inner[i * 2 + 1];
      const len = Math.hypot(x, z) || 1;
      push(cx + x, DECK_FLOOR, cz + z, -x / len, 0, -z / len);
    }
    band(indices, chamferBase, wallFloor, M);

    // 凹槽底：朝上的封口，接住键帽落下的影子
    const floorRing = positions.length / 3;
    for (let i = 0; i < M; i++) {
      push(cx + inner[i * 2], DECK_FLOOR, cz + inner[i * 2 + 1], 0, 1, 0);
    }
    const floorCenter = positions.length / 3;
    push(cx, DECK_FLOOR, cz, 0, 1, 0);
    for (let i = 0; i < M; i++) {
      indices.push(floorRing + i, floorRing + ((i + 1) % M), floorCenter);
    }

    // 格体外壁：底沿 → 顶沿，法线朝外（只在配列缝隙里露出）
    const cellBottom = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = cell[i * 2];
      const z = cell[i * 2 + 1];
      const len = Math.hypot(x, z) || 1;
      push(cx + x, DECK_BOTTOM, cz + z, x / len, 0, z / len);
    }
    const cellTopWall = positions.length / 3;
    for (let i = 0; i < M; i++) {
      const x = cell[i * 2];
      const z = cell[i * 2 + 1];
      const len = Math.hypot(x, z) || 1;
      push(cx + x, DECK_TOP, cz + z, x / len, 0, z / len);
    }
    band(indices, cellBottom, cellTopWall, M);
  }

  // ---- 键簇缝隙填充 ---------------------------------------------------------
  // 配列里区块之间（如主键区与编辑区）存在没有键的位置，直接露出的话会看到外壳
  // 腔底形成一道深槽。用低 0.006U 的基面按 0.25U 网格补齐：与某个键帽凹孔相交的
  // 方块整块跳过（那部分本来就被键位格顶面盖住），其余照铺。
  {
    const FILL_STEP = 0.25;
    const FILL_DROP = 0.006;
    const EPS = 1e-4;
    const cols = Math.max(1, Math.ceil(maxX / FILL_STEP - EPS));
    const rows = Math.max(1, Math.ceil(maxY / FILL_STEP - EPS));
    const stepX = maxX / cols;
    const stepZ = maxY / rows;
    // 每键凹孔在配列坐标里的范围（与键位格同一套尺寸）。注意填充方块用的是
    // 以配列中心为原点的坐标，这里必须先减掉 maxX/2、maxY/2，否则两套坐标系
    // 混比，右半区 / 下半区会把无关的方块误判成与孔相交而整块跳过。
    const holes = keys.map((k) => {
      const hx = (k.w - gapU) / 2 + DECK_CLEARANCE;
      const hz = (k.h - gapU) / 2 + DECK_CLEARANCE;
      const ccx = k.x + k.w / 2 - maxX / 2;
      const ccz = k.y + k.h / 2 - maxY / 2;
      return {
        x0: ccx - hx - EPS,
        x1: ccx + hx + EPS,
        z0: ccz - hz - EPS,
        z1: ccz + hz + EPS,
      };
    });
    const y = DECK_TOP - FILL_DROP;
    for (let r = 0; r < rows; r++) {
      const z0 = r * stepZ - maxY / 2;
      const z1 = (r + 1) * stepZ - maxY / 2;
      for (let c = 0; c < cols; c++) {
        const x0 = c * stepX - maxX / 2;
        const x1 = (c + 1) * stepX - maxX / 2;
        let blocked = false;
        for (const h of holes) {
          if (x0 < h.x1 && x1 > h.x0 && z0 < h.z1 && z1 > h.z0) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const base = positions.length / 3;
        push(x0, y, z0, 0, 1, 0);
        push(x1, y, z0, 0, 1, 0);
        push(x1, y, z1, 0, 1, 0);
        push(x0, y, z1, 0, 1, 0);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  return finish(positions, normals, indices);
}
