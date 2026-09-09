import { ApngWriter } from './apng';
import type { FrameMeta, FrameSink } from './framesink';
import { GifWriter } from './gif';
import { LIMITS } from './limits';
import { rasterOfImage } from './raster';
import type { AnimatedFormat, DecodePorts, Raster, TexFile, TexFrame } from './types';

export interface Surface {
  w: number;
  h: number;
}

export interface DestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 帧矩形用的是像素还是归一化 UV：整表判一次，别逐帧猜 */
export type RectMode = 'pixel' | 'uv';

export function frameRectMode(frames: TexFrame[], surface: Surface): RectMode {
  let max = 0;
  for (const f of frames) max = Math.max(max, Math.abs(f.x), Math.abs(f.y), Math.abs(f.width), Math.abs(f.height));
  // 归一化 UV 不会明显超过 1；像素坐标只要出现 >1 的值就说明是像素
  return max <= 1.5 && (surface.w > 2 || surface.h > 2) ? 'uv' : 'pixel';
}

/**
 * 帧矩形 = image（通常是雪碧图）里的源格子，不是画布上的目标位置。
 * 实测 WE 动画贴图：1 张 1680x960 的图 + 28 个 [0,0,240,240]/[240,0,240,240]/… 的格子。
 */
export function deriveSourceRect(f: TexFrame, image: Surface, mode: RectMode): DestRect {
  const kx = mode === 'uv' ? image.w : 1;
  const ky = mode === 'uv' ? image.h : 1;
  const x = Math.round(f.x * kx);
  const y = Math.round(f.y * ky);
  const w = Math.round(f.width * kx);
  const h = Math.round(f.height * ky);
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const cx = Math.max(0, Math.min(x, image.w));
  const cy = Math.max(0, Math.min(y, image.h));
  return { x: cx, y: cy, w: Math.min(w, image.w - cx), h: Math.min(h, image.h - cy) };
}

/** 整格拷贝：雪碧图里切出一帧，尺寸刚好等于画布时不需要任何缩放 */
export function copySubRect(src: Uint8Array, srcW: number, rect: DestRect): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h * 4);
  const stride = rect.w * 4;
  for (let y = 0; y < rect.h; y++) {
    const from = ((rect.y + y) * srcW + rect.x) * 4;
    out.set(src.subarray(from, from + stride), y * stride);
  }
  return out;
}

/** 动画画布尺寸优先级：TEXS0003 声明值 → imageWidth/Height → textureWidth/Height */
export function animationSurface(tex: TexFile): Surface {
  const candidates: (Surface | null)[] = [
    tex.gifWidth > 0 && tex.gifHeight > 0 ? { w: tex.gifWidth, h: tex.gifHeight } : null,
    tex.imageWidth > 0 && tex.imageHeight > 0 ? { w: tex.imageWidth, h: tex.imageHeight } : null,
    tex.textureWidth > 0 && tex.textureHeight > 0 ? { w: tex.textureWidth, h: tex.textureHeight } : null,
  ];
  const s = candidates.find((c) => !!c && c.w * c.h * 4 <= LIMITS.maxSurfaceBytes);
  if (!s) {
    throw new Error(`动画画布尺寸异常或超过 ${Math.round(LIMITS.maxSurfaceBytes / 1024 / 1024)} MB 上限`);
  }
  return s;
}

/** frametime → 两种容器各自能表达的延时 */
export function frameDelay(seconds: number): FrameMeta {
  const sec = Number.isFinite(seconds) && seconds >= LIMITS.minFrameSeconds ? seconds : LIMITS.defaultFrameSeconds;
  return {
    delayNum: Math.max(1, Math.min(65535, Math.round(sec * LIMITS.apngDelayDen))),
    delayDen: LIMITS.apngDelayDen,
    delayCs: Math.max(LIMITS.gifMinCs, Math.min(65535, Math.round(sec * 100))),
  };
}

