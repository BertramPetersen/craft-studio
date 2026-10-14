import { Scene, inverse, nodeBounds, transformPoint } from '../core/scene';
import type { Bounds, DesignNode } from '../core/types';

type Segment = { canvas: HTMLCanvasElement } | { node: DesignNode };
export type View = { x: number; y: number; scale: number };

export class CanvasView {
  view: View = { x: 70, y: 70, scale: 3 };
  selection = new Set<string>();
  delta = { x: 0, y: 0 };
  renderTimes: number[] = [];
  frameCount = 0;
  staticBuildCount = 0;
  visibleCount = 0;
  private ctx: CanvasRenderingContext2D;
  private hitCtx = document.createElement('canvas').getContext('2d')!;
  private paths = new Map<string, { source: string; path: Path2D }>();
  private segments: Segment[] | null = null;
  private raf = 0;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private observer: ResizeObserver;

  constructor(public canvas: HTMLCanvasElement, public scene: Scene) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser does not support Canvas2D. Try current Edge or Chrome.');
    this.ctx = ctx;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * this.ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.ratio));
    this.segments = null;
    this.request();
  }

  changed() {
    const ids = new Set(this.scene.nodes.map(node => node.id));
    for (const id of this.paths.keys()) if (!ids.has(id)) this.paths.delete(id);
    this.segments = null;
    this.request();
  }

  path(node: DesignNode) {
    const cached = this.paths.get(node.id);
    if (cached?.source === node.path) return cached.path;
    const path = new Path2D(node.path);
    this.paths.set(node.id, { source: node.path, path });
    return path;
  }

  screenToWorld(x: number, y: number) {
    return { x: (x - this.view.x) / this.view.scale, y: (y - this.view.y) / this.view.scale };
  }

  eventPoint(event: PointerEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  viewport(): Bounds {
    return { x: -this.view.x / this.view.scale, y: -this.view.y / this.view.scale,
      width: this.width / this.view.scale, height: this.height / this.view.scale };
  }

  hit(x: number, y: number) {
    const point = this.screenToWorld(x, y);
    const candidates = this.scene.query({ x: point.x - 1, y: point.y - 1, width: 2, height: 2 });
    for (const node of [...candidates].reverse()) {
      if (node.locked || node.hidden) continue;
      const inv = inverse(node.transform);
      if (!inv) continue;
      const local = transformPoint(inv, point.x, point.y);
      if (this.hitCtx.isPointInPath(this.path(node), local.x, local.y, 'nonzero')) return node;
    }
  }

  selectionBounds(): Bounds | null {
    const nodes = [...this.selection].map(id => this.scene.get(id)).filter((n): n is DesignNode => !!n && !n.hidden);
    if (!nodes.length) return null;
    const bounds = nodes.map(nodeBounds);
    const x = Math.min(...bounds.map(b => b.x)), y = Math.min(...bounds.map(b => b.y));
    return { x, y, width: Math.max(...bounds.map(b => b.x + b.width)) - x,
      height: Math.max(...bounds.map(b => b.y + b.height)) - y };
  }

  beginDrag() {
    this.delta = { x: 0, y: 0 };
    // Cache paint-order runs, not just a single background, so occlusion stays correct.
    const visible = this.scene.query(this.viewport());
    const visibleIds = new Set(visible.map(node => node.id));
    const nodes = this.scene.nodes.filter(n => !n.hidden && (this.selection.has(n.id) || visibleIds.has(n.id)));
    this.visibleCount = visible.length;
    let runs = 0, inRun = false;
    for (const node of nodes) {
      if (this.selection.has(node.id)) inRun = false;
      else if (!inRun) { runs++; inRun = true; }
    }
    // Interleaved selections must not allocate an unbounded number of viewport rasters.
    if (runs * this.canvas.width * this.canvas.height * 4 > 64 * 1024 * 1024) {
      this.segments = nodes.map(node => ({ node }));
      this.request();
      return;
    }
    this.segments = [];
    let run: HTMLCanvasElement | null = null;
    for (const node of nodes) {
      if (this.selection.has(node.id)) {
        run = null;
        this.segments.push({ node });
      } else {
        if (!run) {
          run = document.createElement('canvas');
          run.width = this.canvas.width;
          run.height = this.canvas.height;
          this.segments.push({ canvas: run });
        }
        this.drawNode(run.getContext('2d')!, node);
      }
    }
    this.staticBuildCount++;
    this.request();
  }

  endDrag() { this.segments = null; this.delta = { x: 0, y: 0 }; this.request(); }

  zoom(factor: number, x = this.width / 2, y = this.height / 2) {
    const point = this.screenToWorld(x, y);
    this.view.scale = Math.max(0.2, Math.min(32, this.view.scale * factor));
    this.view.x = x - point.x * this.view.scale;
    this.view.y = y - point.y * this.view.scale;
    this.segments = null;
    this.request();
  }

  fit() {
    const bounds = this.scene.nodes.filter(n => !n.hidden).map(nodeBounds);
    if (!bounds.length) { this.view = { x: 70, y: 70, scale: 3 }; this.request(); return; }
    const left = Math.min(...bounds.map(b => b.x)), top = Math.min(...bounds.map(b => b.y));
    const width = Math.max(...bounds.map(b => b.x + b.width)) - left;
    const height = Math.max(...bounds.map(b => b.y + b.height)) - top;
    this.view.scale = Math.max(0.2, Math.min(12, Math.min((this.width - 120) / Math.max(width, 1), (this.height - 120) / Math.max(height, 1))));
    this.view.x = (this.width - width * this.view.scale) / 2 - left * this.view.scale;
    this.view.y = (this.height - height * this.view.scale) / 2 - top * this.view.scale;
    this.segments = null;
    this.request();
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private drawNode(ctx: CanvasRenderingContext2D, node: DesignNode, dx = 0, dy = 0) {
    const [a, b, c, d, e, f] = node.transform;
    const s = this.view.scale, r = this.ratio;
    ctx.setTransform(r * s * a, r * s * b, r * s * c, r * s * d,
      r * (this.view.x + s * (e + dx)), r * (this.view.y + s * (f + dy)));
    ctx.fillStyle = node.fill;
    ctx.fill(this.path(node), 'nonzero');
  }

  private grid() {
    const ctx = this.ctx;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, this.width, this.height);
    const step = (this.view.scale < 1 ? 50 : 10) * this.view.scale;
    ctx.beginPath();
    for (let x = ((this.view.x % step) + step) % step; x < this.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, this.height); }
    for (let y = ((this.view.y % step) + step) % step; y < this.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(this.width, y); }
    ctx.strokeStyle = '#dce1e8'; ctx.lineWidth = 0.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(this.view.x, 0); ctx.lineTo(this.view.x, this.height);
    ctx.moveTo(0, this.view.y); ctx.lineTo(this.width, this.view.y);
    ctx.strokeStyle = '#a8b4c6'; ctx.stroke();
    ctx.fillStyle = '#56677e'; ctx.font = '10px system-ui';
    for (let x = Math.ceil(-this.view.x / step) * step; x + this.view.x < this.width; x += step) {
      ctx.fillText(String(Math.round(x / this.view.scale)), x + this.view.x + 4, 13);
    }
    ctx.fillText('mm', 8, 13);
  }

  private render() {
    const started = performance.now();
    this.grid();
    if (this.segments) {
      for (const segment of this.segments) {
        if ('canvas' in segment) { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.drawImage(segment.canvas, 0, 0); }
        else this.drawNode(this.ctx, segment.node, this.selection.has(segment.node.id) ? this.delta.x : 0,
          this.selection.has(segment.node.id) ? this.delta.y : 0);
      }
    } else {
      const nodes = this.scene.query(this.viewport()).filter(n => !n.hidden);
      this.visibleCount = nodes.length;
      for (const node of nodes) this.drawNode(this.ctx, node);
    }
    const bounds = this.selectionBounds();
    if (bounds) {
      this.ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      const x = this.view.x + (bounds.x + this.delta.x) * this.view.scale;
      const y = this.view.y + (bounds.y + this.delta.y) * this.view.scale;
      const w = bounds.width * this.view.scale, h = bounds.height * this.view.scale;
      this.ctx.strokeStyle = '#315ec7'; this.ctx.lineWidth = 1.5; this.ctx.setLineDash([4, 3]);
      this.ctx.strokeRect(x, y, w, h); this.ctx.setLineDash([]);
    }
    this.frameCount++;
    this.renderTimes.push(performance.now() - started);
    if (this.renderTimes.length > 180) this.renderTimes.shift();
  }

  dispose() { this.observer.disconnect(); cancelAnimationFrame(this.raf); this.paths.clear(); this.segments = null; }
}
