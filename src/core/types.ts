import type { ByteSource } from './bytesource';

export interface PkgEntry {
  /** 包内相对路径，'/' 分隔 */
  name: string;
  /** 相对 dataStart 的偏移 */
  offset: number;
  length: number;
}

export interface PkgFile {
  magic: string;
  dataStart: number;
  /** 整包数据源：解析阶段真正进过内存的只有目录表 */
  source: ByteSource;
  entries: PkgEntry[];
  /** 条目字节子源（绝对偏移 = dataStart + entry.offset） */
  entrySource(entry: PkgEntry): ByteSource;
  /** 直通导出的零拷贝通道 */
  entryBlob(entry: PkgEntry): Promise<Blob>;
}

export interface ContainerAdapter {
  id: string;
  label: string;
  /** 只需要覆盖 magic 的前几个字节 */
  detect(head: Uint8Array): boolean;
  parse(source: ByteSource): Promise<PkgFile>;
}

export interface TexMipmap {
  width: number;
  height: number;
  isLz4: boolean;
  decompressedLength: number;
  /** 相对 tex.source 的起点 */
  start: number;
  /** 压缩后的字节数；数据按需再读 */
  length: number;
}

export interface TexFrame {
  imageId: number;
  /** 秒 */
  frametime: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TexFile {
  texFormat: number;
  flags: number;
  textureWidth: number;
  textureHeight: number;
  imageWidth: number;
  imageHeight: number;
  containerVersion: number;
  /** 帧容器 TEXS 版本；无帧表时为 0 */
  frameVersion: number;
  /** FreeImageFormat；-1 = 未知（按 texFormat 处理） */
  imageFormat: number;
  isVideoMp4: boolean;
  /** TEXS0003 才有：动画画布的权威尺寸，其余版本为 0 */
  gifWidth: number;
  gifHeight: number;
  source: ByteSource;
  images: TexMipmap[][];
  frames: TexFrame[];
}

export type ItemKind = 'image' | 'video' | 'json' | 'binary';

/** poster = 动画条目的第 0 帧单图，只为缩略图存在，避免为一格小图编完整动画 */
export type BlobVariant = 'full' | 'poster';

export interface ExtractItem {
  id: number;
  /** 输出文件名（可能已由 .tex 转为 .png/.mp4/.apng/.gif） */
  name: string;
  /** 包内原始路径 */
  sourcePath: string;
  kind: ItemKind;
  mime: string;
  /** 输出字节数；原样导出与静态解码是精确值，动图是估算值 */
  bytes: number;
  /** true 时 bytes 是估算，编码完成后由 worker 回填精确值 */
  estimated?: boolean;
  /** true 时 toBlob('poster') 走得通 */
  poster?: boolean;
  toBlob(variant?: BlobVariant): Promise<Blob>;
  tex?: TexFile;
  /** 解码失败回退原样导出时给 UI 提示 */
  warning?: string;
  /** 惰性编码失败回退后由 toBlob 写下：新文件名/mime/类别与原因，UI 据此改名并告知用户 */
  degraded?: { name: string; mime: string; kind: ItemKind; reason: string };
}

export type AnimatedFormat = 'apng' | 'gif' | 'both';

export interface DecodeOptions {
  texToImage: boolean;
  animatedFormat: AnimatedFormat;
  /** 调试用：强制走「每帧一张 PNG」，用来核对真实包的帧矩形与时间语义 */
  legacyFrames?: boolean;
}

/** 一段已解码的像素 */
export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 宿主能力注入点：core 不直接碰 createImageBitmap / OffscreenCanvas */
export interface DecodePorts {
  /** 把编码图片字节（png/jpg/gif/webp…）解成 RGBA */
  decodeRaster?(bytes: Uint8Array, mime: string): Promise<Raster>;
}

export interface WallpaperMeta {
  title: string;
  type?: string;
  tags: string[];
  previewFiles: string[];
  videoFile?: string;
  propertiesFile?: string;
}
