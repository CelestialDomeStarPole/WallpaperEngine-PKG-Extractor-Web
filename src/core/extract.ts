import type { DecodeOptions, ExtractItem, PkgFile, TexFile, TexMipmap } from './types';
import { parseTex, TexFormat, TexFlags, Fif, isEncodedImageFormat } from './tex';
import { lz4Decompress } from './lz4';
import { decompressDxt, rg88ToRgba, r8ToRgba, rgba8888ToRgba } from './dxt';
import { encodePng } from './png';
import { parseProjectMeta } from './metadata';
import type { WallpaperMeta } from './types';

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  json: 'application/json', txt: 'text/plain',
};
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm']);

const FIF_EXT: Record<number, string> = { [Fif.PNG]: 'png', [Fif.JPEG]: 'jpg', [Fif.GIF]: 'gif', [Fif.MP4]: 'mp4' };

function extOf(name: string): string {
  const m = /\.(\w+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function base64SliceToBlob(bytes: Uint8Array, mime: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: mime });
}

/** mipmap 数据按 isLz4 解压（dxt/rgba 直通路径用） */
function mipBytes(mip: TexMipmap): Uint8Array {
  if (!mip.isLz4) return mip.data;
  return lz4Decompress(mip.data, mip.decompressedLength);
}

/** imageFormat==-1 的原始纹理解码为 RGBA */
export function decodeRawTexToRgba(tex: TexFile, mip: TexMipmap): Uint8Array {
  const data = mipBytes(mip);
  switch (tex.texFormat) {
    case TexFormat.RGBA8888: return rgba8888ToRgba(data, mip.width, mip.height);
    case TexFormat.RG88: return rg88ToRgba(data, mip.width, mip.height);
    case TexFormat.R8: return r8ToRgba(data, mip.width, mip.height);
    case TexFormat.DXT1: return decompressDxt(mip.width, mip.height, data, 1);
    case TexFormat.DXT3: return decompressDxt(mip.width, mip.height, data, 2);
    case TexFormat.DXT5: return decompressDxt(mip.width, mip.height, data, 5);
    default: throw new Error(`无法解码的 TexFormat: ${tex.texFormat}`);
  }
}

interface TexOutcome {
  name: string;
  mime: string;
  kind: ExtractItem['kind'];
  bytes: Uint8Array;
}

/** 单个 .tex → 输出文件（0~N 个结果由调用方决定个数；这里返回主输出） */
export function texToPrimaryOutput(tex: TexFile, sourceName: string): TexOutcome {
  const base = sourceName.replace(/\.tex$/i, '');
  const mip0 = tex.images[0]?.[0];
  if (!mip0) throw new Error('TEX 无 mipmap');

  if (tex.imageFormat === Fif.MP4) {
    return { name: base + '.mp4', mime: 'video/mp4', kind: 'video', bytes: mip0.data };
  }
  if (isEncodedImageFormat(tex.imageFormat)) {
    const ext = FIF_EXT[tex.imageFormat] ?? 'img';
    const mime = EXT_MIME[ext] ?? 'application/octet-stream';
    return { name: `${base}.${ext}`, mime, kind: 'image', bytes: mip0.data };
  }
  const rgba = decodeRawTexToRgba(tex, mip0);
  let w = mip0.width;
  let h = mip0.height;
  // 裁剪到 imageWidth/Height（repkg 行为：mip 尺寸 ≥ 目标尺寸才裁）
  if (tex.imageWidth > 0 && tex.imageWidth <= w && tex.imageHeight > 0 && tex.imageHeight <= h) {
    const cropped = new Uint8Array(tex.imageWidth * tex.imageHeight * 4);
    for (let y = 0; y < tex.imageHeight; y++) {
      cropped.set(rgba.subarray(y * w * 4, y * w * 4 + tex.imageWidth * 4), y * tex.imageWidth * 4);
    }
    w = tex.imageWidth;
    h = tex.imageHeight;
    return { name: base + '.png', mime: 'image/png', kind: 'image', bytes: encodePng(cropped, w, h) };
  }
  return { name: base + '.png', mime: 'image/png', kind: 'image', bytes: encodePng(rgba, w, h) };
}

