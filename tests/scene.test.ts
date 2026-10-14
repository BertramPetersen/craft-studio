import { describe, expect, it } from 'vitest';
import { inverse, multiply, nodeBounds, Scene, transformPoint } from '../src/core/scene';
import type { DesignNode, Matrix } from '../src/core/types';

function node(id: string, x = 0, y = 0, width = 10, height = 10): DesignNode {
  return { id, name: id, path: `M0 0H${width}V${height}H0Z`, bounds: { x: 0, y: 0, width, height },
    transform: [1, 0, 0, 1, x, y], fill: '#123456', hidden: false, locked: false };
}

const ids = (nodes: readonly DesignNode[]) => nodes.map(node => node.id);

describe('affine geometry', () => {
  it('transforms all four bounds corners, including negative scale and skew', () => {
    const shape = node('a');
    shape.bounds = { x: 2, y: 3, width: 4, height: 5 };
    shape.transform = [0, 2, -3, 0, 10, 20];
    expect(nodeBounds(shape)).toEqual({ x: -14, y: 24, width: 15, height: 8 });
    shape.transform = [-2, 1, 3, -4, 10, 20];
    expect(nodeBounds(shape)).toEqual({ x: 7, y: -10, width: 23, height: 24 });
  });

  it('composes in SVG order and inverts translations, reflections and rotations', () => {
    const a: Matrix = [0, 2, -3, 0, 10, 20];
    const b: Matrix = [-1, 0, 0.5, 1, 3, -2];
    const point = transformPoint(b, 7, 8);
    expect(transformPoint(multiply(a, b), 7, 8)).toEqual(transformPoint(a, point.x, point.y));
    const composed = multiply(a, b);
    const undo = inverse(composed)!;
    multiply(undo, composed).forEach((value, index) => expect(value).toBeCloseTo([1, 0, 0, 1, 0, 0][index]));
    const moved = transformPoint(composed, 7, 8);
    expect(transformPoint(undo, moved.x, moved.y).x).toBeCloseTo(7);
    expect(transformPoint(undo, moved.x, moved.y).y).toBeCloseTo(8);
  });

  it('rejects singular and nonfinite inverses without rejecting small valid scales', () => {
    expect(inverse([1, 2, 2, 4, 0, 0])).toBeNull();
    expect(inverse([NaN, 0, 0, 1, 0, 0])).toBeNull();
    expect(inverse([1, 0, 0, 1, Infinity, 0])).toBeNull();
    expect(inverse([1e-6, 0, 0, 1e-6, 0, 0])).toEqual([1e6, -0, -0, 1e6, 0, 0]);
  });
});

