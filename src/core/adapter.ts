import type { ContainerAdapter } from './types';
import { plainAdapter } from './pkg-plain';
import { texAdapter } from './tex-adapter';

/**
 * 明文 PKG 容器、单独的 TEX 贴图各一个适配器（magic 不重叠）。
 * 第二期加密格式（Workshop "PKG " v1/v2, AES-CTR + zlib）也在此注册：adapters.push(encryptedAdapter) 即可，
 * 其余流程无需改动。
 */
export const adapters: ContainerAdapter[] = [plainAdapter, texAdapter];

export function detectAdapter(bytes: Uint8Array): ContainerAdapter | null {
  for (const a of adapters) {
    try {
      if (a.detect(bytes)) return a;
    } catch {
      /* 单个适配器探测失败不影响其他 */
    }
  }
  return null;
}
