/** BC1/BC2/BC3 (DXT1/DXT3/DXT5) → RGBA8888，逐行翻写自 repkg Texture/Helpers/DXT.cs (MIT) */

function readU16LE(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}

function unpack565(v: number): [number, number, number] {
  let r = (v >> 11) & 0x1f;
  let g = (v >> 5) & 0x3f;
  let bl = v & 0x1f;
  // 位扩展回 8bit：v * 0x10802 >> 16 等效的高位复制
  r = (r << 3) | (r >> 2);
  g = (g << 2) | (g >> 4);
  bl = (bl << 3) | (bl >> 2);
  return [r, g, bl];
}

/** 写一个 4x4 块的 RGB 分量；alpha 由调用方预设，DXT1 透明分支单独处理 */
function decodeColorBlock(b: Uint8Array, bp: number, dst: Uint8Array, dp: number, stride: number, hasAlpha0Mode: boolean): void {
  const c0 = readU16LE(b, bp);
  const c1 = readU16LE(b, bp + 2);
  const idx = bp + 4;
  const [r0, g0, b0] = unpack565(c0);
  const [r1, g1, b1] = unpack565(c1);
  const pal: number[][] = [[r0, g0, b0], [r1, g1, b1]];
  if (hasAlpha0Mode && c0 <= c1) {
    pal.push([(2 * r1 + r0) / 3 | 0, (2 * g1 + g0) / 3 | 0, (2 * b1 + b0) / 3 | 0]);
    pal.push([0, 0, 0]);
  } else {
    pal.push([(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0]);
    pal.push([(2 * r1 + r0) / 3 | 0, (2 * g1 + g0) / 3 | 0, (2 * b1 + b0) / 3 | 0]);
  }
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const bitPos = row * 8 + col * 2;
      const sel = (b[idx + (bitPos >> 3)] >> (bitPos & 7)) & 3;
      const [r, g, bb] = pal[sel];
      const o = dp + row * stride + col * 4;
      dst[o] = r;
      dst[o + 1] = g;
      dst[o + 2] = bb;
    }
  }
}

function decodeAlphaBlockAlpha4(b: Uint8Array, bp: number, dst: Uint8Array, dp: number, stride: number): void {
  // DXT3: 16 个 4bit alpha
  for (let row = 0; row < 4; row++) {
    const bits = b[bp + row * 2] | (b[bp + row * 2 + 1] << 8);
    for (let col = 0; col < 4; col++) {
      const nib = (bits >> (col * 4)) & 0xf;
      dst[dp + row * stride + col * 4 + 3] = (nib << 4) | nib;
    }
  }
}

function decodeAlphaBlockAlpha8(b: Uint8Array, bp: number, dst: Uint8Array, dp: number, stride: number): void {
  // DXT5: alpha0/alpha1 + 3bit 索引
  const a0 = b[bp];
  const a1 = b[bp + 1];
  const table = new Array<number>(8);
  table[0] = a0;
  table[1] = a1;
  if (a0 > a1) {
    table[2] = (6 * a0 + a1) / 7 | 0;
    table[3] = (5 * a0 + 2 * a1) / 7 | 0;
    table[4] = (4 * a0 + 3 * a1) / 7 | 0;
    table[5] = (3 * a0 + 4 * a1) / 7 | 0;
    table[6] = (2 * a0 + 5 * a1) / 7 | 0;
    table[7] = (a0 + 6 * a1) / 7 | 0;
  } else {
    table[2] = (4 * a0 + a1) / 5 | 0;
    table[3] = (3 * a0 + 2 * a1) / 5 | 0;
    table[4] = (2 * a0 + 3 * a1) / 5 | 0;
    table[5] = (a0 + 4 * a1) / 5 | 0;
    table[6] = 0;
    table[7] = 255;
  }
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const bitPos = 16 + row * 8 + col * 3;
      const byteI = bp + (bitPos >> 3);
      const shift = bitPos & 7;
      let sel: number;
      if (shift <= 5) {
        sel = (b[byteI] >> shift) & 7;
      } else {
        sel = ((b[byteI] >> shift) | (b[byteI + 1] << (8 - shift))) & 7;
      }
      dst[dp + row * stride + col * 4 + 3] = table[sel];
    }
  }
}

