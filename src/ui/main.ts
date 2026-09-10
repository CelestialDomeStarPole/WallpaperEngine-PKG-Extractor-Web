import './style.css';
import type { BlobVariant, DecodeOptions, ItemKind, WallpaperMeta } from '../core/types';
import { LIMITS } from '../core/limits';
import { ZipWriter, entryName, uniqueKey } from '../core/zipstream';
import { createGlassController } from './glass';
import { initDock } from './dock';
import { createProgress } from './progress';

interface ItemSummary {
  id: number; name: string; sourcePath: string; kind: ItemKind;
  mime: string; bytes: number; estimated?: boolean; poster?: boolean; warning?: string;
}
type OutMsg =
  | { type: 'parsed'; magic: string; items: ItemSummary[]; meta?: WallpaperMeta }
  | { type: 'error'; message: string }
  | { type: 'blob'; id: number; variant: BlobVariant; blob: Blob; bytes: number; patch?: ItemPatch };

interface ItemPatch { name: string; mime: string; kind: ItemKind; notice: string }

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
const optTex = $<HTMLInputElement>('#opt-tex');
const animatedFormat = $<HTMLSelectElement>('#opt-animated');
const animatedField = $<HTMLElement>('#field-animated');
const zipBtn = $<HTMLButtonElement>('#btn-zip');
const selbar = $<HTMLElement>('#selbar');
const selSummary = $<HTMLElement>('#sel-summary');
const selHint = $<HTMLElement>('#sel-hint');
const selAll = $<HTMLButtonElement>('#btn-sel-all');
const selClear = $<HTMLButtonElement>('#btn-sel-clear');
const selZip = $<HTMLButtonElement>('#btn-sel-zip');
const selDl = $<HTMLButtonElement>('#btn-sel-dl');
const notice = $<HTMLElement>('#notice');
const noticeTitle = $<HTMLElement>('#notice-title');
const noticeList = $<HTMLElement>('#notice-list');

const defs = document.querySelector<SVGDefsElement>('#lg-defs defs')!;
const glass = createGlassController(defs);
const progress = createProgress($<HTMLElement>('#progress'), $<HTMLElement>('#progress-bar'), $<HTMLElement>('#progress-text'));
const dock = initDock(document.documentElement, glass);

const worker = new Worker(new URL('../workers/extract.worker.ts', import.meta.url), { type: 'module' });

let currentItems: ItemSummary[] = [];
let view: View = { name: 'folders' };
let renderToken = 0;

/** 缓存键：同一条目的完整输出与 poster 单图分开存 */
type CacheKey = string;
const keyOf = (id: number, variant: BlobVariant): CacheKey => `${id}:${variant}`;

/** 超过这个量就按插入顺序淘汰还没挂在页面上的 Blob */
const MAX_CACHED_BLOB_BYTES = 160 * 1024 * 1024;
const objectUrls = new Map<CacheKey, string>();
const pending = new Map<CacheKey, { ok: (b: Blob) => void; no: (e: Error) => void }>();
/** Map 的插入序就是 LRU 序 */
const cachedBlobs = new Map<CacheKey, Blob>();
let cachedBytes = 0;

function cacheBlob(key: CacheKey, blob: Blob) {
  const prev = cachedBlobs.get(key);
  if (prev) cachedBytes -= prev.size;
  cachedBlobs.set(key, blob);
  cachedBytes += blob.size;
  evictToBudget();
}

function dropBlob(key: CacheKey) {
  const hit = cachedBlobs.get(key);
  if (!hit) return;
  cachedBlobs.delete(key);
  cachedBytes -= hit.size;
}

function evictToBudget() {
  for (const [key, blob] of cachedBlobs) {
    if (cachedBytes <= MAX_CACHED_BLOB_BYTES) return;
    // 还挂着 objectURL 的留着：淘汰了浏览器也不会真的释放，纯属假装省内存
    if (objectUrls.has(key)) continue;
    dropBlob(key);
  }
}

function releaseObjectUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

function clearCaches() {
  releaseObjectUrls();
  cachedBlobs.clear();
  cachedBytes = 0;
}

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
    clearCaches();
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
  const key = keyOf(msg.id, msg.variant);
  cacheBlob(key, msg.blob);
  const waiter = pending.get(key);
  pending.delete(key);
  waiter?.ok(msg.blob);
  if (msg.variant === 'full') {
    if (msg.patch) applyItemPatch(msg.id, msg.patch);
    // 惰性输出的体积此刻才准确，回填卡片
    patchItemSize(msg.id, msg.bytes);
  }
};

