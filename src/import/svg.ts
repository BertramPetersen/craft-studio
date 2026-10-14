import svgpath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';
import type { DesignNode, Matrix } from '../core/types';

const PX_TO_MM = 25.4 / 96;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ELEMENTS = 10_000;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const LENGTH_RE = new RegExp(`^(${NUMBER})(px|mm|cm|in|pt|pc)?$`, 'i');
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline']);
const PRESENTATION = new Set([
  'fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity',
  'opacity', 'visibility', 'display', 'fill-rule',
]);
const GEOMETRY: Record<string, string[]> = {
  svg: ['width', 'height', 'viewBox', 'preserveAspectRatio', 'version'],
  g: [],
  path: ['d'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  polygon: ['points'],
  polyline: ['points'],
  title: [],
  desc: [],
};
const COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00',
  teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', rebeccapurple: '#663399',
};

type Paint = {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  invisible: boolean;
  displayNone: boolean;
  opacityZero: boolean;
};

function fail(message: string): never {
  throw new Error(`Cannot import SVG: ${message}`);
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const result: Matrix = [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  if (!result.every(Number.isFinite)) fail('A transform contains non-finite coordinates.');
  return result;
}

function numbers(value: string, label: string): number[] {
  const input = value.trim();
  if (!input) fail(`${label} is empty.`);
  const matches = input.match(new RegExp(NUMBER, 'g')) ?? [];
  // Require separators, rather than accepting arbitrary text between numeric tokens.
  const grammar = new RegExp(`^${NUMBER}(?:(?:\\s*,\\s*|\\s+)${NUMBER})*$`);
  if (!grammar.test(input)) fail(`${label} contains an invalid number list.`);
  const result = matches.map(Number);
  if (!result.every(Number.isFinite)) fail(`${label} contains a non-finite number.`);
  return result;
}

function length(value: string, label: string): number {
  const match = LENGTH_RE.exec(value.trim());
  if (!match) fail(`${label} must be a finite length in px, mm, cm, in, pt, or pc; percentages are not supported.`);
  const factors: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 960 / 25.4, in: 96, pt: 96 / 72, pc: 16 };
  const result = Number(match[1]) * factors[(match[2] ?? 'px').toLowerCase()];
  if (!Number.isFinite(result)) fail(`${label} is not finite.`);
  return result;
}

function attributeLength(element: Element, name: string, fallback = 0): number {
  const value = element.getAttribute(name);
  return value === null ? fallback : length(value, `${element.localName} ${name}`);
}

function transform(value: string | null): Matrix {
  if (value === null) return [...IDENTITY];
  let remaining = value.trim();
  if (!remaining) fail('The transform attribute is empty.');
  let result: Matrix = [...IDENTITY];
  while (remaining) {
    const match = /^(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)/.exec(remaining);
    if (!match) fail('Unsupported or malformed transform. Use matrix, translate, scale, rotate, skewX, or skewY.');
    const args = numbers(match[2], `${match[1]} transform`);
    let next: Matrix;
    switch (match[1]) {
      case 'matrix':
        if (args.length !== 6) fail('matrix() requires six numbers.');
        next = args as Matrix;
        break;
      case 'translate':
        if (args.length !== 1 && args.length !== 2) fail('translate() requires one or two numbers.');
        next = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case 'scale':
        if (args.length !== 1 && args.length !== 2) fail('scale() requires one or two numbers.');
        next = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) fail('rotate() requires an angle, optionally followed by a centre x and y.');
        const radians = (args[0] % 360) * Math.PI / 180;
        const c = Math.cos(radians);
        const s = Math.sin(radians);
        const x = args[1] ?? 0;
        const y = args[2] ?? 0;
        next = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
        break;
      }
      default: {
        if (args.length !== 1) fail(`${match[1]}() requires one angle.`);
        const degrees = args[0] % 180;
        if (Math.abs(Math.abs(degrees) - 90) < 1e-10) fail('A skew transform is undefined at 90 degrees.');
        const tangent = Math.tan(degrees * Math.PI / 180);
        next = match[1] === 'skewX' ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0];
      }
    }
    result = multiply(result, next);
    remaining = remaining.slice(match[0].length);
    if (!remaining.trim()) break;
    const separator = /^(?:\s*,\s*|\s+)/.exec(remaining);
    if (!separator) fail('Transform functions must be separated by whitespace or a comma.');
    remaining = remaining.slice(separator[0].length);
    if (!remaining) fail('The transform attribute ends with a separator.');
  }
  return result;
}

