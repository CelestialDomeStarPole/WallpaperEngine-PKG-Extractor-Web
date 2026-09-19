const MAP_EDGE_CAP = 256;
const QUANTUM = 8;
const MAX_REFRACT_LAYERS = 24;
const LRU_MAX = 40;
/** 位移图里的偏移是相对量，实际幅度由 feDisplacementMap 的 scale（px）决定 */
const DISPLACE_SCALE_PX = 18;

export interface GlassController {
  supported: boolean;
  observe(root: ParentNode): void;
  release(root: ParentNode): void;
  setEnabled(on: boolean): void;
  refresh(): void;
  activeCount(): number;
}

export function detectRefract(defs: SVGDefsElement): boolean {
  if (!CSS.supports?.('backdrop-filter', 'blur(2px) url(#x)')) return false;
  // 必须引用真实存在的 filter：url() 解析不到目标时整条 backdrop-filter 会被丢弃
  const probeId = 'lg-probe';
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.setAttribute('id', probeId);
  filter.innerHTML = '<feColorMatrix type="saturate" values="1"/>';
  defs.append(filter);
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;left:-9999px;top:0;width:8px;height:8px;backdrop-filter:blur(2px) url(#${probeId})`;
  document.body.append(probe);
  const kept = (getComputedStyle(probe).backdropFilter || '').includes('url(');
  probe.remove();
  filter.remove();
  return kept;
}

function quantize(v: number): number {
  return Math.max(QUANTUM, Math.round(v / QUANTUM) * QUANTUM);
}

function edgeBand(w: number, h: number): number {
  return Math.min(Math.max(Math.min(w, h) * 0.16, 6), 24);
}

/**
 * 圆角矩形边缘透镜：SDF 给出到边框的距离与外法线，边缘带内位移最强、向内衰减。
 * 通道编码 R=dx、G=dy，128 为零点（feDisplacementMap 的约定）。
 */
function bakeDisplacementMap(w: number, h: number, radius: number): string {
  const cw = Math.min(Math.max(Math.round(w), 4), MAP_EDGE_CAP);
  const ch = Math.min(Math.max(Math.round(h), 4), MAP_EDGE_CAP);
  const r = Math.min(radius, w / 2, h / 2);
  const band = edgeBand(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const image = ctx.createImageData(cw, ch);
  const data = image.data;
  const sx = w / cw;
  const sy = h / ch;
  const halfW = w / 2;
  const halfH = h / 2;
  const flatW = Math.max(halfW - r, 0);
  const flatH = Math.max(halfH - r, 0);
  const sdf = (x: number, y: number) => {
    const qx = Math.abs(x - halfW) - flatW;
    const qy = Math.abs(y - halfH) - flatH;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const eps = 0.7;
  for (let py = 0; py < ch; py++) {
    const y = (py + 0.5) * sy;
    for (let px = 0; px < cw; px++) {
      const x = (px + 0.5) * sx;
      const d = sdf(x, y);
      const t = Math.min(Math.max(-d / band, 0), 1);
      const strength = (1 - t * t * (3 - 2 * t)) * (d <= 0 ? 1 : 0);
      const gx = (sdf(x + eps, y) - sdf(x - eps, y)) / (2 * eps);
      const gy = (sdf(x, y + eps) - sdf(x, y - eps)) / (2 * eps);
      const len = Math.hypot(gx, gy) || 1;
      const dx = (gx / len) * strength;
      const dy = (gy / len) * strength;
      const i = (py * cw + px) * 4;
      data[i] = 128 + Math.round(dx * 127);
      data[i + 1] = 128 + Math.round(dy * 127);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function createFilter(defs: SVGDefsElement, w: number, h: number, radius: number): string {
  const id = `lg-${quantize(w)}x${quantize(h)}x${Math.round(radius)}`;
  const bw = quantize(w);
  const bh = quantize(h);
  const band = edgeBand(bw, bh);
  // backdrop-filter 的滤镜区域不会自适应元素尺寸，必须显式给出 px 区域
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  filter.setAttribute('x', String(-band));
  filter.setAttribute('y', String(-band));
  filter.setAttribute('width', String(bw + band * 2));
  filter.setAttribute('height', String(bh + band * 2));
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const href = bakeDisplacementMap(bw, bh, radius);
  const feImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
  feImage.setAttribute('href', href);
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('width', String(bw));
  feImage.setAttribute('height', String(bh));
  feImage.setAttribute('preserveAspectRatio', 'none');
  feImage.setAttribute('result', 'map');
  const disp = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
  disp.setAttribute('in', 'SourceGraphic');
  disp.setAttribute('in2', 'map');
  disp.setAttribute('scale', String(DISPLACE_SCALE_PX));
  disp.setAttribute('xChannelSelector', 'R');
  disp.setAttribute('yChannelSelector', 'G');
  disp.setAttribute('result', 'warped');
  const sat = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
  sat.setAttribute('in', 'warped');
  sat.setAttribute('type', 'saturate');
  sat.setAttribute('values', '1.42');
  filter.append(feImage, disp, sat);
  defs.append(filter);
  return id;
}

function readRadius(el: HTMLElement): number {
  const raw = getComputedStyle(el).borderTopLeftRadius || '0px';
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function overlapRatio(r: DOMRect): number {
  if (r.width <= 0 || r.height <= 0) return 0;
  const iw = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
  const ih = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  if (iw <= 0 || ih <= 0) return 0;
  return (iw * ih) / (r.width * r.height);
}

export function createGlassController(defs: SVGDefsElement): GlassController {
  const supported = detectRefract(defs);
  const wanted = new Set<HTMLElement>();
  const filterIds = new Map<string, string>();
  /** 元素当前挂着的尺寸键：滤镜区域是固定 px，尺寸一变就必须换，否则会露出没被滤镜覆盖的一条 */
  const appliedKey = new Map<HTMLElement, string>();
  const order: string[] = [];
  let enabled = supported;
  let resizeTimer: number | undefined;

  /** 淘汰旧滤镜：连同还指着它的元素一起忘掉，下一趟 reconcile 会重新分配 */
  const evict = (key: string) => {
    const id = filterIds.get(key);
    if (!id) return;
    filterIds.delete(key);
    defs.querySelector(`#${id}`)?.remove();
    for (const [el, k] of appliedKey) if (k === key) appliedKey.delete(el);
  };

  const filterFor = (el: HTMLElement, rect: DOMRect): { id: string; key: string } | null => {
    if (rect.width < 24 || rect.height < 24) return null;
    const radius = readRadius(el);
    const key = `${quantize(rect.width)}x${quantize(rect.height)}x${Math.round(radius)}`;
    let id = filterIds.get(key);
    if (!id) {
      id = createFilter(defs, rect.width, rect.height, radius);
      filterIds.set(key, id);
      order.push(key);
      while (order.length > LRU_MAX) {
        const dead = order.shift();
        if (dead) evict(dead);
      }
    }
    return { id, key };
  };

  const apply = (el: HTMLElement, on: boolean, rect?: DOMRect) => {
    if (!on) {
      el.style.removeProperty('--lg-refract');
      appliedKey.delete(el);
      return;
    }
    const hit = filterFor(el, rect ?? el.getBoundingClientRect());
    if (!hit) {
      // 收成 0 尺寸或太小：撤掉引用，别让它继续指着一个不匹配的滤镜
      el.style.removeProperty('--lg-refract');
      appliedKey.delete(el);
      return;
    }
    if (appliedKey.get(el) === hit.key) return;
    el.style.setProperty('--lg-refract', `url(#${hit.id})`);
    appliedKey.set(el, hit.key);
  };

  const reconcile = () => {
    // 关闭时不清除任何状态：重新开启无需等一次滚动才恢复
    if (!enabled) {
      for (const el of wanted) apply(el, false);
      return;
    }
    // 就地按视口求交集，而不是依赖 IntersectionObserver 的回调数据：
    // 后者的初始回调要等帧调度，页面不可见时整批不来，折射就会永久缺席
    const rects = new Map<HTMLElement, DOMRect>();
    const ranked = [...wanted]
      .map((el) => {
        const r = el.getBoundingClientRect();
        rects.set(el, r);
        return { el, ratio: overlapRatio(r) };
      })
      .filter((x) => x.ratio > 0.02)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, MAX_REFRACT_LAYERS);
    const allowed = new Set(ranked.map((x) => x.el));
    for (const el of wanted) apply(el, allowed.has(el), rects.get(el));
  };

  const io = new IntersectionObserver(() => reconcile(), { threshold: [0, 0.03, 0.25, 0.6] });
  window.addEventListener('scroll', () => requestAnimationFrame(reconcile), { passive: true });
  // 内容变化（纹理层级那一行填进来、缩略图撑高卡片）都会改尺寸，
  // 而 backdrop-filter 的区域不会跟着长大：盯着尺寸，一变就换滤镜
  const ro = new ResizeObserver(() => reconcile());

  const collect = (root: ParentNode, on: boolean) => {
    const nodes: HTMLElement[] = root instanceof HTMLElement && root.matches('.glass') ? [root] : [];
    root.querySelectorAll?.('.glass').forEach((n) => nodes.push(n as HTMLElement));
    for (const el of nodes) {
      if (on) {
        if (wanted.has(el)) continue;
        wanted.add(el);
        io.observe(el);
        ro.observe(el);
      } else {
        wanted.delete(el);
        io.unobserve(el);
        ro.unobserve(el);
        apply(el, false);
      }
    }
  };

  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => controller.refresh(), 160);
  });

  const controller: GlassController = {
    supported,
    observe: (root) => { collect(root, true); reconcile(); requestAnimationFrame(reconcile); },
    release: (root) => collect(root, false),
    setEnabled: (on) => { enabled = on && supported; reconcile(); },
    refresh: () => {
      if (!enabled) return;
      for (const el of wanted) {
        el.style.removeProperty('--lg-refract');
        appliedKey.delete(el);
      }
      reconcile();
      requestAnimationFrame(reconcile);
    },
    activeCount: () => [...wanted].filter((el) => el.style.getPropertyValue('--lg-refract')).length,
  };
  return controller;
}