describe('Scene', () => {
  it('starts without history and exposes stable, frozen, independent snapshots', () => {
    const source = node('a');
    source.text = { text: 'Hi', fontId: 'font', fontName: 'Font', size: 10 };
    const scene = new Scene([source]);
    const current = scene.nodes;
    source.bounds.width = 999;
    source.transform[4] = 999;
    source.text.text = 'Changed';
    expect(scene.nodes).toBe(current);
    expect(scene.get('a')!.bounds.width).toBe(10);
    expect(scene.get('a')!.transform[4]).toBe(0);
    expect(scene.get('a')!.text!.text).toBe('Hi');
    expect(Object.isFrozen(scene.nodes)).toBe(true);
    expect(Object.isFrozen(scene.get('a'))).toBe(true);
    expect(Object.isFrozen(scene.get('a')!.bounds)).toBe(true);
    expect(Object.isFrozen(scene.get('a')!.transform)).toBe(true);
    expect(Object.isFrozen(scene.get('a')!.text)).toBe(true);
    expect(scene.get('missing')).toBeUndefined();
    expect(scene.canUndo).toBe(false);
    expect(scene.canRedo).toBe(false);
    expect(scene.undo()).toBe(false);
    expect(scene.redo()).toBe(false);
    scene.add([node('b')]);
    expect(ids(current)).toEqual(['a']);
    expect(ids(scene.nodes)).toEqual(['a', 'b']);
    expect(scene.get('a')).toBe(current[0]);
  });

  it('queries intersecting AABBs in paint order with inclusive edges and negative coordinates', () => {
    const scene = new Scene([node('a', -25, -25), node('b', -20, -20), node('c', 200), node('d', -25, -25)]);
    expect(ids(scene.query({ x: -20, y: -20, width: 0, height: 0 }))).toEqual(['a', 'b', 'd']);
    expect(ids(scene.query({ x: -15, y: -15, width: 0, height: 0 }))).toEqual(['a', 'b', 'd']);
    expect(scene.query({ x: 10, y: 10, width: 10, height: 10 })).toEqual([]);
    const rotated = { ...node('rotated'), transform: [0, 1, -1, 0, 50, 50] as Matrix };
    scene.add([rotated]);
    expect(ids(scene.query({ x: 40, y: 60, width: 0, height: 0 }))).toEqual(['rotated']);
  });

  it('maintains its index across batched add, update, remove, undo and redo', () => {
    const scene = new Scene([node('base', -200)]);
    scene.add([node('a'), node('b')]);
    expect(ids(scene.query({ x: 0, y: 0, width: 10, height: 10 }))).toEqual(['a', 'b']);
    const original = scene.get('a');
    scene.update([node('b', 300), node('a', 100)]);
    expect(ids(scene.nodes)).toEqual(['base', 'a', 'b']);
    expect(scene.query({ x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
    expect(ids(scene.query({ x: 100, y: 0, width: 210, height: 10 }))).toEqual(['a', 'b']);
    scene.undo();
    expect(scene.get('a')).toBe(original);
    expect(ids(scene.query({ x: 0, y: 0, width: 10, height: 10 }))).toEqual(['a', 'b']);
    scene.redo();
    scene.remove(new Set(['b', 'base', 'missing']));
    expect(ids(scene.nodes)).toEqual(['a']);
    scene.undo();
    expect(ids(scene.nodes)).toEqual(['base', 'a', 'b']);
    expect(ids(scene.query({ x: -200, y: 0, width: 510, height: 10 }))).toEqual(['base', 'a', 'b']);
    scene.redo();
    expect(ids(scene.nodes)).toEqual(['a']);
    expect(scene.query({ x: 300, y: 0, width: 10, height: 10 })).toEqual([]);
    scene.undo();
    scene.undo();
    scene.undo();
    expect(ids(scene.nodes)).toEqual(['base']);
    expect(scene.canUndo).toBe(false);
    scene.redo();
    expect(ids(scene.nodes)).toEqual(['base', 'a', 'b']);
  });

  it('falls back safely for oversized nodes, huge coordinates and broad queries', () => {
    const giant = node('giant', -10_000, -10_000, 20_000, 20_000);
    const scene = new Scene([node('first'), giant, node('remote', 1e20, 1e20)]);
    expect(ids(scene.query({ x: 0, y: 0, width: 1, height: 1 }))).toEqual(['first', 'giant']);
    expect(ids(scene.query({ x: -20_000, y: -20_000, width: 40_000, height: 40_000 }))).toEqual(['first', 'giant']);
    expect(ids(scene.query({ x: 1e20, y: 1e20, width: 0, height: 0 }))).toEqual(['remote']);
    scene.update([node('giant', 200)]);
    expect(ids(scene.query({ x: 0, y: 0, width: 1, height: 1 }))).toEqual(['first']);
    scene.undo();
    expect(ids(scene.query({ x: 0, y: 0, width: 1, height: 1 }))).toEqual(['first', 'giant']);
    scene.remove(new Set(['giant']));
    expect(ids(scene.query({ x: 0, y: 0, width: 1, height: 1 }))).toEqual(['first']);
  });

  it('keeps hidden and locked nodes queryable without changing paint order', () => {
    const scene = new Scene([{ ...node('hidden'), hidden: true }, { ...node('locked'), locked: true }]);
    expect(ids(scene.query({ x: 0, y: 0, width: 5, height: 5 }))).toEqual(['hidden', 'locked']);
  });

  it('rejects invalid batches atomically, preserving index, snapshots and redo', () => {
    const scene = new Scene([node('a')]);
    scene.add([node('b')]);
    scene.undo();
    const current = scene.nodes;
    expect(() => scene.add([node('c'), node('a')])).toThrow();
    expect(() => scene.add([node('c'), node('c')])).toThrow();
    expect(() => scene.update([node('a', 100), node('missing')])).toThrow();
    expect(() => scene.update([node('a', 100), node('a', 200)])).toThrow();
    expect(() => scene.add([{ ...node('bad'), transform: [1, 0, 0, 1, NaN, 0] }])).toThrow();
    expect(() => scene.add([{ ...node('bad'), bounds: { x: 0, y: 0, width: -1, height: 1 } }])).toThrow();
    expect(scene.nodes).toBe(current);
    expect(ids(scene.query({ x: 0, y: 0, width: 1, height: 1 }))).toEqual(['a']);
    expect(scene.canRedo).toBe(true);
    scene.redo();
    expect(ids(scene.nodes)).toEqual(['a', 'b']);
  });

  it('no-op commands retain redo, while a real change branches history', () => {
    const scene = new Scene([node('a')]);
    scene.add([node('b')]);
    scene.undo();
    const current = scene.nodes;
    scene.add([]);
    scene.update([node('a')]);
    scene.update([]);
    scene.remove(new Set(['missing']));
    expect(scene.nodes).toBe(current);
    expect(scene.canRedo).toBe(true);
    scene.update([node('a', 100)]);
    expect(scene.canRedo).toBe(false);
  });

  it('caps history at 100 atomic commands', () => {
    const scene = new Scene([node('a')]);
    for (let index = 1; index <= 110; index++) scene.update([node('a', index)]);
    for (let index = 0; index < 100; index++) expect(scene.undo()).toBe(true);
    expect(scene.get('a')!.transform[4]).toBe(10);
    expect(scene.undo()).toBe(false);
    for (let index = 0; index < 100; index++) expect(scene.redo()).toBe(true);
    expect(scene.get('a')!.transform[4]).toBe(110);
    expect(scene.redo()).toBe(false);
  });

  it('matches a brute-force query after deterministic mixed edits', () => {
    const scene = new Scene(Array.from({ length: 200 }, (_, index) => node(`n${index}`, index * 13 - 1000, index % 7 * 30)));
    for (let step = 0; step < 40; step++) {
      scene.update([node(`n${step}`, step * -33, step * 15, step % 4 ? 10 : 20_000, 20)]);
      if (step % 3 === 0) scene.undo();
      if (step % 6 === 0) scene.redo();
      const query = { x: step * -20, y: step * 7, width: 150, height: 100 };
      const expected = scene.nodes.filter(shape => {
        const b = nodeBounds(shape);
        return b.x <= query.x + query.width && b.x + b.width >= query.x &&
          b.y <= query.y + query.height && b.y + b.height >= query.y;
      });
      expect(scene.query(query)).toEqual(expected);
    }
  });

  it('rejects invalid query bounds', () => {
    const scene = new Scene();
    expect(() => scene.query({ x: Infinity, y: 0, width: 0, height: 0 })).toThrow();
    expect(() => scene.query({ x: 0, y: 0, width: -1, height: 0 })).toThrow();
  });
});