function viewport(root: Element): Matrix {
  const rawViewBox = root.getAttribute('viewBox');
  const box = rawViewBox === null ? null : numbers(rawViewBox, 'viewBox');
  if (box && (box.length !== 4 || box[2] <= 0 || box[3] <= 0)) fail('viewBox requires four numbers and positive width and height.');
  const width = attributeLength(root, 'width', box?.[2] ?? 0);
  const height = attributeLength(root, 'height', box?.[3] ?? 0);
  if (width <= 0 || height <= 0) fail('Provide positive SVG width and height, or a viewBox.');
  const aspect = (root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim();
  const alignment = /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))(?:\s+(meet|slice))?$/.exec(aspect);
  if (!alignment || alignment[4] === 'slice' || (alignment[1] === 'none' && alignment[4])) {
    fail('Unsupported preserveAspectRatio. Use none or a Min/Mid/Max alignment with meet; slice clipping is not supported.');
  }
  if (!box) return [PX_TO_MM, 0, 0, PX_TO_MM, 0, 0];
  let sx = width / box[2];
  let sy = height / box[3];
  let dx = 0;
  let dy = 0;
  if (alignment[1] !== 'none') {
    sx = sy = Math.min(sx, sy);
    const fraction = { Min: 0, Mid: 0.5, Max: 1 };
    dx = (width - box[2] * sx) * fraction[alignment[2] as keyof typeof fraction];
    dy = (height - box[3] * sy) * fraction[alignment[3] as keyof typeof fraction];
  }
  const result: Matrix = [sx * PX_TO_MM, 0, 0, sy * PX_TO_MM, (dx - box[0] * sx) * PX_TO_MM, (dy - box[1] * sy) * PX_TO_MM];
  if (!result.every(Number.isFinite)) fail('The SVG dimensions produce non-finite coordinates.');
  return result;
}

function color(value: string): string {
  const input = value.trim().toLowerCase();
  if (input === 'none') return 'none';
  if (Object.hasOwn(COLORS, input)) return COLORS[input];
  if (/^#[\da-f]{6}$/.test(input)) return input;
  if (/^#[\da-f]{3}$/.test(input)) return `#${[...input.slice(1)].map(c => c + c).join('')}`;
  const rgb = /^rgb\(\s*([^()]*)\s*\)$/.exec(input);
  if (rgb) {
    const components = rgb[1].split(',').map(s => s.trim());
    const percentage = components.every(s => s.endsWith('%'));
    if (components.length === 3 && components.every(s => NUMBER_RE.test(percentage ? s.slice(0, -1) : s))) {
      const values = components.map(s => Number(percentage ? s.slice(0, -1) : s));
      if (values.every(v => Number.isFinite(v) && v >= 0 && v <= (percentage ? 100 : 255))) {
        return `#${values.map(v => Math.round(percentage ? v * 255 / 100 : v).toString(16).padStart(2, '0')).join('')}`;
      }
    }
  }
  fail(`Unsupported paint "${value}". Use none, a basic named colour, #rgb, #rrggbb, or rgb().`);
}

function properties(element: Element): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of PRESENTATION) {
    const value = element.getAttribute(name);
    if (value !== null) result.set(name, value.trim());
  }
  const style = element.getAttribute('style');
  if (style !== null) {
    for (const declaration of style.split(';')) {
      if (!declaration.trim()) continue;
      const match = /^\s*([a-z-]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration);
      if (!match || !PRESENTATION.has(match[1].toLowerCase()) || /!/.test(match[2])) {
        fail('Inline styles support only fill, stroke, stroke-width, fill-rule, opacity, fill-opacity, stroke-opacity, visibility, and display.');
      }
      result.set(match[1].toLowerCase(), match[2]);
    }
  }
  return result;
}

function paint(element: Element, parent: Paint): Paint {
  const props = properties(element);
  const next = { ...parent };
  if (props.has('fill')) next.fill = color(props.get('fill')!);
  if (props.has('stroke')) next.stroke = color(props.get('stroke')!);
  if (props.has('stroke-width')) next.strokeWidth = length(props.get('stroke-width')!, 'stroke-width');
  if (next.strokeWidth < 0) fail('stroke-width must not be negative.');
  for (const [name, key] of [['fill-opacity', 'fillOpacity'], ['stroke-opacity', 'strokeOpacity']] as const) {
    if (props.has(name)) next[key] = binaryOpacity(props.get(name)!, name);
  }
  if (props.has('opacity')) next.opacityZero = parent.opacityZero || binaryOpacity(props.get('opacity')!, 'opacity') === 0;
  if (props.has('visibility')) {
    const visibility = props.get('visibility');
    if (!['visible', 'hidden', 'collapse'].includes(visibility!)) fail('visibility must be visible, hidden, or collapse.');
    next.invisible = visibility !== 'visible';
  }
  if (props.has('display')) {
    const display = props.get('display');
    if (display !== 'none' && display !== 'inline') fail('display supports only none or inline.');
    next.displayNone = parent.displayNone || display === 'none';
  }
  if (props.has('fill-rule') && props.get('fill-rule') !== 'nonzero') {
    fail('Only nonzero fill-rule is supported. Convert evenodd fills to nonzero paths before importing.');
  }
  return next;
}

