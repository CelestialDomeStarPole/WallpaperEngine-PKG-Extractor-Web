const MB = 1024 * 1024;

/** 所有可调上限集中在这里，别处不许再散着写魔数 */
export const LIMITS = {
  // —— 容器（PKGV 目录表）——
  maxEntries: 100_000,
  maxNameLen: 255,
  /** 探测格式用的读头字节数，只需覆盖 magic */
  detectProbe: 64,
  /** 目录表逐级加宽的探测步长 */
  tocProbeSteps: [64 * 1024, 1 * MB, 4 * MB, 32 * MB],
  tocProbeMax: 32 * MB,
  /** 目录表偏移/长度是 int32，超过这个数容器本身就无法表达 */
  pkgFormatCeiling: 0x7fff_ffff,
  /** 只提示不拒绝 */
  softSizeWarn: 1536 * MB,
  /** 单次底层读取的分片大小，杜绝一口气读几个 GB */
  maxReadPerCall: 64 * MB,
  metaJsonMaxRead: 512 * 1024,

  // —— TEX ——
  maxMipmapBytes: 250 * MB,
  maxImages: 100,
  maxMipmaps: 32,
  maxFrames: 100_000,
  texProbeSteps: [32 * 1024, 256 * 1024, 2 * MB, 8 * MB],
  texProbeMax: 8 * MB,

  // —— 动画重编码 ——
  /** 合成画布 W*H*4 的上限 */
  maxSurfaceBytes: 512 * MB,
  /** 单个重编码输出（APNG/GIF）的上限，超了回退单帧 PNG */
  maxAnimationBytes: 200 * MB,
  /** frametime 缺失或非法时的兜底帧时长（秒）：25fps */
  defaultFrameSeconds: 0.04,
  /** 小于这个值的 frametime 当坏数据处理（60fps 也有 16ms） */
  minFrameSeconds: 0.005,
  apngDelayDen: 1000,
  /** GIF 延时单位是 1/100 秒，小于 2cs 的各家播放器都会加速，钳到 2 */
  gifMinCs: 2,
  /** 调色板分桶精度：每通道 5 bit → 32768 桶 */
  gifPaletteBits: 5,
  gifDitherSpread: 24,
  /** 估算重编码体积时的转码系数（按 TexFormat） */
  transcodeFactor: { 0: 0.25, 4: 0.45, 6: 0.45, 7: 0.3, 8: 0.2, 9: 0.12 } as Record<number, number>,

  // —— ZIP ——
  zipChunk: 4 * MB,
  /** fflate 不写 ZIP64，归档总量必须留在 4GiB 以内 */
  zipTotalCeiling: 3.8 * 1024 * MB,
} as const;
