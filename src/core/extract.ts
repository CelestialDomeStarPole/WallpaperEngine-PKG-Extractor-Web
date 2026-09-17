import { animationJob, animationSurface, estimateAnimationBytes, formatsOf, FrameSource, SINK_PLANS } from './animation';
import { LIMITS } from './limits';
import { parseProjectMeta } from './metadata';
import { encodePng } from './png';
import { ENCODED_EXT, rasterOfImage, rasterOfImageRaw } from './raster';
import { Fif, TexFlags, isEncodedImageFormat, parseTex, readMipmapBlob } from './tex';
import type { BlobVariant, DecodeOptions, DecodePorts, ExtractItem, ItemKind, PkgFile, Raster, TexFile, WallpaperMeta } from './types';

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', apng: 'image/apng',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  json: 'application/json', txt: 'text/plain',
};
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'apng']);
const VIDEO_EXTS = new Set(['mp4', 'webm']);

/** 逐帧 PNG 兜底路径最多产出多少帧 */
const LEGACY_FRAME_CAP = 60;

function extOf(name: string): string {
  const m = /\.(\w+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function blobOf(bytes: Uint8Array, mime: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: mime });
}

/** 输出只物化一次 */
function memo(make: () => Promise<Blob>): () => Promise<Blob> {
  let p: Promise<Blob> | undefined;
  return () => (p ??= make());
}

export function texBaseName(sourceName: string): string {
  return sourceName.replace(/\.tex$/i, '');
}

export interface TexOutcome {
  name: string;
  mime: string;
  kind: ItemKind;
  bytes: number;
  estimated?: boolean;
  poster?: boolean;
  make(variant?: BlobVariant): Promise<Blob>;
}

/** 输出名：最高层保持原名，低层级带 .mipN 后缀 */
function mipName(base: string, ext: string, mip: number): string {
  return mip === 0 ? `${base}.${ext}` : `${base}.mip${mip}.${ext}`;
}

/**
 * 视频纹理：payload 是一整段 mp4。
 * imageFormat 可能显式标成 MP4，也可能标成 UNKNOWN 而靠 flags 的 IsVideoTexture 位（实测样本属于后者）。
 */
function isVideoTexture(tex: TexFile): boolean {
  return tex.imageFormat === Fif.MP4
    || (tex.imageFormat === Fif.UNKNOWN && (tex.flags & TexFlags.IsVideoTexture) !== 0);
}

/**
 * 单个 .tex 的主输出，按 mips 给的层级各出一条。
 * 编码类（内嵌 jpg/png）每层都是独立的完整图片，零拷贝直通；原始类逐层解码成 PNG。
 */
export async function texOutputs(
  tex: TexFile, sourceName: string, mips: number[], ports: DecodePorts = {},
): Promise<TexOutcome[]> {
  const base = texBaseName(sourceName);
  const levels = mips.length ? mips : [0];
  const out: TexOutcome[] = [];
  for (const mip of levels) {
    const m = tex.images[0]?.[mip];
    if (!m) continue; // 这张贴图没有这一层级就跳过
    if (isVideoTexture(tex)) {
      // 视频纹理只有一个逻辑层级，低层级没有意义
      if (mip === 0) {
        out.push({
          name: `${base}.mp4`, mime: 'video/mp4', kind: 'video', bytes: m.length,
          make: memo(() => readMipmapBlob(tex, 0, mip)),
        });
      }
      continue;
    }
    if (isEncodedImageFormat(tex.imageFormat)) {
      const ext = ENCODED_EXT[tex.imageFormat] ?? 'img';
      out.push({
        name: mipName(base, ext, mip), mime: EXT_MIME[ext] ?? 'application/octet-stream', kind: 'image',
        bytes: m.length, make: memo(() => readMipmapBlob(tex, 0, mip)),
      });
      continue;
    }
    const raster = await rasterOfImage(tex, 0, ports, mip);
    const png = encodePng(raster.rgba, raster.width, raster.height);
    out.push({
      name: mipName(base, 'png', mip), mime: 'image/png', kind: 'image', bytes: png.length,
      make: memo(async () => blobOf(png, 'image/png')),
    });
  }
  return out;
}

