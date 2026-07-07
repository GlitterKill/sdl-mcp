export const LAYOUT_SCHEMA_VERSION = 1;

export type LayoutInput = {
  nodes: Array<{ id: string; size: number }>;
  edges: Array<{ from: string; to: string; weight: number }>;
  initialPositions?: Record<string, { x: number; y: number; z: number }>;
};

export type LayoutResult = {
  layoutSchemaVersion: number;
  seed: number;
  iterations: number;
  inputHash: string;
  positions: Array<{ id: string; x: number; y: number; z: number }>;
};
