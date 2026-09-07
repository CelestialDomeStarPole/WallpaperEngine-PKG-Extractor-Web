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
const zipBtn = $<HTMLButtonElement>('#btn-zip');
const selbar = $<HTMLElement>('#selbar');
const selSummary = $<HTMLElement>('#sel-summary');
const selHint = $<HTMLElement>('#sel-hint');
const selAll = $<HTMLButtonElement>('#btn-sel-all');
const selClear = $<HTMLButtonElement>('#btn-sel-clear');
const selZip = $<HTMLButtonElement>('#btn-sel-zip');
const selDl = $<HTMLButtonElement>('#btn-sel-dl');

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
const pending = new Map<number, { ok: (b: Blob) => void; no: (e: Error) => void }>();

/** 超过这个数量还逐个下载就是自找麻烦，提示改用打包 */
const BATCH_HINT = 20;
const selected = new Set<number>();
let byId = new Map<number, ItemSummary>();
/** 换包或重新解析后自增：批量循环据此判断条目身份已失效 */
let parseEpoch = 0;
let running = false;
let runLabel = '';

/** 让所有还在等 blob 的调用方以错误收尾，否则批量循环会永久卡住 */
function rejectPending(reason: string) {
  for (const { no } of pending.values()) no(new Error(reason));
  pending.clear();
}