export function gifFrameOutputs(tex: TexFile, sourceName: string): TexOutcome[] {
  const out: TexOutcome[] = [];
  const base = sourceName.replace(/\.tex$/i, '');
  for (let i = 0; i < tex.frames.length && i < tex.images.length; i++) {
    const mip0 = tex.images[i][0];
    if (!mip0) continue;
    try {
      const rgba = decodeRawTexToRgba(tex, mip0);
      out.push({
        name: `${base}.frame${String(i).padStart(3, '0')}.png`,
        mime: 'image/png', kind: 'image',
        bytes: encodePng(rgba, mip0.width, mip0.height),
      });
    } catch {
      /* 单帧失败跳过，不阻断 */
    }
  }
  return out;
}

export function buildItems(pkg: PkgFile, options: DecodeOptions): { items: ExtractItem[]; meta?: WallpaperMeta } {
  const items: ExtractItem[] = [];
  let meta: WallpaperMeta | undefined;
  let nextId = 1;
  for (const entry of pkg.entries) {
    const raw = pkg.bytes.subarray(pkg.dataStart + entry.offset, pkg.dataStart + entry.offset + entry.length);
    const ext = extOf(entry.name);
    const id = nextId++;

    if (ext === 'tex') {
      if (!options.texToImage) {
        items.push({
          id, name: entry.name, sourcePath: entry.name, kind: 'binary',
          mime: 'application/octet-stream', bytes: entry.length,
          toBlob: () => base64SliceToBlob(raw, 'application/octet-stream'),
        });
        continue;
      }
      let tex: TexFile;
      try {
        tex = parseTex(raw);
      } catch (e) {
        items.push({
          id, name: entry.name, sourcePath: entry.name, kind: 'binary',
          mime: 'application/octet-stream', bytes: entry.length,
          warning: `TEX 解析失败，已按原样导出: ${(e as Error).message}`,
          toBlob: () => base64SliceToBlob(raw, 'application/octet-stream'),
        });
        continue;
      }
      try {
        const main = texToPrimaryOutput(tex, entry.name);
        const extraFrames = tex.flags & TexFlags.IsGif ? gifFrameOutputs(tex, entry.name) : [];
        let blob: Blob | undefined;
        const make = (bytes: Uint8Array, mime: string) => () => base64SliceToBlob(bytes, mime);
        items.push({
          id, name: main.name, sourcePath: entry.name, kind: main.kind,
          mime: main.mime, bytes: main.bytes.length, tex,
          toBlob: () => (blob ??= base64SliceToBlob(main.bytes, main.mime)),
        });
        for (const f of extraFrames) {
          items.push({
            id: nextId++, name: f.name, sourcePath: entry.name, kind: f.kind,
            mime: f.mime, bytes: f.bytes.length,
            toBlob: make(f.bytes, f.mime),
          });
        }
        void make;
      } catch (e) {
        items.push({
          id, name: entry.name, sourcePath: entry.name, kind: 'binary',
          mime: 'application/octet-stream', bytes: entry.length, tex,
          warning: `TEX 解码失败，已按原样导出: ${(e as Error).message}`,
          toBlob: () => base64SliceToBlob(raw, 'application/octet-stream'),
        });
      }
      continue;
    }

    const mime = EXT_MIME[ext] ?? 'application/octet-stream';
    const kind = IMAGE_EXTS.has(ext) ? 'image' : VIDEO_EXTS.has(ext) ? 'video' : ext === 'json' ? 'json' : 'binary';
    if (ext === 'json' && /(^|\/)project\.json$/.test(entry.name)) {
      try {
        meta = parseProjectMeta(new TextDecoder().decode(raw), entry.name);
      } catch { /* 忽略 */ }
    }
    items.push({
      id, name: entry.name, sourcePath: entry.name, kind, mime, bytes: entry.length,
      toBlob: () => base64SliceToBlob(raw, mime),
    });
  }
  return { items, meta };
}

/** ZIP/下载用：条目全字节（惰性物化） */
export function entryBytes(pkg: PkgFile, entryName: string): Uint8Array {
  const e = pkg.entries.find((x) => x.name === entryName);
  if (!e) throw new Error(`entry 不存在: ${entryName}`);
  return pkg.bytes.subarray(pkg.dataStart + e.offset, pkg.dataStart + e.offset + e.length);
}
