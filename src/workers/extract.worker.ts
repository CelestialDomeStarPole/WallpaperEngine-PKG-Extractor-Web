/// <reference lib="webworker" />
import type { DecodeOptions, ExtractItem, PkgFile, WallpaperMeta } from '../core/types';
import { detectAdapter } from '../core/adapter';
import { buildItems } from '../core/extract';

interface ParseMsg { type: 'parse'; buffer: ArrayBuffer; options: DecodeOptions }
interface ReparseMsg { type: 'reparse'; options: DecodeOptions }
interface BlobMsg { type: 'blob'; id: number }
type InMsg = ParseMsg | ReparseMsg | BlobMsg;

let pkg: PkgFile | null = null;
let savedBuffer: ArrayBuffer | null = null;
let items: ExtractItem[] = [];

const post = (msg: unknown, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer ?? []);

function summarize(it: ExtractItem) {
  return {
    id: it.id, name: it.name, sourcePath: it.sourcePath, kind: it.kind,
    mime: it.mime, bytes: it.bytes, warning: it.warning,
  };
}

function doParse(options: DecodeOptions): WallpaperMeta | undefined {
  const { items: built, meta } = buildItems(pkg!, options);
  items = built;
  return meta;
}

(self as unknown as Worker).onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'parse') {
      const bytes = new Uint8Array(msg.buffer);
      const adapter = detectAdapter(bytes);
      if (!adapter) {
        const head = new TextDecoder().decode(bytes.subarray(0, 4));
        const hint = head === 'PKG ' ? '检测到 Workshop 加密格式（PKG v1/v2），当前版本暂不支持，第二期将提供。' : '无法识别的文件格式：不是明文 PKGV 容器。';
        post({ type: 'error', message: hint });
        return;
      }
      pkg = adapter.parse(msg.buffer);
      savedBuffer = msg.buffer;
      const meta = doParse(msg.options);
      post({ type: 'parsed', magic: pkg.magic, items: items.map(summarize), meta });
    } else if (msg.type === 'reparse') {
      if (!pkg) throw new Error('尚未加载文件');
      const meta = doParse(msg.options);
      post({ type: 'parsed', magic: pkg.magic, items: items.map(summarize), meta });
    } else if (msg.type === 'blob') {
      if (!pkg) throw new Error('尚未加载文件');
      const item = items.find((i) => i.id === msg.id);
      if (!item) throw new Error(`条目不存在: ${msg.id}`);
      const blob = item.toBlob();
      const out = new Uint8Array(await blob.arrayBuffer());
      post({ type: 'blob', id: msg.id, bytes: out, name: item.name, mime: item.mime }, [out.buffer]);
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
  void savedBuffer;
};
