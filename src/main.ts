import './style.css';
import { Scene, multiply, nodeBounds } from './core/scene';
import { parseProject, exportProject, exportSvg } from './core/project';
import type { DesignNode, FontRecord, Matrix } from './core/types';
import { CanvasView } from './editor/canvas';
import { shape, sample } from './editor/shapes';
import { importSvg } from './import/svg';
import { FontClient } from './fonts/client';
import { listFontMetadata, readFont, saveFont, type FontMetadata } from './fonts/storage';

const icons: Record<string, string> = {
  select: 'M5 3v17l5-5 4 7 3-2-4-7 7-1Z', hand: 'M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v10c0 4-3 6-6 6h-2l-7-8a2 2 0 0 1 3-3Z',
  rectangle: 'M4 5h16v14H4Z', circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  heart: 'M12 20S3 14 3 8a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6-9 12-9 12Z',
  text: 'M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3',
  import: 'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',
  undo: 'M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12', redo: 'M16 4l5 5-5 5M21 9H10a6 6 0 0 0 0 12',
  duplicate: 'M8 8h13v13H8ZM16 8V3H3v13h5', trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  lock: 'M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0v4', plus: 'M12 4v16M4 12h16', minus: 'M4 12h16',
  unlock: 'M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0',
  'eye-off': 'M3 3l18 18M9 5a10 10 0 0 1 3 0c6 0 10 7 10 7l-3 4M6 6c-3 2-4 6-4 6s4 7 10 7a10 10 0 0 0 4-1',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name]}"/></svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">${icon('heart')}</span><strong>Craft Studio</strong></div>
    <label class="project-title"><span class="sr-only">Project name</span><input id="project-name" value="Untitled design" maxlength="100" /></label>
    <div class="file-actions"><button id="new-project">New</button><button id="open-project">Open project</button><button id="save-project">Save project</button><button id="export-svg" class="primary" disabled>Export SVG</button></div>
  </header>
  <div class="workspace">
    <nav class="toolrail" aria-label="Drawing tools">
      <button id="select-tool" class="tool active" title="Select (V)" aria-label="Select" aria-pressed="true">${icon('select')}<span>Select</span></button>
      <button id="pan-tool" class="tool" title="Pan (H), or hold Space" aria-label="Pan" aria-pressed="false">${icon('hand')}<span>Pan</span></button>
      <span class="tool-divider"></span>
      <button id="add-text" class="tool" title="Add outlined text from a font" aria-label="Add text">${icon('text')}<span>Text</span></button>
      <button id="add-rectangle" class="tool" aria-label="Add rectangle">${icon('rectangle')}<span>Rectangle</span></button>
      <button id="add-circle" class="tool" aria-label="Add circle">${icon('circle')}<span>Circle</span></button>
      <button id="add-heart" class="tool" aria-label="Add heart">${icon('heart')}<span>Heart</span></button>
      <span class="tool-divider"></span>
      <button id="import-svg" class="tool" aria-label="Import SVG">${icon('import')}<span>Import SVG</span></button>
    </nav>
    <main class="design-area" aria-label="Design workspace">
      <div class="canvas-toolbar"><div class="history-actions"><button id="undo" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled>${icon('undo')}</button><button id="redo" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled>${icon('redo')}</button><span class="toolbar-separator"></span><button id="duplicate" title="Duplicate (Ctrl/Cmd+D)" aria-label="Duplicate selection" disabled>${icon('duplicate')}</button><button id="delete" title="Delete" aria-label="Delete selection" disabled>${icon('trash')}</button></div><span class="workspace-label">Design canvas <span>Millimetres</span></span><button id="fit">Fit design</button></div>
      <div class="canvas-wrap">
        <canvas id="canvas" tabindex="0" aria-label="Vector canvas. Select objects in the layers list for keyboard editing."></canvas>
        <div id="empty-state" class="empty-state"><div class="empty-illustration">${icon('rectangle')}${icon('circle')}${icon('heart')}</div><h1>Make room for your ideas.</h1><p>Add a shape, import an SVG, or bring your own font.<br>Your design stays local. No account needed.</p><button id="load-sample">Try a sample design</button><small>Editable shapes, not a benchmark.</small></div>
        <div id="notice" class="notice" role="alert" hidden></div>
      </div>
      <footer class="statusbar"><span id="status" role="status">Ready. Import SVGs and licensed TTF/OTF fonts.</span><div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">${icon('minus')}</button><output id="zoom-value">79%</output><button id="zoom-in" aria-label="Zoom in">${icon('plus')}</button></div></footer>
    </main>
    <aside class="sidebar" aria-label="Design properties and library">
      <section class="inspector"><div class="section-heading"><h2>Properties</h2><span id="selection-count">No selection</span></div><p id="selection-hint" class="hint">Select an object to change its size or position.</p><div id="object-properties" hidden><label class="field">Object name<input id="object-name" maxlength="100" /></label><div class="field-grid"><label class="field">X <span>mm</span><input id="object-x" type="number" step="0.1" /></label><label class="field">Y <span>mm</span><input id="object-y" type="number" step="0.1" /></label><label class="field">Width <span>mm</span><input id="object-width" type="number" min="0.1" max="10000" step="0.1" /></label><label class="field">Height <span>mm</span><input id="object-height" type="number" min="0.1" max="10000" step="0.1" /></label></div><div class="field-grid"><label class="field">Rotation <span>°</span><input id="object-rotation" type="number" step="1" /></label><label class="field">Fill<input id="object-fill" type="color" /></label></div><div id="text-properties" hidden><label class="field">Text<textarea id="object-text" maxlength="500" rows="2"></textarea></label><label class="field">Font size <span>mm</span><input id="text-size" type="number" min="1" max="200" step="0.5" /></label><button id="apply-text" class="wide">Update outlined text</button></div></div></section>
      <div class="library-tabs" role="tablist" aria-label="Library"><button id="layers-tab" role="tab" aria-selected="true" aria-controls="layers-panel">Layers <span id="layer-count">0</span></button><button id="fonts-tab" role="tab" aria-selected="false" aria-controls="fonts-panel">Fonts <span id="font-count">0</span></button></div>
      <section id="layers-panel" class="library-panel" role="tabpanel" aria-labelledby="layers-tab"><div id="layers-empty" class="panel-empty">Your objects will appear here.<br>Use Shift+click to select several.</div><div id="layers-scroll" class="virtual-scroll"><div id="layers-content"></div></div></section>
      <section id="fonts-panel" class="library-panel" role="tabpanel" aria-labelledby="fonts-tab" hidden><div class="font-actions"><button id="import-font" class="wide">Import a TTF / OTF font</button><button id="local-fonts" class="wide">Use installed fonts</button><label class="field"><span class="sr-only">Search fonts</span><input id="font-search" type="search" placeholder="Search fonts" /></label><p class="hint">Only selected fonts are prepared for outlines. Imported font files stay on this device.</p></div><div id="fonts-empty" class="panel-empty">Import a font to add text.<br>Use fonts you are licensed to use.</div><div id="fonts-scroll" class="virtual-scroll"><div id="fonts-content"></div></div></section>
      <div class="sidebar-footer"><p>SVG handoff</p><span>Design here. Cut in Design Space.</span></div>
    </aside>
  </div>
  <input id="svg-file" type="file" accept=".svg,image/svg+xml" hidden />
  <input id="font-file" type="file" accept=".ttf,.otf" multiple hidden />
  <input id="project-file" type="file" accept=".json,.craft" hidden />`;

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
let scene = new Scene();
const renderer = new CanvasView(element<HTMLCanvasElement>('canvas'), scene);
const fonts = new FontClient();
const records = new Map<string, FontRecord>();
const fontCatalog = new Map<string, FontMetadata>();
type LocalFont = { family: string; fullName: string; postscriptName: string; style: string; blob(): Promise<Blob> };
const installed = new Map<string, LocalFont>();
let selectedFont: string | null = null;
let activeLibrary: 'layers' | 'fonts' = 'layers';
let pan = false, space = false, historyCommits = 0, pendingShapes = 0;
let dirty = false, autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const shapeGenerations = new Map<string, number>();
let gesture: { pointerId: number; kind: 'pan' | 'move'; start: { x: number; y: number }; origin: { x: number; y: number }; ids: string[]; } | null = null;

function message(text: string, error = false) {
  element('status').textContent = text;
  if (error) {
    const notice = element('notice'); notice.textContent = text; notice.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 12000);
  }
}

function guarded(action: () => void | Promise<void>) {
  return () => { Promise.resolve().then(action).catch(error => message(error instanceof Error ? error.message : String(error), true)); };
}

function currentNodes() { return [...renderer.selection].map(id => scene.get(id)).filter((n): n is DesignNode => !!n); }
function single() { const nodes = currentNodes(); return nodes.length === 1 ? nodes[0] : undefined; }

function select(ids: string[]) {
  renderer.selection = new Set(ids); renderer.request(); updateInspector(); renderLayers();
}

function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (gesture) { autosave(); return; }
    try {
      localStorage.setItem('craft-studio-draft', exportProject(input('project-name').value || 'Untitled design', [...scene.nodes]));
      dirty = false;
      message('Draft saved on this browser. Download a project file for a portable backup.');
    } catch { message('Browser draft could not be saved. Use Save project to download a backup.', true); }
  }, 700);
}

function changed() {
  historyCommits++; dirty = true;
  renderer.selection = new Set([...renderer.selection].filter(id => scene.get(id)));
  renderer.changed(); updateInspector(); renderLayers(); updateControls(); autosave();
}

function updateControls() {
  button('undo').disabled = !scene.canUndo; button('redo').disabled = !scene.canRedo;
  const editable = currentNodes().some(n => !n.locked);
  button('duplicate').disabled = !editable; button('delete').disabled = !editable;
  button('export-svg').disabled = !scene.nodes.some(n => !n.hidden) || pendingShapes > 0;
  button('save-project').disabled = pendingShapes > 0;
  element('empty-state').hidden = scene.nodes.length > 0;
  element('layer-count').textContent = String(scene.nodes.length);
}

function updateInspector() {
  const node = single();
  element('selection-count').textContent = renderer.selection.size ? `${renderer.selection.size} selected` : 'No selection';
  element('selection-hint').hidden = !!node;
  element('object-properties').hidden = !node;
  element('selection-hint').textContent = renderer.selection.size > 1 ? 'Move the selection together. Select one object to edit its properties.' : 'Select an object to change its size or position.';
  if (node) {
    const bounds = nodeBounds(node);
    input('object-name').value = node.name;
    input('object-x').value = bounds.x.toFixed(2); input('object-y').value = bounds.y.toFixed(2);
    input('object-width').value = bounds.width.toFixed(2); input('object-height').value = bounds.height.toFixed(2);
    input('object-rotation').value = (Math.atan2(node.transform[1], node.transform[0]) * 180 / Math.PI).toFixed(1);
    input('object-fill').value = node.fill;
    element('text-properties').hidden = !node.text;
    if (node.text) { element<HTMLTextAreaElement>('object-text').value = node.text.text; input('text-size').value = String(node.text.size); }
    for (const field of element('object-properties').querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input,textarea,button')) field.disabled = node.locked;
  }
  updateControls();
}

function virtualWindow(scroller: HTMLElement, count: number, height: number) {
  const start = Math.max(0, Math.floor(scroller.scrollTop / height) - 3);
  const end = Math.min(count, start + Math.ceil((scroller.clientHeight || 250) / height) + 6);
  return { start, end };
}

function rowFocus(container: HTMLElement): string | undefined {
  return container.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
}
function restoreRowFocus(container: HTMLElement, key: string | undefined) {
  if (!key) return;
  const control = [...container.querySelectorAll<HTMLButtonElement>('button[data-focus-key]')].find(b => b.dataset.focusKey === key);
  control?.focus({ preventScroll: true });
}

function renderLayers() {
  if (activeLibrary !== 'layers') return;
  const nodes = [...scene.nodes].reverse();
  const container = element('layers-content'), scroll = element('layers-scroll');
  const focused = rowFocus(container);
  container.style.height = `${nodes.length * 44}px`;
  element('layers-empty').hidden = nodes.length > 0;
  const { start, end } = virtualWindow(scroll, nodes.length, 44);
  const rows: HTMLElement[] = [];
  for (let i = start; i < end; i++) {
    const node = nodes[i], row = document.createElement('div'); row.className = `layer-row${renderer.selection.has(node.id) ? ' selected' : ''}`; row.style.top = `${i * 44}px`;
    const pick = document.createElement('button'); pick.className = 'layer-select'; pick.setAttribute('aria-pressed', String(renderer.selection.has(node.id)));
    pick.dataset.focusKey = JSON.stringify([node.id, 'select']);
    const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.backgroundColor = node.fill;
    const label = document.createElement('span'); label.textContent = node.name; pick.append(swatch, label);
    pick.onclick = event => select(event.shiftKey ? (renderer.selection.has(node.id) ? [...renderer.selection].filter(id => id !== node.id) : [...renderer.selection, node.id]) : [node.id]);
    const visibility = document.createElement('button'); visibility.className = `row-control${node.hidden ? ' muted' : ''}`; visibility.innerHTML = icon(node.hidden ? 'eye-off' : 'eye'); visibility.setAttribute('aria-label', `${node.hidden ? 'Show' : 'Hide'} ${node.name}`);
    visibility.dataset.focusKey = JSON.stringify([node.id, 'visibility']); visibility.setAttribute('aria-pressed', String(!node.hidden));
    visibility.onclick = () => { scene.update([{ ...node, hidden: !node.hidden }]); changed(); };
    const lock = document.createElement('button'); lock.className = `row-control${node.locked ? ' locked' : ' muted'}`; lock.innerHTML = icon(node.locked ? 'lock' : 'unlock'); lock.setAttribute('aria-label', `${node.locked ? 'Unlock' : 'Lock'} ${node.name}`);
    lock.dataset.focusKey = JSON.stringify([node.id, 'lock']); lock.setAttribute('aria-pressed', String(node.locked));
    lock.onclick = () => { scene.update([{ ...node, locked: !node.locked }]); changed(); };
    row.append(pick, visibility, lock); rows.push(row);
  }
  container.replaceChildren(...rows);
  restoreRowFocus(container, focused);
}

const ensurePromises = new Map<string, Promise<FontRecord>>();
function ensureFont(key: string): Promise<FontRecord> {
  const pending = ensurePromises.get(key);
  if (pending) return pending;
  const work = (async () => {
    let record = records.get(key);
    if (!record && fontCatalog.has(key)) record = await readFont(key);
    if (!record) {
      const local = installed.get(key);
      if (!local) throw new Error('This project needs its original font file for text editing. Import the same TTF/OTF font first.');
      record = await fonts.addFont(await (await local.blob()).arrayBuffer());
      records.set(record.id, record); fontCatalog.set(record.id, { id: record.id, name: record.name });
      try { await saveFont(record); records.delete(record.id); } catch { message('Font is ready in memory, but browser storage failed. Re-import it after reopening.', true); }
    }
    await fonts.loadFont(record);
    return record;
  })();
  ensurePromises.set(key, work);
  void work.then(() => { ensurePromises.delete(key); }, () => { ensurePromises.delete(key); });
  return work;
}

function renderFonts() {
  element('font-count').textContent = String(fontCatalog.size + installed.size);
  if (activeLibrary !== 'fonts') return;
  const term = input('font-search').value.toLocaleLowerCase();
  const choices = [...fontCatalog.values()].map(r => ({ id: r.id, name: r.name, family: null as string | null }))
    .concat([...installed].map(([id, f]) => ({ id, name: f.fullName, family: f.family })))
    .filter(f => f.name.toLocaleLowerCase().includes(term)).sort((a, b) => a.name.localeCompare(b.name));
  const scroll = element('fonts-scroll'), content = element('fonts-content');
  const focused = rowFocus(content);
  content.style.height = `${choices.length * 64}px`;
  element('fonts-empty').hidden = choices.length > 0;
  if (!choices.length) element('fonts-empty').textContent = term ? 'No fonts match this search.' : 'Import a font to add text. Use fonts you are licensed to use.';
  const { start, end } = virtualWindow(scroll, choices.length, 64);
  const rows: HTMLButtonElement[] = [];
  for (let i = start; i < end; i++) {
    const font = choices[i], row = document.createElement('button'); row.className = `font-row${selectedFont === font.id ? ' selected' : ''}`; row.style.top = `${i * 64}px`; row.setAttribute('aria-pressed', String(selectedFont === font.id));
    row.dataset.focusKey = font.id;
    const name = document.createElement('span'); name.className = 'font-name'; name.textContent = font.name;
    const preview = document.createElement('span'); preview.className = 'font-preview'; preview.textContent = 'Aa Bb Cc';
    if (font.family) preview.style.fontFamily = `"${font.family.replaceAll('"', '')}", sans-serif`;
    row.append(name, preview);
    row.onclick = guarded(async () => { selectedFont = font.id; renderFonts();
      if (single()?.text && !single()?.locked) await editText(font.id);
      else message(`${font.name} selected. Choose Text to add outlined text.`);
    });
    rows.push(row);
    if (!font.family) {
      ensureFont(font.id).then(record => row.isConnected ? fonts.preview(record.id) : null).then(result => {
        if (!row.isConnected || !result?.path) return;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const path = document.createElementNS(svg.namespaceURI, 'path');
        const b = result.bounds; svg.setAttribute('viewBox', `${b.x} ${b.y} ${Math.max(b.width, 1)} ${Math.max(b.height, 1)}`); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', result.path); svg.append(path); preview.replaceChildren(svg);
      }).catch(() => { row.title = 'Preview unavailable. Select this font to see its preparation error.'; });
    }
  }
  content.replaceChildren(...rows);
  restoreRowFocus(content, focused);
}

