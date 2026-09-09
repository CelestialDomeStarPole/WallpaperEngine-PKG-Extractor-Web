import { Zlib } from 'fflate';

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个完整 PNG 块：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据） */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function ihdrData(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return ihdr;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * RGBA（直通、无预乘）逐行前置 filter 0 喂给 zlib 流。
 * 按行推送而不是先拷出整帧，是为了让峰值内存停在「一帧」而不是「两帧 + 压缩结果」。
 */
export function compressRows(
  rgba: Uint8Array,
  width: number,
  height: number,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
  onChunk: (chunk: Uint8Array, final: boolean) => void,
): void {
  if (rgba.length < width * height * 4) throw new Error('PNG 编码：像素数据不足');
  const z = new Zlib({ level }, (data, final) => onChunk(data, final));
  const stride = width * 4;
  const row = new Uint8Array(1 + stride);
  for (let y = 0; y < height; y++) {
    row[0] = 0;
    row.set(rgba.subarray(y * stride, (y + 1) * stride), 1);
    z.push(row, y === height - 1);
  }
}

/** 整帧一次性压缩（静态单图用） */
export function zlibFrame(rgba: Uint8Array, width: number, height: number, level: 6 | 9 = 6): Uint8Array {
  const parts: Uint8Array[] = [];
  compressRows(rgba, width, height, level, (c) => parts.push(c));
  return concat(parts);
}
