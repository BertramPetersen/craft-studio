import type { Bounds, FontRecord } from '../core/types';
import { ShapeCache } from './cache';

export type ShapeResult = { path: string; bounds: Bounds };

export type FontRequest =
  | { id: number; type: 'add'; bytes: ArrayBuffer }
  | { id: number; type: 'load'; record: FontRecord }
  | { id: number; type: 'shape'; fontId: string; text: string; size: number };

export type FontResponse =
  | { id: number; ok: true; value: { id: string; name: string; evicted?: string[] } | ShapeResult | null }
  | { id: number; ok: false; error: string };

const MAX_FONT_BYTES = 16 * 1024 * 1024;

function checkBytes(bytes: ArrayBuffer): void {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_FONT_BYTES) {
    throw new Error('Choose a nonempty TTF or OTF font of at most 16 MB.');
  }
}

export class FontClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, {
    resolve: (value: FontResponse & { ok: true }) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly shapes = new ShapeCache<ShapeResult>({
    maxActive: 1,
    sizeOf: (value) => value.path.length * 2 + 128,
  });
  private readonly previews = new ShapeCache<ShapeResult>({
    maxActive: 1,
    maxPending: 32,
    sizeOf: value => value.path.length * 2 + 128,
  });
  private sequence = 0;
  private failure: Error | null = null;
  private fontLoads = new Map<string, Promise<void>>();

  constructor() {
    if (typeof Worker === 'undefined') throw new Error('Font processing requires Web Worker support.');
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FontResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response?.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok && response.value && 'evicted' in response.value) {
        for (const id of response.value.evicted ?? []) this.fontLoads.delete(id);
      }
      if (response.ok) pending.resolve(response);
      else pending.reject(new Error(response.error));
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || 'The font worker failed. Reload to try again.'));
    };
    this.worker.onmessageerror = () => this.fail(new Error('The font worker returned unreadable data.'));
  }

  async addFont(bytes: ArrayBuffer): Promise<FontRecord> {
    checkBytes(bytes);
    const savedBytes = bytes.slice(0);
    // Only this disposable copy is transferred; the record remains usable for IndexedDB.
    const workerBytes = savedBytes.slice(0);
    const response = await this.send({ id: this.nextId(), type: 'add', bytes: workerBytes }, [workerBytes]);
    const metadata = response.value as { id: string; name: string };
    this.fontLoads.set(metadata.id, Promise.resolve());
    return { id: metadata.id, name: metadata.name, bytes: savedBytes };
  }

  async loadFont(record: FontRecord): Promise<void> {
    checkBytes(record.bytes);
    const pending = this.fontLoads.get(record.id);
    if (pending) return pending;
    const bytes = record.bytes.slice(0);
    const work = this.send({ id: this.nextId(), type: 'load', record: { ...record, bytes } }, [bytes]).then(() => {});
    this.fontLoads.set(record.id, work);
    try { await work; } catch (error) { this.fontLoads.delete(record.id); throw error; }
  }

  shape(fontId: string, text: string, size: number): Promise<ShapeResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (typeof fontId !== 'string' || !fontId || typeof text !== 'string' || text.length > 1000 || [...text].length > 500) {
      return Promise.reject(new Error('Text must contain at most 500 characters and use a loaded font.'));
    }
    if (!Number.isFinite(size) || size < 1 || size > 200) {
      return Promise.reject(new Error('Font size must be between 1 and 200 mm.'));
    }
    return this.shapes.request(fontId, text, size, () => this.processShape(fontId, text, size));
  }

  preview(fontId: string, text = 'Aa Bb Cc'): Promise<ShapeResult> {
    if (this.failure) return Promise.reject(this.failure);
    // Catalog previews cannot fill the queue used by an explicit text edit.
    return this.previews.request(fontId, text, 10, () => this.processShape(fontId, text, 10));
  }

  private async processShape(fontId: string, text: string, size: number): Promise<ShapeResult> {
    const response = await this.send({ id: this.nextId(), type: 'shape', fontId, text, size });
    const result = response.value as ShapeResult;
    Object.freeze(result.bounds);
    return Object.freeze(result);
  }

  dispose(): void {
    this.fail(new Error('Font client is disposed.'));
  }

  private nextId(): number {
    return ++this.sequence;
  }

  private send(message: FontRequest, transfer: Transferable[] = []): Promise<FontResponse & { ok: true }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Font preparation exceeded 15 seconds. Your existing outlines are safe; reload and try a simpler font.')), 15000);
      this.pending.set(message.id, { resolve, reject, timer });
      try {
        this.worker.postMessage(message, transfer);
      } catch (error) {
        this.pending.delete(message.id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.fontLoads.clear();
    this.shapes.dispose(error);
    this.previews.dispose(error);
  }
}
