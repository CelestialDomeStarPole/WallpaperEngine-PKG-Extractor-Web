import type { ByteSource } from './bytesource';
import type { ContainerAdapter, PkgEntry, PkgFile } from './types';

/**
 * 单独的 .tex 文件（外面没有 PKG 容器）。
 * 实测 WE 写的是两个 NUL 结尾串直接拼在一起：`TEXV0005\0TEXI0001\0`。
 */
const TEX_MAGIC = 'TEXV0005\0TEXI0001\0';

export function detectTex(bytes: Uint8Array): boolean {
  if (bytes.length < TEX_MAGIC.length) return false;
  for (let i = 0; i < TEX_MAGIC.length; i++) {
    if (bytes[i] !== TEX_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 包成「只有一个条目」的 PkgFile，条目名取源的文件名（后缀规整成 .tex）。
 * 这样 TEX 解码、mip 层级选择、动画重编码、ZIP 导出这些下游流程全都原样复用。
 */
export async function parseTexFile(source: ByteSource): Promise<PkgFile> {
  const base = source.label.split(/[\\/]/).pop() || 'texture';
  const entry: PkgEntry = {
    name: `${base.replace(/\.[^.]+$/, '')}.tex`,
    offset: 0,
    length: source.size,
  };
  return {
    magic: 'TEX',
    dataStart: 0,
    source,
    entries: [entry],
    entrySource: () => source,
    entryBlob: () => source.blob(0, source.size),
  };
}

export const texAdapter: ContainerAdapter = {
  id: 'tex',
  label: 'TEX 贴图',
  detect: detectTex,
  parse: parseTexFile,
};