/**
 * 最近邻取样 + source-over 合成：把 src 的 srcRect 画进 dst 的 dstRect。
 * 帧格子与画布尺寸不匹配时（少见）就会走这条缩放路径。
 */
export function blitRgba(
  dst: Uint8Array, dstW: number,
  src: Uint8Array, srcW: number,
  srcRect: DestRect, dstRect: DestRect,
): void {
  if (srcRect.w <= 0 || srcRect.h <= 0 || dstRect.w <= 0 || dstRect.h <= 0) return;
  for (let j = 0; j < dstRect.h; j++) {
    const dy = dstRect.y + j;
    const sy = srcRect.y + Math.min(srcRect.h - 1, Math.floor(((j + 0.5) * srcRect.h) / dstRect.h));
    for (let i = 0; i < dstRect.w; i++) {
      const dx = dstRect.x + i;
      if (dx >= dstW) break;
      const sx = srcRect.x + Math.min(srcRect.w - 1, Math.floor(((i + 0.5) * srcRect.w) / dstRect.w));
      const s = (sy * srcW + sx) * 4;
      const a = src[s + 3];
      const d = (dy * dstW + dx) * 4;
      if (a === 255) {
        dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255;
      } else if (a !== 0) {
        const da = dst[d + 3];
        const out = a + ((da * (255 - a)) >> 8);
        for (let c = 0; c < 3; c++) {
          dst[d + c] = Math.round((src[s + c] * a + (dst[d + c] * da * (255 - a)) / 255) / out);
        }
        dst[d + 3] = out;
      }
    }
  }
}

/**
 * 逐帧取画布大小的像素。
 * 只缓存最近解码的那张 image：雪碧图（所有帧共用一张）会命中，省掉 28 次 LZ4 解压；
 * 逐帧各一张图的布局则永远不会同时驻留多张。
 */
export class FrameSource {
  private cached: { index: number; raster: Raster } | null = null;
  private readonly canvas: Uint8Array;
  private readonly mode: RectMode;

  constructor(
    private readonly tex: TexFile,
    readonly surface: Surface,
    private readonly ports: DecodePorts,
    frames: TexFrame[],
  ) {
    this.canvas = new Uint8Array(surface.w * surface.h * 4);
    this.mode = frameRectMode(frames, surface);
  }

  /** 解码次数：用来验证雪碧图只解压一次 */
  decoded = 0;

  private async image(index: number): Promise<Raster> {
    if (!this.cached || this.cached.index !== index) {
      this.cached = { index, raster: await rasterOfImage(this.tex, index, this.ports) };
      this.decoded += 1;
    }
    return this.cached.raster;
  }

  /** 返回画布大小的 RGBA。可能复用内部缓冲，调用方必须当场消费掉 */
  async framePixels(f: TexFrame): Promise<Uint8Array> {
    const img = await this.image(f.imageId);
    const cell = deriveSourceRect(f, { w: img.width, h: img.height }, this.mode);
    if (cell.w === this.surface.w && cell.h === this.surface.h) {
      // 只有一整张图恰好等于画布时才能免拷贝；雪碧图的第 0 格仍要按行切
      if (cell.x === 0 && cell.y === 0 && img.width === this.surface.w && img.height === this.surface.h) {
        return img.rgba;
      }
      return copySubRect(img.rgba, img.width, cell);
    }
    this.canvas.fill(0);
    if (cell.w > 0 && cell.h > 0) {
      blitRgba(this.canvas, this.surface.w, img.rgba, img.width, cell, {
        x: 0, y: 0, w: this.surface.w, h: this.surface.h,
      });
    }
    return this.canvas;
  }
}

/**
 * 跑一遍帧循环，同时喂给多个 sink（「两者都出」时只解码一次）。
 * 单个 sink 抛错只作废它自己，其它格式照样产出。
 */