/** 只要最高层的便捷入口 */
export async function texToPrimaryOutput(tex: TexFile, sourceName: string): Promise<TexOutcome> {
  const [first] = await texOutputs(tex, sourceName, [0]);
  if (!first) throw new Error('TEX 无 mipmap');
  return first;
}

/**
 * 临时方案：每帧一张 PNG。
 * 只在重编码不可用时兜底，以及 ?legacyFrames=1 逐帧核对帧矩形/时间语义时用。
 */
export async function legacyFrameOutputs(tex: TexFile, sourceName: string, ports: DecodePorts): Promise<TexOutcome[]> {
  const out: TexOutcome[] = [];
  const base = texBaseName(sourceName);
  const count = Math.min(tex.frames.length, LEGACY_FRAME_CAP);
  for (let i = 0; i < count; i++) {
    try {
      // 帧用 imageId 索引自己的 image，不是循环下标；不裁剪，方便逐帧核对矩形
      const raster: Raster = await rasterOfImageRaw(tex, tex.frames[i].imageId, ports);
      const png = encodePng(raster.rgba, raster.width, raster.height);
      out.push({
        name: `${base}.frame${String(i).padStart(3, '0')}.png`,
        mime: 'image/png', kind: 'image', bytes: png.length,
        make: memo(async () => blobOf(png, 'image/png')),
      });
    } catch {
      continue; // 单帧失败跳过，不阻断
    }
  }
  return out;
}

export function isAnimatedTex(tex: TexFile): boolean {
  return (tex.flags & TexFlags.IsGif) !== 0 && tex.frames.length > 1;
}

/** 原始纹理格式本地就能解码；内嵌编码帧必须有宿主提供的 decodeRaster */
function canReencode(tex: TexFile, ports: DecodePorts): boolean {
  if (isVideoTexture(tex)) return false;
  return !isEncodedImageFormat(tex.imageFormat) || !!ports.decodeRaster;
}

/** 动画贴图 → 1~2 个条目（每个格式一条），编码惰性、体积估算、超限按格式各自降级 */
function animatedItems(
  tex: TexFile, entry: { name: string; length: number }, options: DecodeOptions, ports: DecodePorts,
  firstId: number, nextId: () => number, fallback: () => Promise<Blob>,
): ExtractItem[] {
  const surface = animationSurface(tex);
  const formats = formatsOf(options.animatedFormat);
  const base = texBaseName(entry.name);
  const source = new FrameSource(tex, surface, ports, tex.frames);
  const run = animationJob(tex.frames, source, formats);
  const poster = memo(async () =>
    blobOf(encodePng(await source.framePixels(tex.frames[0]), surface.w, surface.h), 'image/png'));
  console.info(
    `[anim] ${entry.name}: ${tex.frames.length} 帧 · 画布 ${surface.w}x${surface.h} · 输出 ${options.animatedFormat}`,
    tex.frames.slice(0, 3).map((f) => `${f.imageId}@${f.frametime.toFixed(3)}s[${f.x},${f.y},${f.width},${f.height}]`).join(' '),
  );
  return formats.map((f, i) => {
    const plan = SINK_PLANS[f];
    const item: ExtractItem = {
      id: i === 0 ? firstId : nextId(),
      name: `${base}.${plan.ext}`,
      sourcePath: entry.name,
      kind: 'image',
      mime: plan.mime,
      bytes: estimateAnimationBytes(tex, surface, tex.frames, f),
      estimated: true,
      poster: true,
      tex,
      toBlob: async (variant: BlobVariant = 'full') => {
        if (variant === 'poster') return poster();
        let got: Blob | Error | undefined;
        try {
          got = (await run()).get(f);
        } catch (e) {
          got = e as Error;
        }
        if (got instanceof Blob) return got;
        const reason = got instanceof Error ? got.message : '编码失败';
        try {
          // 这个格式编不出来（超上限 / 缺解码能力）→ 回退第 0 帧 PNG
          const png = await poster();
          item.degraded = { name: `${base}.png`, mime: 'image/png', kind: 'image', reason };
          return png;
        } catch (e) {
          // 连第 0 帧都解不出来 → 原样导出包内 .tex，至少下载不会失败
          item.degraded = {
            name: entry.name, mime: 'application/octet-stream', kind: 'binary',
            reason: `${reason}；第 0 帧也无法解码（${(e as Error).message}），已按原样导出`,
          };
          return fallback();
        }
      },
    };
    return item;
  });
}

