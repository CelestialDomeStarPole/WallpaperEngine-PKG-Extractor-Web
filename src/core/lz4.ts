/** raw LZ4 block 解码（无帧头），对应 K4os/lz4.block 的产物 */
export function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  if (decompressedSize < 0) throw new Error('LZ4 目标长度非法');
  const dst = new Uint8Array(decompressedSize);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let literal = token >> 4;
    if (literal === 15) {
      let b: number;
      do {
        if (s >= src.length) throw new Error('LZ4 流截断（literal 长度）');
        b = src[s++];
        literal += b;
      } while (b === 255);
    }
    if (d + literal > decompressedSize || s + literal > src.length) {
      throw new Error('LZ4 数据损坏：literal 越界');
    }
    dst.set(src.subarray(s, s + literal), d);
    s += literal;
    d += literal;
    if (s === src.length) break; // 最后一段只有 literal
    if (s + 2 > src.length) throw new Error('LZ4 流截断（offset）');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error(`LZ4 offset 非法: ${offset}`);
    let match = token & 15;
    if (match === 15) {
      let b: number;
      do {
        if (s >= src.length) throw new Error('LZ4 流截断（match 长度）');
        b = src[s++];
        match += b;
      } while (b === 255);
    }
    match += 4;
    if (d + match > decompressedSize) throw new Error('LZ4 数据损坏：match 越界');
    // 允许重叠拷贝 → copyWithin
    for (let i = 0; i < match; i++) dst[d + i] = dst[d + i - offset];
    d += match;
  }
  if (d !== decompressedSize) {
    // 部分实现写入不足目标长度时补零前先报错，避免静默产出坏图
    throw new Error(`LZ4 解压长度不符: 得到 ${d}, 期望 ${decompressedSize}`);
  }
  return dst;
}
