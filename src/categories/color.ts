// 分类取色 —— OKLCH，固定 L/C 只变 H。
//
// 为什么是 OKLCH 而不是 HSL：HSL 的「亮度」是几何量不是感知量，同一个 L 值下
// 黄色看起来比蓝色亮得多。一组分类色如果用 HSL 均匀铺色相，读者会觉得某几个
// 分类"更重"——而分类之间本来是平权的。OKLCH 的 L 是感知亮度，固定 L 就真的
// 等亮度。
//
// 三条硬约束：
//   1. **色相禁区**。暖色阶 --intensity-* 是「活跃强度」的唯一编码，品牌紫是
//      交互与身份的唯一编码。分类色撞进这两段色相，读者就会把"某个分类"误读成
//      "强度高"或"被选中"。禁区从 token 的**实际值**算出（各向两侧外扩 15°），
//      不写死角度：将来调 token，禁区跟着走。
//   2. **只持久化 hue**。深浅主题下的 L/C 由主题层的 --cat-l / --cat-c 给，
//      所以切主题分类色自动适配，不用存两套色值。
//   3. **色相一旦分配就不再重算**。新建时找最大空隙取中点写进该分类，此后
//      删除/归档/新增别的分类都不动它。绝不能实现成"按列表位置算第 N 个颜色"
//      ——那样删掉中间一个，后面所有分类的颜色会集体平移。

/** 色相禁区外扩角度：token 实际色相范围向两侧各让出这么多度。 */
const PAD_DEG = 15;

/** 低于此彩度的 token 视为中性色，色相无意义（--intensity-0 正是这种淡灰）。 */
const MIN_CHROMA = 0.04;

export interface Arc {
  /** 起始角，[0,360) */
  start: number;
  /** 结束角，可能 > 360（表示跨过 0 度） */
  end: number;
}

// ── sRGB ↔ OKLCH ────────────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(x: number): number {
  const v = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** #RRGGBB → OKLCH。非法输入返回 null。 */