function passthroughItem(
  id: number, entry: { name: string; length: number }, source: PkgFile['source'], kind: ItemKind, mime: string,
): ExtractItem {
  return {
    id, name: entry.name, sourcePath: entry.name, kind, mime, bytes: entry.length,
    toBlob: memo(() => source.blob(0, entry.length)),
  };
}

export async function buildItems(
  pkg: PkgFile,
  options: DecodeOptions,
  ports: DecodePorts = {},
): Promise<{ items: ExtractItem[]; meta?: WallpaperMeta; maxMip: number }> {
  const items: ExtractItem[] = [];
  let meta: WallpaperMeta | undefined;
  let nextId = 1;
  const takeId = () => nextId++;
  const mipLevels = options.mipLevels?.length ? options.mipLevels : [0];
  /** 整包里最深的 mip 链长度，UI 据此决定「纹理层级」能给几个选项 */
  let maxMip = 0;

  for (const entry of pkg.entries) {
    const ext = extOf(entry.name);
    const id = takeId();
    const source = pkg.entrySource(entry);
    const rawOutput = (warning: string): ExtractItem => ({
      id, name: entry.name, sourcePath: entry.name, kind: 'binary',
      mime: 'application/octet-stream', bytes: entry.length, warning,
      toBlob: memo(() => pkg.entryBlob(entry)),
    });

    if (ext !== 'tex') {
      const mime = EXT_MIME[ext] ?? 'application/octet-stream';
      const kind: ItemKind = IMAGE_EXTS.has(ext) ? 'image' : VIDEO_EXTS.has(ext) ? 'video' : ext === 'json' ? 'json' : 'binary';
      if (ext === 'json' && /(^|\/)project\.json$/.test(entry.name)) {
        try {
          const bytes = await source.read(0, Math.min(entry.length, LIMITS.metaJsonMaxRead), 'project.json');
          meta = parseProjectMeta(new TextDecoder().decode(bytes), entry.name);
        } catch { /* 忽略 */ }
      }
      items.push(passthroughItem(id, entry, source, kind, mime));
      continue;
    }

    if (!options.texToImage) {
      items.push(passthroughItem(id, entry, source, 'binary', 'application/octet-stream'));
      continue;
    }

    let tex: TexFile;
    try {
      tex = await parseTex(source);
    } catch (e) {
      items.push(rawOutput(`TEX 解析失败，已按原样导出: ${(e as Error).message}`));
      continue;
    }
    for (const mips of tex.images) maxMip = Math.max(maxMip, mips.length);
    try {
      if (isAnimatedTex(tex)) {
        if (options.legacyFrames) {
          const frames = await legacyFrameOutputs(tex, entry.name, ports);
          if (frames.length) {
            items.push(...frames.map((o) => ({
              id: takeId(), name: o.name, sourcePath: entry.name, kind: o.kind,
              mime: o.mime, bytes: o.bytes, tex, toBlob: o.make,
            })));
            continue;
          }
        } else if (canReencode(tex, ports)) {
          items.push(...animatedItems(tex, entry, options, ports, id, takeId, () => pkg.entryBlob(entry)));
          continue;
        } else {
          const main = await texToPrimaryOutput(tex, entry.name);
          main.poster = true;
          items.push({
            id, name: main.name, sourcePath: entry.name, kind: main.kind,
            mime: main.mime, bytes: main.bytes, tex, toBlob: main.make,
            warning: `动画共 ${tex.frames.length} 帧，但内嵌帧的解码需要浏览器能力，当前环境没有：只导出了第一帧`,
          });
          continue;
        }
      }
      const outs = await texOutputs(tex, entry.name, mipLevels, ports);
      outs.forEach((o, i) => {
        items.push({
          id: i === 0 ? id : takeId(), name: o.name, sourcePath: entry.name, kind: o.kind,
          mime: o.mime, bytes: o.bytes, tex, toBlob: o.make,
        });
      });
    } catch (e) {
      items.push(rawOutput(`TEX 解码失败，已按原样导出: ${(e as Error).message}`));
    }
  }
  return { items, meta, maxMip };
}