worker.onmessage = (ev: MessageEvent<OutMsg>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    rejectPending('解析出错');
    progress.hide();
    runLabel = '';
    running = false;
    renderSelbar();
    setStatus(msg.message, 'err');
    return;
  }
  if (msg.type === 'parsed') {
    rejectPending('条目已重新编号');
    releaseObjectUrls();
    blobCache.clear();
    currentItems = msg.items;
    byId = new Map(msg.items.map((i) => [i.id, i]));
    // id 按产出条目重新分配，切换 .tex 转换还会改变条目总数，旧选中一律作废
    selected.clear();
    parseEpoch += 1;
    running = false;
    runLabel = '';
    view = { name: 'folders' };
    setStatus(`解析成功：${msg.items.length} 个条目（${msg.magic}）`, 'ok');
    optionsBar.hidden = false;
    result.hidden = false;
    progress.finish(`解析完成 · ${msg.items.length} 个条目`);
    renderMeta(msg.meta, msg.items);
    fillZipScope();
    render();
    renderSelbar();
    return;
  }
  if (msg.type === 'blob') {
    const blob = new Blob([msg.bytes as unknown as BlobPart], { type: msg.mime });
    blobCache.set(msg.id, blob);
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    waiter?.ok(blob);
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
  return new Promise((resolve, reject) => {
    pending.set(id, { ok: resolve, no: reject });
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

// —— 多选 ——
const selectedItems = () => currentItems.filter((i) => selected.has(i.id));

/** 「全选本类」的目标：文件夹视图内＝该类全部条目（跨页），上层＝全部 */
function scopeItemsToSelect(): ItemSummary[] {
  if (view.name !== 'folder') return currentItems;
  const kind = view.kind;
  return currentItems.filter((i) => i.kind === kind);
}

/** 只改可见卡片的 class 与勾选框，不重建 DOM：重建会重新拉一遍缩略图并触发折射重算 */
function paintSelection() {
  for (const card of grid.querySelectorAll<HTMLElement>('.card[data-id]')) {
    const on = selected.has(Number(card.dataset.id));
    card.classList.toggle('selected', on);
    const box = card.querySelector<HTMLInputElement>('.card-check');
    if (box) box.checked = on;
  }
}

function setSelection(id: number, on: boolean) {
  if (!byId.has(id) || selected.has(id) === on) return;
  if (on) selected.add(id);
  else selected.delete(id);
  paintSelection();
  renderSelbar();
}

function setMany(items: ItemSummary[], on: boolean) {
  for (const i of items) {
    if (on) selected.add(i.id);
    else selected.delete(i.id);
  }
  paintSelection();
  renderSelbar();
}

function renderSelbar() {
  const n = selected.size;
  selbar.hidden = n === 0 && !runLabel;
  if (runLabel) {
    selSummary.innerHTML = n
      ? `${selKindText(n)}<span class="sep">·</span><span class="sel-state">${esc(runLabel)}</span>`
      : `<span class="sel-state">${esc(runLabel)}</span>`;
  } else {
    selSummary.innerHTML = n ? selKindText(n) : '';
  }
  selHint.hidden = n <= BATCH_HINT;
  selHint.textContent = `已选 ${n} 个：逐个下载需要浏览器允许「下载多个文件」，每个文件还会完整解码进内存，建议改用打包下载。`;

  const scope = scopeItemsToSelect();
  const pendingCount = scope.filter((i) => !selected.has(i.id)).length;
  selAll.textContent = `${view.name === 'folder' ? '全选本类' : '全选全部'}（${scope.length}）`;
  selAll.disabled = running || !pendingCount;
  selClear.disabled = running || !n;
  selZip.disabled = running || !n;
  selDl.disabled = running || !n;
  zipBtn.disabled = running;
}

function selKindText(n: number): string {
  const counts = new Map<ItemKind, number>();
  for (const i of currentItems) {
    if (selected.has(i.id)) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  }
  const parts = [`已选<b>${n}</b>个`];
  for (const g of GROUP_ORDER) {
    const c = counts.get(g.kind);
    if (c) parts.push(`${g.label}<b>${c}</b>`);
  }
  return parts.join('<span class="sep" aria-hidden="true">·</span>');
}

function setRunState(text: string) {
  runLabel = text;
  renderSelbar();
}

/** 三个下载入口共用一把锁：并行跑会互相踩进度条，还会同时存两个文件 */
function beginRun(): boolean {
  if (running) {
    setStatus('已有下载任务在进行中，请稍候', 'err');
    return false;
  }
  running = true;
  renderSelbar();
  return true;
}

function endRun() {
  running = false;
  runLabel = '';
  renderSelbar();
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
  renderSelbar();
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
    const on = selected.has(item.id);
    const media = item.kind === 'image' || item.kind === 'video';
    const card = document.createElement('div');
    card.className = `card glass${on ? ' selected' : ''}`;
    card.dataset.id = String(item.id);
    card.innerHTML = `
      <input class="card-check" type="checkbox" ${on ? 'checked' : ''} aria-label="选中 ${esc(item.name)}" />
      <div class="thumb" data-slot="${item.id}">${media ? '' : `<span style="font-size:16px">${groupIcon(item.kind)}</span>`}</div>
      <div class="info">
        <div class="name" title="${esc(item.sourcePath)}">${esc(item.name)}</div>
        <div class="meta"><span>${esc(item.kind)}</span><span>${fmtSize(item.bytes)}</span></div>
        ${item.warning ? `<div class="warn">${esc(item.warning)}</div>` : ''}
        <div class="actions">
          <button class="btn small" data-download="${item.id}">下载</button>
          <button class="btn small" data-open="${item.id}">查看</button>
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
  for (const slot of grid.querySelectorAll<HTMLElement>('[data-slot]')) {
    const id = Number(slot.dataset.slot);
    const item = byId.get(id);
    // JSON / 其他 没有可视缩略图，连解码都不该发起
    if (!item || (item.kind !== 'image' && item.kind !== 'video')) continue;
    let url: string;
    try {
      url = await previewUrl(id);
    } catch {
      continue;
    }
    if (token !== renderToken || !slot.isConnected) continue;
    slot.innerHTML = '';
    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.preload = 'metadata';
      slot.append(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
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
  const action = t.closest<HTMLElement>('[data-download], [data-open]');
  if (action) {
    const id = Number(action.dataset.download ?? action.dataset.open);
    if (action.dataset.download) void downloadItem(id);
    else void openItem(id);
    return;
  }
  // 勾选框的原生 change 已经处理过了，这里再取反等于没点
  if (t.closest('.card-check')) return;
  const card = t.closest<HTMLElement>('.card[data-id]');
  if (card) {
    const id = Number(card.dataset.id);
    setSelection(id, !selected.has(id));
  }
});

grid.addEventListener('change', (e) => {
  const box = (e.target as HTMLElement).closest<HTMLInputElement>('.card-check');
  if (!box) return;
  const id = Number(box.closest<HTMLElement>('.card[data-id]')?.dataset.id);
  if (Number.isFinite(id)) setSelection(id, box.checked);
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
  const item = byId.get(id);
  if (!item) return;
  try {
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
  } catch (e) {
    setStatus(`预览失败：${(e as Error).message}`, 'err');
  }
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
  const item = byId.get(id);
  if (!item) return;
  setStatus(`正在导出 ${item.name} …`);
  try {
    saveBlob(await requestBlob(id), item.name);
    setStatus('导出完成', 'ok');
  } catch (e) {
    setStatus(`导出失败：${(e as Error).message}`, 'err');
  }
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

const entryName = (item: ItemSummary, keepPath: boolean) =>
  keepPath ? item.name : item.name.split('/').pop() || 'download';

/** 关闭「保留目录结构」后不同目录的同名条目会撞成同一个 key，撞了就加序号，别静默覆盖 */
function uniqueKey(want: string, used: Set<string>): string {
  if (!used.has(want)) { used.add(want); return want; }
  const dot = want.lastIndexOf('.');
  let n = 2;
  let key = '';
  do {
    key = dot > 0 ? `${want.slice(0, dot)}-${n}${want.slice(dot)}` : `${want}-${n}`;
    n += 1;
  } while (used.has(key));
  used.add(key);
  return key;
}

/** 不用 rAF 让步：后台标签页里 rAF 不触发，批量循环会永久卡住 */
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

function abortIfStale(epoch: number): boolean {
  if (epoch === parseEpoch) return false;
  progress.hide();
  endRun();
  setStatus('已中止：包内容已变化', 'err');
  return true;
}

/** 打包给定条目：#btn-zip 与「选中文件打包下载」共用同一条流水线 */
async function zipItems(items: ItemSummary[]) {
  if (!items.length) {
    setStatus('没有可打包的文件', 'err');
    return;
  }
  if (!beginRun()) return;
  const epoch = parseEpoch;
  const keepPath = ($<HTMLInputElement>('#opt-keep-path')).checked;
  setStatus(`正在打包 ${items.length} 个文件…`);
  progress.start('正在解码…', items.length);
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  let done = 0;
  let skipped = 0;
  let renamed = 0;
  for (const item of items) {
    if (abortIfStale(epoch)) return;
    try {
      const want = entryName(item, keepPath);
      const key = uniqueKey(want, used);
      if (key !== want) renamed += 1;
      const blob = await requestBlob(item.id);
      files[key] = new Uint8Array(await blob.arrayBuffer());
      // 打包时每个 id 只用一次，留在 blobCache 里纯属白占内存
      blobCache.delete(item.id);
    } catch {
      skipped += 1;
    }
    done += 1;
    progress.set(done);
    setRunState(`已处理 ${done}/${items.length}`);
    if (done % 5 === 0) await yieldToUI();
  }
  if (!Object.keys(files).length) {
    progress.hide();
    endRun();
    setStatus(`打包失败：${skipped} 个条目全部解码失败`, 'err');
    return;
  }
  progress.start('正在写入 ZIP…');
  setRunState('正在写入 ZIP…');
  const { zip } = await import('fflate');
  zip(files, { level: 0 }, (err, data) => {
    if (err) {
      progress.hide();
      endRun();
      setStatus(`ZIP 失败: ${err.message}`, 'err');
      return;
    }
    const summary = [fmtSize(data.length), `${done} 个`, skipped ? `跳过 ${skipped} 个` : '', renamed ? `重命名 ${renamed} 个` : '']
      .filter(Boolean)
      .join(' · ');
    saveBlob(new Blob([data as unknown as BlobPart], { type: 'application/zip' }), 'wallpaper-extract.zip');
    setStatus(`ZIP 完成（${summary}）`, skipped ? 'err' : 'ok');
    progress.finish(`ZIP 完成 · ${summary}`);
    endRun();
  });
}

/**
 * 逐个触发浏览器下载。i/N 度量的是「解码 + 派发」而不是落盘：
 * <a download> 没有完成事件，落盘由浏览器自己的下载条反映。
 */
async function downloadItems(items: ItemSummary[]) {
  if (!items.length) {
    setStatus('未选择任何文件', 'err');
    return;
  }
  if (!beginRun()) return;
  const epoch = parseEpoch;
  progress.start('正在派发下载…', items.length);
  let done = 0;
  let dispatched = 0;
  let fail = 0;
  for (const item of items) {
    if (abortIfStale(epoch)) return;
    try {
      const blob = await requestBlob(item.id);
      saveBlob(blob, item.name);
      dispatched += 1;
      // 已经在预览里的条目留着，省得再解一次
      if (!objectUrls.has(item.id)) blobCache.delete(item.id);
    } catch {
      fail += 1;
    }
    done += 1;
    progress.set(done);
    setRunState(`已派发 ${done}/${items.length}`);
    // 每 3 个让一次路：既让进度条动，也不把 N 次点击挤进同一个 task
    if (done % 3 === 0) await yieldToUI();
  }
  progress.finish(`已派发 ${dispatched} 个下载`);
  setStatus(
    `已派发 ${dispatched}/${items.length} 个下载${fail ? `，失败 ${fail} 个` : ''}。浏览器可能要求允许「下载多个文件」`,
    fail || dispatched !== items.length ? 'err' : 'ok',
  );
  endRun();
}

zipBtn.addEventListener('click', () => void zipItems(scopeItems()));
selZip.addEventListener('click', () => void zipItems(selectedItems()));
selDl.addEventListener('click', () => void downloadItems(selectedItems()));
selClear.addEventListener('click', () => setMany(currentItems, false));
selAll.addEventListener('click', () => setMany(scopeItemsToSelect(), true));

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
renderSelbar();
