import { BinReader } from './binary';
import type { TexFile, TexFrame, TexMipmap } from './types';

/** repkg Constants 防御上限 */
export const LIMITS = {
  maxMipmapBytes: 250 * 1024 * 1024,
  maxImages: 100,
  maxMipmaps: 32,
  maxFrames: 100_000,
};

export const TexFormat = { RGBA8888: 0, DXT5: 4, DXT3: 6, DXT1: 7, RG88: 8, R8: 9 } as const;
export const TexFlags = { IsGif: 4, IsVideoTexture: 32 };
export const Fif = { UNKNOWN: -1, PNG: 13, JPEG: 2, GIF: 25, MP4: 35 } as const;

const VALID_TEX_FORMATS = new Set([0, 4, 6, 7, 8, 9]);

function parseContainerVersion(magic: string): number {
  if (!/^TEXB000[1-4]$/.test(magic)) {
    throw new Error(`未知 TEX 容器 magic: ${JSON.stringify(magic)}`);
  }
  return parseInt(magic.slice(4, 8), 10);
}

function readMipmap(r: BinReader, layout: 1 | 2 | 4): TexMipmap {
  if (layout === 1) {
    const width = r.i32('mip.w');
    const height = r.i32('mip.h');
    const blen = r.i32('mip.len');
    return { width, height, isLz4: false, decompressedLength: blen, data: readMipBytes(r, blen) };
  }
  let isV4Prefix = false;
  if (layout === 4) {
    // V4 视频专用前置四元组: param1==1, param2==2, conditionJson(NString), param3==1
    const p1 = r.i32('mip.p1');
    const p2 = r.i32('mip.p2');
    if (p1 !== 1 || p2 !== 2) throw new Error(`TEX V4 mipmap 前置字段异常: p1=${p1} p2=${p2}`);
    isV4Prefix = true;
    r.nullString(65536, 'mip.conditionJson');
    const p3 = r.i32('mip.p3');
    if (p3 !== 1) throw new Error(`TEX V4 mipmap p3 != 1: ${p3}`);
  }
  const width = r.i32('mip.w');
  const height = r.i32('mip.h');
  const isLz4 = r.i32('mip.isLz4') === 1;
  const dlen = r.i32('mip.dlen');
  const blen = r.i32('mip.len');
  const m = { width, height, isLz4, decompressedLength: dlen, data: readMipBytes(r, blen) };
  if (isV4Prefix && !isLz4) m.decompressedLength = blen;
  return m;
}

function readMipBytes(r: BinReader, blen: number): Uint8Array {
  if (blen < 0 || blen > LIMITS.maxMipmapBytes) {
    throw new Error(`mipmap 字节数异常: ${blen}`);
  }
  return r.take(blen, 'mip.bytes');
}

/** FreeImageFormat 中"整张编码图片"的判定（对齐 repkg MipmapFormat >= 1000 语义），由 extract.ts 使用 */
export function isEncodedImageFormat(fmt: number): boolean {
  return fmt >= 0 && fmt <= 35 && fmt !== 34 /* RAW */;
}

export function parseTex(bytes: Uint8Array): TexFile {
  const r = new BinReader(bytes);
  const m1 = r.nullString(16, 'tex.magic1');
  const m2 = r.nullString(16, 'tex.magic2');
  if (m1 !== 'TEXV0005' || m2 !== 'TEXI0001') {
    throw new Error(`TEX magic 不符: ${m1}/${m2}`);
  }
  const texFormat = r.i32('header.format');
  const flags = r.i32('header.flags');
  const textureWidth = r.i32('header.texW');
  const textureHeight = r.i32('header.texH');
  const imageWidth = r.i32('header.imgW');
  const imageHeight = r.i32('header.imgH');
  r.i32('header.unk');
  if (!VALID_TEX_FORMATS.has(texFormat)) {
    throw new Error(`未知 TexFormat: ${texFormat}`);
  }

  const containerVersion = parseContainerVersion(r.nullString(16, 'container.magic'));
  const imageCount = r.i32('imageCount');
  if (imageCount < 0 || imageCount > LIMITS.maxImages) {
    throw new Error(`imageCount 异常: ${imageCount}`);
  }
  let imageFormat = -1;
  let isVideoMp4 = false;
  if (containerVersion >= 3) {
    imageFormat = r.i32('imageFormat');
    if (imageFormat < -1 || imageFormat > 35) {
      throw new Error(`imageFormat 越界: ${imageFormat}`);
    }
  }
  if (containerVersion === 4) {
    isVideoMp4 = r.i32('isVideoMp4') === 1;
    if (imageFormat === Fif.UNKNOWN && isVideoMp4) imageFormat = Fif.MP4;
  }

  // 版本4但格式非 MP4 → 按版本3 的 mipmap 布局（repkg 降级规则）
  const v4VideoMips = containerVersion === 4 && imageFormat === Fif.MP4 && isVideoMp4;
  const layout: 1 | 2 | 4 = containerVersion === 1 ? 1 : v4VideoMips ? 4 : 2;

  const images: TexMipmap[][] = [];
  for (let i = 0; i < imageCount; i++) {
    const mipmapCount = r.i32('mipmapCount');
    if (mipmapCount <= 0 || mipmapCount > LIMITS.maxMipmaps) {
      throw new Error(`image[${i}] mipmapCount 异常: ${mipmapCount}`);
    }
    const mips: TexMipmap[] = [];
    for (let j = 0; j < mipmapCount; j++) mips.push(readMipmap(r, layout));
    images.push(mips);
  }

  const frames: TexFrame[] = [];
  if (flags & TexFlags.IsGif) {
    const frameMagic = r.nullString(16, 'frames.magic');
    if (!/^TEXS000[1-3]$/.test(frameMagic)) {
      throw new Error(`未知帧容器 magic: ${frameMagic}`);
    }
    const frameVersion = parseInt(frameMagic.slice(4, 8), 10);
    const frameCount = r.i32('frameCount');
    if (frameCount < 0 || frameCount > LIMITS.maxFrames) {
      throw new Error(`frameCount 异常: ${frameCount}`);
    }
    if (frameVersion === 3) {
      r.i32('gifWidth');
      r.i32('gifHeight');
    }
    for (let i = 0; i < frameCount; i++) {
      const imageId = r.i32('frame.imageId');
      const frametime = r.f32('frame.time');
      let x: number, y: number, width: number, height: number;
      if (frameVersion === 1) {
        x = r.i32(); y = r.i32(); width = r.i32(); r.i32(); r.i32(); height = r.i32();
      } else {
        x = r.f32(); y = r.f32(); width = r.f32(); r.f32(); r.f32(); height = r.f32();
      }
      frames.push({ imageId, frametime, x, y, width, height });
    }
  }
  return {
    texFormat, flags, textureWidth, textureHeight, imageWidth, imageHeight,
    containerVersion, imageFormat, isVideoMp4, images, frames,
  };
}
