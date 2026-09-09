import { ByteGauge, type FrameMeta, type FrameSink } from './framesink';
import { LIMITS } from './limits';
import { PNG_SIGNATURE, compressRows, concat, ihdrData, pngChunk } from './pngio';

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

/**
 * APNG：IHDR + acTL + 每帧 (fcTL + IDAT|fdAT) + IEND。
 *
 * 编号规则：第一个 fcTL 的 sequence 为 0，默认图像（第 0 帧）的数据在 IDAT 里、不参与编号；
 * 之后每帧的 fdAT 比自己的 fcTL 大 1，下一帧的 fcTL 再大 1。搞错的话浏览器只显示第 0 帧且不报错。
 * 每帧的压缩结果先缓存成一片再整体写出，保证一帧只有一个 fdAT、一个序号。
 */
export class ApngWriter implements FrameSink {
  readonly label = 'APNG';
  private readonly parts: Uint8Array[] = [];
  private readonly gauge: ByteGauge;
  private seq = 0;
  private framesWritten = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly frameCount: number,
    cap: number = LIMITS.maxAnimationBytes,
  ) {
    if (frameCount <= 0) throw new Error('APNG 至少要一帧');
    this.gauge = new ByteGauge(cap, 'APNG');
    this.emit(PNG_SIGNATURE);
    this.emit(pngChunk('IHDR', ihdrData(width, height)));
    const actl = new Uint8Array(8);
    const dv = new DataView(actl.buffer);
    dv.setUint32(0, frameCount);
    dv.setUint32(4, 0); // num_plays = 0 → 无限循环
    this.emit(pngChunk('acTL', actl));
  }

  get bytes(): number {
    return this.gauge.bytes;
  }

  private emit(chunk: Uint8Array) {
    this.gauge.add(chunk);
    this.parts.push(chunk);
  }

  addFrame(px: Uint8Array, meta: FrameMeta): void {
    if (this.framesWritten >= this.frameCount) throw new Error('APNG：帧数超出声明值');
    const fctl = new Uint8Array(26);
    const dv = new DataView(fctl.buffer);
    dv.setUint32(0, this.seq);
    dv.setUint32(4, this.width);
    dv.setUint32(8, this.height);
    dv.setUint32(12, 0); // x_off：始终输出整张画布
    dv.setUint32(16, 0); // y_off
    dv.setUint16(20, meta.delayNum);
    dv.setUint16(22, meta.delayDen);
    fctl[24] = 0; // dispose_op = NONE
    fctl[25] = 0; // blend_op = SOURCE（整帧覆盖，无需混合）
    this.emit(pngChunk('fcTL', fctl));
    this.seq += 1;

    const body: Uint8Array[] = [];
    compressRows(px, this.width, this.height, 6, (c) => body.push(c));
    if (this.framesWritten === 0) {
      this.emit(pngChunk('IDAT', concat(body)));
    } else {
      this.emit(pngChunk('fdAT', concat([u32(this.seq), ...body])));
      this.seq += 1;
    }
    this.framesWritten += 1;
  }

  async finish(): Promise<Blob> {
    if (this.framesWritten !== this.frameCount) {
      throw new Error(`APNG 帧数不符：写入 ${this.framesWritten}，声明 ${this.frameCount}`);
    }
    this.emit(pngChunk('IEND', new Uint8Array(0)));
    const blob = new Blob(this.parts as unknown as BlobPart[], { type: 'image/apng' });
    this.parts.length = 0;
    return blob;
  }
}
