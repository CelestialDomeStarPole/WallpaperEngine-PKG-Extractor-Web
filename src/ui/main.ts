import './style.css';
import type { DecodeOptions, ItemKind, WallpaperMeta } from '../core/types';
import { createGlassController } from './glass';
import { initDock } from './dock';
import { createProgress } from './progress';

interface ItemSummary {
  id: number; name: string; sourcePath: string; kind: ItemKind;
  mime: string; bytes: number; warning?: string;
}
type OutMsg =
  | { type: 'parsed'; magic: string; items: ItemSummary[]; meta?: WallpaperMeta }
  | { type: 'error'; message: string }
  | { type: 'blob'; id: number; bytes: Uint8Array; name: string; mime: string };

interface Group { kind: ItemKind; label: string; items: ItemSummary[]; bytes: number }

type View = { name: 'folders' } | { name: 'folder'; kind: ItemKind; page: number };

const PAGE_SIZE = 15;
const GROUP_ORDER: { kind: ItemKind; label: string }[] = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'json', label: 'JSON' },
  { kind: 'binary', label: '其他' },
];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dropzone = $<HTMLElement>('#dropzone');
const fileInput = $<HTMLInputElement>('#file-input');
const status = $<HTMLElement>('#status');
const metaCard = $<HTMLElement>('#meta-card');
const optionsBar = $<HTMLElement>('#options');
const result = $<HTMLElement>('#result');
const grid = $<HTMLElement>('#grid');
const crumbs = $<HTMLElement>('#crumbs');
const pager = $<HTMLElement>('#pager');
const modal = $<HTMLElement>('#modal');
const modalContent = $<HTMLElement>('#modal-content');
const zipScope = $<HTMLSelectElement>('#opt-zip-scope');

const defs = document.querySelector<SVGDefsElement>('#lg-defs defs')!;
const glass = createGlassController(defs);
const progress = createProgress($<HTMLElement>('#progress'), $<HTMLElement>('#progress-bar'), $<HTMLElement>('#progress-text'));
const dock = initDock(document.documentElement, glass);

const worker = new Worker(new URL('../workers/extract.worker.ts', import.meta.url), { type: 'module' });

let currentItems: ItemSummary[] = [];
let view: View = { name: 'folders' };
let renderToken = 0;
const blobCache = new Map<number, Blob>();
const objectUrls = new Map<number, string>();
const pending = new Map<number, (b: Blob) => void>();

worker.onmessage = (ev: MessageEvent<OutMsg>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    progress.hide();
    setStatus(msg.message, 'err');
    return;
  }
  if (msg.type === 'parsed') {
    releaseObjectUrls();
    blobCache.clear();
    currentItems = msg.items;
    view = { name: 'folders' };
    setStatus(`解析成功：${msg.items.length} 个条目（${msg.magic}）`, 'ok');
    optionsBar.hidden = false;
    result.hidden = false;
    progress.finish(`解析完成 · ${msg.items.length} 个条目`);
    renderMeta(msg.meta, msg.items);
    fillZipScope();
    render();
    return;
  }
  if (msg.type === 'blob') {
    const blob = new Blob([msg.bytes as unknown as BlobPart], { type: msg.mime });
    blobCache.set(msg.id, blob);
    pending.get(msg.id)?.(blob);
    pending.delete(msg.id);
  }
};

function setStatus(text: string, cls?: 'err' | 'ok') {
  status.textContent = text;
  status.className = `status${cls ? ' ' + cls : ''}`;
}

function currentOptions(): DecodeOptions {
  return { texToImage: ($<HTMLInputElement>('#opt-tex')).checked };
}

function requestBlob(id: number): Promise<Blob> {
  const cached = blobCache.get(id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ type: 'blob', id });
  });
}

