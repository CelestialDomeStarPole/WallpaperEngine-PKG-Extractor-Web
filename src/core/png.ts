import { PNG_SIGNATURE, concat, ihdrData, pngChunk, zlibFrame } from './pngio';

/** RGBA(直通、无预乘) → PNG 字节。纯 TS，不依赖 canvas，worker/node 通用 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height)),
    pngChunk('IDAT', zlibFrame(rgba, width, height)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
