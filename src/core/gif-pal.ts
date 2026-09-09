import { LIMITS } from './limits';

/** 每通道保留几位做分桶：5 bit → 32×32×32 = 32768 桶 */
const BITS = LIMITS.gifPaletteBits;
const LEVELS = 1 << BITS;
const BUCKETS = LEVELS * LEVELS * LEVELS;
const SHIFT = 8 - BITS;
const MASK = LEVELS - 1;
const HALF = 1 << (SHIFT - 1);

/** GIF 调色板固定 256 项；索引 0 永远留给透明 */
export const PALETTE_ENTRIES = 256;
export const TRANSPARENT_INDEX = 0;
export const ALPHA_CUTOFF = 128;

function bucketOf(r: number, g: number, b: number): number {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
}

function redOf(bucket: number): number {
  return ((bucket >> (BITS * 2)) & MASK) << SHIFT;
}
function greenOf(bucket: number): number {
  return ((bucket >> BITS) & MASK) << SHIFT;
}
function blueOf(bucket: number): number {
  return (bucket & MASK) << SHIFT;
}

interface Box {
  from: number;
  to: number;
}

export interface Palette {
  /** 256×3 的 RGB 表，索引 0 为透明占位 */
  readonly rgb: Uint8Array;
  /** 32768 桶 → 调色板索引，量化时 O(1) 查表 */
  readonly bucketIndex: Uint8Array;
  readonly used: number;
}

/**
 * 中位切分：只在占用桶上做，按像素数加权把最宽的盒子对半切，最多 255 色（0 号留给透明）。
 * 桶的代表色用桶内真实像素均值，而不是桶中心——否则纯黑会变成 4 这类系统偏差。
 */
export function buildPalette(rgba: Uint8Array): Palette {
  const counts = new Int32Array(BUCKETS);
  const sumR = new Float64Array(BUCKETS);
  const sumG = new Float64Array(BUCKETS);
  const sumB = new Float64Array(BUCKETS);
  const pixels = rgba.length >> 2;
  for (let i = 0; i < pixels; i++) {
    if (rgba[i * 4 + 3] < ALPHA_CUTOFF) continue;
    const b = bucketOf(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    counts[b]++;
    sumR[b] += rgba[i * 4];
    sumG[b] += rgba[i * 4 + 1];
    sumB[b] += rgba[i * 4 + 2];
  }
  const meanR = (k: number) => Math.round(sumR[k] / counts[k]);
  const meanG = (k: number) => Math.round(sumG[k] / counts[k]);
  const meanB = (k: number) => Math.round(sumB[k] / counts[k]);

  const keys: number[] = [];
  for (let b = 0; b < BUCKETS; b++) if (counts[b]) keys.push(b);

  const boxes: Box[] = keys.length ? [{ from: 0, to: keys.length }] : [];
  while (boxes.length < PALETTE_ENTRIES - 1) {
    let widest = -1;
    let widestSpan = 0;
    let axis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.to - box.from < 2) continue;
      for (let a = 0; a < 3; a++) {
        const lo = a === 0 ? redOf(keys[box.from]) : a === 1 ? greenOf(keys[box.from]) : blueOf(keys[box.from]);
        const hi = a === 0 ? redOf(keys[box.to - 1]) : a === 1 ? greenOf(keys[box.to - 1]) : blueOf(keys[box.to - 1]);
        if (hi - lo > widestSpan) { widestSpan = hi - lo; widest = i; axis = a; }
      }
    }
    if (widest < 0) break;
    const box = boxes[widest];
    const slice = keys.slice(box.from, box.to);
    const key = axis === 0 ? redOf : axis === 1 ? greenOf : blueOf;
    slice.sort((x, y) => key(x) - key(y) || counts[x] - counts[y]);
    let half = 0;
    for (const k of slice) half += counts[k];
    half /= 2;
    let acc = 0;
    let cut = slice.length - 1;
    for (let i = 0; i < slice.length; i++) {
      acc += counts[slice[i]];
      if (acc >= half) { cut = i + 1; break; }
    }
    if (cut < 1) cut = 1;
    if (cut >= slice.length) cut = slice.length - 1;
    const mid = box.from + cut;
    boxes.splice(widest, 1, { from: box.from, to: mid }, { from: mid, to: box.to });
  }

  const rgb = new Uint8Array(PALETTE_ENTRIES * 3);
  for (let i = 0; i < boxes.length; i++) {
    let wsum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = boxes[i].from; j < boxes[i].to; j++) {
      const k = keys[j];
      const c = counts[k];
      r += meanR(k) * c;
      g += meanG(k) * c;
      b += meanB(k) * c;
      wsum += c;
    }
    if (!wsum) continue;
    const at = (i + 1) * 3;
    rgb[at] = Math.min(255, Math.round(r / wsum));
    rgb[at + 1] = Math.min(255, Math.round(g / wsum));
    rgb[at + 2] = Math.min(255, Math.round(b / wsum));
  }

  // 每个桶预计算最近色，量化时只剩一次查表
  const bucketIndex = new Uint8Array(BUCKETS);
  for (let bkt = 0; bkt < BUCKETS; bkt++) {
    // 空桶没有真实均值，退回桶中心
    const rr = counts[bkt] ? meanR(bkt) : redOf(bkt) + HALF;
    const gg = counts[bkt] ? meanG(bkt) : greenOf(bkt) + HALF;
    const bb = counts[bkt] ? meanB(bkt) : blueOf(bkt) + HALF;
    let best = 1;
    let bestDist = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const at = (i + 1) * 3;
      const dr = rgb[at] - rr;
      const dg = rgb[at + 1] - gg;
      const db = rgb[at + 2] - bb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = i + 1; }
    }
    bucketIndex[bkt] = best;
  }
  return { rgb, bucketIndex, used: boxes.length + 1 };
}

/** 4×4 Bayer 矩阵：有序抖动的阈值 */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * RGBA → GIF 索引流。
 * alpha<128 一律走透明索引（GIF 只有 1-bit 透明）；不透明像素先做有序抖动再查最近色，
 * 这样大面积渐变不会切出硬色带。
 */
export function quantize(rgba: Uint8Array, width: number, height: number, palette: Palette): {
  indices: Uint8Array; hasTransparent: boolean;
} {
  const indices = new Uint8Array(width * height);
  // 色数很少时抖动只会引入噪声：超过 16 色才真正施加 Bayer 位移
  const spread = palette.used > 16 ? LIMITS.gifDitherSpread : 0;
  const { bucketIndex } = palette;
  let hasTransparent = false;
  let i = 0;
  for (let y = 0; y < height; y++) {
    const row = BAYER[y & 3];
    for (let x = 0; x < width; x++, i++) {
      const p = i * 4;
      if (rgba[p + 3] < ALPHA_CUTOFF) {
        indices[i] = TRANSPARENT_INDEX;
        hasTransparent = true;
        continue;
      }
      const t = ((row[x & 3] + 0.5) / 16 - 0.5) * spread;
      const b = bucketOf(clamp255(rgba[p] + t), clamp255(rgba[p + 1] + t), clamp255(rgba[p + 2] + t));
      indices[i] = bucketIndex[b];
    }
  }
  return { indices, hasTransparent };
}
