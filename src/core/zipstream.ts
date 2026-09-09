import { Zip, ZipPassThrough } from 'fflate';
import { LIMITS } from './limits';

export function entryName(name: string, keepPath: boolean): string {
  return keepPath ? name : name.split('/').pop() || 'download';
}

/** 关闭「保留目录结构」后不同目录的同名条目会撞成同一个 key，撞了就加序号，别静默覆盖 */
export function uniqueKey(want: string, used: Set<string>): string {
  if (!used.has(want)) { used.add(want); return want; }
  const dot = want.lastIndexOf('.');
  let n = 2;
  let key = '';
  do {
    key = dot > 0 ? `${want.slice(0, dot)}-${n}${want.slice(dot)}` : `${want}-${n}`;
    n += 1;
  } while (used.has(key));
  used.add(key);
  return key;
}

/**
 * 流式 ZIP：产出的分片直接收进数组，最后 new Blob(chunks) —— Blob 不复制分片内容。
 * 相比「所有条目读成 Uint8Array 再 zipSync」，峰值从约 3 倍降到 1 倍。
 *
 * fflate 的 Zip 会把尚未 final 的文件分片缓存下来，所以必须一个文件推完再 add 下一个；
 * addFile 是 async 且内部串行 push，调用方按顺序 await 即可。
 */
export class ZipWriter {
  private readonly chunks: Uint8Array[] = [];
  private readonly zip: Zip;
  private failure: Error | undefined;
  /** ZIP 内文件字节合计（不含头与目录） */
  private fileBytes = 0;

  constructor() {
    this.zip = new Zip((err, data) => {
      if (err) { this.failure = err; return; }
      this.chunks.push(data);
    });
  }

  get bytes(): number {
    return this.chunks.reduce((a, c) => a + c.length, 0);
  }

  async addFile(name: string, blob: Blob): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.fileBytes + blob.size > LIMITS.zipTotalCeiling) {
      throw new Error(`ZIP 内容 ${(this.fileBytes + blob.size) / 1024 / 1024 | 0} MB 超过 ${LIMITS.zipTotalCeiling / 1024 / 1024 / 1024} GB 上限：fflate 不写 ZIP64`);
    }
    const file = new ZipPassThrough(name);
    this.zip.add(file);
    this.fileBytes += blob.size;
    if (!blob.size) {
      file.push(new Uint8Array(0), true);
    } else {
      for (let p = 0; p < blob.size; p += LIMITS.zipChunk) {
        const end = Math.min(p + LIMITS.zipChunk, blob.size);
        const chunk = new Uint8Array(await blob.slice(p, end).arrayBuffer());
        file.push(chunk, end === blob.size);
      }
    }
    if (this.failure) throw this.failure;
  }

  /** 写中央目录并交出结果 */
  finish(): Blob {
    if (this.failure) throw this.failure;
    this.zip.end();
    if (this.failure) throw this.failure;
    const blob = new Blob(this.chunks as unknown as BlobPart[], { type: 'application/zip' });
    this.chunks.length = 0;
    return blob;
  }
}
