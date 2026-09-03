const utf8Decoder = new TextDecoder('utf-8');

export class BinReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    if (start < 0 || end > bytes.length || start > end) {
      throw new Error(`读取范围越界 [${start}, ${end}) / ${bytes.length}`);
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    Object.defineProperty(this, '_end', { value: end, writable: true });
  }

  private get end(): number {
    return (this as any)._end as number;
  }

  get offset(): number {
    return this.pos;
  }

  remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new Error(`数据不完整：位置 ${this.pos} 需要 ${n} 字节（${what}），剩余 ${this.remaining()}`);
    }
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
