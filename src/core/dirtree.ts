/**
 * 包内目录树：按 sourcePath 归位，同名目录自动合并。
 * 只认 '/' 分隔（容器层已把 '\\' 规整过），不做文件系统语义推断。
 */

export interface DirNode<T> {
  /** 从根算起的完整路径，根为 '' */
  path: string;
  /** 目录名 → 子节点 */
  dirs: Map<string, DirNode<T>>;
  /** 直接位于本目录下的条目 */
  items: T[];
}

export function buildDirTree<T extends { sourcePath: string }>(items: T[]): DirNode<T> {
  const root: DirNode<T> = { path: '', dirs: new Map(), items: [] };
  for (const item of items) {
    const segs = item.sourcePath.split('/').filter((s) => s.length > 0 && s !== '.');
    let node = root;
    // 最后一段是文件名，不建目录
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      let next = node.dirs.get(seg);
      if (!next) {
        next = { path: node.path ? `${node.path}/${seg}` : seg, dirs: new Map(), items: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.items.push(item);
  }
  return root;
}

/** 逐段下钻；任一段不存在就返回 null（陈旧视图据此退回空态） */
export function dirAt<T>(root: DirNode<T>, path: string): DirNode<T> | null {
  let node = root;
  if (!path) return node;
  for (const seg of path.split('/')) {
    const next = node.dirs.get(seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

/** 递归统计：文件数含所有子目录 */
export function dirStats<T>(node: DirNode<T>, bytesOf: (item: T) => number): { count: number; bytes: number } {
  let count = node.items.length;
  let bytes = 0;
  for (const item of node.items) bytes += bytesOf(item);
  for (const child of node.dirs.values()) {
    const sub = dirStats(child, bytesOf);
    count += sub.count;
    bytes += sub.bytes;
  }
  return { count, bytes };
}

/** 上一级目录；已在根则原样返回 '' */
export function parentDir(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}
