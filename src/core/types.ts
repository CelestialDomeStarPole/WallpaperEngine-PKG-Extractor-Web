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
  bytes: Uint8Array;
  entries: PkgEntry[];
}

export interface ContainerAdapter {
  id: string;
  label: string;
  detect(view: Uint8Array): boolean;
  parse(buffer: ArrayBuffer): PkgFile;
}

export interface TexMipmap {
  width: number;
  height: number;
  isLz4: boolean;
  decompressedLength: number;
  data: Uint8Array;
}

export interface TexFrame {
  imageId: number;
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
  /** FreeImageFormat；-1 = 未知（按 texFormat 处理） */
  imageFormat: number;
  isVideoMp4: boolean;
  images: TexMipmap[][];
  frames: TexFrame[];
}

export type ItemKind = 'image' | 'video' | 'json' | 'binary';

export interface ExtractItem {
  id: number;
  /** 输出文件名（可能已由 .tex 转为 .png/.mp4） */
  name: string;
  /** 包内原始路径 */
  sourcePath: string;
  kind: ItemKind;
  mime: string;
  /** 输出字节数（估算或原样大小时精确） */
  bytes: number;
  toBlob(): Blob;
  tex?: TexFile;
  /** 解码失败回退原样导出时给 UI 提示 */
  warning?: string;
}

export interface DecodeOptions {
  texToImage: boolean;
}

export interface WallpaperMeta {
  title: string;
  type?: string;
  tags: string[];
  previewFiles: string[];
  videoFile?: string;
  propertiesFile?: string;
}
