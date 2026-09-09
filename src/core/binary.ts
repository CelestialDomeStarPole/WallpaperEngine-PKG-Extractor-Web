const utf8Decoder = new TextDecoder('utf-8');

/** 探针没覆盖到：不是错误，是「再多读点」的信号 */
export class ShortReadError extends Error {
  constructor(readonly pos: number, readonly need: number) {
    super(`探针不足：位置 ${pos} 需要 ${need} 字节`);
    this.name = 'ShortReadError';
  }
}

export function isShortRead(e: unknown): e is ShortReadError {
  return e instanceof ShortReadError;
}

export class BinReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;
  /** 已物理读到的位置；越过它要加宽探针重读 */
  private readonly probeEnd: number;
  /** 逻辑流总长（数据源可以比探针大）；越过它是真截断 */
  private readonly streamEnd: number;

  constructor(bytes: Uint8Array, start = 0, probeEnd = bytes.length, streamEnd = probeEnd) {
    if (start < 0 || probeEnd > bytes.length || start > probeEnd || streamEnd < probeEnd) {
      throw new Error(`读取范围非法：[${start}, ${probeEnd}) / ${bytes.length}，流尾 ${streamEnd}`);
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.probeEnd = probeEnd;
    this.streamEnd = streamEnd;
  }

  get offset(): number {
    return this.pos;
  }

  remaining(): number {
    return this.probeEnd - this.pos;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.streamEnd) {
      throw new Error(`数据不完整：位置 ${this.pos} 需要 ${n} 字节（${what}），流尾 ${this.streamEnd}`);
    }
    if (this.pos + n > this.probeEnd) {
      throw new ShortReadError(this.pos, n);
    }
  }

  /** 只确认这段在流内并推进游标，不索取数据；返回这段的起点。数据可以在探针之外 */
  record(n: number, what = 'bytes'): number {
    if (n < 0 || this.pos + n > this.streamEnd) {
      throw new Error(`数据不完整：位置 ${this.pos} 需要 ${n} 字节（${what}），流尾 ${this.streamEnd}`);
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  i32(what = 'int32'): number {
    this.need(4, what);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(what = 'float'): number {
    this.need(4, what);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  byte(what = 'byte'): number {
    this.need(1, what);
    return this.bytes[this.pos++];
  }

  take(n: number, what = 'bytes'): Uint8Array {
    this.need(n, what);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  skip(n: number): void {
    this.need(n, 'skip');
    this.pos += n;
  }

  /** i32 长度前缀 UTF-8 串（无 NUL），带最大长度防御 */
  lengthString(maxLen: number, what = 'string'): string {
    const len = this.i32(`${what}.len`);
    if (len < 0 || len > maxLen) {
      throw new Error(`${what} 长度 ${len} 超出上限 ${maxLen}（位置 ${this.pos}）`);
    }
    return utf8Decoder.decode(this.take(len, `${what}.data`));
  }

  /** NUL 结尾定长区串，最多窥 maxLen 字节 */
  nullString(maxLen: number, what = 'nstring'): string {
    let s = '';
    for (let i = 0; i < maxLen; i++) {
      const c = this.byte(`${what}.data`);
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    throw new Error(`${what} 在 ${maxLen} 字节内未找到终止符（位置 ${this.pos - s.length}）`);
  }
}
