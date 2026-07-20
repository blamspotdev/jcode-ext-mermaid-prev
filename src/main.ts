// Mermaid Preview — JCode extension UI (TypeScript, bundled to www/main.js by esbuild).
// Renders Mermaid diagrams fully offline via the vendored mermaid.min.js (loaded by index.html
// before this bundle). Views, selected by location.hash (the route the host opens for the tapped
// contributes.editorContextActions id, or a route built by "View in New Tab"):
//   #charts        — chart-by-chart cards from a .mmd/.mermaid file or a Markdown file's fences
//   #document      — the whole Markdown document with every mermaid fence rendered in place
//   #chart?p=..&i= — a single chart (opened from a per-chart "View in New Tab"); p = guest path
//                    (percent-encoded), i = fence index
// Every rendered chart has a compact control cluster: zoom -/+, pan lock/unlock (drag to pan,
// pinch to zoom while unlocked), and "View in New Tab". Content is SAVED (no live-buffer API);
// the preview follows the active editor tab and re-reads on filesChanged.

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
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
interface RouteInfo { route: 'charts' | 'document' | 'single'; path?: string; index?: number }
function parseRoute(): RouteInfo {
  const raw = location.hash.replace(/^#/, '');
  if (raw.startsWith('chart?')) {
    // URLSearchParams already percent-decodes get() — decoding again would corrupt any path
    // containing a literal '%'.
    const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
    const p = params.get('p');
    const i = parseInt(params.get('i') || '0', 10);
    return { route: 'single', path: p || undefined, index: isNaN(i) ? 0 : i };
  }
  return { route: raw === 'document' ? 'document' : 'charts' };
}
const routeInfo = parseRoute();
const route = routeInfo.route;

let currentPath = '';
let currentName = '';
let followActive = route !== 'single';   // a pinned single-chart tab doesn't chase the active file
let renderGen = 0;                        // invalidates in-flight renders when a newer load starts
const svgCache: Record<string, string> = {};  // source hash -> rendered SVG

const root = document.getElementById('root') as HTMLElement;

// ---- Fence extraction ----
// One enumerator for every view (charts, document, single) so a fence INDEX means the same fence
// everywhere: a whole .mmd file is fence 0; a Markdown file's mermaid fences are walked from the
// Marked token tree in document order (matching the inline document renderer, incl. fences nested
// in blockquotes/lists) — a regex line-scan would count different things and desync "View in New Tab".
interface Fence { src: string }
function extractFences(content: string, path: string): Fence[] {
  if (isMermaidFile(path)) {
    const s = content.trim();
    return s ? [{ src: s }] : [];
  }
  const out: Fence[] = [];
  const walk = (tokens: any[]) => {
    for (const t of tokens) {
      if (t.type === 'code' && String(t.lang || '').trim().toLowerCase() === 'mermaid') {
        const src = String(t.text || '').trim();
        if (src) out.push({ src });
      } else if (Array.isArray(t.tokens)) {
        walk(t.tokens);
      } else if (Array.isArray(t.items)) {
        for (const it of t.items) if (Array.isArray(it.tokens)) walk(it.tokens);
      }
    }
  };
  try { walk(md.lexer(content)); } catch { /* malformed markdown -> no charts */ }
  return out;
}

// ---- Per-chart pan/zoom controller ----
// The rendered SVG lives inside `.chart-pan` within a clipping `.chart-viewport`. When unlocked,
// a one-finger drag pans and a two-finger pinch zooms; while locked, the viewport passes touches
// through so the page scrolls normally and the chart stays put. Zoom -/+ buttons work regardless.
interface ChartCtl { locked: boolean; zoomBy(f: number): void; reset(): void; setLocked(v: boolean): void }
function setupChart(viewport: HTMLElement, pan: HTMLElement): ChartCtl {
  let zoom = 1, panX = 0, panY = 0, locked = true;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0, pinchZoom = 1, midX = 0, midY = 0;
  // Double-tap-to-reset: only a genuine single-finger tap counts. Tracked per gesture so lifting
  // the two fingers of a pinch (two pointerups in quick succession) never self-triggers a reset.
  let gestureMaxPointers = 0, moved = false, lastTapAt = 0;

  const apply = () => { pan.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`; };
  const reset = () => { zoom = 1; panX = 0; panY = 0; apply(); };
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  viewport.addEventListener('pointerdown', (e) => {
    if (locked) return;
    if (pointers.size === 0) { gestureMaxPointers = 0; moved = false; }
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gestureMaxPointers = Math.max(gestureMaxPointers, pointers.size);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchZoom = zoom;
      const m = mid(a, b); midX = m.x; midY = m.y;
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (locked || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (pinchDist > 0) zoom = clamp(pinchZoom * Math.hypot(a.x - b.x, a.y - b.y) / pinchDist, 0.25, 6);
      const m = mid(a, b);
      panX += m.x - midX; panY += m.y - midY; midX = m.x; midY = m.y;
      moved = true;
      apply();
    } else {
      if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 2) moved = true;
      panX += e.clientX - prev.x; panY += e.clientY - prev.y;
      apply();
    }
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      // A single-finger tap that didn't drag: apply double-tap detection.
      if (gestureMaxPointers === 1 && !moved) {
        const now = performance.now();
        if (now - lastTapAt < 300) reset();
        lastTapAt = now;
      }
    }
  };
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);

  return {
    get locked() { return locked; },
    zoomBy(f) { zoom = clamp(zoom * f, 0.25, 6); apply(); },
    reset,
    setLocked(v) {
      locked = v;
      viewport.classList.toggle('unlocked', !v);
      viewport.style.touchAction = v ? '' : 'none';
    },
  };
}

// ---- Rendering ----
const LOCK_ICON = '🔒', UNLOCK_ICON = '✋';

// A chart card: kind label + control cluster, then the viewport/pan holder, then (optionally) the
// collapsible source. `slotId` is where the SVG is injected after the card is in the DOM.
function chartCardHtml(src: string, idx: number, slotId: string, opts: { source: boolean; newTab: boolean }): string {
  const ctrls =
    '<button class="cbtn" data-a="zoomout" title="Zoom out">−</button>' +
    '<button class="cbtn" data-a="zoomin" title="Zoom in">+</button>' +
    '<button class="cbtn" data-a="lock" title="Pan (unlock to drag / pinch)">' + LOCK_ICON + '</button>' +
    (opts.newTab ? '<button class="cbtn" data-a="newtab" title="View in new tab">⧉</button>' : '');
  return (
    '<section class="card" data-idx="' + idx + '">' +
    '<div class="chart-head"><span class="kind">' + esc(diagramKind(src)) + '</span>' +
    '<span class="chart-ctrls">' + ctrls + '</span></div>' +
    '<div class="chart-viewport"><div class="chart-pan" id="' + slotId + '"></div></div>' +
    (opts.source ? '<details class="src"><summary>Source</summary><pre>' + esc(src) + '</pre></details>' : '') +
    '</section>'
  );
}

// Render `src` into the card identified by `slotId`, cap the viewport height, and wire the controls.
async function mountChart(src: string, idx: number, slotId: string, gen: number): Promise<void> {
  const pan = document.getElementById(slotId);
  if (!pan) return;
  const key = hashStr(src);
  let svg = svgCache[key];
  if (!svg) {
    try {
      svg = (await mermaid.render('mmd-' + gen + '-' + idx, src)).svg;
      if (gen !== renderGen) return;
      svgCache[key] = svg;
    } catch (e: any) {
      if (gen !== renderGen) return;
      document.getElementById('dmmd-' + gen + '-' + idx)?.remove();  // mermaid error node = 'd' + id
      const card = pan.closest('.card');
      if (card) {
        card.classList.add('errcard');
        card.querySelector('.chart-viewport')!.innerHTML =
          '<div class="errmsg">' + esc(String(e?.message || e)) + '</div><pre>' + esc(src) + '</pre>';
        card.querySelector('.chart-ctrls')?.remove();
      }
      return;
    }
  }
  pan.innerHTML = svg;
  const viewport = pan.parentElement as HTMLElement;
  // Cap the viewport to the diagram's natural height (or the screen), so a tall chart becomes a
  // pannable window rather than an endless column; small charts show whole with no clipping.
  const natural = pan.getBoundingClientRect().height;
  const cap = Math.min(natural || 320, Math.round(window.innerHeight * 0.72));
  if (natural > cap) viewport.style.height = cap + 'px';

  const ctl = setupChart(viewport, pan);
  const card = viewport.closest('.card') as HTMLElement;
  card.querySelector('.chart-ctrls')?.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn) return;
    switch (btn.getAttribute('data-a')) {
      case 'zoomin': ctl.zoomBy(1.25); break;
      case 'zoomout': ctl.zoomBy(0.8); break;
      case 'lock':
        ctl.setLocked(!ctl.locked);
        btn.textContent = ctl.locked ? LOCK_ICON : UNLOCK_ICON;
        btn.classList.toggle('on', !ctl.locked);
        break;
      case 'newtab': openChartInNewTab(idx); break;
    }
  });
}

function openChartInNewTab(idx: number): void {
  if (!currentPath) return;
  void api('workbench.openView', {
    view: 'chart?p=' + encodeURIComponent(currentPath) + '&i=' + idx,
    title: currentName + ' · chart ' + (idx + 1),
    newTab: true,   // coexist with the source preview instead of replacing it
  });
}

function topbarHtml(subtitle: string): string {
  return (
    '<div class="topbar">' +
    '<div class="title">' + esc(currentName || 'Mermaid Preview') +
    ' <span class="meta">' + esc(subtitle) + '</span></div>' +
    (route !== 'single'
      ? '<button class="iconbtn' + (followActive ? ' toggled' : '') + '" id="btn-follow" title="Follow active editor tab">📌</button>'
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
  const fences: Fence[] = extractFences(content, currentPath);
  if (fences.length === 0 || (fences.length === 1 && !fences[0].src)) {
    showPlaceholder('No mermaid diagrams found in this file.');
    return;
  }
  const cards = fences.map((f, i) =>
    chartCardHtml(f.src, i, 'slot-' + gen + '-' + i, { source: true, newTab: true }),
  ).join('');
  root.innerHTML = topbarHtml(fences.length + ' diagram' + (fences.length === 1 ? '' : 's')) +
    '<div id="content">' + cards + '</div>';
  wireTopbar();
  for (let i = 0; i < fences.length; i++) await mountChart(fences[i].src, i, 'slot-' + gen + '-' + i, gen);
}

// Markdown renderer for document mode: raw HTML is escaped (never reaches the DOM live — same
// policy as JCode's built-in preview), mermaid fences become chart cards rendered after the
// document is in the DOM, other fences stay as escaped code blocks.
let docFences: Fence[] = [];
let docGen = 0;
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
        return chartCardHtml(text.trim(), idx, 'slot-' + docGen + '-' + idx, { source: false, newTab: true });
      }
      return '<pre><code>' + esc(text) + '</code></pre>';
    },
  },
});

async function renderDocument(content: string, gen: number): Promise<void> {
  docFences = [];
  docGen = gen;
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
  for (let i = 0; i < fences.length; i++) await mountChart(fences[i].src, i, 'slot-' + gen + '-' + i, gen);
}

async function renderSingle(content: string, gen: number, index: number): Promise<void> {
  const fences: Fence[] = extractFences(content, currentPath);
  const f = fences[index];
  if (!f || !f.src) {
    showPlaceholder('That diagram is no longer in the file.');
    return;
  }
  root.innerHTML = topbarHtml('chart ' + (index + 1) + ' of ' + fences.length) +
    '<div id="content">' + chartCardHtml(f.src, index, 'slot-' + gen + '-0', { source: true, newTab: false }) + '</div>';
  wireTopbar();
  await mountChart(f.src, index, 'slot-' + gen + '-0', gen);
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
  if (route === 'single') await renderSingle(content, gen, routeInfo.index ?? 0);
  else if (route === 'document' && isMarkdownFile(path)) await renderDocument(content, gen);
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
  // A single-chart tab carries its file in the route hash — no host round-trip needed.
  if (route === 'single' && routeInfo.path) {
    await load(routeInfo.path);
    return;
  }
  // Events are not replayed to a fresh page: pull the stashed context action first, then fall
  // back to whatever file is active in the editor. The pull response nests the payload under
  // `data.action` (unlike the pushed `contextAction` event, which is flat).
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
