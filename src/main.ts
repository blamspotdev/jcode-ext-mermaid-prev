// Mermaid Preview — JCode extension UI (TypeScript, bundled to www/main.js by esbuild).
// Renders Mermaid diagrams fully offline via the vendored mermaid.min.js (loaded by index.html
// before this bundle). Two views from one bundle, selected by location.hash (the route the host
// opens for the tapped contributes.editorContextActions id):
//   #charts   — chart-by-chart cards from a .mmd/.mermaid file or a Markdown file's fences
//   #document — the whole Markdown document with every mermaid fence rendered in place
// The preview shows SAVED content (there is no live-buffer API); it follows the active editor
// tab and re-reads on filesChanged.

import { Marked } from 'marked';

interface ApiResult { ok: boolean; data?: any; error?: string }

declare const mermaid: any;

// ---- Extension API v1 bridge ----
const pending: Record<string, (r: ApiResult) => void> = {};
let seq = 0;
function api(type: string, payload?: unknown): Promise<ApiResult> {
  return new Promise((resolve) => {
    const id = 'q' + (seq++);
    pending[id] = resolve;
    try {
      (window as any).JCodeNative.request(id, JSON.stringify({ type, payload: payload ?? {} }));
    } catch (e) {
      delete pending[id];
      resolve({ ok: false, error: 'bridge unavailable: ' + e });
    }
  });
}
(window as any).JCode = {
  request: api,
  _onResult(id: string, jsonString: string) {
    const cb = pending[id];
    if (!cb) return;
    delete pending[id];
    let r: ApiResult;
    try { r = JSON.parse(jsonString); } catch { r = { ok: false, error: jsonString }; }
    cb(r);
  },
  _onEvent(name: string, json: string) {
    let payload: any = {};
    try { payload = JSON.parse(json); } catch { /* keep {} */ }
    onHostEvent(name, payload);
  },
};

// ---- helpers ----
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
));
const baseName = (p: string) => p.split('/').pop() || p;
const fileExt = (p: string) => (baseName(p).split('.').pop() || '').toLowerCase();
const isMermaidFile = (p: string) => ['mmd', 'mermaid'].includes(fileExt(p));
const isMarkdownFile = (p: string) => ['md', 'markdown', 'mdown', 'mkd', 'mkdn'].includes(fileExt(p));
const isSupported = (p: string) => isMermaidFile(p) || isMarkdownFile(p);

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

// First word of the diagram source, for the card header ("flowchart", "sequenceDiagram", …).
function diagramKind(src: string): string {
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('%%')) continue;
    return t.split(/[\s{]/)[0] || 'diagram';
  }
  return 'diagram';
}

// ---- Mermaid theming (host injects --jcode-* CSS vars; re-injected on theme change) ----
function cssVar(name: string, fallback: string): string {
  return (getComputedStyle(document.documentElement).getPropertyValue(name) || fallback).trim() || fallback;
}

function isDarkTheme(): boolean {
  const bg = cssVar('--jcode-background', '#11151c');
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.replace('#', ''));
  if (!m) return true;
  const v = parseInt(m[1], 16);
  const lum = 0.2126 * ((v >> 16) & 0xff) + 0.7152 * ((v >> 8) & 0xff) + 0.0722 * (v & 0xff);
  return lum < 128;
}

let mermaidDark = true;
function initMermaid(): void {
  mermaidDark = isDarkTheme();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: mermaidDark ? 'dark' : 'default',
    fontFamily: 'system-ui, sans-serif',
  });
}

// ---- State ----
type Route = 'charts' | 'document';
const route: Route = location.hash.replace('#', '') === 'document' ? 'document' : 'charts';
let currentPath = '';
let currentName = '';
let followActive = true;
let zoom = 1.0;
let renderGen = 0;                       // invalidates in-flight renders when a newer load starts
const svgCache: Record<string, string> = {};  // source hash -> rendered SVG

const root = document.getElementById('root') as HTMLElement;