async function previewUrl(id: number): Promise<string> {
  const known = objectUrls.get(id);
  if (known) return known;
  const blob = await requestBlob(id);
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

function releaseObjectUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

// —— 拖拽 / 选择 ——
function handleFile(file: File) {
  if (!/\.(pkg)$/i.test(file.name)) {
    setStatus('仅支持 .pkg 文件', 'err');
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    setStatus('文件超过 200MB，暂不支持在浏览器中处理', 'err');
    return;
  }
  setStatus(`正在解析 ${file.name}（${fmtSize(file.size)}）…`);
  progress.start('正在解析…');
  file.arrayBuffer().then((buf) => {
    worker.postMessage({ type: 'parse', buffer: buf, options: currentOptions() }, [buf]);
  });
}

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

// —— 元数据卡片 ——
function renderMeta(meta: WallpaperMeta | undefined, items: ItemSummary[]) {
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const total = items.reduce((a, i) => a + i.bytes, 0);
  metaCard.hidden = false;
  if (!meta) {
    metaCard.innerHTML = `<div class="row">条目 ${items.length} · 图片 ${counts.image ?? 0} · 视频 ${counts.video ?? 0} · 其他 ${counts.binary ?? 0} · 合计 ${fmtSize(total)}</div>`;
  } else {
    metaCard.innerHTML = `
      <h2>${esc(meta.title)}</h2>
      <div class="row">类型：${esc(meta.type ?? '未知')} · 条目 ${items.length} · 合计 ${fmtSize(total)}</div>
      ${meta.tags.length ? `<div class="tags">${meta.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${meta.videoFile ? `<div class="row">视频：${esc(meta.videoFile)}</div>` : ''}`;
  }
  glass.refresh();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function groups(): Group[] {
  const out: Group[] = [];
  for (const g of GROUP_ORDER) {
    const items = currentItems.filter((i) => i.kind === g.kind);
    if (items.length) out.push({ kind: g.kind, label: g.label, items, bytes: items.reduce((a, i) => a + i.bytes, 0) });
  }
  return out;
}

// —— 视图渲染 ——
function render() {
  glass.release(grid);
  if (view.name === 'folders') renderFolders();
  else renderFolderContents(view.kind, view.page);
  glass.observe(grid);
}

function renderFolders() {
  crumbs.hidden = true;
  pager.hidden = true;
  grid.className = 'grid grid--folders';
  grid.innerHTML = '';
  const list = groups();
  if (!list.length) {
    grid.innerHTML = '<p class="empty">这个包里没有可导出的条目。</p>';
    return;
  }
  for (const g of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'folder glass';
    card.dataset.group = g.kind;
    const first = g.items.find((i) => i.kind === 'image' || i.kind === 'video');
    card.innerHTML = `
      <span class="folder-thumb"${first ? ` data-slot="${first.id}"` : ''}>${first ? '' : groupIcon(g.kind)}</span>
      <span class="folder-body">
        <span>
          <span class="folder-name">${esc(g.label)}</span>
          <span class="folder-meta">${g.items.length} 个文件 · ${fmtSize(g.bytes)}</span>
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </span>`;
    grid.append(card);
  }
  void loadThumbs();
}

function groupIcon(kind: ItemKind): string {
  return kind === 'video' ? '🎬' : kind === 'image' ? '🖼' : kind === 'json' ? '{ }' : '📄';
}

function renderFolderContents(kind: ItemKind, page: number) {
  const group = groups().find((g) => g.kind === kind);
  grid.className = 'grid';
  if (!group) {
    grid.innerHTML = '<p class="empty">该文件夹为空。</p>';
    crumbs.hidden = true;
    pager.hidden = true;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(group.items.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  view = { name: 'folder', kind, page: safePage };

  renderCrumbs(group);
  grid.innerHTML = '';
  for (const item of group.items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)) {
    const card = document.createElement('div');
    card.className = 'card glass';
    card.dataset.id = String(item.id);
    card.innerHTML = `
      <div class="thumb" data-thumb="${item.id}">${item.kind === 'image' || item.kind === 'video' ? '' : `<span style="font-size:16px">${groupIcon(item.kind)}</span>`}</div>
      <div class="info">
        <div class="name" title="${esc(item.sourcePath)}">${esc(item.name)}</div>
        <div class="meta"><span>${esc(item.kind)}</span><span>${fmtSize(item.bytes)}</span></div>
        ${item.warning ? `<div class="warn">${esc(item.warning)}</div>` : ''}
        <div class="actions">
          <button class="btn small" data-download="${item.id}">下载</button>
          ${item.kind === 'image' || item.kind === 'video' ? `<button class="btn small" data-open="${item.id}">查看</button>` : ''}
        </div>
      </div>`;
    grid.append(card);
  }
  renderPager(safePage, pageCount);
  void loadThumbs();
}

function renderCrumbs(group: Group) {
  crumbs.hidden = false;
  crumbs.innerHTML = `
    <button type="button" data-crumb="root">全部文件夹</button>
    <span class="sep" aria-hidden="true">›</span>
    <button type="button" data-crumb="${group.kind}" aria-current="page">${esc(group.label)}（${group.items.length}）</button>`;
  glass.observe(crumbs);
}

function renderPager(page: number, pageCount: number) {
  if (pageCount <= 1) {
    pager.hidden = true;
    pager.innerHTML = '';
    glass.release(pager);
    return;
  }
  pager.hidden = false;
  const parts: (number | 'gap')[] = [];
  if (pageCount <= 7) {
    for (let i = 0; i < pageCount; i++) parts.push(i);
  } else {
    const near = [page - 1, page, page + 1].filter((p) => p > 0 && p < pageCount - 1);
    const gaps: ('gap' | number)[] = near.length ? ['gap'] : [];
    parts.push(0, ...gaps, ...near, ...gaps, pageCount - 1);
  }
  let html = `<button type="button" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''} aria-label="上一页">‹</button>`;
  for (const p of parts) {
    html += p === 'gap'
      ? '<span class="gap" aria-hidden="true">…</span>'
      : `<button type="button" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p + 1}</button>`;
  }
  html += `<button type="button" data-page="${page + 1}" ${page === pageCount - 1 ? 'disabled' : ''} aria-label="下一页">›</button>`;
  pager.innerHTML = html;
  glass.observe(pager);
}

/** 只取当前可见的缩略图：卡片每页最多 PAGE_SIZE 个，文件夹页最多 4 个 */
async function loadThumbs() {
  const token = ++renderToken;
  const slots = [...grid.querySelectorAll<HTMLElement>('[data-slot]'), ...grid.querySelectorAll<HTMLElement>('[data-thumb]')]
    .filter((el) => el.dataset.slot || el.dataset.thumb);
  for (const slot of slots) {
    const id = Number(slot.dataset.slot ?? slot.dataset.thumb);
    if (!Number.isFinite(id)) continue;
    const url = await previewUrl(id);
    if (token !== renderToken || !slot.isConnected) continue;
    const item = currentItems.find((i) => i.id === id);
    slot.innerHTML = '';
    if (item?.kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.preload = 'metadata';
      slot.append(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item?.name ?? '';
      img.loading = 'lazy';
      slot.append(img);
    }
  }
}

grid.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const folder = t.closest<HTMLElement>('[data-group]');
  if (folder?.dataset.group) {
    view = { name: 'folder', kind: folder.dataset.group as ItemKind, page: 0 };
    render();
    return;
  }
  const dl = t.dataset?.download;
  const open = t.dataset?.open;
  const thumb = t.dataset?.thumb;
  if (dl) void downloadItem(Number(dl));
  else if (open) void openItem(Number(open));
  else if (thumb) void openItem(Number(thumb));
});

crumbs.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-crumb]');
  if (btn?.dataset.crumb === 'root') {
    view = { name: 'folders' };
    render();
  }
});

pager.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-page]');
  if (!btn || btn.disabled || view.name !== 'folder') return;
  view = { ...view, page: Number(btn.dataset.page) };
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' && e.key !== 'ArrowLeft') return;
  if (!modal.hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (e.key === 'Escape') {
    closeModal();
    return;
  }
  if (view.name === 'folder' && !isTyping(e.target)) {
    view = { name: 'folders' };
    render();
  }
});

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
}

async function openItem(id: number) {
  const item = currentItems.find((i) => i.id === id);
  if (!item) return;
  const url = await previewUrl(id);
  modalContent.innerHTML = '';
  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    modalContent.append(img);
  } else if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    modalContent.append(video);
  } else {
    const blob = await requestBlob(id);
    const text = await blob.text();
    const pre = document.createElement('pre');
    pre.textContent = text.slice(0, 200_000);
    modalContent.append(pre);
  }
  modal.hidden = false;
  glass.observe(modal);
}

function closeModal() {
  modal.hidden = true;
  modalContent.innerHTML = '';
  glass.release(modal);
}

$<HTMLButtonElement>('#modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

// —— 下载 ——
function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.split('/').pop() || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function downloadItem(id: number) {
  const item = currentItems.find((i) => i.id === id);
  if (!item) return;
  setStatus(`正在导出 ${item.name} …`);
  const blob = await requestBlob(id);
  saveBlob(blob, item.name);
  setStatus('导出完成', 'ok');
}

function fillZipScope() {
  zipScope.innerHTML = '';
  zipScope.append(new Option(`全部（${currentItems.length}）`, 'all'));
  for (const g of groups()) zipScope.append(new Option(`${g.label}（${g.items.length}）`, g.kind));
  zipScope.value = 'all';
}

function scopeItems(): ItemSummary[] {
  const scope = zipScope.value || 'all';
  if (scope === 'all') return currentItems;
  return currentItems.filter((i) => i.kind === scope);
}

/** 不用 rAF 让步：后台标签页里 rAF 不触发，打包会永久卡住 */
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

$<HTMLButtonElement>('#btn-zip').addEventListener('click', async () => {
  const items = scopeItems();
  if (!items.length) {
    setStatus('没有可打包的文件', 'err');
    return;
  }
  const keepPath = ($<HTMLInputElement>('#opt-keep-path')).checked;
  setStatus(`正在打包 ${items.length} 个文件…`);
  progress.start('正在解码…', items.length);
  const files: Record<string, Uint8Array> = {};
  let done = 0;
  for (const item of items) {
    const blob = await requestBlob(item.id);
    files[keepPath ? item.name : item.name.split('/').pop()!] = new Uint8Array(await blob.arrayBuffer());
    done += 1;
    progress.set(done);
    if (done % 5 === 0) await yieldToUI();
  }
  progress.start('正在写入 ZIP…');
  const { zip } = await import('fflate');
  zip(files, { level: 0 }, (err, data) => {
    if (err) {
      progress.hide();
      setStatus(`ZIP 失败: ${err.message}`, 'err');
      return;
    }
    saveBlob(new Blob([data as unknown as BlobPart], { type: 'application/zip' }), 'wallpaper-extract.zip');
    setStatus(`ZIP 完成（${fmtSize(data.length)}）`, 'ok');
    progress.finish(`ZIP 完成 · ${fmtSize(data.length)}`);
  });
});

// —— 选项变化 ——
$<HTMLElement>('#opt-tex').addEventListener('change', () => {
  if (!currentItems.length) return;
  setStatus('正在按新选项重新解析…');
  progress.start('正在重新解析…');
  worker.postMessage({ type: 'reparse', options: currentOptions() });
});

// —— 启动 ——
glass.observe(document.body);
dock.start();
