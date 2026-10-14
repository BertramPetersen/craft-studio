import { describe, expect, it } from 'vitest';
import { exportProject, exportSvg, parseProject } from '../src/core/project';
import type { DesignNode } from '../src/core/types';

function node(overrides: Partial<DesignNode> = {}): DesignNode {
  return { id: 'shape', name: 'Rectangle', path: 'M0 0H10V20H0Z', bounds: { x: 0, y: 0, width: 10, height: 20 },
    transform: [1, 0, 0, 1, 0, 0], fill: '#123456', hidden: false, locked: false, ...overrides };
}

function project(nodes: unknown[] = [node()], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'craft-studio', version: 1, name: 'My artwork', nodes, ...overrides });
}

describe('project files', () => {
  it('round trips shapes and optional text metadata with a self-contained baked path', () => {
    const nodes = [node({ text: { text: 'Hello\nworld 😀', fontId: 'local-font', fontName: 'Local Font', size: 12 } }),
      node({ id: 'hidden', hidden: true, locked: true, fill: '#aBcD' })];
    const parsed = parseProject(exportProject('Design & <name>', nodes));
    expect(parsed).toEqual({ format: 'craft-studio', version: 1, name: 'Design & <name>', nodes });
    expect(parsed.nodes).not.toBe(nodes);
    expect(parsed.nodes[0].bounds).not.toBe(nodes[0].bounds);
    expect(parsed.nodes[0].transform).not.toBe(nodes[0].transform);
    expect(exportSvg(parsed.nodes)).toContain('d="M0 0H10V20H0Z"');
    expect(exportSvg(parsed.nodes)).not.toContain('<text');
    expect(exportSvg(parsed.nodes)).not.toContain('local-font');
  });

  it('permits empty projects but rejects malformed or unsupported envelopes', () => {
    expect(parseProject(project([])).nodes).toEqual([]);
    for (const source of ['', '{', 'null', '[]', '42', '{}', project([], { format: 'other' }),
      project([], { version: 2 }), project([], { name: 42 }), project([], { script: 'alert(1)' }),
      project([], { nodes: {} })]) expect(() => parseProject(source)).toThrow(/Invalid project/);
  });

  it('rejects duplicate IDs and missing or malformed shape fields', () => {
    expect(() => parseProject(project([node(), node()]))).toThrow(/Duplicate/);
    const badValues: Record<string, unknown>[] = [
      { id: '' }, { id: ' '.repeat(5) }, { id: 'x'.repeat(129) }, { name: null }, { path: null },
      { hidden: 'false' }, { locked: 0 }, { bounds: [] }, { bounds: { x: 0, y: 0, width: -1, height: 1 } },
      { bounds: { x: 0, y: 0, width: 1 } }, { bounds: { x: 1e9, y: 0, width: 1, height: 1 } },
      { transform: [1, 0, 0, 1, 0] }, { transform: [1, 0, 0, 1, '0', 0] },
      { transform: [1, 2, 2, 4, 0, 0] }, { transform: [1, 0, 0, 1e-13, 0, 0] },
      { transform: [1e7, 0, 0, 1, 0, 0] }, { transform: [1, 0, 0, 1, 1e10, 0] },
      { transform: [1e6, 0, 0, 1e6, 0, 0], bounds: { x: 0, y: 0, width: 1e6, height: 1e6 } },
      { text: null }, { text: { text: 'hi', fontId: 'f', fontName: 'F', size: 0 } },
      { text: { text: 'hi', fontId: 'f', fontName: 'F', size: 12, url: 'https://example.com/font' } },
    ];
    for (const override of badValues) expect(() => parseProject(project([{ ...node(), ...override }]))).toThrow();
    const { hidden: _hidden, ...missing } = node();
    expect(() => parseProject(project([missing]))).toThrow();
  });

  it('rejects nonfinite numbers both in JSON and from export callers', () => {
    expect(() => parseProject(project().replace('"width":10', '"width":1e999'))).toThrow(/finite/);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => exportProject('Bad', [node({ transform: [1, 0, 0, 1, value, 0] })])).toThrow();
      expect(() => exportSvg([node({ bounds: { x: 0, y: 0, width: value, height: 1 } })])).toThrow();
    }
  });

  it('validates paths using the SVG path grammar and limits numeric coordinates', () => {
    for (const path of ['', ' ', 'L1 2', 'M0', 'M0 0 X2 2', 'M0 0L1 nope', 'M0 0L1e999 2',
      'M0 0L1000000001 2', '<path d="M0 0"/>', 'M0 0<script>alert(1)</script>',
      'M0 0A1 1 0 2 0 10 10', 'M1000000000 0l1 0']) {
      expect(() => parseProject(project([node({ path })])), path).toThrow();
    }
    for (const path of ['M.5-.5 l2 3z', 'M0 0C1 2 3 4 5 6S8 9 10 10', 'M0 0Q1 2 3 4T5 6',
      'M0 0A10 10 0 1 0 20 20z']) expect(parseProject(project([node({ path })])).nodes[0].path).toBe(path);
  });

  it('rejects external references, executable members, unsafe paints and prototype members', () => {
    for (const fill of ['red', 'none', '#12', '#12345', '#1234567', '#ggg', 'url(#paint)',
      'url(https://example.com/p.svg)', '#fff" onload="alert(1)']) {
      expect(() => parseProject(project([node({ fill })]))).toThrow();
    }
    for (const key of ['href', 'xlink:href', 'onload', 'style', 'svg', '__proto__', 'constructor']) {
      const malicious = JSON.parse(project());
      Object.defineProperty(malicious.nodes[0], key, { value: 'evil', enumerable: true });
      expect(() => parseProject(JSON.stringify(malicious))).toThrow(/Unexpected/);
    }
    for (const fill of ['#abc', '#abcd', '#ABCDEF', '#12345678']) {
      expect(parseProject(project([node({ fill })])).nodes[0].fill).toBe(fill);
    }
  });

  it('rejects XML-illegal metadata while allowing escaped markup as plain text', () => {
    for (const name of ['bad\u0000name', '\ud800', '\udfff', '\uffff']) {
      expect(() => parseProject(project([node({ name })]))).toThrow();
    }
    expect(parseProject(project([node({ name: '<script>plain text</script>' })])).nodes[0].name)
      .toBe('<script>plain text</script>');
  });

  it('enforces node, file, path and text member budgets', () => {
    expect(() => parseProject(project(Array(10_001).fill(node())))).toThrow(/10000/);
    expect(() => parseProject(' '.repeat(10 * 1024 * 1024 + 1))).toThrow(/10 MiB/);
    expect(() => parseProject('😀'.repeat(3 * 1024 * 1024))).toThrow(/10 MiB/);
    expect(() => parseProject(project([node({ path: `M0 0${' '.repeat(1_000_000)}` })]))).toThrow(/1000000/);
    expect(() => parseProject(project([node({ path: `M0 0${'L1 1'.repeat(100_000)}` })]))).toThrow(/commands/);
    expect(() => parseProject(project([node({ name: 'a'.repeat(1025) })]))).toThrow();
    expect(() => parseProject(project([node({ text: { text: 'a'.repeat(100_001), fontId: 'f', fontName: 'F', size: 1 } })])))
      .toThrow();
    const padded = `M0 0H10V20H0Z${' '.repeat(940_000)}`;
    expect(() => parseProject(project(Array.from({ length: 9 }, (_, index) => node({ id: `n${index}`, path: padded })))))
      .toThrow(/Total path budget/);
    const manyCommands = `M0 0${'L1 1'.repeat(90_000)}`;
    expect(() => parseProject(project(Array.from({ length: 6 }, (_, index) => node({ id: `n${index}`, path: manyCommands })))))
      .toThrow(/Total path budget/);
  });

  it('refuses non-plain objects from export callers', () => {
    const inherited = Object.assign(Object.create({ script: 'evil' }), node()) as DesignNode;
    expect(() => exportProject('Bad', [inherited])).toThrow(/plain object/);
  });

  it('recomputes finite but incorrect imported bounds from the baked path', () => {
    const parsed = parseProject(project([node({ bounds: { x: 400, y: 900, width: 1, height: 1 } })]));
    expect(parsed.nodes[0].bounds).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(exportSvg(parsed.nodes)).toContain('width="10mm" height="20mm"');
  });
});

