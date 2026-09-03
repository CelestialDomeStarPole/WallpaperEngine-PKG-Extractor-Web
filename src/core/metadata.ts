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
  const meta: WallpaperMeta = {
    title: typeof obj?.title === 'string' && obj.title ? obj.title : fallbackTitle,
    type: typeof obj?.type === 'string' ? obj.type : undefined,
    tags: Array.isArray(obj?.tags) ? obj.tags.filter((t: unknown) => typeof t === 'string') : [],
    previewFiles: [props?.previewimage, props?.preview_id].filter(
      (v: unknown): v is string => typeof v === 'string' && v.length > 0,
    ),
    videoFile: typeof props?.video === 'string' ? props.video : undefined,
    propertiesFile: typeof props?.file === 'string' ? props.file : undefined,
  };
  return meta;
}