// ---- Fence extraction ----
interface Fence { src: string }
function extractMermaidFences(md: string): Fence[] {
  const out: Fence[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const open = /^(\s{0,3})(```+|~~~+)\s*mermaid\s*$/i.exec(lines[i]);
    if (!open) { i++; continue; }
    const marker = open[2][0];
    const minLen = open[2].length;
    const body: string[] = [];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t[0] === marker && t.length >= minLen && new RegExp('^' + '\\' + marker + '{' + minLen + ',}$').test(t)) break;
      body.push(lines[i]);
      i++;
    }
    i++;
    const src = body.join('\n').trim();
    if (src) out.push({ src });
  }
  return out;
}

// ---- Rendering ----
async function renderDiagramInto(el: HTMLElement, src: string, idx: number, gen: number): Promise<void> {
  const key = hashStr(src);
  const cached = svgCache[key];
  if (cached) { el.innerHTML = cached; return; }
  try {
    const { svg } = await mermaid.render('mmd-' + gen + '-' + idx, src);
    if (gen !== renderGen) return;
    svgCache[key] = svg;
    el.innerHTML = svg;
    applyZoom(el);
  } catch (e: any) {
    if (gen !== renderGen) return;
    const card = el.closest('.card');
    if (card) card.classList.add('errcard');
    el.outerHTML =
      '<div class="errmsg">' + esc(String(e?.message || e)) + '</div>' +
      '<pre>' + esc(src) + '</pre>';
    // mermaid.render leaves an error element behind on failure (id = 'd' + renderId) — drop it.
    document.getElementById('dmmd-' + gen + '-' + idx)?.remove();
  }
}

function applyZoom(diagram: HTMLElement): void {
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  if (zoom === 1.0) {
    svg.style.removeProperty('width');
    svg.style.maxWidth = '100%';
  } else {
    svg.style.maxWidth = 'none';
    svg.style.width = Math.round(zoom * 100) + '%';
  }
}

function applyZoomAll(): void {
  document.querySelectorAll<HTMLElement>('.diagram').forEach(applyZoom);
}

function topbarHtml(subtitle: string): string {
  return (
    '<div class="topbar">' +
    '<div class="title">' + esc(currentName || 'Mermaid Preview') +
    ' <span class="meta">' + esc(subtitle) + '</span></div>' +
    '<button class="iconbtn' + (followActive ? ' toggled' : '') + '" id="btn-follow" title="Follow active editor tab">📌</button>' +
    (route === 'charts'
      ? '<button class="iconbtn" id="btn-zoom-out" title="Zoom out">−</button>' +
        '<button class="iconbtn" id="btn-zoom-in" title="Zoom in">+</button>'
      : '') +
    '<button class="iconbtn" id="btn-refresh" title="Refresh">↻</button>' +
    '</div>'
  );
}

function wireTopbar(): void {
  document.getElementById('btn-refresh')?.addEventListener('click', () => { void load(currentPath); });
  document.getElementById('btn-follow')?.addEventListener('click', (e) => {
    followActive = !followActive;
    (e.currentTarget as HTMLElement).classList.toggle('toggled', followActive);
  });
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    zoom = Math.min(3, zoom + 0.25);
    applyZoomAll();
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    zoom = Math.max(0.5, zoom - 0.25);
    applyZoomAll();
  });
}

function showPlaceholder(message: string): void {
  root.innerHTML =
    topbarHtml('') +
    '<div id="content"><div class="placeholder"><div class="big">📊</div>' +
    '<p>' + esc(message) + '</p>' +
    '<p>Long-press a <code>.mmd</code> or Markdown file in the editor and choose a Mermaid preview action.</p>' +
    '</div></div>';
  wireTopbar();
}

async function renderCharts(content: string, gen: number): Promise<void> {
  const fences: Fence[] = isMermaidFile(currentPath) ? [{ src: content.trim() }] : extractMermaidFences(content);
  if (fences.length === 0 || (fences.length === 1 && !fences[0].src)) {
    showPlaceholder('No mermaid diagrams found in this file.');
    return;
  }
  const cards = fences.map((f, i) =>
    '<section class="card">' +
    '<div class="head"><span class="kind">' + esc(diagramKind(f.src)) + '</span><span>#' + (i + 1) + '</span></div>' +
    '<div class="diagram" id="slot-' + gen + '-' + i + '"></div>' +
    '<details class="src"><summary>Source</summary><pre>' + esc(f.src) + '</pre></details>' +
    '</section>',
  ).join('');
  root.innerHTML = topbarHtml(fences.length + ' diagram' + (fences.length === 1 ? '' : 's')) +
    '<div id="content">' + cards + '</div>';
  wireTopbar();
  for (let i = 0; i < fences.length; i++) {
    const el = document.getElementById('slot-' + gen + '-' + i);
    if (el) await renderDiagramInto(el, fences[i].src, i, gen);
  }
}

// Markdown renderer for document mode: raw HTML is escaped (never reaches the DOM live — same
// policy as JCode's built-in preview), mermaid fences become placeholder slots rendered after
// the document is in the DOM, other fences stay as escaped code blocks.
let docFences: Fence[] = [];
const md = new Marked();
md.use({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: any) { return esc(token.text ?? token.raw ?? ''); },
    code(token: any) {
      const lang = (token.lang || '').trim().toLowerCase();
      const text: string = token.text ?? '';
      if (lang === 'mermaid') {
        const idx = docFences.length;
        docFences.push({ src: text.trim() });
        return '<section class="card"><div class="diagram" id="docslot-' + idx + '"></div></section>';
      }
      return '<pre><code>' + esc(text) + '</code></pre>';
    },
  },
});

async function renderDocument(content: string, gen: number): Promise<void> {
  docFences = [];
  let body: string;
  try {
    body = md.parse(content) as string;
  } catch (e: any) {
    showPlaceholder('Markdown parse failed: ' + String(e?.message || e));
    return;
  }
  const fences = docFences;
  root.innerHTML = topbarHtml(fences.length + ' inline chart' + (fences.length === 1 ? '' : 's')) +
    '<div id="content"><div class="doc">' + body + '</div></div>';
  wireTopbar();
  for (let i = 0; i < fences.length; i++) {
    const slot = document.getElementById('docslot-' + i);
    if (slot) {
      slot.id = 'slot-' + gen + '-' + i;
      await renderDiagramInto(slot, fences[i].src, i, gen);
    }
  }
}

// ---- Loading ----
let loadTimer: number | undefined;
function scheduleReload(): void {
  if (!currentPath) return;
  clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => { void load(currentPath); }, 300) as unknown as number;
}

async function load(path: string): Promise<void> {
  if (!path) { showPlaceholder('Nothing to preview yet.'); return; }
  const gen = ++renderGen;
  currentPath = path;
  currentName = baseName(path);
  const r = await api('fs.read', { path });
  if (gen !== renderGen) return;
  if (!r.ok) {
    showPlaceholder('Could not read ' + currentName + ': ' + (r.error || 'unknown error'));
    return;
  }
  const content: string = String(r.data?.content ?? r.data?.text ?? '');
  if (route === 'document' && isMarkdownFile(path)) await renderDocument(content, gen);
  else await renderCharts(content, gen);
}

// ---- Host events ----
function onHostEvent(name: string, payload: any): void {
  switch (name) {
    case 'contextAction': {
      const path = String(payload?.path || '');
      if (path && isSupported(path)) void load(path);
      break;
    }
    case 'activeFile': {
      const path = String(payload?.path || '');
      if (followActive && path && isSupported(path) && path !== currentPath) void load(path);
      break;
    }
    case 'filesChanged':
      scheduleReload();
      break;
  }
}

// Theme changes arrive as re-injected --jcode-* vars with no event: watch the root style attr,
// re-init mermaid, and re-render from scratch (the SVG cache bakes in theme colors).
let themeTimer: number | undefined;
new MutationObserver(() => {
  clearTimeout(themeTimer);
  themeTimer = window.setTimeout(() => {
    if (isDarkTheme() !== mermaidDark) {
      initMermaid();
      for (const k of Object.keys(svgCache)) delete svgCache[k];
      if (currentPath) void load(currentPath);
    }
  }, 100) as unknown as number;
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// ---- Boot ----
(async () => {
  initMermaid();
  showPlaceholder('Loading…');
  // Events are not replayed to a fresh page: pull the stashed context action first (the host
  // nests the tap payload under data.action), then fall back to the active editor file.
  const ctx = await api('workbench.pendingContextAction');
  const ctxPath = String(ctx.data?.action?.path || '');
  if (ctx.ok && ctxPath && isSupported(ctxPath)) {
    await load(ctxPath);
    return;
  }
  const active = await api('workbench.activeFile');
  const activePath = String(active.data?.path || '');
  if (active.ok && activePath && isSupported(activePath)) {
    await load(activePath);
    return;
  }
  showPlaceholder('Nothing to preview yet.');
})();
