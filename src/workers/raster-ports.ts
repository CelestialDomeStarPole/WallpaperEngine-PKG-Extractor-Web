import type { DecodePorts, Raster } from '../core/types';

/**
 * worker 侧的宿主能力注入：把内嵌编码帧（png/jpg/gif/webp）解成 RGBA。
 * core 不许直接碰 createImageBitmap/OffscreenCanvas，所以这里做特性探测，
 * 缺能力时返回空 ports，由动画路径自行降级。
 */
async function decodeRaster(bytes: Uint8Array, mime: string): Promise<Raster> {
  const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }), {
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
  // copy：避免透明边缘被预乘洗掉，保住原始 alpha
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: d.width, height: d.height, rgba: new Uint8Array(d.data.buffer) };
}

export const rasterPorts: DecodePorts =
  typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
    ? { decodeRaster }
    : {};