function library(name: 'layers' | 'fonts') {
  activeLibrary = name;
  element('layers-panel').hidden = name !== 'layers'; element('fonts-panel').hidden = name !== 'fonts';
  button('layers-tab').setAttribute('aria-selected', String(name === 'layers')); button('fonts-tab').setAttribute('aria-selected', String(name === 'fonts'));
  button('layers-tab').tabIndex = name === 'layers' ? 0 : -1; button('fonts-tab').tabIndex = name === 'fonts' ? 0 : -1;
  if (name === 'layers') renderLayers(); else renderFonts();
}

async function addText() {
  if (!selectedFont) { library('fonts'); message('Import a font or select an installed font, then choose Text.', true); return; }
  const targetScene = scene;
  pendingShapes++; updateControls();
  try {
    message('Preparing outlined text in a worker…');
    const font = await ensureFont(selectedFont);
    const result = await fonts.shape(font.id, 'Your words', 12);
    if (scene !== targetScene) return;
    const node: DesignNode = { id: crypto.randomUUID(), name: 'Your words', ...result,
      transform: [1, 0, 0, 1, 20 - result.bounds.x, 25 - result.bounds.y], fill: '#284e81', hidden: false, locked: false,
      text: { text: 'Your words', fontId: font.id, fontName: font.name, size: 12 } };
    scene.add([node]); select([node.id]); library('layers'); changed(); renderer.fit();
  } finally { pendingShapes--; updateControls(); }
}

