// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { importSvg } from '../src/import/svg';

const PX_TO_MM = 25.4 / 96;
function svg(body: string, attributes = 'width="100mm" height="100mm" viewBox="0 0 100 100"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
}
function load(body: string, attributes?: string) {
  return importSvg(svg(body, attributes), 'drawing.svg');
}
function expectBounds(bounds: { x: number; y: number; width: number; height: number }, expected: number[]) {
  [bounds.x, bounds.y, bounds.width, bounds.height].forEach((value, i) => expect(value).toBeCloseTo(expected[i], 7));
}

describe('physical SVG dimensions', () => {
  it('preserves millimetre dimensions without fitting the artwork', () => {
    const [node] = load('<rect x="10" y="20" width="30" height="40"/>');
    expectBounds(node.bounds, [10, 20, 30, 40]);
    expect(node.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it.each([
    ['96px', 25.4], ['25.4mm', 25.4], ['2.54cm', 25.4], ['1in', 25.4], ['72pt', 25.4], ['6pc', 25.4], ['96', 25.4],
  ])('converts physical root units %s', (unit, mm) => {
    const [node] = load('<rect width="96" height="96"/>', `width="${unit}" height="${unit}" viewBox="0 0 96 96"`);
    expectBounds(node.bounds, [0, 0, mm, mm]);
  });

  it('uses CSS pixels for an unsized viewBox', () => {
    const [node] = load('<rect x="10" y="20" width="96" height="48"/>', 'viewBox="10 20 96 48"');
    expectBounds(node.bounds, [0, 0, 25.4, 12.7]);
  });

  it('converts lengths without a viewBox, including physical shape lengths', () => {
    const [node] = load('<rect x="1mm" width="1in" height="72pt"/>', 'width="50mm" height="50mm"');
    expectBounds(node.bounds, [1, 0, 25.4, 25.4]);
  });

  it('applies the default centered meet alignment and viewBox origin', () => {
    const [node] = load('<rect x="10" y="20" width="100" height="50"/>', 'width="100mm" height="100mm" viewBox="10 20 100 50"');
    expectBounds(node.bounds, [0, 25, 100, 50]);
  });

  it('supports explicit meet alignment and nonuniform scaling with none', () => {
    const shape = '<rect width="100" height="50"/>';
    expectBounds(load(shape, 'width="100mm" height="100mm" viewBox="0 0 100 50" preserveAspectRatio="xMinYMax meet"')[0].bounds, [0, 50, 100, 50]);
    expectBounds(load(shape, 'width="100mm" height="100mm" viewBox="0 0 100 50" preserveAspectRatio="none"')[0].bounds, [0, 0, 100, 100]);
  });

  it.each(['preserveAspectRatio="xMidYMid slice"', 'preserveAspectRatio="defer xMidYMid"', 'width="100%"', 'viewBox="0 0 0 100"', 'viewBox="0 0 1e999 100"'])('rejects unsupported viewport semantics: %s', attribute => {
    expect(() => load('<rect width="10" height="10"/>', attribute)).toThrow(/Cannot import SVG/);
  });
});

describe('filled shapes and appearance', () => {
  it('supports all seven shape variants in document order', () => {
    const nodes = load(`
      <path id="path" d="M1 2h10v20h-10z"/>
      <rect x="1" y="2" width="10" height="20"/>
      <rect x="1" y="2" width="10" height="20" rx="3"/>
      <circle cx="6" cy="12" r="5"/>
      <ellipse cx="6" cy="12" rx="5" ry="10"/>
      <polygon points="1,2 11,2 11,22 1,22"/>
      <polyline points="1 2 11 2 11 22 1 22"/>
    `);
    expect(nodes).toHaveLength(7);
    expect(nodes[0].name).toBe('path');
    expect(new Set(nodes.map(node => node.id)).size).toBe(7);
    nodes.forEach((node, index) => {
      expectBounds(node.bounds, index === 3 ? [1, 7, 10, 10] : [1, 2, 10, 20]);
      expect(node.path).toMatch(/[Zz]\s*$/);
      expect(node.fill).toBe('#000000');
      expect(node.locked).toBe(false);
    });
  });

  it('uses actual curve extrema, not the control-point hull', () => {
    const [node] = load('<path d="M0 0 C100 0 100 100 0 100 Z"/>');
    expectBounds(node.bounds, [0, 0, 75, 100]);
  });

  it('clamps rounded corners and copies a single specified radius', () => {
    const [node] = load('<rect width="10" height="20" ry="100"/>');
    expectBounds(node.bounds, [0, 0, 10, 20]);
    expect(node.path).toMatch(/A 5 10/);
  });

  it('closes every implicitly filled open subpath', () => {
    const [node] = load('<path d="M0 0L10 0L10 10 M20 20l10 0l0 10"/>');
    expect(node.path.match(/Z/g)).toHaveLength(2);
  });

  it('inherits paint, lets inline styles win, and normalizes safe colours', () => {
    const nodes = load('<g fill="red"><rect width="5" height="5"/><rect x="10" width="5" height="5" fill="blue" style="fill:rgb(100%, 0%, 50%);stroke:none"/><rect x="20" width="5" height="5" fill="#AbC"/></g>');
    expect(nodes.map(node => node.fill)).toEqual(['#ff0000', '#ff0080', '#aabbcc']);
  });

  it('omits fill none and preserves hidden nodes and visibility overrides', () => {
    const nodes = load('<rect width="1" height="1" fill="none"/><g visibility="hidden"><rect width="5" height="5"/><rect width="5" height="5" visibility="visible"/></g><g display="none"><rect width="5" height="5" display="inline"/></g><g opacity="0"><rect width="5" height="5" opacity="1"/></g><rect width="5" height="5" fill-opacity="0"/>');
    expect(nodes.map(node => node.hidden)).toEqual([true, false, true, true, true]);
  });

  it('permits explicitly non-rendering strokes and inherited stroke overrides', () => {
    expect(load('<g stroke="red"><rect width="10" height="10" stroke="none"/><rect width="10" height="10" stroke-width="0"/><rect width="10" height="10" stroke-opacity="0"/></g>')).toHaveLength(3);
  });

  it.each([
    '<rect width="10" height="10" stroke="red"/>',
    '<g stroke="blue"><path d="M0 0L10 0L10 10Z"/></g>',
    '<path d="M0 0L10 0" fill="none" stroke="#000"/>',
  ])('rejects meaningful stroke geometry: %s', body => {
    expect(() => load(body)).toThrow(/Convert strokes to filled paths/);
  });

  it.each(['fill="currentColor"', 'fill="transparent"', 'fill="constructor"', 'fill="#ff000080"', 'opacity="0.5"', 'fill-rule="evenodd"', 'style="mix-blend-mode:multiply"', 'style="fill:red !important"'])('rejects unsupported paint semantics: %s', attributes => {
    expect(() => load(`<rect width="10" height="10" ${attributes}/>`)).toThrow(/Cannot import SVG/);
  });
});

describe('nested and flattened transforms', () => {
  it('combines root, group and shape transforms in SVG order', () => {
    const [node] = load('<g transform="translate(10,20)"><g transform="scale(2 3)"><rect width="5" height="4" transform="translate(1 2)"/></g></g>');
    expectBounds(node.bounds, [12, 26, 10, 12]);
    expect(node.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('supports matrix and rotation about a centre', () => {
    expectBounds(load('<rect x="10" y="20" width="4" height="6" transform="rotate(90 10 20)"/>')[0].bounds, [4, 20, 6, 4]);
    expectBounds(load('<rect width="4" height="6" transform="matrix(2 0 0 3 10 20)"/>')[0].bounds, [10, 20, 8, 18]);
  });

  it('transforms elliptical arcs as well as straight edges', () => {
    const [node] = load('<ellipse cx="10" cy="20" rx="4" ry="6" transform="rotate(90 10 20) scale(1)"/>');
    expectBounds(node.bounds, [4, 16, 12, 8]);
  });

  it('handles reflections, skew and transform lists', () => {
    expectBounds(load('<rect width="4" height="6" transform="translate(10 20) scale(-2 3)"/>')[0].bounds, [2, 20, 8, 18]);
    expectBounds(load('<rect width="4" height="6" transform="skewX(45)"/>')[0].bounds, [0, 0, 10, 6]);
    expectBounds(load('<rect width="4" height="6" transform="skewY(45)"/>')[0].bounds, [0, 0, 4, 10]);
  });

  it('scales transformed shapes into mm after the viewBox mapping', () => {
    const [node] = load('<rect width="10" height="20" transform="translate(20 30) scale(2)"/>', 'width="96px" height="96px" viewBox="0 0 96 96"');
    expectBounds(node.bounds, [20 * PX_TO_MM, 30 * PX_TO_MM, 20 * PX_TO_MM, 40 * PX_TO_MM]);
  });

  it.each(['matrix(1 0 0 1 0)', 'translate(NaN)', 'scale(Infinity)', 'scale(1e999)', 'rotate(1 2)', 'skewX(90)', 'translate(1) garbage', 'scale(1),', 'scale(1e308) scale(1e308)'])('rejects invalid or non-finite transforms: %s', value => {
    expect(() => load(`<rect width="10" height="10" transform="${value}"/>`)).toThrow(/Cannot import SVG/);
  });
});

describe('hostile and malformed input', () => {
  it.each([
    '<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.com/x.png"/>', '<text>hello</text>',
    '<use href="#x"/>', '<defs><path id="x" d="M0 0L1 1Z"/></defs>', '<style>rect{fill:red}</style>',
    '<linearGradient/>', '<filter/>', '<mask/>', '<clipPath/>', '<constructor/>', '<svg viewBox="0 0 10 10"/>',
    '<line x1="0" y1="0" x2="10" y2="10"/>', '<rect xmlns="http://www.w3.org/1999/xhtml" width="10" height="10"/>',
  ])('rejects unsafe or unsupported elements even alongside valid geometry: %s', body => {
    expect(() => load(`<rect width="10" height="10"/>${body}`)).toThrow(/Cannot import SVG/);
  });

  it.each([
    'onload="alert(1)"', 'onclick="alert(1)"', 'href="https://example.com/"', 'fill="url(#gradient)"',
    'style="fill:url(https://example.com/x)"', 'filter="url(#filter)"', 'mask="none"', 'clip-path="none"',
    'vector-effect="non-scaling-stroke"',
  ])('rejects dangerous or unrepresentable attributes: %s', attributes => {
    expect(() => load(`<rect width="10" height="10" ${attributes}/>`)).toThrow(/Cannot import SVG/);
  });

  it.each(['M0 0 L10', 'M0 0 WHAT 10 20', 'L0 0L10 10', 'M0 0L1e999 10', 'M-1e308 0L1e308 0L1e308 1Z', 'M0 0A-5 5 0 0 1 10 10', 'M0 0A5 5 0 2 1 10 10', ''])('rejects malformed paths: %s', d => {
    expect(() => load(`<path d="${d}"/>`)).toThrow(/Cannot import SVG/);
  });

  it.each([
    '<svg><rect></svg>', '<html/>', '<!DOCTYPE svg [<!ENTITY x "boom">]><svg>&x;</svg>',
    '<?xml-stylesheet href="https://example.com/style.css"?><svg/>',
  ])('rejects malformed XML, entities, non-SVG roots and external processing instructions', source => {
    expect(() => importSvg(source, 'bad.svg')).toThrow(/Cannot import SVG/);
  });

  it('accepts an ordinary XML declaration, comments and descriptive title', () => {
    expect(importSvg(`<?xml version="1.0"?>${svg('<!-- harmless --><title>Drawing</title><desc>Original design</desc><rect width="10" height="10"/>')}`, 'good.svg')).toHaveLength(1);
  });

  it.each(['<rect width="-1" height="10"/>', '<circle r="0"/>', '<polygon points="0,0 1,1"/>', '<polyline points="0 0 1 1 2"/>', '<rect width="NaN" height="10"/>', '<path d="M0 0L10 0"/>', ''])('rejects invalid or absent cut geometry: %s', body => {
    expect(() => load(body)).toThrow(/Cannot import SVG/);
  });

  it('enforces the source byte limit, including multibyte input', () => {
    expect(() => importSvg(' '.repeat(10 * 1024 * 1024 + 1), 'large.svg')).toThrow(/10 MB/);
    expect(() => importSvg('ø'.repeat(5 * 1024 * 1024 + 1), 'large.svg')).toThrow(/10 MB/);
  });

  it('enforces the element and nesting limits', () => {
    expect(() => load('<g/>'.repeat(10_000))).toThrow(/10,000 element/);
    expect(() => load(`${'<g>'.repeat(130)}<rect width="10" height="10"/>${'</g>'.repeat(130)}`)).toThrow(/nested too deeply/);
  });
});