describe('SVG export', () => {
  it('uses physical millimetre dimensions and translates to a normalized viewBox', () => {
    const svg = exportSvg([node({ transform: [2, 0, 0, 3, 100, -50] })]);
    expect(svg).toContain('width="20mm" height="60mm" viewBox="0 0 20 60"');
    expect(svg).toContain('transform="matrix(2 0 0 3 0 0)"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('preserves rotation, skew, reflection and inter-node spacing', () => {
    const rotated = node({ transform: [0, 1, -1, 0, 10, 30] });
    const reflected = node({ id: 'other', transform: [-1, 0, 1, 1, 60, 20] });
    const svg = exportSvg([rotated, reflected]);
    expect(svg).toContain('width="90mm" height="20mm" viewBox="0 0 90 20"');
    expect(svg).toContain('matrix(0 1 -1 0 20 10)');
    expect(svg).toContain('matrix(-1 0 1 1 70 0)');
    expect(svg.indexOf('id="shape"')).toBeLessThan(svg.indexOf('id="other"'));
    expect(svg).not.toContain('<g');
  });

  it('excludes hidden nodes from paths and dimensions but includes locked nodes', () => {
    const svg = exportSvg([node({ hidden: true, transform: [100, 0, 0, 100, -2000, -2000] }),
      node({ id: 'locked', locked: true, transform: [1, 0, 0, 1, 50, 50] })]);
    expect(svg).not.toContain('id="shape"');
    expect(svg).toContain('id="locked"');
    expect(svg).toContain('width="10mm" height="20mm"');
    expect(svg).toContain('matrix(1 0 0 1 0 0)');
  });

  it('escapes metadata and never emits executable SVG or live text/font references', () => {
    const svg = exportSvg([node({ id: 'shape"<&\'!', name: '</title><script>alert("x")</script>&\'',
      text: { text: '<script>x</script>', fontId: 'file://font', fontName: 'Any Font', size: 10 } })]);
    expect(svg).toContain('id="shape&quot;&lt;&amp;&apos;!"');
    expect(svg).toContain('&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;');
    expect(svg).not.toMatch(/<script|href=|url\(|<text|file:\/\//);
  });

  it('rejects empty, hidden-only and zero-area artwork with user-facing errors', () => {
    expect(() => exportSvg([])).toThrow(/no visible shapes/);
    expect(() => exportSvg([node({ hidden: true })])).toThrow(/no visible shapes/);
    expect(() => exportSvg([node({ path: 'M0 0L0 0', bounds: { x: 0, y: 0, width: 0, height: 0 } })])).toThrow(/non-zero/);
  });
});