async function editText(fontKey?: string) {
  const node = single(); if (!node?.text || node.locked) return;
  const targetScene = scene;
  const text = element<HTMLTextAreaElement>('object-text').value, size = Number(input('text-size').value);
  const generation = (shapeGenerations.get(node.id) || 0) + 1; shapeGenerations.set(node.id, generation);
  pendingShapes++; updateControls();
  try {
    const font = await ensureFont(fontKey ?? node.text.fontId);
    const result = await fonts.shape(font.id, text, size);
    if (!result.path || result.bounds.width <= 0 || result.bounds.height <= 0) throw new Error('Enter text with visible cuttable outlines. Use Delete to remove an empty text object.');
    const latest = scene.get(node.id);
    if (scene !== targetScene || !latest || latest.locked || shapeGenerations.get(node.id) !== generation) return;
    const oldBounds = nodeBounds(latest);
    const updated = { ...latest, ...result, name: text.slice(0, 40), text: { ...node.text, text, size, fontId: font.id, fontName: font.name } };
    const newBounds = nodeBounds(updated);
    updated.transform = [...latest.transform] as Matrix;
    updated.transform[4] += oldBounds.x - newBounds.x; updated.transform[5] += oldBounds.y - newBounds.y;
    scene.update([updated]); changed();
  } finally { pendingShapes--; updateControls(); }
}

