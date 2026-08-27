// 一次性脚本（不参与构建）：从 tokens.css 的实际值推导分类色相禁区，
// 并为内置分类分配种子 hue。与 src/categories/color.ts 的算法保持一致。
//   node scripts/seed-hues.mjs
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToOklch(hex) {
  const h = hex.replace("#", "").trim();
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

const HEX = "(#[0-9A-Fa-f]{6})";
const grab = (name) =>
  [...css.matchAll(new RegExp(name + "\\s*:\\s*" + HEX, "g"))].map((m) => m[1]);

const intensity = [];
for (let i = 0; i <= 4; i++) intensity.push(...grab("--intensity-" + i));
const accent = grab("--color-accent");

const MIN_C = 0.04; // 低于此彩度视为中性色，色相无意义（--intensity-0 正是如此）
const huesOf = (hexes) => hexes.map(hexToOklch).filter((o) => o.C >= MIN_C).map((o) => o.H);
const iH = huesOf(intensity);
const aH = huesOf(accent);
console.log("intensity 值:", intensity.join(" "));
console.log("intensity 有效色相:", iH.map((h) => h.toFixed(1)).join(", "));
console.log("accent    值:", accent.join(" "));
console.log("accent    有效色相:", aH.map((h) => h.toFixed(1)).join(", "));

const PAD = 15;
const arcOf = (hs) => [Math.min(...hs) - PAD, Math.max(...hs) + PAD];
const forbidden = [arcOf(iH), arcOf(aH)];
console.log("禁区:", forbidden.map(([a, b]) => "[" + a.toFixed(1) + ", " + b.toFixed(1) + "]").join("  "));

function allowedArcs(forb) {
  const f = [...forb].sort((x, y) => x[0] - y[0]);
  const out = [];
  let cur = 0;
  for (const [s, e] of f) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < 360) out.push([cur, 360]);
  if (out.length > 1 && out[0][0] === 0 && out[out.length - 1][1] === 360) {
    const last = out.pop();
    const first = out.shift();
    out.push([last[0], last[1] + (first[1] - first[0])]);
  }
  return out;
}

const arcs = allowedArcs(forbidden);
console.log("允许弧:", arcs.map(([a, b]) => "[" + a.toFixed(1) + ", " + b.toFixed(1) + "]").join("  "));
const total = arcs.reduce((s, [a, b]) => s + (b - a), 0);
console.log("允许弧总长:", total.toFixed(1));

const IDS = [
  "development", "communication", "browsing", "entertainment", "design", "document",
  "system", "remote", "download", "ai_assistant", "other", "uncategorized",
];
const step = total / IDS.length;
const at = (t) => {
  let acc = 0;
  for (const [a, b] of arcs) {
    const w = b - a;
    if (t < acc + w) return (a + (t - acc)) % 360;
    acc += w;
  }
  return arcs[arcs.length - 1][1] % 360;
};
console.log("\n种子 hue（内置分类按序均匀铺满允许弧）：");
IDS.forEach((id, k) => console.log("  " + id.padEnd(14) + " " + at(step * (k + 0.5)).toFixed(1)));
