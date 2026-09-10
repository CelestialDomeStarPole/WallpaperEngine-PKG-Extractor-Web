import type { WallpaperMeta } from './types';

/** 从 project.json（壁纸根配置）提取元数据；scene.json 兜底 */
export function parseProjectMeta(json: string, fallbackTitle: string): WallpaperMeta {
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    return { title: fallbackTitle, tags: [], previewFiles: [] };
  }
  const props = obj?.properties ?? obj?.general ?? {};
  const type = typeof obj?.type === 'string' ? obj.type : undefined;
  // 安卓 .mpkg 是扁平 schema，视频文件名写在顶层 file 上，不在 properties 里
  const videoFile = [props?.video, type === 'video' ? obj?.file : undefined].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  const meta: WallpaperMeta = {
    title: typeof obj?.title === 'string' && obj.title ? obj.title : fallbackTitle,
    type,
    tags: Array.isArray(obj?.tags) ? obj.tags.filter((t: unknown) => typeof t === 'string') : [],
    previewFiles: [props?.previewimage, props?.preview_id].filter(
      (v: unknown): v is string => typeof v === 'string' && v.length > 0,
    ),
    videoFile,
    propertiesFile: typeof props?.file === 'string' ? props.file : undefined,
  };
  return meta;
}