function addShape(kind: 'rectangle' | 'circle' | 'heart') {
  const position = renderer.screenToWorld(renderer.canvas.clientWidth / 2, renderer.canvas.clientHeight / 2);
  const node = shape(kind, position.x - 20, position.y - 15); scene.add([node]); select([node.id]); changed();
}

function setPan(value: boolean) {
  pan = value; renderer.canvas.style.cursor = pan ? 'grab' : 'default';
  for (const [id, active] of [['pan-tool', pan], ['select-tool', !pan]] as const) { button(id).classList.toggle('active', active); button(id).setAttribute('aria-pressed', String(active)); }
}

renderer.canvas.onpointerdown = event => {
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault(); renderer.canvas.focus();
  clearTimeout(autosaveTimer);
  const point = renderer.eventPoint(event);
  if (pan || space || event.button === 1) {
    gesture = { pointerId: event.pointerId, kind: 'pan', start: point, origin: { x: renderer.view.x, y: renderer.view.y }, ids: [] };
  } else {
    const hit = renderer.hit(point.x, point.y);
    if (!hit) { if (!event.shiftKey) select([]); return; }
    if (event.shiftKey) select(renderer.selection.has(hit.id) ? [...renderer.selection].filter(id => id !== hit.id) : [...renderer.selection, hit.id]);
    else if (!renderer.selection.has(hit.id)) select([hit.id]);
    const ids = currentNodes().filter(n => !n.locked && !n.hidden).map(n => n.id);
    if (!ids.length) return;
    if (ids.length !== renderer.selection.size) select(ids);
    gesture = { pointerId: event.pointerId, kind: 'move', start: point, origin: { x: 0, y: 0 }, ids };
    renderer.beginDrag();
  }
  renderer.canvas.setPointerCapture(event.pointerId);
};
renderer.canvas.onpointermove = event => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const point = renderer.eventPoint(event);
  if (gesture.kind === 'pan') {
    renderer.view.x = gesture.origin.x + point.x - gesture.start.x; renderer.view.y = gesture.origin.y + point.y - gesture.start.y;
  } else {
    renderer.delta = { x: (point.x - gesture.start.x) / renderer.view.scale, y: (point.y - gesture.start.y) / renderer.view.scale };
    if (event.shiftKey) { if (Math.abs(renderer.delta.x) > Math.abs(renderer.delta.y)) renderer.delta.y = 0; else renderer.delta.x = 0; }
  }
  renderer.request();
};
function endGesture(cancel = false) {
  if (!gesture) return;
  const current = gesture; gesture = null;
  if (current.kind === 'move' && !cancel && (renderer.delta.x || renderer.delta.y)) {
    scene.update(current.ids.map(id => scene.get(id)).filter((n): n is DesignNode => !!n).map(n => ({ ...n, transform: [n.transform[0], n.transform[1], n.transform[2], n.transform[3], n.transform[4] + renderer.delta.x, n.transform[5] + renderer.delta.y] as Matrix })));
    changed();
  }
  if (cancel && current.kind === 'pan') { renderer.view.x = current.origin.x; renderer.view.y = current.origin.y; }
  renderer.endDrag();
  if (dirty) autosave();
  if (renderer.canvas.hasPointerCapture(current.pointerId)) renderer.canvas.releasePointerCapture(current.pointerId);
}
renderer.canvas.onpointerup = event => { renderer.canvas.onpointermove?.call(renderer.canvas, event); endGesture(); };
renderer.canvas.onpointercancel = () => endGesture(true);
renderer.canvas.onlostpointercapture = () => { if (gesture) endGesture(true); };
window.addEventListener('blur', () => { space = false; endGesture(true); });
renderer.canvas.addEventListener('wheel', event => {
  event.preventDefault(); if (gesture) return;
  const point = renderer.eventPoint(event);
  if (event.ctrlKey || event.metaKey) renderer.zoom(Math.exp(-event.deltaY * 0.004), point.x, point.y);
  else { renderer.view.x -= event.deltaX; renderer.view.y -= event.deltaY; renderer.request(); }
}, { passive: false });

