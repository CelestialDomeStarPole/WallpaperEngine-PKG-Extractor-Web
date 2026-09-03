import type { GlassController } from './glass';
import { createBackground, type BackgroundState } from './scrim';
import { wallpapers, randomWallpaper, type Wallpaper } from './wallpapers';

const LS_KEY = 'we.ui.v1';
const SS_KEY = 'we.ui.wallpaper.v1';

interface UiState {
  blur: number;
  scrim: number;
  scrimMode: 'auto' | 'manual';
  refract: boolean;
  motion: boolean;
  customUrl: string;
}

const DEFAULTS: UiState = { blur: 24, scrim: 0.46, scrimMode: 'auto', refract: true, motion: true, customUrl: '' };

function loadState(): UiState {
  const base = { ...DEFAULTS };
  let stored = false;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      Object.assign(base, JSON.parse(raw) as Partial<UiState>);
      stored = true;
    }
  } catch {
    /* 存不动就用默认值 */
  }
  if (!stored && window.matchMedia('(prefers-reduced-motion: reduce)').matches) base.motion = false;
  return base;
}

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export interface DockHandle {
  /** 选初始壁纸并应用：本次会话内手动选过就沿用，否则每次随机 */
  start(): void;
}

export function initDock(root: HTMLElement, glass: GlassController): DockHandle {
  const state = loadState();
  const img = $<HTMLImageElement>('bg-img');
  const bg: BackgroundState = createBackground(img);
  const list = $<HTMLElement>('bg-list');
  const customInput = $<HTMLInputElement>('set-custom');
  const scrimInput = $<HTMLInputElement>('set-scrim');
  const scrimAuto = $<HTMLButtonElement>('set-scrim-auto');
  const blurInput = $<HTMLInputElement>('set-blur');
  const refractInput = $<HTMLInputElement>('set-refract');
  const motionInput = $<HTMLInputElement>('set-motion');
  const note = $<HTMLElement>('dock-note');
  const dock = $<HTMLElement>('dock');
  const dockToggle = $<HTMLButtonElement>('dock-toggle');
  const dockBody = $<HTMLElement>('dock-body');

  const save = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      /* 隐私模式下忽略 */
    }
  };

  const options = (): Wallpaper[] =>
    state.customUrl ? [...wallpapers, { url: state.customUrl, title: '自定义' }] : wallpapers;

  let current: Wallpaper | null = null;

  const markActive = () => {
    for (const btn of list.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.url === current?.url));
    }
  };

  const buildList = () => {
    list.innerHTML = '';
    for (const wp of options()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.url = wp.url;
      btn.title = wp.title;
      btn.setAttribute('aria-label', `壁纸：${wp.title}`);
      const thumb = document.createElement('img');
      thumb.src = wp.url;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.crossOrigin = 'anonymous';
      btn.append(thumb);
      btn.addEventListener('click', () => void pick(wp, true));
      list.append(btn);
    }
    markActive();
  };

  function applyMotion() {
    document.body.classList.toggle('motion-off', !state.motion);
    root.style.setProperty('--dur', state.motion ? '0.22s' : '0s');
  }

  async function pick(wp: Wallpaper | null, fromUser: boolean) {
    current = wp;
    markActive();
    const result = await bg.apply(wp);
    if (state.scrimMode === 'auto' && result.scrim !== null) {
      state.scrim = result.scrim;
      scrimInput.value = String(Math.round(result.scrim * 100));
      root.style.setProperty('--lg-scrim', result.scrim.toFixed(3));
    }
    if (fromUser && wp) {
      try {
        sessionStorage.setItem(SS_KEY, wp.url);
      } catch {
        /* 忽略 */
      }
    }
    if (wp && result.scrim === null) note.textContent = '壁纸未能加载或不允许取样，已保留当前遮罩强度。';
    else if (!note.textContent.startsWith('当前浏览器')) note.textContent = '';
  }

  function step(delta: number) {
    const all = options();
    const at = all.findIndex((w) => w.url === current?.url);
    const next = all[(at + delta + all.length * 2) % all.length] ?? all[0];
    void pick(next, true);
  }

  scrimInput.value = String(Math.round(state.scrim * 100));
  root.style.setProperty('--lg-scrim', state.scrim.toFixed(3));
  root.style.setProperty('--lg-blur', `${state.blur}px`);
  blurInput.value = String(state.blur);
  refractInput.checked = state.refract && glass.supported;
  motionInput.checked = state.motion;
  customInput.value = state.customUrl;
  applyMotion();

  scrimInput.addEventListener('input', () => {
    state.scrimMode = 'manual';
    state.scrim = Number(scrimInput.value) / 100;
    root.style.setProperty('--lg-scrim', state.scrim.toFixed(3));
    scrimAuto.disabled = false;
    save();
  });
  scrimAuto.disabled = state.scrimMode === 'auto';
  scrimAuto.addEventListener('click', () => {
    state.scrimMode = 'auto';
    scrimAuto.disabled = true;
    void pick(current, false);
    save();
  });

  blurInput.addEventListener('input', () => {
    state.blur = Number(blurInput.value);
    root.style.setProperty('--lg-blur', `${state.blur}px`);
    save();
  });
  blurInput.addEventListener('change', () => glass.refresh());

  refractInput.addEventListener('change', () => {
    state.refract = refractInput.checked;
    glass.setEnabled(state.refract);
    save();
  });

  motionInput.addEventListener('change', () => {
    state.motion = motionInput.checked;
    applyMotion();
    save();
  });

  const commitCustom = () => {
    const value = customInput.value.trim();
    if (!value) {
      if (state.customUrl) {
        state.customUrl = '';
        save();
        buildList();
        void pick(randomWallpaper(), false);
      }
      return;
    }
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || !/^https?:$/.test(url.protocol)) {
      note.textContent = '自定义地址需要是完整的 http(s) 图片链接。';
      return;
    }
    state.customUrl = value;
    save();
    buildList();
    void pick({ url: value, title: '自定义' }, true);
  };
  customInput.addEventListener('change', commitCustom);
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitCustom();
  });

  $('bg-prev').addEventListener('click', () => step(-1));
  $('bg-next').addEventListener('click', () => step(1));

  dockBody.hidden = true;
  dockToggle.addEventListener('click', () => {
    const open = dockBody.hidden;
    dockBody.hidden = !open;
    dockToggle.setAttribute('aria-expanded', String(open));
    dock.classList.toggle('open', open);
    if (open) glass.refresh();
  });

  buildList();
  glass.setEnabled(refractInput.checked);
  if (!glass.supported) {
    refractInput.disabled = true;
    note.textContent = '当前浏览器不支持边缘折射（Chromium 专属），已使用纯 CSS 玻璃。';
  }

  return {
    start() {
      let picked: string | null = null;
      try {
        picked = sessionStorage.getItem(SS_KEY);
      } catch {
        picked = null;
      }
      const all = options();
      const wp = (picked && all.find((w) => w.url === picked)) || randomWallpaper();
      void pick(wp, false);
    },
  };
}
