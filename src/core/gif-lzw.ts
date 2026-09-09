/** GIF 的 LZW 压缩：码表 12 bit 上限，LSB 先出，输出按 ≤255 字节的子块回调 */

const HASH_SIZE = 8192;
const HASH_MASK = HASH_SIZE - 1;
const MAX_CODE = 4096;
/**
 * 码宽加宽的时机。实测（ffmpeg 与 Chrome 双重确认）：真实解码端在它的
 * nextCode == 1<<size 时加宽，而解码端建表比编码端慢一个条目，
 * 所以编码端必须推迟一格。早一格或晚一格都会让位宽错位——
 * 表现为图像开头几百像素正常、其后整片花屏。
 */
const CODE_WIDTH_LAG = 1;

/**
 * @param indices 索引流（每项 < 2^minCodeSize 之外的调色板项也允许，minCodeSize 由调色板位数决定）
 * @param minCodeSize 通常是 8
 * @param emit 每次给一段子块数据；final=true 表示这是该帧最后一段（调用方负责写块尾 0x00）
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number, emit: (chunk: Uint8Array, final: boolean) => void): void {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const tableKey = new Int32Array(HASH_SIZE);
  const tableCode = new Int32Array(HASH_SIZE);
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  const resetDict = () => {
    tableKey.fill(0);
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  let bits = 0;
  let bitCount = 0;
  const block = new Uint8Array(255);
  let blockLen = 0;

  const pushByte = (b: number) => {
    block[blockLen++] = b;
    if (blockLen === block.length) {
      emit(block.slice(0, blockLen), false);
      blockLen = 0;
    }
  };
  const putBits = (code: number, size: number) => {
    bits |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      pushByte(bits & 0xff);
      bits >>= 8;
      bitCount -= 8;
    }
  };

  /** 找到 scan 对应的码，或（insert=true 时）登记一个新码；返回 -1 表示没有 */
  const probe = (scan: number, insert: boolean): number => {
    let h = ((scan >>> 4) ^ scan) & HASH_MASK;
    for (;;) {
      const k = tableKey[h];
      if (k === 0) {
        if (!insert) return -1;
        tableKey[h] = scan + 1;
        tableCode[h] = nextCode;
        return nextCode;
      }
      if (k === scan + 1) return tableCode[h];
      h = (h + 1) & HASH_MASK;
    }
  };

  if (!indices.length) {
    putBits(clearCode, codeSize);
    putBits(eoiCode, codeSize);
    if (bitCount > 0) pushByte(bits & 0xff);
    if (blockLen) emit(block.slice(0, blockLen), true);
    else emit(new Uint8Array(0), true);
    return;
  }

  resetDict();
  putBits(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const scan = ((prefix << 8) | k) >>> 0;
    const found = probe(scan, false);
    if (found >= 0) {
      prefix = found;
      continue;
    }
    putBits(prefix, codeSize);
    if (nextCode < MAX_CODE) {
      probe(scan, true);
      nextCode += 1;
      if (nextCode - CODE_WIDTH_LAG === (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      putBits(clearCode, codeSize);
      resetDict();
    }
    prefix = k;
  }
  putBits(prefix, codeSize);
  putBits(eoiCode, codeSize);
  if (bitCount > 0) pushByte(bits & 0xff);
  bits = 0;
  bitCount = 0;
  if (blockLen) emit(block.slice(0, blockLen), true);
  else emit(new Uint8Array(0), true);
}
