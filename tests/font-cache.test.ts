import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as opentype from 'opentype.js';
import { ShapeCache, shapeKey } from '../src/fonts/cache';
import { FontClient } from '../src/fonts/client';
import type { FontRequest, FontResponse, ShapeResult } from '../src/fonts/client';

vi.mock('opentype.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('opentype.js')>();
  const parse = vi.fn(original.parse);
  // 1.3.x publishes a CommonJS entry as well as named ESM exports.
  return { ...original, parse, default: { ...original, parse } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}

describe('font shape cache', () => {
  it('singleflights pending work and reuses completed results', async () => {
    const cache = new ShapeCache<string>();
    const pending = deferred<string>();
    let calls = 0;
    const work = () => { calls++; return pending.promise; };
    const first = cache.request('font', 'Hello', 10, work);
    const duplicate = cache.request('font', 'Hello', 10, work);
    expect(first).toBe(duplicate);
    await flush();
    expect(calls).toBe(1);
    pending.resolve('outline');
    expect(await first).toBe('outline');
    expect(await cache.request('font', 'Hello', 10, work)).toBe('outline');
    expect(calls).toBe(1);
  });

  it('never runs more than two requests concurrently', async () => {
    const cache = new ShapeCache<number>();
    const jobs = Array.from({ length: 6 }, () => deferred<number>());
    let active = 0;
    let peak = 0;
    let started = 0;
    const promises = jobs.map((job, index) => cache.request('font', String(index), 10, async () => {
      started++;
      active++;
      peak = Math.max(peak, active);
      try { return await job.promise; } finally { active--; }
    }));
    await flush();
    expect(started).toBe(2);
    for (let index = 0; index < jobs.length; index++) {
      jobs[index].resolve(index);
      await flush();
    }
    expect(await Promise.all(promises)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('separates font ID, exact text, and size without delimiter collisions', async () => {
    const cache = new ShapeCache<number>();
    let calls = 0;
    const work = async () => ++calls;
    expect(await cache.request('a', 'text', 10, work)).toBe(1);
    expect(await cache.request('b', 'text', 10, work)).toBe(2);
    expect(await cache.request('a', 'text ', 10, work)).toBe(3);
    expect(await cache.request('a', 'text', 11, work)).toBe(4);
    expect(shapeKey('a|b', 'c', 10)).not.toBe(shapeKey('a', 'b|c', 10));
  });

  it('evicts rejected pending requests so an immediate retry succeeds', async () => {
    const cache = new ShapeCache<string>();
    let calls = 0;
    const work = async () => {
      if (++calls === 1) throw new Error('parse failed');
      return 'retry';
    };
    await expect(cache.request('font', 'x', 10, work)).rejects.toThrow('parse failed');
    await expect(cache.request('font', 'x', 10, work)).resolves.toBe('retry');
    expect(calls).toBe(2);
  });

  it('evicts least recently used entries to enforce item count', async () => {
    const cache = new ShapeCache<number>({ maxEntries: 2 });
    let calls = 0;
    const get = (text: string) => cache.request('font', text, 10, async () => ++calls);
    expect(await get('a')).toBe(1);
    expect(await get('b')).toBe(2);
    expect(await get('a')).toBe(1);
    expect(await get('c')).toBe(3);
    expect(await get('b')).toBe(4);
  });

  it('enforces the memory budget and never retains oversized results', async () => {
    const cache = new ShapeCache<string>({ maxBytes: 50, sizeOf: (value) => value.length });
    let calls = 0;
    const get = (text: string) => cache.request('font', text, 10, async () => { calls++; return text; });
    await get('aaa');
    await get('bbb');
    await get('aaa');
    expect(calls).toBe(3);
    await get('oversized');
    await flush();
    await get('oversized');
    expect(calls).toBe(5);
  });

  it('clearing rejects queued work and ignores late active results', async () => {
    const cache = new ShapeCache<string>({ maxActive: 1 });
    const old = deferred<string>();
    const first = cache.request('font', 'a', 10, () => old.promise);
    let queuedCalls = 0;
    const queued = cache.request('font', 'b', 10, async () => { queuedCalls++; return 'b'; });
    const failures = Promise.all([
      expect(first).rejects.toThrow('cleared'),
      expect(queued).rejects.toThrow('cleared'),
    ]);
    await flush();
    cache.clear();
    await failures;
    const fresh = cache.request('font', 'a', 10, async () => 'new');
    old.resolve('stale');
    expect(await fresh).toBe('new');
    expect(queuedCalls).toBe(0);
  });

  it('bounds pending work and rejects requests after disposal', async () => {
    const cache = new ShapeCache<string>({ maxPending: 1 });
    const job = deferred<string>();
    const pending = cache.request('font', 'a', 10, () => job.promise);
    const failure = expect(pending).rejects.toThrow('disposed');
    await expect(cache.request('font', 'b', 10, async () => 'b')).rejects.toThrow('Too many pending');
    cache.dispose();
    await failure;
    await expect(cache.request('font', 'c', 10, async () => 'c')).rejects.toThrow('disposed');
    job.resolve('late');
    await flush();
  });
});

describe('font worker', () => {
  const responses = new Map<number, (response: FontResponse) => void>();
  const scope = {
    crypto: globalThis.crypto,
    onmessage: null as null | ((event: MessageEvent<FontRequest>) => void),
    postMessage: (response: FontResponse) => {
      const resolve = responses.get(response.id);
      responses.delete(response.id);
      resolve?.(response);
    },
  };
  let sequence = 100;
  let fontBytes: ArrayBuffer;
  let fontId: string;
  let parseCalls: () => number;

  function send(request: FontRequest): Promise<FontResponse> {
    return new Promise((resolve) => {
      responses.set(request.id, resolve);
      scope.onmessage!({ data: request } as MessageEvent<FontRequest>);
    });
  }

  beforeAll(async () => {
    // These outlines are original test geometry, not an extracted third-party font.
    const path = new opentype.Path();
    path.moveTo(0, 0);
    path.lineTo(300, 700);
    path.lineTo(600, 0);
    path.close();
    const font = new opentype.Font({
      familyName: 'Original Test', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200,
      glyphs: [
        new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path }),
        new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: 250, path: new opentype.Path() }),
        new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 650, path }),
      ],
    });
    fontBytes = font.toArrayBuffer();
    parseCalls = () => vi.mocked(opentype.parse).mock.calls.length;
    vi.stubGlobal('self', scope);
    await import('../src/fonts/worker');
    const response = await send({ id: ++sequence, type: 'add', bytes: fontBytes });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    fontId = (response.value as { id: string }).id;
    expect(parseCalls()).toBe(1);
  });

  afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('uses the content SHA-256 ID and metadata name for repeat imports', async () => {
    const before = parseCalls();
    const response = await send({ id: ++sequence, type: 'add', bytes: fontBytes.slice(0) });
    const digest = await globalThis.crypto.subtle.digest('SHA-256', fontBytes);
    const expectedId = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    expect(response).toEqual({ id: sequence, ok: true, value: { id: expectedId, name: 'Original Test Regular', evicted: [] } });
    expect(fontId).toBe(expectedId);
    expect(parseCalls()).toBe(before);
  });

  it('reuses the parsed font during concurrent import and reload requests', async () => {
    const before = parseCalls();
    const ids = [++sequence, ++sequence, ++sequence];
    const results = await Promise.all([
      send({ id: ids[0], type: 'add', bytes: fontBytes.slice(0) }),
      send({ id: ids[1], type: 'add', bytes: fontBytes.slice(0) }),
      send({ id: ids[2], type: 'load', record: { id: fontId, name: 'metadata is authoritative', bytes: fontBytes.slice(0) } }),
    ]);
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(parseCalls()).toBe(before);
  });

  it('returns original request IDs on parsing and saved-content errors', async () => {
    const invalid = await send({ id: 782, type: 'add', bytes: new ArrayBuffer(12) });
    expect(invalid).toMatchObject({ id: 782, ok: false });
    const mismatch = await send({ id: 915, type: 'load', record: { id: 'wrong', name: 'ignored', bytes: fontBytes } });
    expect(mismatch).toMatchObject({ id: 915, ok: false });
    if (!mismatch.ok) expect(mismatch.error).toContain('does not match');
  });

  it('produces outline paths with millimetre bounds', async () => {
    const response = await send({ id: ++sequence, type: 'shape', fontId, text: 'A', size: 10 });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const result = response.value as ShapeResult;
    expect(result.path).toContain('M');
    expect(result.bounds).toEqual({ x: 0, y: -7, width: 6, height: 7 });
  });

  it('preserves empty and space-only text without manufacturing outlines', async () => {
    const blank = await send({ id: ++sequence, type: 'shape', fontId, text: '', size: 10 });
    expect(blank).toMatchObject({ ok: true, value: { path: '', bounds: { width: 0, height: 0 } } });
    const spaces = await send({ id: ++sequence, type: 'shape', fontId, text: '   ', size: 10 });
    expect(spaces).toMatchObject({ ok: true, value: { path: '', bounds: { x: 0, y: -8, width: 7.5, height: 10 } } });
  });

  it.each(['אב', 'مرحبا', 'क', 'ก', 'a\u0301', 'A\u200dA', '🇩🇰'])('rejects unsupported shaping-dependent text %s', async (text) => {
    const response = await send({ id: ++sequence, type: 'shape', fontId, text, size: 10 });
    expect(response).toMatchObject({ id: sequence, ok: false });
    if (!response.ok) expect(response.error).toMatch(/shaping|joining/);
  });

  it('rejects missing glyphs, excessive text, and invalid mm sizes', async () => {
    for (const [text, size] of [['B', 10], ['A'.repeat(501), 10], ['A', 0], ['A', 201], ['A', NaN]] as const) {
      expect(await send({ id: ++sequence, type: 'shape', fontId, text, size })).toMatchObject({ ok: false });
    }
  });
});