/**
 * 解压 DXT 家族。kind: 1 = DXT1(BC1), 2 = DXT3(BC2), 5 = DXT5(BC3)
 * 返回 RGBA 字节（stride = width*4）。宽高按 4 对齐向上取整的块数处理。
 */
export function decompressDxt(width: number, height: number, src: Uint8Array, kind: 1 | 2 | 5): Uint8Array {
  const stride = width * 4;
  const dst = new Uint8Array(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const blockBytes = kind === 1 ? 8 : 16;
  const needed = blocksX * blocksY * blockBytes;
  if (src.length < needed) throw new Error(`DXT 数据不足: 需要 ${needed}, 只有 ${src.length}`);
  let sp = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const dp = by * 4 * stride + bx * 4 * 4;
      // 先全部初始化为不透明（DXT1 透明分支会再覆盖）
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          dst[dp + row * stride + col * 4 + 3] = 255;
        }
      }
      if (kind === 1) {
        decodeColorBlock(src, sp, dst, dp, stride, true);
      } else if (kind === 2) {
        decodeAlphaBlockAlpha4(src, sp, dst, dp, stride);
        decodeColorBlock(src, sp + 8, dst, dp, stride, false);
      } else {
        decodeAlphaBlockAlpha8(src, sp, dst, dp, stride);
        decodeColorBlock(src, sp + 8, dst, dp, stride, false);
      }
      if (kind === 1) {
        // DXT1 的 c0<=c1 模式：索引 3 = 全透明，索引 2 = 1/2 混合，已在 hasAlpha0Mode 分支处理颜色，alpha 需补
        const c0 = readU16LE(src, sp);
        const c1 = readU16LE(src, sp + 2);
        if (c0 <= c1) {
          for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
              const bitPos = row * 8 + col * 2;
              const sel = (src[sp + 4 + (bitPos >> 3)] >> (bitPos & 7)) & 3;
              if (sel === 3) {
                dst[dp + row * stride + col * 4 + 3] = 0;
                dst[dp + row * stride + col * 4] = 0;
                dst[dp + row * stride + col * 4 + 1] = 0;
                dst[dp + row * stride + col * 4 + 2] = 0;
              }
            }
          }
        }
      }
      sp += blockBytes;
    }
  }
  return dst;
}

/** RG88：u16 LE，G→RGB 三通道、R→alpha（repkg Helpers/RG88.cs 语义） */
export function rg88ToRgba(src: Uint8Array, width: number, height: number): Uint8Array {
  const dst = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = src[i * 2];
    const g = src[i * 2 + 1];
    dst[i * 4] = g;
    dst[i * 4 + 1] = g;
    dst[i * 4 + 2] = g;
    dst[i * 4 + 3] = r;
  }
  return dst;
}

/** R8 灰度 → RGBA */
export function r8ToRgba(src: Uint8Array, width: number, height: number): Uint8Array {
  const dst = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = src[i];
    dst[i * 4] = v;
    dst[i * 4 + 1] = v;
    dst[i * 4 + 2] = v;
    dst[i * 4 + 3] = 255;
  }
  return dst;
}

/** RGBA8888 直通（WE 该格式的 mipmap 字节序实测为 R,G,B,A，与 DXT 解码输出一致） */
export function rgba8888ToRgba(src: Uint8Array, width: number, height: number): Uint8Array {
  const need = width * height * 4;
  if (src.length < need) throw new Error(`RGBA8888 数据不足: 需要 ${need}, 只有 ${src.length}`);
  return src.subarray(0, need);
}
