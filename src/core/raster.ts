import { decompressDxt, rg88ToRgba, r8ToRgba, rgba8888ToRgba } from './dxt';
import { Fif, isEncodedImageFormat, readMipmapBytes } from './tex';
import type { DecodePorts, Raster, TexFile } from './types';

/** imageFormat==-1 的原始纹理字节 → RGBA（纯像素转换；LZ4 已在 readMipmapBytes 展开） */
export function decodeRawTexToRgba(tex: TexFile, data: Uint8Array, width: number, height: number): Uint8Array {
  switch (tex.texFormat) {
    case 0 /* RGBA8888 */: return rgba8888ToRgba(data, width, height);
    case 8 /* RG88 */: return rg88ToRgba(data, width, height);
    case 9 /* R8 */: return r8ToRgba(data, width, height);
    case 7 /* DXT1 */: return decompressDxt(width, height, data, 1);
    case 6 /* DXT3 */: return decompressDxt(width, height, data, 2);
    case 4 /* DXT5 */: return decompressDxt(width, height, data, 5);
    default: throw new Error(`无法解码的 TexFormat: ${tex.texFormat}`);
  }
}

/** repkg 行为：mip 尺寸 ≥ 目标尺寸才裁到 imageWidth/Height */
export function cropToImage(tex: TexFile, rgba: Uint8Array, w: number, h: number): Raster {
  if (!(tex.imageWidth > 0 && tex.imageWidth <= w && tex.imageHeight > 0 && tex.imageHeight <= h)) {
    return { width: w, height: h, rgba };
  }
  const cropped = new Uint8Array(tex.imageWidth * tex.imageHeight * 4);
  for (let y = 0; y < tex.imageHeight; y++) {
    cropped.set(rgba.subarray(y * w * 4, y * w * 4 + tex.imageWidth * 4), y * tex.imageWidth * 4);
  }
  return { width: tex.imageWidth, height: tex.imageHeight, rgba: cropped };
}

/** 一个 image 栅格化：内嵌编码格式走宿主解码，原始格式走本地解码 */
export async function rasterOfImage(tex: TexFile, image: number, ports: DecodePorts): Promise<Raster> {
  const mip = tex.images[image]?.[0];
  if (!mip) throw new Error(`引用了不存在的 image ${image}`);
  if (isEncodedImageFormat(tex.imageFormat) && tex.imageFormat !== Fif.MP4) {
    if (!ports.decodeRaster) {
      throw new Error(`需要解码内嵌帧（FreeImage 格式 ${tex.imageFormat}），当前环境没有解码能力`);
    }
    const mime = ENCODED_MIME[tex.imageFormat] ?? 'image/*';
    return ports.decodeRaster(await readMipmapBytes(tex, image), mime);
  }
  const bytes = await readMipmapBytes(tex, image);
  return cropToImage(tex, decodeRawTexToRgba(tex, bytes, mip.width, mip.height), mip.width, mip.height);
}

const ENCODED_MIME: Record<number, string> = {
  [Fif.PNG]: 'image/png', [Fif.JPEG]: 'image/jpeg', [Fif.GIF]: 'image/gif',
};

export const ENCODED_EXT: Record<number, string> = {
  [Fif.PNG]: 'png', [Fif.JPEG]: 'jpg', [Fif.GIF]: 'gif', [Fif.MP4]: 'mp4',
};