function duplicate() {
  const nodes = currentNodes().filter(n => !n.locked).map(n => ({ ...n, id: crypto.randomUUID(), name: `${n.name} copy`, transform: [...n.transform] as Matrix }));
  for (const node of nodes) { node.transform[4] += 8; node.transform[5] += 8; }
  if (nodes.length) { scene.add(nodes); select(nodes.map(n => n.id)); changed(); }
}
function removeSelection() { const ids = new Set(currentNodes().filter(n => !n.locked).map(n => n.id)); if (ids.size) { scene.remove(ids); select([]); changed(); } }
function undo() { endGesture(true); if (scene.undo()) changed(); }
function redo() { endGesture(true); if (scene.redo()) changed(); }
window.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  const editingContext = event.target === renderer.canvas || (event.target instanceof HTMLElement && !!event.target.closest('.layer-select'));
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (pendingShapes) { message('Wait for outlined text preparation to finish before saving.', true); return; }
    try { saveProject(); } catch (error) { message(error instanceof Error ? error.message : String(error), true); }
    return;
  }
  if (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)) return;
  if (event.code === 'Space' && !(event.target instanceof HTMLElement && event.target.closest('button'))) { space = true; event.preventDefault(); }
  if (event.key === 'Escape') { endGesture(true); select([]); }
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  else if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); }
  else if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); select(scene.nodes.filter(n => !n.hidden && !n.locked).map(n => n.id)); }
  else if (editingContext && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); removeSelection(); }
  else if (event.key.toLowerCase() === 'v') setPan(false);
  else if (event.key.toLowerCase() === 'h') setPan(true);
  else if (editingContext && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const distance = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
    const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
    const nodes = currentNodes().filter(n => !n.locked).map(n => ({ ...n, transform: [n.transform[0], n.transform[1], n.transform[2], n.transform[3], n.transform[4] + dx, n.transform[5] + dy] as Matrix }));
    if (nodes.length) { scene.update(nodes); changed(); }
  }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') space = false; });

