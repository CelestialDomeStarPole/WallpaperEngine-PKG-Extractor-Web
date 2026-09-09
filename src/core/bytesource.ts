import { isShortRead } from './binary';
import { LIMITS } from './limits';

/**
 * 可随机读取的字节源。core 只认这个接口，绝不接触 File / Blob / fs 之类宿主对象。
 * 所有偏移都相对本源起点，长度单位字节。
 */
export interface ByteSource {
  /** 源总长度：一切越界与格式上限校验以它为准 */
  readonly size: number;
  /** 报错文案用（文件名 / 路径 / "memory"） */
  readonly label: string;
  /** 读 [start, start+length)；length 为 0 时返回空数组 */
  read(start: number, length: number, what?: string): Promise<Uint8Array>;
  /**
   * [start, start+length) 的 Blob。
   * 能零拷贝的实现（File.slice）必须零拷贝：直通导出的条目因此一个字节都不进 JS 堆。
   */
  blob(start: number, length: number): Promise<Blob>;
  /** 子源：绝对偏移 = 本源的 start + 子源内偏移 */
  slice(start: number, length: number): ByteSource;
}

export function rangeCheck(size: number, start: number, length: number, what: string): void {
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > size) {
    throw new RangeError(`${what}：范围 [${start}, ${start + length}) 超出源长度 ${size}`);
  }
}

class MemoryByteSource implements ByteSource {
  readonly label: string;

  /** base 是整源视图；offset/size 描述本源在 base 里的位置 */
  private constructor(private readonly base: Uint8Array, readonly offset: number, readonly size: number, label: string) {
    this.label = label;
  }

  async read(start: number, length: number, what = 'read'): Promise<Uint8Array> {
    rangeCheck(this.size, start, length, `${this.label} ${what}`);
    // 返回视图：与旧的 pkg.bytes.subarray 行为一致，测试里靠这个省掉复制
    return this.base.subarray(this.offset + start, this.offset + start + length);
  }

  async blob(start: number, length: number): Promise<Blob> {
    return new Blob([await this.read(start, length, 'blob') as unknown as BlobPart], { type: 'application/octet-stream' });
  }

  slice(start: number, length: number): ByteSource {
    rangeCheck(this.size, start, length, `${this.label} slice`);
    return new MemoryByteSource(this.base, this.offset + start, length, `${this.label}@${start}`);
  }

  static of(bytes: Uint8Array, label = 'memory'): ByteSource {
    return new MemoryByteSource(bytes, 0, bytes.length, label);
  }
}

export function memorySource(bytes: Uint8Array | ArrayBuffer, label = 'memory'): ByteSource {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return MemoryByteSource.of(view, label);
}

/** 只有长度可知的假源：用来断言「解析一个超大文件究竟读没读数据」 */
export function emptySource(size: number, label = 'empty'): ByteSource {
  return {
    size,
    label,
    read: (start, length, what) => {
      rangeCheck(size, start, length, `${label} ${what ?? 'read'}`);
      return Promise.resolve(new Uint8Array(length));
    },
    blob: async (start, length) => new Blob([new Uint8Array(length)]),
    slice: (start, length) => {
      rangeCheck(size, start, length, `${label} slice`);
      return emptySource(length, `${label}@${start}`);
    },
  };
}

export interface CountedSource {
  source: ByteSource;
  reads: { start: number; length: number }[];
  /** 跨所有子源累计真实读取的字节数 */
  bytesRead(): number;
}

/** 包住任意源，记录真实发生的读取：「整包不驻内存」的断言靠它。子源共享同一份计数 */
export function countingSource(inner: ByteSource): CountedSource {
  const state = { reads: [] as { start: number; length: number }[], total: 0 };
  const wrap = (src: ByteSource): ByteSource => ({
    size: src.size,
    label: src.label,
    read(start, length, what) {
      state.reads.push({ start, length });
      state.total += length;
      return src.read(start, length, what);
    },
    blob(start, length) {
      // Blob 通道是零拷贝的，不算读进内存
      return src.blob(start, length);
    },
    slice(start, length) {
      return wrap(src.slice(start, length));
    },
  });
  return {
    source: wrap(inner),
    reads: state.reads,
    bytesRead: () => state.total,
  };
}

/**
 * 从 start 起逐级加宽探针的公共循环。
 * parse 抛 ShortReadError 表示「再多给点」；探针严格递增且被 hardMax 钳住，所以一定收敛。
 * 回调拿到的 streamEnd 是「从 start 算起源还剩多少字节」，即该段的逻辑流尾。
 */
export async function readHeader<T>(
  src: ByteSource,
  start: number,
  steps: readonly number[],
  hardMax: number,
  what: string,
  parse: (bytes: Uint8Array, streamEnd: number) => T,
): Promise<T> {
  const span = src.size - start;
  if (span < 0) throw new RangeError(`${what}：起始位置 ${start} 超出源长度 ${src.size}`);
  const cap = Math.min(hardMax, span);
  let probe = Math.min(steps[0], cap);
  for (let i = 1; ; i++) {
    const bytes = await src.read(start, probe, what);
    try {
      return parse(bytes, span);
    } catch (e) {
      if (!isShortRead(e)) throw e;
      const needed = e.pos + e.need;
      if (needed > span) {
        throw new Error(`${what}：数据被截断，偏移 ${start + needed} 超出源长度 ${src.size}`);
      }
      const grown = Math.min(cap, Math.max(needed, steps[i] ?? probe * 4));
      if (grown <= probe) {
        throw new Error(`${what}：超出探测上限 ${cap} 字节（偏移 ${start + needed} 仍缺）`);
      }
      probe = grown;
    }
  }
}

/** 分片读取：避免一次向宿主请求几百 MB */
export async function readInChunks(src: ByteSource, start: number, length: number, what = 'read'): Promise<Uint8Array> {
  rangeCheck(src.size, start, length, `${src.label} ${what}`);
  if (length <= LIMITS.maxReadPerCall) return src.read(start, length, what);
  const out = new Uint8Array(length);
  for (let p = 0; p < length; p += LIMITS.maxReadPerCall) {
    const n = Math.min(LIMITS.maxReadPerCall, length - p);
    out.set(await src.read(start + p, n, what), p);
  }
  return out;
}
