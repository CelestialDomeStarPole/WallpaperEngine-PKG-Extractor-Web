import { wallpapers, randomWallpaper, type Wallpaper } from './wallpapers';

const SAMPLE_EDGE = 32;
/** 暗壁纸不需要太重的遮罩，否则整页发死 */
const SCRIM_MIN = 0.28;
const SCRIM_MAX = 0.88;
/** 正文色 #f3f8ff 的相对亮度与目标对比度：留足余量，让次级文字也过 AA */
const TEXT_LUMINANCE = 0.937;
const TARGET_CONTRAST = 5.4;

export interface ScrimResult {
  /** 0..1 遮罩强度；null 表示未能取样，调用方应保留当前值 */
  scrim: number | null;
  luminance: number | null;
}

const FAILED: ScrimResult = { scrim: null, luminance: null };

/** 相对亮度（sRGB 线性化后按 Rec.709 加权） */
function measureLuminance(src: CanvasImageSource): number | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_EDGE;
  canvas.height = SAMPLE_EDGE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
    n += 1;
  }
  return n ? sum / n : null;
}

/** 越亮的壁纸需要越重的遮罩：直接由目标对比度反解所需暗化比例，而不是拍一个斜率 */
function scrimForLuminance(l: number): number {
  const maxBgLum = (TEXT_LUMINANCE + 0.05) / TARGET_CONTRAST - 0.05;
  const need = l > 0 ? 1 - maxBgLum / l : 0;
  return Math.min(SCRIM_MAX, Math.max(SCRIM_MIN, need));
}

export interface BackgroundState {
  apply(wp: Wallpaper | null): Promise<ScrimResult>;
}

export function createBackground(img: HTMLImageElement): BackgroundState {
  let token = 0;
  return {
    async apply(wp) {
      const mine = ++token;
      img.classList.remove('ready');
      if (!wp) return FAILED;
      // 预加载到离屏 Image 再赋给可见层：避开重复 URL 不触发 load 事件、以及取样到旧图的竞态
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      try {
        await new Promise<void>((resolve, reject) => {
          probe.onload = () => resolve();
          probe.onerror = () => reject(new Error('wallpaper load failed'));
          probe.src = wp.url;
        });
      } catch {
        return FAILED;
      }
      if (mine !== token) return FAILED;
      let luminance: number | null = null;
      try {
        // 图床没给 CORS 时 drawImage 会污染 canvas，这里 getImageData 抛 SecurityError
        luminance = measureLuminance(probe);
      } catch {
        luminance = null;
      }
      img.src = wp.url;
      img.classList.add('ready');
      return { luminance, scrim: luminance === null ? null : scrimForLuminance(luminance) };
    },
  };
}

export { randomWallpaper, wallpapers, type Wallpaper };
