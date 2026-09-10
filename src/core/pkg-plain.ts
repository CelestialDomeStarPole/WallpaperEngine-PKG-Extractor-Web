import { BinReader } from './binary';
import { readHeader } from './bytesource';
import type { ByteSource } from './bytesource';
import type { ContainerAdapter, PkgEntry, PkgFile } from './types';
import { LIMITS } from './limits';

/** PKGV#### = 桌面 .pkg，PKGM#### = 安卓 .mpkg；两者目录表布局实测一致，共用一套解析 */
const MAGIC_RE = /^PKG[VM]\d{4}$/;
/** 目录表一条记录至少 = 4(名长) + 1(名) + 4(偏移) + 4(长度) */
const MIN_RECORD = 13;

export function detectPlain(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicLen = view.getInt32(0, true);
  if (magicLen < 4 || magicLen > 32 || 4 + magicLen > bytes.length) return false;
  const magic = new TextDecoder().decode(bytes.subarray(4, 4 + magicLen));
  return MAGIC_RE.test(magic);
}

/**
 * 只读目录表：探针不够时由 readHeader 逐级加宽重读，数据区一个字节都不碰。
 * 返回后探针 buffer 是函数局部变量，随即释放——整包不再驻留内存。
 */
export async function parsePlain(source: ByteSource): Promise<PkgFile> {
  if (source.size > LIMITS.pkgFormatCeiling) {
    throw new Error(
      `文件 ${source.size} 字节：PKGV 目录表的偏移与长度是 int32，这个格式存不下超过 ${LIMITS.pkgFormatCeiling} 字节的包`,
    );
  }
  return readHeader(source, 0, LIMITS.tocProbeSteps, LIMITS.tocProbeMax, 'PKGV 目录表', (bytes, streamEnd) => {
    const r = new BinReader(bytes, 0, bytes.length, streamEnd);
    const magic = r.lengthString(32, 'magic');
    if (!MAGIC_RE.test(magic)) {
      throw new Error(`非法 magic: ${JSON.stringify(magic)}`);
    }
    const entryCount = r.i32('entryCount');
    if (entryCount < 0 || entryCount > LIMITS.maxEntries) {
      throw new Error(`条目数量异常: ${entryCount}`);
    }
    // 先把「条目数明显虚高」的坏头挡掉，免得为它一路加宽到探测上限
    if (r.offset + entryCount * MIN_RECORD > streamEnd) {
      throw new Error(
        `条目数与文件长度不符：声明 ${entryCount} 条，目录表至少要 ${r.offset + entryCount * MIN_RECORD} 字节，文件只有 ${streamEnd}`,
      );
    }
    const entries: PkgEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      const name = r.lengthString(LIMITS.maxNameLen, `entry[${i}].name`);
      const offset = r.i32(`entry[${i}].offset`);
      const length = r.i32(`entry[${i}].length`);
      if (offset < 0 || length < 0) {
        throw new Error(`entry[${i}] (${name}) 偏移/长度为负数`);
      }
      entries.push({ name, offset, length });
    }
    const dataStart = r.offset;
    for (const e of entries) {
      if (dataStart + e.offset + e.length > streamEnd) {
        throw new Error(`entry "${e.name}" 数据区越界: ${e.offset}+${e.length} > ${streamEnd - dataStart}`);
      }
    }
    return {
      magic,
      dataStart,
      source,
      entries,
      entrySource: (e) => source.slice(dataStart + e.offset, e.length),
      entryBlob: (e) => source.blob(dataStart + e.offset, e.length),
    };
  });
}

export const plainAdapter: ContainerAdapter = {
  id: 'plain',
  label: '明文 PKG',
  detect: detectPlain,
  parse: parsePlain,
};
