import './style.css';
import type { DecodeOptions, ItemKind, WallpaperMeta } from '../core/types';

interface ItemSummary {
  id: number; name: string; sourcePath: string; kind: ItemKind;
  mime: string; bytes: number; warning?: string;
}
type OutMsg =
  | { type: 'parsed'; magic: string; items: ItemSummary[]; meta?: WallpaperMeta }
  | { type: 'error'; message: string }
  | { type: 'blob'; id: number; bytes: Uint8Array; name: string; mime: string };

const worker = new Worker(new URL('../workers/extract.worker.ts', import.meta.url), { type: 'module' });

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dropzone = $<HTMLElement>('#dropzone');
const fileInput = $<HTMLInputElement>('#file-input');
const status = $<HTMLElement>('#status');
const metaCard = $<HTMLElement>('#meta-card');
const optionsBar = $<HTMLElement>('#options');
const result = $<HTMLElement>('#result');
const grid = $<HTMLElement>('#grid');
const modal = $<HTMLElement>('#modal');
const modalContent = $<HTMLElement>('#modal-content');

let currentItems: ItemSummary[] = [];
const blobCache = new Map<number, Blob>();
const pending = new Map<number, (b: Blob) => void>();

worker.onmessage = (ev: MessageEvent<OutMsg>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    setStatus(msg.message, 'err');
    return;
  }
  if (msg.type === 'parsed') {
    blobCache.clear();
    currentItems = msg.items;
    setStatus(`解析成功：${msg.items.length} 个条目（${msg.magic}）`, 'ok');
    optionsBar.hidden = false;
    result.hidden = false;
    renderMeta(msg.meta, msg.items);
    renderGrid();
    loadVisiblePreviews();
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
  if (!meta) {
    metaCard.hidden = false;
    metaCard.innerHTML = `<div class="row">条目 ${items.length} · 图片 ${counts.image ?? 0} · 视频 ${counts.video ?? 0} · 其他 ${counts.binary ?? 0} · 合计 ${fmtSize(total)}</div>`;
    return;
  }
  metaCard.hidden = false;
  metaCard.innerHTML = `
    <h2>${esc(meta.title)}</h2>
    <div class="row">类型：${esc(meta.type ?? '未知')} · 条目 ${items.length} · 合计 ${fmtSize(total)}</div>
    ${meta.tags.length ? `<div class="tags">${meta.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    ${meta.videoFile ? `<div class="row">视频：${esc(meta.videoFile)}</div>` : ''}`;
}

// —— 列表与预览 ——
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function filteredItems(): ItemSummary[] {
  const filter = ($<HTMLSelectElement>('#opt-filter')).value;
  if (filter === 'all') return currentItems;
  return currentItems.filter((i) => i.kind === filter);
}

function renderGrid() {
  grid.innerHTML = '';
  const items = filteredItems();
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = String(item.id);
    const icon = item.kind === 'video' ? '🎬' : item.kind === 'image' ? '🖼' : item.kind === 'json' ? '{ }' : '📄';
    card.innerHTML = `
      <div class="thumb" data-thumb="${item.id}">${item.kind === 'binary' || item.kind === 'json' ? `<span style="font-size:16px">${icon}</span>` : icon}</div>
      <div class="info">
        <div class="name" title="${esc(item.sourcePath)}">${esc(item.name)}</div>
        <div class="meta"><span>${item.kind}</span><span>${fmtSize(item.bytes)}</span></div>
        ${item.warning ? `<div class="warn">${esc(item.warning)}</div>` : ''}
        <div class="actions">
          <button class="btn" data-download="${item.id}">下载</button>
          ${item.kind === 'image' || item.kind === 'video' ? `<button class="btn" data-open="${item.id}">查看</button>` : ''}
        </div>
      </div>`;
    grid.appendChild(card);
  }
}

grid.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const dl = t.dataset?.download;
  const open = t.dataset?.open;
  const thumb = t.dataset?.thumb;
  if (dl) void downloadItem(Number(dl));
  else if (open) void openItem(Number(open));
  else if (thumb) void openItem(Number(thumb));
});

async function loadVisiblePreviews() {
  const previewable = filteredItems().filter((i) => i.kind === 'image' || i.kind === 'video').slice(0, 48);
  for (const item of previewable) {
    const blob = await requestBlob(item.id);
    const slot = grid.querySelector<HTMLElement>(`[data-thumb="${item.id}"]`);
    if (!slot || !slot.isConnected) return;
    slot.innerHTML = '';
    const url = URL.createObjectURL(blob);
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
      slot.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.preload = 'metadata';
      slot.appendChild(video);
    }
  }
}

async function openItem(id: number) {
  const item = currentItems.find((i) => i.id === id);
  if (!item) return;
  const blob = await requestBlob(id);
  const url = URL.createObjectURL(blob);
  modalContent.innerHTML = '';
  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    modalContent.appendChild(img);
  } else if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    modalContent.appendChild(video);
  } else {
    const text = await blob.text();
    const pre = document.createElement('pre');
    pre.style.cssText = 'max-width:80vw;max-height:80vh;overflow:auto;font-size:12px';
    pre.textContent = text.slice(0, 200_000);
    modalContent.appendChild(pre);
  }
  modal.hidden = false;
}

$<HTMLElement>('#modal-close').addEventListener('click', () => {
  modal.hidden = true;
  modalContent.innerHTML = '';
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    modal.hidden = true;
    modalContent.innerHTML = '';
  }
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

$<HTMLElement>('#btn-zip').addEventListener('click', async () => {
  const { zip } = await import('fflate');
  const items = filteredItems();
  if (!items.length) return;
  const keepPath = ($<HTMLInputElement>('#opt-keep-path')).checked;
  setStatus(`正在打包 ${items.length} 个文件…`);
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    const blob = await requestBlob(item.id);
    files[keepPath ? item.name : item.name.split('/').pop()!] = new Uint8Array(await blob.arrayBuffer());
  }
  zip(files, { level: 0 }, (err, data) => {
    if (err) {
      setStatus(`ZIP 失败: ${err.message}`, 'err');
      return;
    }
    saveBlob(new Blob([data as unknown as BlobPart], { type: 'application/zip' }), 'wallpaper-extract.zip');
    setStatus(`ZIP 完成（${fmtSize(data.length)}）`, 'ok');
  });
});

// —— 选项变化 ——
for (const id of ['#opt-tex']) {
  $<HTMLElement>(id).addEventListener('change', () => {
    if (!currentItems.length) return;
    setStatus('正在按新选项重新解析…');
    worker.postMessage({ type: 'reparse', options: currentOptions() });
  });
}
$<HTMLElement>('#opt-filter').addEventListener('change', () => renderGrid());
