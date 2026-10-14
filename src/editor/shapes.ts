import type { DesignNode } from '../core/types';
import { svgPathBbox } from 'svg-path-bbox';

export function shape(kind: 'rectangle' | 'circle' | 'heart', x = 10, y = 10): DesignNode {
  const paths = {
    rectangle: 'M0 0H40V30H0Z',
    circle: 'M20 0A20 20 0 1 1 20 40A20 20 0 1 1 20 0Z',
    heart: 'M20 37C17 32 0 22 0 12C0-2 17-4 20 7C23-4 40-2 40 12C40 22 23 32 20 37Z',
  };
  const [left, top, right, bottom] = svgPathBbox(paths[kind]);
  return { id: crypto.randomUUID(), name: kind[0].toUpperCase() + kind.slice(1), path: paths[kind],
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    transform: [1, 0, 0, 1, x, y], fill: '#3468a8', hidden: false, locked: false };
}

export function sample(): DesignNode[] {
  const nodes = [shape('heart', 20, 20), shape('heart', 75, 20), shape('circle', 48, 70)];
  nodes[0].fill = '#c76578'; nodes[1].fill = '#d79651'; nodes[2].fill = '#3468a8';
  return nodes;
}