describe('font client transport', () => {
  class TestWorker {
    static latest: TestWorker;
    onmessage: ((event: MessageEvent<FontResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    messages: FontRequest[] = [];
    terminated = false;
    constructor(readonly url: URL, readonly options: WorkerOptions) { TestWorker.latest = this; }
    postMessage(message: FontRequest, transfer: Transferable[]) {
      this.messages.push(structuredClone(message, { transfer }));
    }
    terminate() { this.terminated = true; }
    reply(response: FontResponse) { this.onmessage?.({ data: response } as MessageEvent<FontResponse>); }
  }

  beforeAll(() => vi.stubGlobal('Worker', TestWorker));
  afterAll(() => vi.unstubAllGlobals());

  it('uses a module worker and transfers only disposable copies of font bytes', async () => {
    const client = new FontClient();
    const worker = TestWorker.latest;
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.url.pathname).toContain('/fonts/worker.ts');
    const bytes = new ArrayBuffer(12);
    new Uint8Array(bytes)[0] = 123;
    const add = client.addFont(bytes);
    const first = worker.messages[0];
    worker.reply({ id: first.id, ok: true, value: { id: 'a'.repeat(64), name: 'Original' } });
    const record = await add;
    expect(bytes.byteLength).toBe(12);
    expect(record.bytes.byteLength).toBe(12);
    expect(new Uint8Array(record.bytes)[0]).toBe(123);
    const load = client.loadFont(record);
    expect(record.bytes.byteLength).toBe(12);
    await load;
    expect(worker.messages).toHaveLength(1);
    const another = { ...record, id: 'b'.repeat(64) };
    const loadAnother = client.loadFont(another);
    expect(another.bytes.byteLength).toBe(12);
    worker.reply({ id: worker.messages[1].id, ok: true, value: { id: another.id, name: another.name, evicted: [record.id] } });
    await loadAnother;
    const reloadEvicted = client.loadFont(record);
    expect(worker.messages).toHaveLength(3);
    worker.reply({ id: worker.messages[2].id, ok: true, value: { id: record.id, name: record.name, evicted: [] } });
    await reloadEvicted;
    client.dispose();
  });

  it('correlates out-of-order errors exactly and ignores unknown response IDs', async () => {
    const client = new FontClient();
    const worker = TestWorker.latest;
    const first = client.preview('font');
    const second = client.shape('font', 'B', 10);
    const failure = expect(second).rejects.toThrow('second failed');
    await flush();
    worker.reply({ id: 9999, ok: false, error: 'unrelated' });
    worker.reply({ id: worker.messages[1].id, ok: false, error: 'second failed' });
    worker.reply({ id: worker.messages[0].id, ok: true, value: { path: 'M0 0Z', bounds: { x: 0, y: 0, width: 1, height: 1 } } });
    await failure;
    expect((await first).path).toBe('M0 0Z');
    client.dispose();
  });

  it('singleflights previews separately from text edits and stops pending calls on disposal', async () => {
    const client = new FontClient();
    const worker = TestWorker.latest;
    const preview = client.preview('font');
    const duplicate = client.preview('font');
    expect(preview).toBe(duplicate);
    const edit = client.shape('font', 'A', 10);
    const failure = Promise.all([expect(preview).rejects.toThrow('disposed'), expect(edit).rejects.toThrow('disposed')]);
    await flush();
    expect(worker.messages).toHaveLength(2);
    expect(worker.messages[0]).toMatchObject({ type: 'shape', text: 'Aa Bb Cc', size: 10 });
    client.dispose();
    await failure;
    expect(worker.terminated).toBe(true);
    worker.reply({ id: worker.messages[0].id, ok: true, value: { path: '', bounds: { x: 0, y: 0, width: 0, height: 0 } } });
    await expect(client.preview('font')).rejects.toThrow('disposed');
  });

  it('times out a nonresponding worker without leaving requests pending', async () => {
    vi.useFakeTimers();
    try {
      const client = new FontClient();
      const request = client.preview('font');
      const failure = expect(request).rejects.toThrow('15 seconds');
      await flush();
      await vi.advanceTimersByTimeAsync(15000);
      await failure;
      expect(TestWorker.latest.terminated).toBe(true);
      await expect(client.shape('font', 'A', 10)).rejects.toThrow('15 seconds');
    } finally { vi.useRealTimers(); }
  });
});