export async function encodeAnimation(
  frames: TexFrame[],
  source: FrameSource,
  sinks: FrameSink[],
  onFrame?: (done: number, total: number) => void,
): Promise<void> {
  let written = 0;
  for (let i = 0; i < frames.length; i++) {
    const live = sinks.filter((s) => !s.failed);
    if (!live.length) return;
    try {
      const px = await source.framePixels(frames[i]);
      const meta = frameDelay(frames[i].frametime);
      for (const s of live) {
        try {
          await s.addFrame(px, meta);
        } catch (e) {
          s.failed = e as Error;
        }
      }
      written += 1;
    } catch {
      // 单帧解码失败跳过：坏一帧不该毁掉整个动画
    }
    onFrame?.(i + 1, frames.length);
  }
  if (!written) throw new Error('动画所有帧都解码失败');
}

/**
 * 编码前唯一的线索是头信息，所以只能估算；真实值在编完后回填。
 * 代理量 = 这些帧实际用到的源字节总量（按 imageId 去重，雪碧图只算一次），全部来自帧表。
 * 系数取自真实样本：327KB 的 LZ4 雪碧图 → APNG 195KB / GIF 167KB。
 */
export function estimateAnimationBytes(tex: TexFile, surface: Surface, frames: TexFrame[], format: AnimatedFormat): number {
  const used = new Set<number>();
  let sourceBytes = 0;
  for (const f of frames) {
    if (used.has(f.imageId)) continue;
    used.add(f.imageId);
    const mip = tex.images[f.imageId]?.[0];
    sourceBytes += mip ? mip.length : surface.w * surface.h * 4;
  }
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) sourceBytes = surface.w * surface.h * 4 * frames.length;
  const paletteOverhead = format === 'gif' ? frames.length * 800 : 0;
  const guess = sourceBytes * (format === 'gif' ? 0.55 : 0.65) + paletteOverhead;
  return Math.round(Math.max(sourceBytes * 0.15, Math.min(sourceBytes * 2.5, guess)));
}

export interface SinkPlan {
  ext: string;
  mime: string;
  create(surface: Surface, frameCount: number): FrameSink;
}

export const SINK_PLANS: Record<'apng' | 'gif', SinkPlan> = {
  apng: { ext: 'apng', mime: 'image/apng', create: (s, n) => new ApngWriter(s.w, s.h, n) },
  gif: { ext: 'gif', mime: 'image/gif', create: (s, n) => new GifWriter(s.w, s.h, n) },
};

export function formatsOf(animated: AnimatedFormat): ('apng' | 'gif')[] {
  return animated === 'both' ? ['apng', 'gif'] : [animated];
}

export type AnimationResult = Map<'apng' | 'gif', Blob | Error>;

/**
 * 一次解码、多路写入：「两者都出」也只跑一遍帧循环。
 * 结果按格式记忆，所以两个条目共享同一次编码。
 */
export function animationJob(
  frames: TexFrame[],
  source: FrameSource,
  formats: ('apng' | 'gif')[],
  onFrame?: (done: number, total: number) => void,
): () => Promise<AnimationResult> {
  let job: Promise<AnimationResult> | undefined;
  return () => (job ??= (async () => {
    const sinks = formats.map((f) => ({ f, sink: SINK_PLANS[f].create(source.surface, frames.length) }));
    const result: AnimationResult = new Map();
    let thrown: Error | undefined;
    try {
      await encodeAnimation(frames, source, sinks.map((s) => s.sink), onFrame);
    } catch (e) {
      thrown = e as Error;
    }
    for (const { f, sink } of sinks) {
      // sink 自己失败过就别再调 finish()：那里的"帧数不符"会盖掉真正的原因
      if (thrown) {
        result.set(f, sink.failed ?? thrown);
        continue;
      }
      if (sink.failed) {
        result.set(f, sink.failed);
        continue;
      }
      try {
        result.set(f, await sink.finish());
      } catch (e) {
        result.set(f, e as Error);
      }
    }
    return result;
  })());
}