for (const id of ['object-x', 'object-y', 'object-width', 'object-height', 'object-rotation', 'object-fill', 'object-name']) {
  input(id).onchange = guarded(() => {
    const node = single(); if (!node || node.locked) return;
    const updated = { ...node, transform: [...node.transform] as Matrix };
    const bounds = nodeBounds(node), value = Number(input(id).value);
    if (id === 'object-fill') updated.fill = input(id).value;
    else if (id === 'object-name') updated.name = input(id).value || 'Object';
    else {
      if (!Number.isFinite(value) || Math.abs(value) > 10000) { updateInspector(); throw new Error('Use a finite measurement within 10,000 mm.'); }
      if (id === 'object-x') updated.transform[4] += value - bounds.x;
      if (id === 'object-y') updated.transform[5] += value - bounds.y;
      if (id === 'object-width' || id === 'object-height') {
        if (value <= 0) { updateInspector(); throw new Error('Width and height must be greater than zero.'); }
        const sx = id === 'object-width' ? value / Math.max(bounds.width, 0.001) : 1;
        const sy = id === 'object-height' ? value / Math.max(bounds.height, 0.001) : 1;
        updated.transform = multiply([sx, 0, 0, sy, bounds.x * (1 - sx), bounds.y * (1 - sy)], node.transform);
      }
      if (id === 'object-rotation') {
        const angle = value * Math.PI / 180 - Math.atan2(node.transform[1], node.transform[0]);
        const c = Math.cos(angle), s = Math.sin(angle), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
        updated.transform = multiply([c, s, -s, c, x - c * x + s * y, y - s * x - c * y], node.transform);
      }
    }
    scene.update([updated]); changed();
  });
}

