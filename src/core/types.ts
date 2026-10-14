export type Matrix = [number, number, number, number, number, number];
export type Bounds = { x: number; y: number; width: number; height: number };

export type TextSource = {
  text: string;
  fontId: string;
  fontName: string;
  size: number;
};

// All document-space distances are millimetres, including font size.
export type DesignNode = {
  id: string;
  name: string;
  path: string;
  bounds: Bounds;
  transform: Matrix;
  fill: string;
  hidden: boolean;
  locked: boolean;
  text?: TextSource;
};

export type Project = {
  format: 'craft-studio';
  version: 1;
  name: string;
  nodes: DesignNode[];
};

export type FontRecord = {
  id: string;
  name: string;
  bytes: ArrayBuffer;
};

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
