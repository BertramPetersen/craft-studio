import svgpath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';
import type { Bounds, DesignNode, Matrix, Project, TextSource } from './types';
import { inverse, nodeBounds } from './scene';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 10_000;
const MAX_PATH_LENGTH = 1_000_000;
const MAX_TOTAL_PATH_LENGTH = 8 * 1024 * 1024;
const MAX_SEGMENTS = 100_000;
const MAX_COORDINATE = 1_000_000_000;

function fail(message: string): never { throw new Error(`Invalid project: ${message}`); }

function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`Unexpected ${label} member: ${key}.`);
  return result;
}

function string(value: unknown, label: string, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    fail(`${label} must be valid text of at most ${max} characters.`);
  }
  return value;
}

function number(value: unknown, label: string, min = -MAX_COORDINATE, max = MAX_COORDINATE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}

function bounds(value: unknown): Bounds {
  const b = object(value, 'bounds', ['x', 'y', 'width', 'height']);
  const result = { x: number(b.x, 'bounds.x'), y: number(b.y, 'bounds.y'),
    width: number(b.width, 'bounds.width', 0), height: number(b.height, 'bounds.height', 0) };
  number(result.x + result.width, 'bounds right edge');
  number(result.y + result.height, 'bounds bottom edge');
  return result;
}

function matrix(value: unknown): Matrix {
  if (!Array.isArray(value) || value.length !== 6) fail('Transform must contain six numbers.');
  const m = value.map((entry, index) => number(entry, `transform[${index}]`,
    index < 4 ? -1_000_000 : -MAX_COORDINATE, index < 4 ? 1_000_000 : MAX_COORDINATE)) as Matrix;
  const determinant = m[0] * m[3] - m[1] * m[2];
  const scale = Math.max(...m.slice(0, 4).map(Math.abs));
  const inverted = inverse(m);
  if (!inverted || Math.abs(determinant) <= scale * scale * 1e-12 ||
      inverted.some(value => Math.abs(value) > MAX_COORDINATE)) {
    fail('Transform must be invertible and reasonably conditioned.');
  }
  return m;
}

function path(value: unknown): { value: string; segments: number } {
  const source = string(value, 'path', MAX_PATH_LENGTH, true);
  // svgpath exposes parse errors and segments at runtime but omits them from its declarations.
  const parsed = svgpath(source) as ReturnType<typeof svgpath> & { err: string; segments: [string, ...number[]][] };
  if (parsed.err) fail(`Malformed SVG path: ${parsed.err}`);
  if (!parsed.segments.length || parsed.segments.length > MAX_SEGMENTS) fail('SVG path has too many or no commands.');
  for (const segment of parsed.segments) {
    for (const coordinate of segment.slice(1)) number(coordinate, 'path coordinate');
  }
  parsed.abs();
  for (const segment of parsed.segments) {
    for (const coordinate of segment.slice(1)) number(coordinate, 'absolute path coordinate');
  }
  return { value: source, segments: parsed.segments.length };
}

function textSource(value: unknown): TextSource {
  const text = object(value, 'text', ['text', 'fontId', 'fontName', 'size']);
  return { text: string(text.text, 'text.text', 100_000), fontId: string(text.fontId, 'text.fontId', 256, true),
    fontName: string(text.fontName, 'text.fontName', 512, true), size: number(text.size, 'text.size', 0.001, 100_000) };
}

function validate(value: unknown): Project {
  const project = object(value, 'project', ['format', 'version', 'name', 'nodes']);
  if (project.format !== 'craft-studio' || project.version !== 1) fail('Unsupported format or version.');
  const name = string(project.name, 'name', 1024);
  if (!Array.isArray(project.nodes) || project.nodes.length > MAX_NODES) fail(`At most ${MAX_NODES} nodes are allowed.`);
  const ids = new Set<string>();
  let totalPathLength = 0;
  let totalSegments = 0;
  const nodes = project.nodes.map((value): DesignNode => {
    const input = object(value, 'node', ['id', 'name', 'path', 'bounds', 'transform', 'fill', 'hidden', 'locked', 'text']);
    const id = string(input.id, 'id', 128, true);
    if (ids.has(id)) fail(`Duplicate node ID: ${id}.`);
    ids.add(id);
    const nodePath = path(input.path);
    totalPathLength += nodePath.value.length;
    totalSegments += nodePath.segments;
    if (totalPathLength > MAX_TOTAL_PATH_LENGTH || totalSegments > 500_000) fail('Total path budget exceeded.');
    const fill = string(input.fill, 'fill', 9, true);
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(fill)) fail('Fill must be a hex colour.');
    const node: DesignNode = { id, name: string(input.name, 'node.name', 1024), path: nodePath.value,
      bounds: bounds(input.bounds), transform: matrix(input.transform), fill,
      hidden: boolean(input.hidden, 'hidden'), locked: boolean(input.locked, 'locked'),
      ...(input.text !== undefined ? { text: textSource(input.text) } : {}) };
    const declared = nodeBounds(node);
    for (const [key, value] of Object.entries(declared)) number(value, `declared transformed bounds.${key}`);
    number(declared.x + declared.width, 'declared transformed right edge');
    number(declared.y + declared.height, 'declared transformed bottom edge');
    // Imported project metadata is not authoritative over the actual cut geometry.
    let actual: [number, number, number, number];
    try { actual = svgPathBbox(node.path); } catch { fail('Path bounds could not be calculated.'); }
    node.bounds = { x: actual[0], y: actual[1], width: actual[2] - actual[0], height: actual[3] - actual[1] };
    const transformed = nodeBounds(node);
    for (const [key, value] of Object.entries(transformed)) number(value, `transformed bounds.${key}`);
    number(transformed.x + transformed.width, 'transformed right edge');
    number(transformed.y + transformed.height, 'transformed bottom edge');
    return node;
  });
  return { format: 'craft-studio', version: 1, name, nodes };
}

export function parseProject(text: string): Project {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES || new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    fail('File exceeds the 10 MiB limit.');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('File is not valid JSON.'); }
  return validate(value);
}

export function exportProject(name: string, nodes: readonly DesignNode[]): string {
  const project = validate({ format: 'craft-studio', version: 1, name, nodes });
  const result = JSON.stringify(project, null, 2);
  if (new TextEncoder().encode(result).length > MAX_FILE_BYTES) fail('File exceeds the 10 MiB limit.');
  return result;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export function exportSvg(nodes: readonly DesignNode[]): string {
  const visible = validate({ format: 'craft-studio', version: 1, name: '', nodes }).nodes.filter(node => !node.hidden);
  if (!visible.length) throw new Error('There are no visible shapes to export.');
  const allBounds = visible.map(nodeBounds);
  const left = Math.min(...allBounds.map(bounds => bounds.x));
  const top = Math.min(...allBounds.map(bounds => bounds.y));
  const width = Math.max(...allBounds.map(bounds => bounds.x + bounds.width)) - left;
  const height = Math.max(...allBounds.map(bounds => bounds.y + bounds.height)) - top;
  if (width <= 0 || height <= 0) throw new Error('The visible artwork must have non-zero width and height to export.');
  const paths = visible.map(node => {
    const transform: Matrix = [...node.transform];
    transform[4] -= left;
    transform[5] -= top;
    return `  <path id="${escapeXml(node.id)}" d="${escapeXml(node.path)}" fill="${node.fill}" transform="matrix(${transform.join(' ')})"><title>${escapeXml(node.name)}</title></path>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n${paths.join('\n')}\n</svg>\n`;
}