function download(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileStem() { return (input('project-name').value || 'design').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'design'; }
function saveProject() {
  download(exportProject(input('project-name').value || 'Untitled design', [...scene.nodes]), `${fileStem()}.craft.json`, 'application/json');
  message('Project download requested. Outlines are included; original fonts are needed for text edits on another device.');
}
function replaceProject(name: string, nodes: DesignNode[]) {
  endGesture(true); clearTimeout(autosaveTimer);
  scene = new Scene(nodes); renderer.scene = scene; select([]); input('project-name').value = name;
  shapeGenerations.clear();
  changed(); renderer.fit();
}
button('new-project').onclick = () => { if (scene.nodes.length && !confirm('Start a new design? Download a project file first if you want to keep this one.')) return; replaceProject('Untitled design', []); };
button('open-project').onclick = () => input('project-file').click();
button('save-project').onclick = guarded(saveProject);
button('export-svg').onclick = guarded(() => { download(exportSvg([...scene.nodes]), `${fileStem()}.svg`, 'image/svg+xml'); message('SVG download requested. Verify size and paths in Design Space before cutting.'); });
button('import-svg').onclick = () => input('svg-file').click();
button('import-font').onclick = () => input('font-file').click();
button('local-fonts').onclick = guarded(async () => {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
  if (!query) throw new Error('Installed-font access is not supported here. Import TTF/OTF files instead, or try current desktop Edge/Chrome.');
  message('Waiting for your browser’s font permission…');
  const local = await query.call(window);
  for (const f of local) installed.set(`local:${f.postscriptName}`, f);
  renderFonts(); message(`${local.length} installed font faces indexed. Font bytes are loaded only when you select one for text.`);
});
for (const id of ['svg-file', 'font-file', 'project-file']) input(id).onchange = guarded(async () => {
  const files = [...(input(id).files || [])]; input(id).value = '';
  for (const file of files) {
    if (file.size > (id === 'font-file' ? 16 : 10) * 1024 * 1024) throw new Error('This file exceeds the import limit (16 MB fonts / 10 MB designs).');
    if (id === 'svg-file') { const nodes = importSvg(await file.text(), file.name); scene.add(nodes); select(nodes.map(n => n.id)); changed(); renderer.fit(); message(`${nodes.length} SVG objects imported. Physical dimensions preserved; verify before cutting.`); }
    else if (id === 'project-file') {
      const project = parseProject(await file.text());
      if (scene.nodes.length && !confirm('Opening this project will replace the current design and its browser draft. Download a project backup first if you want to keep it. Continue?')) continue;
      replaceProject(project.name, project.nodes);
    }
    else {
      message(`Preparing ${file.name}…`); const record = await fonts.addFont(await file.arrayBuffer()); records.set(record.id, record); fontCatalog.set(record.id, { id: record.id, name: record.name }); selectedFont = record.id;
      try { await saveFont(record); records.delete(record.id); message(`${record.name} imported and saved on this device.`); }
      catch { message(`${record.name} is available for this session, but font storage failed. Keep the original file.`, true); }
      library('fonts'); renderFonts();
    }
  }
});
button('select-tool').onclick = () => setPan(false); button('pan-tool').onclick = () => setPan(true);
button('add-text').onclick = guarded(addText); button('apply-text').onclick = guarded(() => editText());
for (const kind of ['rectangle', 'circle', 'heart'] as const) button(`add-${kind}`).onclick = guarded(() => addShape(kind));
button('undo').onclick = undo; button('redo').onclick = redo; button('duplicate').onclick = guarded(duplicate); button('delete').onclick = removeSelection;
button('fit').onclick = () => renderer.fit(); button('zoom-out').onclick = () => renderer.zoom(1 / 1.2); button('zoom-in').onclick = () => renderer.zoom(1.2);
button('layers-tab').onclick = () => library('layers'); button('fonts-tab').onclick = () => library('fonts');
button('fonts-tab').tabIndex = -1;
for (const id of ['layers-tab', 'fonts-tab']) button(id).addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'layers' : event.key === 'End' ? 'fonts' : activeLibrary === 'layers' ? 'fonts' : 'layers';
  library(next); button(`${next}-tab`).focus();
});
button('load-sample').onclick = () => { const nodes = sample(); scene.add(nodes); changed(); renderer.fit(); message('Sample shapes added. Edit them or delete them to start your own design.'); };
element('layers-scroll').onscroll = renderLayers; element('fonts-scroll').onscroll = renderFonts; input('font-search').oninput = renderFonts;
input('project-name').onchange = () => { dirty = true; autosave(); };
new ResizeObserver(() => { renderLayers(); renderFonts(); }).observe(element('layers-panel'));
setInterval(() => { element('zoom-value').textContent = `${Math.round(renderer.view.scale / (96 / 25.4) * 100)}%`; }, 500);
window.addEventListener('beforeunload', event => { if (dirty || pendingShapes) { event.preventDefault(); event.returnValue = ''; } });

