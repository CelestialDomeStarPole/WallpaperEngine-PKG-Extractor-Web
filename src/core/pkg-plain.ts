import { BinReader } from './binary';
import type { ContainerAdapter, PkgFile } from './types';

const MAGIC_RE = /^PKGV\d{4}$/;
const MAX_ENTRIES = 100_000;

export function detectPlain(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicLen = view.getInt32(0, true);
  if (magicLen < 4 || magicLen > 32 || 4 + magicLen > bytes.length) return false;
  const magic = new TextDecoder().decode(bytes.subarray(4, 4 + magicLen));
  return MAGIC_RE.test(magic);
}

export function parsePlain(buffer: ArrayBuffer): PkgFile {
  const bytes = new Uint8Array(buffer);
  const r = new BinReader(bytes);
  const magic = r.lengthString(32, 'magic');
  if (!MAGIC_RE.test(magic)) {
    throw new Error(`非法 magic: ${JSON.stringify(magic)}`);
  }
  const entryCount = r.i32('entryCount');
  if (entryCount < 0 || entryCount > MAX_ENTRIES) {
    throw new Error(`条目数量异常: ${entryCount}`);
  }
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const name = r.lengthString(255, `entry[${i}].name`);
    const offset = r.i32(`entry[${i}].offset`);
    const length = r.i32(`entry[${i}].length`);
    if (offset < 0 || length < 0) {
      throw new Error(`entry[${i}] (${name}) 偏移/长度为负数`);
    }
    entries.push({ name, offset, length });
  }
  const dataStart = r.offset;
  for (const e of entries) {
    if (dataStart + e.offset + e.length > bytes.length) {
      throw new Error(`entry "${e.name}" 数据区越界: ${e.offset}+${e.length} > ${bytes.length - dataStart}`);
    }
  }
  return { magic, dataStart, bytes, entries };
}

export const plainAdapter: ContainerAdapter = {
  id: 'plain',
  label: '明文 PKGV',
  detect: detectPlain,
  parse: parsePlain,
};