function setStatus(text: string, cls?: 'err' | 'ok') {
  status.textContent = text;
  status.className = `status${cls ? ' ' + cls : ''}`;
}

function currentOptions(): DecodeOptions {
  return {
    texToImage: optTex.checked,
    animatedFormat: animatedFormat.value as DecodeOptions['animatedFormat'],
    legacyFrames: new URLSearchParams(location.search).get('legacyFrames') === '1',
  };
}

function requestBlob(id: number, variant: BlobVariant = 'full'): Promise<Blob> {
  const key = keyOf(id, variant);
  const cached = cachedBlobs.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    pending.set(key, { ok: resolve, no: reject });
    worker.postMessage({ type: 'blob', id, variant });
  });
}

async function previewUrl(id: number, variant: BlobVariant = 'full'): Promise<string> {
  const key = keyOf(id, variant);
  const known = objectUrls.get(key);
  if (known) return known;
  const blob = await requestBlob(id, variant);
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

/** 估算体积在真正编码完成后回填成精确值，只改这一个文本节点 */
function patchItemSize(id: number, bytes: number) {
  const item = byId.get(id);
  if (!item || !item.estimated || item.bytes === bytes) return;
  item.bytes = bytes;
  item.estimated = false;
  const el = grid.querySelector<HTMLElement>(`[data-size="${id}"]`);
  if (!el) return;
  el.textContent = fmtSize(bytes);
  el.classList.remove('est');
  el.removeAttribute('title');
}

/** 重编码失败回退后，条目变了名字和类型：原地改，别重建 DOM */
function applyItemPatch(id: number, patch: ItemPatch) {
  const item = byId.get(id);
  if (!item || item.name === patch.name) return;
  const kindChanged = item.kind !== patch.kind;
  item.name = patch.name;
  item.mime = patch.mime;
  item.kind = patch.kind;
  item.warning = patch.notice;
  if (kindChanged) {
    // 缩略图占位要换成图标，只能重建
    render();
  } else {
    const nameEl = grid.querySelector<HTMLElement>(`[data-name="${id}"]`);
    if (nameEl) {
      nameEl.textContent = patch.name.split('/').pop() || patch.name;
      nameEl.title = item.sourcePath;
    }
  }
  reportDegraded(patch.name, patch.notice);
}

const pendingNotices: string[] = [];

function reportDegraded(name: string, reason: string) {
  const line = `${name}：${reason}`;
  if (running) pendingNotices.push(line);
  else showNotice('动图未能重编码，已回退为单帧图片', [line]);
}

function showNotice(title: string, lines: string[]) {
  noticeTitle.textContent = title;
  noticeList.innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join('');
  notice.hidden = false;
  glass.observe(notice);
  $<HTMLButtonElement>('#notice-ok').focus();
}

function closeNotice() {
  notice.hidden = true;
  glass.release(notice);
  glass.refresh();
}

function flushNotices() {
  if (!pendingNotices.length) return;
  showNotice('动图未能重编码，已回退为单帧图片', pendingNotices.splice(0));
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
  selHint.textContent = `已选 ${n} 个：逐个下载需要浏览器允许「下载多个文件」，且会占用 ${n} 次下载队列；建议改用打包下载，只需一次保存。`;

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
  flushNotices();
}

// —— 拖拽 / 选择 ——
function handleFile(file: File) {
  if (!/\.(pkg|mpkg)$/i.test(file.name)) {
    setStatus('仅支持 .pkg / .mpkg 文件', 'err');
    return;
  }
  if (file.size > LIMITS.pkgFormatCeiling) {
    const why = `${fmtSize(file.size)}：PKG 目录表的偏移字段是 int32，这个格式本身存不下超过 ${fmtSize(LIMITS.pkgFormatCeiling)} 的包`;
    setStatus(why, 'err');
    showNotice('这个包大到格式层面就无法解析', [why]);
    return;
  }
  setStatus(
    file.size > LIMITS.softSizeWarn
      ? `正在解析 ${file.name}（${fmtSize(file.size)}）… 包较大，只读目录表，导出时按需取数据`
      : `正在解析 ${file.name}（${fmtSize(file.size)}）…`,
  );
  progress.start('正在解析…');
  // 先让 worker 放下上一个包（连同它的 File 引用），再投新的
  worker.postMessage({ type: 'close' });
  worker.postMessage({ type: 'open', file, options: currentOptions() });
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
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(n / KB).toFixed(1)} KB`;
  if (n < GB) return `${(n / MB).toFixed(2)} MB`;
  return `${(n / GB).toFixed(2)} GB`;
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
        <div class="name" data-name="${item.id}" title="${esc(item.sourcePath)}">${esc(item.name)}</div>
        <div class="meta"><span>${esc(item.kind)}</span><span class="size${item.estimated ? ' est' : ''}" data-size="${item.id}"${
          item.estimated ? ' title="动图为编码前估算值，导出后会回填成实际大小"' : ''
        }>${item.estimated ? '~' : ''}${fmtSize(item.bytes)}${item.estimated ? ' 估算' : ''}</span></div>
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
      // 动图取第 0 帧单图：不为了一格缩略图去编整个动画
      url = await previewUrl(id, item.poster ? 'poster' : 'full');
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
  if (!notice.hidden) {
    if (e.key === 'Escape') closeNotice();
    return;
  }
  if (!modal.hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (e.key === 'Escape') return;
  if (view.name === 'folder' && !isTyping(e.target)) {
    view = { name: 'folders' };
    render();
  }
});

$<HTMLButtonElement>('#notice-ok').addEventListener('click', closeNotice);
notice.addEventListener('click', (e) => {
  if (e.target === notice) closeNotice();
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
  progress.start('正在导出…', items.length);
  const zw = new ZipWriter();
  const used = new Set<string>();
  let done = 0;
  let written = 0;
  let skipped = 0;
  let renamed = 0;
  for (const item of items) {
    if (abortIfStale(epoch)) return;
    try {
      const blob = await requestBlob(item.id);
      // 名字要在编码之后再定：降级回退会当场改掉 item.name
      const want = entryName(item.name, keepPath);
      const key = uniqueKey(want, used);
      if (key !== want) renamed += 1;
      await zw.addFile(key, blob);
      written += 1;
      // 打包只用一次；还挂在预览上的留着，省得再解一次
      if (!objectUrls.has(keyOf(item.id, 'full'))) dropBlob(keyOf(item.id, 'full'));
    } catch {
      skipped += 1;
    }
    done += 1;
    progress.set(done);
    setRunState(`已写入 ${written}/${items.length}`);
    if (done % 5 === 0) await yieldToUI();
  }
  if (!written) {
    progress.hide();
    endRun();
    setStatus(`打包失败：${skipped} 个条目全部导出失败`, 'err');
    return;
  }
  setRunState('正在收尾…');
  let zipBlob: Blob;
  try {
    zipBlob = zw.finish();
  } catch (e) {
    progress.hide();
    endRun();
    setStatus(`ZIP 失败: ${(e as Error).message}`, 'err');
    return;
  }
  const summary = [fmtSize(zipBlob.size), `${written} 个`, skipped ? `跳过 ${skipped} 个` : '', renamed ? `重命名 ${renamed} 个` : '']
    .filter(Boolean)
    .join(' · ');
  saveBlob(zipBlob, 'wallpaper-extract.zip');
  setStatus(`ZIP 完成（${summary}）`, skipped ? 'err' : 'ok');
  progress.finish(`ZIP 完成 · ${summary}`);
  endRun();
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
      const key = keyOf(item.id, 'full');
      if (!objectUrls.has(key)) dropBlob(key);
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
function reparse() {
  if (!currentItems.length) return;
  setStatus('正在按新选项重新解析…');
  progress.start('正在重新解析…');
  worker.postMessage({ type: 'reparse', options: currentOptions() });
}

function syncOptionVisibility() {
  animatedField.hidden = !($<HTMLInputElement>('#opt-tex')).checked;
}

for (const el of [optTex, animatedFormat]) {
  el.addEventListener('change', () => {
    syncOptionVisibility();
    reparse();
  });
}

// —— 启动 ——
glass.observe(document.body);
dock.start();
syncOptionVisibility();
renderSelbar();