try { const draft = localStorage.getItem('craft-studio-draft'); if (draft) { const project = parseProject(draft); scene = new Scene(project.nodes); renderer.scene = scene; input('project-name').value = project.name; renderer.changed(); message('Restored your local draft.'); } }
catch { message('The local draft could not be restored. Open a saved project file instead.', true); }
listFontMetadata().then(saved => { for (const record of saved) fontCatalog.set(record.id, record); selectedFont ??= saved[0]?.id || null; renderFonts(); }).catch(() => message('Font storage is unavailable. Imported fonts can still be used for this session.', true));
updateInspector(); renderLayers();

if (import.meta.env.DEV) {
  Object.defineProperty(window, '__craftDebug', { value: {
    stats: () => ({ nodes: scene.nodes.length, historyCommits, frames: renderer.frameCount, staticBuilds: renderer.staticBuildCount, visible: renderer.visibleCount, renderTimes: [...renderer.renderTimes] }),
    fixture: (count: number) => { if (count < 1 || count > 10000) throw new Error('Fixture limit is 10,000 objects.'); const nodes = Array.from({ length: count }, (_, i) => shape('rectangle', (i % 100) * 50, Math.floor(i / 100) * 40)); replaceProject(`Synthetic ${count}-object fixture`, nodes); },
    editingView: () => { select([]); renderer.view = { x: 70, y: 70, scale: 3 }; renderer.renderTimes.length = 0; renderer.changed(); },
    dragPoint: () => {
      const box = renderer.canvas.getBoundingClientRect();
      const node = scene.query(renderer.viewport()).find(n => {
        const b = nodeBounds(n), x = renderer.view.x + (b.x + b.width / 2) * renderer.view.scale,
          y = renderer.view.y + (b.y + b.height / 2) * renderer.view.scale;
        return x > 40 && x < box.width - 40 && y > 40 && y < box.height - 40;
      });
      if (!node) throw new Error('No fixture object is visible.');
      const b = nodeBounds(node);
      return { x: box.x + renderer.view.x + (b.x + b.width / 2) * renderer.view.scale,
        y: box.y + renderer.view.y + (b.y + b.height / 2) * renderer.view.scale };
    },
  } });
}
