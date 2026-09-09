/// <reference lib="webworker" />
import type { BlobVariant, DecodeOptions, ExtractItem, PkgFile, WallpaperMeta } from '../core/types';
import { detectAdapter } from '../core/adapter';
import { buildItems } from '../core/extract';
import { LIMITS } from '../core/limits';
import { FileByteSource } from '../browser/file-source';
import { rasterPorts } from './raster-ports';

interface OpenMsg { type: 'open'; file: File; options: DecodeOptions }
interface ReparseMsg { type: 'reparse'; options: DecodeOptions }
interface BlobMsg { type: 'blob'; id: number; variant: BlobVariant }
interface CloseMsg { type: 'close' }
type InMsg = OpenMsg | ReparseMsg | BlobMsg | CloseMsg;

interface ItemPatch { name: string; mime: string; kind: ExtractItem['kind']; notice: string }
interface Summary {
  id: number; name: string; sourcePath: string; kind: ExtractItem['kind'];
  mime: string; bytes: number; estimated?: boolean; poster?: boolean; warning?: string;
}
type OutMsg =
  | { type: 'parsed'; magic: string; items: Summary[]; meta?: WallpaperMeta }
  | { type: 'error'; message: string }
  | { type: 'blob'; id: number; variant: BlobVariant; blob: Blob; bytes: number; patch?: ItemPatch };

let pkg: PkgFile | null = null;
let items: ExtractItem[] = [];

const post = (msg: OutMsg) => (self as unknown as Worker).postMessage(msg);

function summarize(it: ExtractItem): Summary {
  return {
    id: it.id, name: it.name, sourcePath: it.sourcePath, kind: it.kind,
    mime: it.mime, bytes: it.bytes, estimated: it.estimated, poster: it.poster, warning: it.warning,
  };
}

async function doParse(options: DecodeOptions): Promise<void> {
  const built = await buildItems(pkg!, options, rasterPorts);
  items = built.items;
  post({ type: 'parsed', magic: pkg!.magic, items: items.map(summarize), meta: built.meta });
}

/**
 * 一次只处理一个 blob 请求：两路并发编码（比如几百帧的动画）会白占一倍内存。
 */
let queue: Promise<void> = Promise.resolve();

async function handle(msg: InMsg): Promise<void> {
  if (msg.type === 'close') {
    pkg = null;
    items = [];
    return;
  }
  if (msg.type === 'open') {
    if (msg.file.size > LIMITS.pkgFormatCeiling) {
      throw new Error(`文件 ${(msg.file.size / 1024 / 1024 / 1024).toFixed(2)} GB：PKGV 的偏移字段是 int32，这个格式存不下超过 2GB 的包`);
    }
    const source = new FileByteSource(msg.file);
    const head = await source.read(0, LIMITS.detectProbe, 'magic');
    const adapter = detectAdapter(head);
    if (!adapter) {
      const magic = new TextDecoder().decode(head.subarray(0, 4));
      throw new Error(
        magic === 'PKG '
          ? '检测到 Workshop 加密格式（PKG v1/v2），当前版本暂不支持，第二期将提供。'
          : '无法识别的文件格式：不是明文 PKGV 容器。',
      );
    }
    pkg = await adapter.parse(source);
    await doParse(msg.options);
    return;
  }
  if (msg.type === 'reparse') {
    if (!pkg) throw new Error('尚未加载文件');
    await doParse(msg.options);
    return;
  }
  if (!pkg) throw new Error('尚未加载文件');
  const item = items.find((i) => i.id === msg.id);
  if (!item) throw new Error(`条目不存在: ${msg.id}`);
  const blob = await item.toBlob(msg.variant);
  const degraded = msg.variant === 'full' ? item.degraded : undefined;
  // 直接把 Blob 递出去：结构化克隆传的是引用，不像 arrayBuffer() 那样整份复制
  post({
    type: 'blob', id: msg.id, variant: msg.variant, blob, bytes: blob.size,
    patch: degraded
      ? { name: degraded.name, mime: degraded.mime, kind: degraded.kind, notice: degraded.reason }
      : undefined,
  });
}

(self as unknown as Worker).onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  queue = queue.then(() => handle(msg)).catch((e: Error) => {
    post({ type: 'error', message: e.message });
  });
};
