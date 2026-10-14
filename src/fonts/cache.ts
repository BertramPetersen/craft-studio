export type ShapeCacheOptions<T> = {
  maxActive?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxPending?: number;
  sizeOf?: (value: T) => number;
};

type Pending<T> = {
  key: string;
  work: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  cancelled: boolean;
};

export function shapeKey(fontId: string, text: string, size: number): string {
  return JSON.stringify([fontId, text, size]);
}

/** Singleflight work scheduling plus an LRU of completed, immutable results. */
export class ShapeCache<T> {
  private readonly ready = new Map<string, { value: T; bytes: number }>();
  private readonly pending = new Map<string, Pending<T>>();
  private readonly queue: Pending<T>[] = [];
  private readonly maxActive: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxPending: number;
  private readonly sizeOf: (value: T) => number;
  private active = 0;
  private bytes = 0;
  private disposed = false;

  constructor(options: ShapeCacheOptions<T> = {}) {
    this.maxActive = options.maxActive ?? 2;
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxPending = options.maxPending ?? 256;
    this.sizeOf = options.sizeOf ?? ((value) => (JSON.stringify(value)?.length ?? 0) * 2);
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1 || this.maxActive > 2) {
      throw new Error('Shape concurrency must be 1 or 2.');
    }
    for (const budget of [this.maxEntries, this.maxBytes, this.maxPending]) {
      if (!Number.isSafeInteger(budget) || budget < 0) {
        throw new Error('Cache budgets must be nonnegative safe integers.');
      }
    }
  }

  request(fontId: string, text: string, size: number, work: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Font cache is disposed.'));
    const key = shapeKey(fontId, text, size);
    const hit = this.ready.get(key);
    if (hit) {
      this.ready.delete(key);
      this.ready.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('Too many pending font requests. Please retry.'));
    }
    let resolve!: Pending<T>['resolve'];
    let reject!: Pending<T>['reject'];
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const entry: Pending<T> = { key, work, promise, resolve, reject, cancelled: false };
    this.pending.set(key, entry);
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  clear(reason: Error = new Error('Font cache was cleared.')): void {
    this.ready.clear();
    this.bytes = 0;
    for (const entry of this.pending.values()) {
      entry.cancelled = true;
      entry.reject(reason);
    }
    this.pending.clear();
    this.queue.length = 0;
  }

  dispose(reason: Error = new Error('Font cache is disposed.')): void {
    this.disposed = true;
    this.clear(reason);
  }

  private pump(): void {
    while (!this.disposed && this.active < this.maxActive && this.queue.length) {
      const entry = this.queue.shift()!;
      this.active++;
      void Promise.resolve().then(() => {
        if (entry.cancelled) throw new Error('Font request was cancelled.');
        return entry.work();
      }).then((value) => {
        if (entry.cancelled) return;
        const valueBytes = this.sizeOf(value);
        const bytes = valueBytes + entry.key.length * 2;
        if (Number.isFinite(valueBytes) && valueBytes >= 0 && bytes <= this.maxBytes && this.maxEntries > 0) {
          this.ready.set(entry.key, { value, bytes });
          this.bytes += bytes;
          while (this.ready.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.ready.keys().next().value!;
            this.bytes -= this.ready.get(oldest)!.bytes;
            this.ready.delete(oldest);
          }
        }
        if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
        entry.resolve(value);
      }).catch((error: unknown) => {
        if (!entry.cancelled) {
          if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
          entry.reject(error);
        }
      }).finally(() => {
        if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
        this.active--;
        this.pump();
      });
    }
  }
}
