import { ByteGauge, type FrameMeta, type FrameSink } from './framesink';
import { buildPalette, quantize, TRANSPARENT_INDEX } from './gif-pal';
import { lzwEncode } from './gif-lzw';
import { LIMITS } from './limits';

const MIN_CODE_SIZE = 8;
/** 256 项局部调色板 → 尺寸字段 7（2^(7+1) 项） */
const PALETTE_BITS_FIELD = 7;
/** 每帧都是完整画布，故帧间必须清屏，否则上一帧会从透明空洞里透出来 */
const DISPOSAL_RESTORE_BACKGROUND = 2;

function u16(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
}

function head(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * 动画 GIF：GIF89a + LSD（无全局表）+ NETSCAPE 循环扩展 + 每帧 (GCE + IMD + 局部调色板 + LZW)。
 * 每帧一张局部调色板，所以帧与帧之间的配色互不牵连；代价是 +768 字节/帧。
 */
export class GifWriter implements FrameSink {
  readonly label = 'GIF';
  private readonly parts: Uint8Array[] = [];
  private readonly gauge: ByteGauge;
  private framesWritten = 0;
  private closed = false;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly frameCount: number,
    cap: number = LIMITS.maxAnimationBytes,
  ) {
    if (frameCount <= 0) throw new Error('GIF 至少要一帧');
    if (width * height > 0x7fff * 0x7fff) throw new Error(`GIF 尺寸过大: ${width}x${height}`);
    this.gauge = new ByteGauge(cap, 'GIF');
    this.emit(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])); // GIF89a
    this.emit(u16(width));
    this.emit(u16(height));
    this.emit(head(0x70, 0, 0)); // 无 GCT + 色深 8bit + 背景 0 + 无宽高比
    this.emit(head(0x21, 0xff, 0x0b));
    this.emit(new TextEncoder().encode('NETSCAPE2.0'));
    this.emit(head(0x03, 0x01));
    this.emit(u16(0)); // 循环次数 0 = 无限
    this.emit(head(0x00));
  }

  get bytes(): number {
    return this.gauge.bytes;
  }

  private emit(chunk: Uint8Array) {
    this.gauge.add(chunk);
    this.parts.push(chunk);
  }

  addFrame(px: Uint8Array, meta: FrameMeta): void {
    if (this.closed) throw new Error('GIF 已收尾');
    if (this.framesWritten >= this.frameCount) throw new Error('GIF：帧数超出声明值');
    const palette = buildPalette(px);
    const { indices, hasTransparent } = quantize(px, this.width, this.height, palette);

    const packed = (DISPOSAL_RESTORE_BACKGROUND << 2) | (hasTransparent ? 1 : 0);
    this.emit(head(0x21, 0xf9, 0x04, packed));
    this.emit(u16(meta.delayCs));
    this.emit(head(hasTransparent ? TRANSPARENT_INDEX : 0, 0x00));

    this.emit(head(0x2c));
    this.emit(u16(0));
    this.emit(u16(0));
    this.emit(u16(this.width));
    this.emit(u16(this.height));
    this.emit(head(0x80 | PALETTE_BITS_FIELD)); // 有局部调色板
    this.emit(palette.rgb);

    this.emit(head(MIN_CODE_SIZE));
    lzwEncode(indices, MIN_CODE_SIZE, (chunk, final) => {
      // 零长度分片不能写成 [0x00]：那本身就是数据结束标志，会多出一个终止符
      if (chunk.length) {
        this.emit(head(chunk.length));
        this.emit(chunk);
      }
      if (final) this.emit(head(0x00));
    });
    this.framesWritten += 1;
  }

  async finish(): Promise<Blob> {
    if (this.framesWritten !== this.frameCount) {
      throw new Error(`GIF 帧数不符：写入 ${this.framesWritten}，声明 ${this.frameCount}`);
    }
    this.closed = true;
    this.emit(head(0x3b));
    const blob = new Blob(this.parts as unknown as BlobPart[], { type: 'image/gif' });
    this.parts.length = 0;
    return blob;
  }
}
