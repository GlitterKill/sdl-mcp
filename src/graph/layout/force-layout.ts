import { createHash } from "node:crypto";

import { mulberry32 } from "./prng.js";
import { LAYOUT_SCHEMA_VERSION, type LayoutInput, type LayoutResult } from "./types.js";

const EPSILON = 1e-9;

export function hashLayoutInput(input: LayoutInput): string {
  const nodes = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...input.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.weight - b.weight);
  const hash = createHash("sha256");
  for (const node of nodes) hash.update(`n\0${node.id}\0${node.size}\n`);
  for (const edge of edges) hash.update(`e\0${edge.from}\0${edge.to}\0${edge.weight}\n`);
  return hash.digest("hex");
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function initialPoint(rand: () => number, width: number): { x: number; y: number; z: number } {
  const u = rand();
  const v = rand();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const radius = width * (0.25 + rand() * 0.25);
  return {
    x: radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

export async function computeForceLayout(input: LayoutInput, seed: number, iterations: number): Promise<LayoutResult> {
  const nodes = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...input.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.weight - b.weight);
  const inputHash = hashLayoutInput({ nodes, edges });
  const width = Math.max(100, Math.sqrt(Math.max(nodes.length, 1)) * 100);
  const area = width * width;
  const k = Math.sqrt(area / Math.max(nodes.length, 1));
  const rand = mulberry32(seed);

  // Index-based hot loop: identical float op order to the reference
  // formulation, but O(1) array lookups instead of string-keyed maps.
  // Any change here must be mirrored in native/src/layout.rs (parity).
  const count = nodes.length;
  const indexById = new Map<string, number>();
  for (let i = 0; i < count; i += 1) indexById.set(nodes[i].id, i);
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const point = input.initialPositions?.[nodes[i].id] ?? initialPoint(rand, width);
    px[i] = point.x;
    py[i] = point.y;
    pz[i] = point.z;
  }
  const edgeCount = edges.length;
  const edgeFrom = new Int32Array(edgeCount);
  const edgeTo = new Int32Array(edgeCount);
  const edgeWeight = new Float64Array(edgeCount);
  for (let e = 0; e < edgeCount; e += 1) {
    edgeFrom[e] = indexById.get(edges[e].from) ?? -1;
    edgeTo[e] = indexById.get(edges[e].to) ?? -1;
    edgeWeight[e] = edges[e].weight;
  }
  const dispX = new Float64Array(count);
  const dispY = new Float64Array(count);
  const dispZ = new Float64Array(count);

  let temp = width / 10;
  for (let iter = 0; iter < iterations; iter += 1) {
    dispX.fill(0);
    dispY.fill(0);
    dispZ.fill(0);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dx = px[i] - px[j];
        const dy = py[i] - py[j];
        const dz = pz[i] - pz[j];
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), EPSILON);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        dispX[i] += fx; dispY[i] += fy; dispZ[i] += fz;
        dispX[j] -= fx; dispY[j] -= fy; dispZ[j] -= fz;
      }
    }
    for (let e = 0; e < edgeCount; e += 1) {
      const from = edgeFrom[e];
      const to = edgeTo[e];
      if (from < 0 || to < 0) continue;
      const dx = px[from] - px[to];
      const dy = py[from] - py[to];
      const dz = pz[from] - pz[to];
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), EPSILON);
      const force = ((dist * dist) / k) * Math.max(edgeWeight[e], 0.1);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      dispX[from] -= fx; dispY[from] -= fy; dispZ[from] -= fz;
      dispX[to] += fx; dispY[to] += fy; dispZ[to] += fz;
    }
    for (let i = 0; i < count; i += 1) {
      const len = Math.max(Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i] + dispZ[i] * dispZ[i]), EPSILON);
      px[i] += (dispX[i] / len) * Math.min(len, temp);
      py[i] += (dispY[i] / len) * Math.min(len, temp);
      pz[i] += (dispZ[i] / len) * Math.min(len, temp);
    }
    temp *= 0.95;
    if (iter % 10 === 9) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    layoutSchemaVersion: LAYOUT_SCHEMA_VERSION,
    seed,
    iterations,
    inputHash,
    positions: nodes.map((node, i) => ({ id: node.id, x: round6(px[i]), y: round6(py[i]), z: round6(pz[i]) })),
  };
}