function binaryOpacity(value: string, name: string): number {
  if (!NUMBER_RE.test(value) || (Number(value) !== 0 && Number(value) !== 1)) {
    fail(`${name} supports only 0 or 1. Flatten translucent artwork before importing.`);
  }
  return Number(value);
}

function geometry(element: Element): string {
  const tag = element.localName;
  if (tag === 'path') {
    const d = element.getAttribute('d');
    if (!d?.trim()) fail('A path is missing its d geometry.');
    return d;
  }
  if (tag === 'polygon' || tag === 'polyline') {
    const points = numbers(element.getAttribute('points') ?? '', `${tag} points`);
    if (points.length < 6 || points.length % 2 !== 0) fail(`${tag} requires at least three x/y point pairs for filled cut geometry.`);
    return `M${points[0]} ${points[1]} L${points.slice(2).join(' ')} Z`;
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = attributeLength(element, 'cx');
    const cy = attributeLength(element, 'cy');
    const rx = attributeLength(element, tag === 'circle' ? 'r' : 'rx');
    const ry = tag === 'circle' ? rx : attributeLength(element, 'ry');
    if (rx <= 0 || ry <= 0) fail(`${tag} requires positive radii.`);
    return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  }
  const x = attributeLength(element, 'x');
  const y = attributeLength(element, 'y');
  const width = attributeLength(element, 'width');
  const height = attributeLength(element, 'height');
  if (width <= 0 || height <= 0) fail('rect requires positive width and height.');
  let rx = attributeLength(element, 'rx', attributeLength(element, 'ry'));
  let ry = attributeLength(element, 'ry', rx);
  if (rx < 0 || ry < 0) fail('Rounded rectangle radii must not be negative.');
  rx = Math.min(rx, width / 2);
  ry = Math.min(ry, height / 2);
  if (rx === 0 || ry === 0) return `M${x} ${y} H${x + width} V${y + height} H${x} Z`;
  return `M${x + rx} ${y} H${x + width - rx} A${rx} ${ry} 0 0 1 ${x + width} ${y + ry} V${y + height - ry} A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height} H${x + rx} A${rx} ${ry} 0 0 1 ${x} ${y + height - ry} V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
}

function bakedPath(source: string, matrix: Matrix): string {
  const path = svgpath(source);
  // svgpath reports parser errors on an undocumented runtime property.
  const error = (path as unknown as { err: string }).err;
  if (error) fail(`Malformed path geometry: ${error}`);
  let segments = 0;
  path.iterate(segment => {
    segments++;
    if (segment.slice(1).some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('Path geometry contains non-finite coordinates.');
    if (segment[0].toUpperCase() === 'A' && (Number(segment[1]) < 0 || Number(segment[2]) < 0)) fail('Path arc radii must not be negative.');
  });
  if (!segments) fail('A path has no geometry.');
  path.matrix(matrix).abs().unshort();
  const commands: string[] = [];
  let open = false;
  path.iterate(segment => {
    if (segment.slice(1).some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('A transformed path contains non-finite coordinates.');
    const command = segment[0].toUpperCase();
    if (command === 'M' && open) commands.push('Z');
    commands.push(segment.join(' '));
    // SVG fills implicitly close each subpath; cutting needs those closing edges explicitly.
    open = command !== 'Z';
  });
  if (open) commands.push('Z');
  return commands.join(' ');
}

function validateElement(element: Element, root: Element): void {
  const tag = element.localName;
  if ((element.namespaceURI !== null && element.namespaceURI !== SVG_NS) || !Object.hasOwn(GEOMETRY, tag)) {
    fail(`Unsupported <${tag}> element. Import only filled paths, rectangles, circles, ellipses, polygons, polylines, and groups; convert text and strokes to paths.`);
  }
  if (tag === 'svg' && element !== root) fail('Nested SVG viewports are not supported; flatten them to groups.');
  for (const attr of element.attributes) {
    const name = attr.name;
    if (/^on/i.test(attr.localName) || /href/i.test(attr.localName) || /url\s*\(/i.test(attr.value)) {
      fail('Scripts, event handlers, references, and url() paints are not allowed.');
    }
    if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    if (attr.namespaceURI !== null || (!['id', 'style', 'transform'].includes(name) && !PRESENTATION.has(name) && !GEOMETRY[tag].includes(name))) {
      fail(`Unsupported ${name} attribute on <${tag}>. Flatten filters, masks, clipping, and other effects before importing.`);
    }
  }
  if ((SHAPES.has(tag) || tag === 'title' || tag === 'desc') && element.children.length) fail(`<${tag}> must not contain child elements.`);
  for (const child of element.childNodes) {
    if ((child.nodeType === 3 || child.nodeType === 4) && child.textContent?.trim() && tag !== 'title' && tag !== 'desc') {
      fail('Text content is not supported; convert text to paths.');
    }
  }
}

/** Imports a deliberately restricted, inert SVG subset. All geometry and bounds are baked into mm. */
export function importSvg(source: string, fileName: string): DesignNode[] {
  if (source.length > MAX_BYTES || new TextEncoder().encode(source).length > MAX_BYTES) fail('The SVG exceeds the 10 MB size limit.');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('DTD and entity declarations are not allowed.');
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror')) fail('Malformed XML. Check that the SVG is a valid, complete XML file.');
  const root = document.documentElement;
  if (!root || root.localName !== 'svg') fail('The document root must be <svg>.');
  const elements = Array.from(document.querySelectorAll('*'));
  if (elements.length > MAX_ELEMENTS) fail('The SVG exceeds the 10,000 element limit.');
  const walker = document.createTreeWalker(document, 64 /* SHOW_PROCESSING_INSTRUCTION */);
  if (walker.nextNode()) fail('XML processing instructions and external stylesheets are not allowed.');
  for (const element of elements) validateElement(element, root);
  const nodes: DesignNode[] = [];
  const basePaint: Paint = {
    fill: '#000000', stroke: 'none', strokeWidth: 1, fillOpacity: 1,
    strokeOpacity: 1, invisible: false, displayNone: false, opacityZero: false,
  };
  const queue: Array<{ element: Element; matrix: Matrix; paint: Paint; depth: number }> = [
    { element: root, matrix: viewport(root), paint: basePaint, depth: 0 },
  ];
  while (queue.length) {
    const current = queue.pop()!;
    const element = current.element;
    if (current.depth > 128) fail('The SVG is nested too deeply (maximum 128 groups).');
    const tag = element.localName;
    if (tag === 'title' || tag === 'desc') continue;
    const matrix = multiply(current.matrix, transform(element.getAttribute('transform')));
    const appearance = paint(element, current.paint);
    if (SHAPES.has(tag)) {
      if (appearance.stroke !== 'none' && appearance.strokeWidth > 0 && appearance.strokeOpacity > 0) {
        fail('Stroked geometry is not supported. Convert strokes to filled paths before importing.');
      }
      let path: string;
      let bounds: ReturnType<typeof svgPathBbox>;
      try {
        path = bakedPath(geometry(element), matrix);
        bounds = svgPathBbox(path);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Cannot import SVG:')) throw error;
        fail('Malformed path geometry; its bounds could not be calculated.');
      }
      const nodeBounds = { x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] };
      if (!Object.values(nodeBounds).every(Number.isFinite)) fail('Path bounds contain non-finite coordinates.');
      if (appearance.fill === 'none') continue;
      if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) fail('A filled shape has no two-dimensional cut geometry.');
      nodes.push({
        id: globalThis.crypto?.randomUUID?.() ?? `svg-${Date.now()}-${++fallbackId}`,
        name: element.getAttribute('id') || `${fileName.replace(/\.svg$/i, '')} ${tag} ${nodes.length + 1}`,
        path,
        bounds: nodeBounds,
        transform: [...IDENTITY],
        fill: appearance.fill,
        hidden: appearance.invisible || appearance.displayNone || appearance.opacityZero || appearance.fillOpacity === 0,
        locked: false,
      });
    } else {
      for (const child of Array.from(element.children).reverse()) {
        queue.push({ element: child, matrix, paint: appearance, depth: current.depth + 1 });
      }
    }
  }
  if (!nodes.length) fail('The SVG contains no filled cut geometry. Convert text and strokes to filled paths.');
  return nodes;
}

let fallbackId = 0;
