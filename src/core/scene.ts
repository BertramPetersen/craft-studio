import type { Bounds, DesignNode, Matrix } from './types';

export function transformPoint(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

/** Composition in SVG order: the right-hand transform is applied first. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function inverse(m: Matrix): Matrix | null {
  if (!m.every(Number.isFinite)) return null;
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const result: Matrix = [
    m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant,
    (m[1] * m[4] - m[0] * m[5]) / determinant,
  ];
  return result.every(Number.isFinite) ? result : null;
}

export function nodeBounds(node: DesignNode): Bounds {
  const { x, y, width, height } = node.bounds;
  const points = [
    transformPoint(node.transform, x, y), transformPoint(node.transform, x + width, y),
    transformPoint(node.transform, x, y + height), transformPoint(node.transform, x + width, y + height),
  ];
  const left = Math.min(...points.map(point => point.x));
  const top = Math.min(...points.map(point => point.y));
  return {
    x: left, y: top,
    width: Math.max(...points.map(point => point.x)) - left,
    height: Math.max(...points.map(point => point.y)) - top,
  };
}

function validBounds(bounds: Bounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height]
    .every(Number.isFinite) && bounds.width >= 0 && bounds.height >= 0;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function snapshot(node: DesignNode): DesignNode {
  if (!node.id || !validBounds(node.bounds) || !node.transform.every(Number.isFinite) ||
      node.transform.length !== 6 || !validBounds(nodeBounds(node))) {
    throw new Error('Node IDs, bounds and transforms must be valid.');
  }
  return Object.freeze({
    ...node,
    bounds: Object.freeze({ ...node.bounds }),
    transform: Object.freeze([...node.transform]) as unknown as Matrix,
    ...(node.text ? { text: Object.freeze({ ...node.text }) } : {}),
  });
}

function sameNode(a: DesignNode, b: DesignNode): boolean {
  return a.id === b.id && a.name === b.name && a.path === b.path && a.fill === b.fill &&
    a.hidden === b.hidden && a.locked === b.locked &&
    a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height &&
    a.transform.every((value, index) => value === b.transform[index]) &&
    a.text?.text === b.text?.text && a.text?.fontId === b.text?.fontId &&
    a.text?.fontName === b.text?.fontName && a.text?.size === b.text?.size;
}

type Change = { id: string; index: number; before?: DesignNode; after?: DesignNode };
type IndexedNode = { bounds: Bounds; cells: string[] | null };

export class Scene {
  private ordered: readonly DesignNode[] = Object.freeze([]);
  private byId = new Map<string, DesignNode>();
  private order = new Map<string, number>();
  private grid = new Map<string, Set<string>>();
  private indexed = new Map<string, IndexedNode>();
  private oversized = new Set<string>();
  private past: Change[][] = [];
  private future: Change[][] = [];
  private readonly cellSize = 25;
  private readonly maxCells = 1024;

  constructor(nodes: DesignNode[] = []) {
    if (nodes.length > 10_000) throw new Error('A design can contain at most 10,000 objects.');
    const prepared = this.prepare(nodes);
    this.apply(prepared.map((node, index) => ({ id: node.id, index, after: node })), 'after');
  }

  get nodes(): readonly DesignNode[] { return this.ordered; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get(id: string): DesignNode | undefined { return this.byId.get(id); }

  add(nodes: DesignNode[]): void {
    if (this.ordered.length + nodes.length > 10_000) throw new Error('A design can contain at most 10,000 objects.');
    const prepared = this.prepare(nodes);
    for (const node of prepared) {
      if (this.byId.has(node.id)) throw new Error(`Node already exists: ${node.id}`);
    }
    this.commit(prepared.map((node, index) => ({ id: node.id, index: this.ordered.length + index, after: node })));
  }

  update(nodes: DesignNode[]): void {
    const prepared = this.prepare(nodes);
    const changes: Change[] = [];
    for (const node of prepared) {
      const before = this.byId.get(node.id);
      if (!before) throw new Error(`Node does not exist: ${node.id}`);
      if (!sameNode(before, node)) changes.push({ id: node.id, index: this.order.get(node.id)!, before, after: node });
    }
    this.commit(changes);
  }

  remove(ids: Set<string>): void {
    const changes: Change[] = [];
    for (const id of ids) {
      const before = this.byId.get(id);
      if (before) changes.push({ id, index: this.order.get(id)!, before });
    }
    this.commit(changes);
  }

  undo(): boolean {
    const changes = this.past.pop();
    if (!changes) return false;
    this.apply(changes, 'before');
    this.future.push(changes);
    return true;
  }

  redo(): boolean {
    const changes = this.future.pop();
    if (!changes) return false;
    this.apply(changes, 'after');
    this.past.push(changes);
    return true;
  }

  query(bounds: Bounds): DesignNode[] {
    if (!validBounds(bounds)) throw new Error('Query bounds must be finite with non-negative dimensions.');
    const cells = this.cells(bounds);
    const candidates = new Set(this.oversized);
    if (cells === null) {
      for (const id of this.indexed.keys()) candidates.add(id);
    } else {
      for (const cell of cells) for (const id of this.grid.get(cell) ?? []) candidates.add(id);
    }
    return [...candidates]
      .filter(id => intersects(this.indexed.get(id)!.bounds, bounds))
      .sort((a, b) => this.order.get(a)! - this.order.get(b)!)
      .map(id => this.byId.get(id)!);
  }

  private prepare(nodes: DesignNode[]): DesignNode[] {
    const ids = new Set<string>();
    return nodes.map(node => {
      if (ids.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`);
      ids.add(node.id);
      return snapshot(node);
    });
  }

  private commit(changes: Change[]): void {
    if (!changes.length) return;
    this.apply(changes, 'after');
    this.past.push(changes);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }

  private apply(changes: Change[], side: 'before' | 'after'): void {
    if (!changes.length) return;
    const touched = new Set(changes.map(change => change.id));
    const ordered = this.ordered.filter(node => !touched.has(node.id));
    for (const change of changes) {
      this.unindex(change.id);
      this.byId.delete(change.id);
    }
    for (const change of [...changes].sort((a, b) => a.index - b.index)) {
      const node = change[side];
      if (!node) continue;
      ordered.splice(change.index, 0, node);
      this.byId.set(node.id, node);
      this.index(node);
    }
    this.ordered = Object.freeze(ordered);
    this.order.clear();
    ordered.forEach((node, index) => this.order.set(node.id, index));
  }

  private cells(bounds: Bounds): string[] | null {
    const left = Math.floor(bounds.x / this.cellSize);
    const top = Math.floor(bounds.y / this.cellSize);
    const right = Math.floor((bounds.x + bounds.width) / this.cellSize);
    const bottom = Math.floor((bounds.y + bounds.height) / this.cellSize);
    if (![left, top, right, bottom].every(Number.isSafeInteger) ||
        (right - left + 1) * (bottom - top + 1) > this.maxCells) return null;
    const cells: string[] = [];
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) cells.push(`${x},${y}`);
    return cells;
  }

  private index(node: DesignNode): void {
    const bounds = nodeBounds(node);
    const cells = this.cells(bounds);
    this.indexed.set(node.id, { bounds, cells });
    if (cells === null) this.oversized.add(node.id);
    else for (const cell of cells) {
      let ids = this.grid.get(cell);
      if (!ids) { ids = new Set(); this.grid.set(cell, ids); }
      ids.add(node.id);
    }
  }

  private unindex(id: string): void {
    const entry = this.indexed.get(id);
    if (!entry) return;
    if (entry.cells === null) this.oversized.delete(id);
    else for (const cell of entry.cells) {
      const ids = this.grid.get(cell)!;
      ids.delete(id);
      if (!ids.size) this.grid.delete(cell);
    }
    this.indexed.delete(id);
  }
}
