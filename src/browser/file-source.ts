import type { ByteSource } from '../core/bytesource';
import { rangeCheck } from '../core/bytesource';
import { LIMITS } from '../core/limits';

/**
 * 浏览器 File 的实现：blob() 走 File.slice，全程零拷贝——
 * 原样导出的条目因此一个字节都不会进 JS 堆，落盘由浏览器自己流式取。
 */
export class FileByteSource implements ByteSource {
  readonly label: string;

  /** File 是 Blob 的子类：传进来的 File 被 slice 成子源后就只是 Blob */
  constructor(private readonly part: Blob, label?: string) {
    this.label = label ?? (part instanceof File ? part.name : 'blob');
  }

  get size(): number {
    return this.part.size;
  }

  async read(start: number, length: number, what = 'read'): Promise<Uint8Array> {
    rangeCheck(this.size, start, length, `${this.label} ${what}`);
    if (length <= LIMITS.maxReadPerCall) {
      return new Uint8Array(await this.part.slice(start, start + length).arrayBuffer());
    }
    const out = new Uint8Array(length);
    for (let p = 0; p < length; p += LIMITS.maxReadPerCall) {
      const n = Math.min(LIMITS.maxReadPerCall, length - p);
      out.set(await this.read(start + p, n, what), p);
    }
    return out;
  }

  blob(start: number, length: number): Promise<Blob> {
    rangeCheck(this.size, start, length, `${this.label} blob`);
    return Promise.resolve(this.part.slice(start, start + length));
  }

  slice(start: number, length: number): ByteSource {
    rangeCheck(this.size, start, length, `${this.label} slice`);
    return new FileByteSource(this.part.slice(start, start + length), `${this.label}@${start}`);
  }
}
