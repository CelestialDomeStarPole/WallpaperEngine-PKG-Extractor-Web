import { LIMITS } from './limits';

/** 一帧的延时元数据：APNG 用 num/den（秒），GIF 用 1/100 秒 */
export interface FrameMeta {
  delayNum: number;
  delayDen: number;
  /** GIF 的 1/100 秒单位 */
  delayCs: number;
}

/**
 * 逐帧写入的输出端。
 * addFrame 抛错会被动画循环记到 failed 上，其它 sink 继续，从而实现「按格式局部降级」。
 */
export interface FrameSink {
  readonly label: string;
  addFrame(px: Uint8Array, meta: FrameMeta): Promise<void> | void;
  finish(): Promise<Blob>;
  /** 已写入字节，供进度与上限判断 */
  readonly bytes: number;
  failed?: Error;
}

export class OutputTooLargeError extends Error {
  constructor(readonly limit: number, readonly wrote: number, readonly what: string) {
    super(`${what}编码到 ${Math.round(wrote / 1024 / 1024)} MB 超过上限 ${Math.round(limit / 1024 / 1024)} MB`);
    this.name = 'OutputTooLargeError';
  }
}

export function isTooLarge(e: unknown): e is OutputTooLargeError {
  return e instanceof OutputTooLargeError;
}

/** 累计输出字节并守住上限：所有 sink 共用 */
export class ByteGauge {
  private total = 0;
  constructor(private readonly cap: number, private readonly label: string) {}
  get bytes(): number {
    return this.total;
  }
  add(chunk: Uint8Array) {
    this.total += chunk.length;
    if (this.total > this.cap) {
      throw new OutputTooLargeError(this.cap, this.total, this.label);
    }
  }
}