export function hexToOklch(hex: string): Oklch | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  const r = srgbToLinear(parseInt(v.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(v.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(v.slice(4, 6), 16));

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}

/** OKLCH → #RRGGBB（取色器要拿一个具体 hex 当初值时用）。 */
export function oklchToHex({ l, c, h }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.2914855480 * B;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const r = linearToSrgb(+4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3);
  const g = linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3);
  const b = linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ── 从 tokens 读禁区 ────────────────────────────────────────────────────────

const INTENSITY_TOKENS = [
  "--intensity-0", "--intensity-1", "--intensity-2", "--intensity-3", "--intensity-4",
];
const ACCENT_TOKEN = "--color-accent";

/**
 * 读一组 CSS 变量在指定主题下的值。
 *
 * tokens.css 把深浅两套值挂在 `[data-theme="dark"]` / `[data-theme="light"]` 上，
 * getComputedStyle 只能给出**当前**主题的值。所以挂一个离屏探针元素、给它打上
 * 目标主题的属性，就能把另一套值也读出来——禁区必须覆盖两个主题，否则浅色下
 * 避开了、切到深色又撞上。
 */
function readTokens(theme: string, names: string[]): string[] {
  const probe = document.createElement("div");
  probe.setAttribute("data-theme", theme);
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = names.map((n) => cs.getPropertyValue(n).trim());
  probe.remove();
  return out;
}

function huesOf(values: string[]): number[] {
  return values
    .map(hexToOklch)
    .filter((o): o is Oklch => o !== null && o.c >= MIN_CHROMA)
    .map((o) => o.h);
}

function arcOf(hues: number[]): Arc | null {
  if (hues.length === 0) return null;
  return { start: Math.min(...hues) - PAD_DEG, end: Math.max(...hues) + PAD_DEG };
}

let cachedForbidden: Arc[] | null = null;

/**
 * 分类色不得落入的色相区间：强度色阶一段、品牌色一段，各向两侧外扩 15°。
 * 跨深浅两个主题取并集。结果缓存——token 是构建期常量，运行时不会变。
 */
export function forbiddenArcs(): Arc[] {
  if (cachedForbidden) return cachedForbidden;
  const intensity: string[] = [];
  const accent: string[] = [];
  for (const theme of ["light", "dark"]) {
    intensity.push(...readTokens(theme, INTENSITY_TOKENS));
    accent.push(...readTokens(theme, [ACCENT_TOKEN]));
  }
  const arcs = [arcOf(huesOf(intensity)), arcOf(huesOf(accent))].filter(
    (a): a is Arc => a !== null,
  );
  cachedForbidden = arcs;
  return arcs;
}

/** 允许弧 = 整圈减去禁区。首尾相接的两段会合并成一段跨 0 度的弧。 */
export function allowedArcs(): Arc[] {
  const forb = [...forbiddenArcs()].sort((a, b) => a.start - b.start);
  const out: Arc[] = [];
  let cur = 0;
  for (const f of forb) {
    if (f.start > cur) out.push({ start: cur, end: f.start });
    cur = Math.max(cur, f.end);
  }
  if (cur < 360) out.push({ start: cur, end: 360 });
  if (out.length > 1 && out[0].start === 0 && out[out.length - 1].end === 360) {
    const last = out.pop()!;
    const first = out.shift()!;
    out.push({ start: last.start, end: last.end + (first.end - first.start) });
  }
  return out;
}

/** 该色相是否落在允许弧内（取色器判定用）。 */
export function isHueAllowed(hue: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return allowedArcs().some(
    (a) => (h >= a.start && h < a.end) || (h + 360 >= a.start && h + 360 < a.end),
  );
}

/** 该色相被哪一段占用了。用于给用户一句准确的提示，而不是笼统说「不可用」。 */
export function forbiddenReason(hue: number): "intensity" | "accent" | null {
  if (isHueAllowed(hue)) return null;
  const arcs = forbiddenArcs();
  const h = ((hue % 360) + 360) % 360;
  const inArc = (a: Arc | undefined) => !!a && h >= a.start && h < a.end;
  if (inArc(arcs[0])) return "intensity";
  if (inArc(arcs[1])) return "accent";
  return "accent";
}

/**
 * 给新分类挑一个色相：在允许弧上找**最大空隙**，取中点。
 *
 * `existing` 必须包含**已归档分类**的色相——归档只是隐藏，恢复后会重新出现，
 * 那时再撞色就晚了（色相分配后不再重算）。
 */
export function pickNewHue(existing: number[]): number {
  const arcs = allowedArcs();
  const used = existing
    .map((h) => ((h % 360) + 360) % 360)
    .filter((h) => Number.isFinite(h));

  let best = { width: -1, hue: arcs.length > 0 ? (arcs[0].start + arcs[0].end) / 2 : 0 };
  for (const a of arcs) {
    // 落在这段弧里的已用色相（跨 0 度的弧要把小角度的 +360 折进来）
    const inside = used
      .map((h) => (h >= a.start && h < a.end ? h : h + 360 >= a.start && h + 360 < a.end ? h + 360 : null))
      .filter((h): h is number => h !== null)
      .sort((x, y) => x - y);

    const bounds = [a.start, ...inside, a.end];
    for (let i = 0; i < bounds.length - 1; i++) {
      const width = bounds[i + 1] - bounds[i];
      if (width > best.width) {
        best = { width, hue: (bounds[i] + bounds[i + 1]) / 2 };
      }
    }
  }
  return Math.round((best.hue % 360) * 10) / 10;
}

// ── 输出成 CSS 颜色 ──────────────────────────────────────────────────────────

/**
 * 分类色的 CSS 值。
 *
 * `customColor` 非空时直接用它（用户坚持选了禁区里的颜色，此后不再参与主题适配）；
 * 否则用 `oklch(var(--cat-l) var(--cat-c) <hue>)`——L/C 由主题层给，所以同一个
 * hue 在深浅两个主题下自动变成各自合适的明度与彩度。
 */
export function categoryColor(hue: number, customColor?: string | null): string {
  if (customColor) return customColor;
  return `oklch(var(--cat-l) var(--cat-c) ${hue})`;
}

/** 同上，但用于需要更淡一层的场合（chip 背景等）。 */
export function categoryColorSoft(hue: number, customColor?: string | null): string {
  if (customColor) return customColor;
  return `oklch(var(--cat-l-soft) var(--cat-c-soft) ${hue})`;
}

/**
 * 色相 → 当前主题下的 hex。
 *
 * `<input type="color">` 只认 hex，给不了 `oklch(var(--cat-l) …)`，所以要把
 * 当前主题的 L/C 读出来把色相实例化成一个具体色值。读的是 token 而不是写死
 * 0.62/0.15：改主题层的 L/C，取色器里的初值跟着变。
 */
export function hueToHex(hue: number): string {
  const cs = getComputedStyle(document.documentElement);
  const l = parseFloat(cs.getPropertyValue("--cat-l")) || 0.62;
  const c = parseFloat(cs.getPropertyValue("--cat-c")) || 0.15;
  return oklchToHex({ l, c, h: hue });
}
