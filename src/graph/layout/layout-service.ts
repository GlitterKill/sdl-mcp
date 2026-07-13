import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Connection } from "kuzu";

import {
  getClusterLayoutInputRows,
  getSymbolLayoutInputRows,
} from "../../db/ladybug-graph-read.js";
import { computeForceLayout, hashLayoutInput } from "./force-layout.js";
import { computeNativeLayout } from "./native-engine.js";
import { fnv1a32, mulberry32 } from "./prng.js";
import { LAYOUT_SCHEMA_VERSION, type LayoutInput, type LayoutResult } from "./types.js";

type LayoutLod = "cluster" | "symbol";

export type LayoutServiceOptions = {
  engine: "auto" | "typescript" | "rust";
  iterations: number;
  maxSymbolsPerClusterExpand: number;
  cacheDir?: string | null;
};

export type LayoutCacheArtifact = {
  result: LayoutResult;
  inputSizes: Record<string, number>;
};

// Tier-1 tolerates cluster-size drift up to 10% before re-layout
// (plan: only membership changes >10% or added/removed clusters re-layout).
const TIER1_SIZE_DRIFT_TOLERANCE = 0.1;
// Deterministic jitter radius for warm-start placement of new nodes.
const WARM_START_JITTER = 20;

function cacheRoot(options: LayoutServiceOptions): string {
  return resolve(options.cacheDir ?? resolve(process.cwd(), "viewer-layout-cache"));
}

function cacheSegment(value: string): string {
  return encodeURIComponent(value);
}

async function readCachedArtifact(file: string, seed: number): Promise<LayoutCacheArtifact | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<LayoutCacheArtifact>;
    const result = parsed.result;
    if (
      result &&
      result.layoutSchemaVersion === LAYOUT_SCHEMA_VERSION &&
      result.seed === seed &&
      Array.isArray(result.positions) &&
      parsed.inputSizes &&
      typeof parsed.inputSizes === "object"
    ) {
      return { result, inputSizes: parsed.inputSizes };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeCachedArtifact(file: string, artifact: LayoutCacheArtifact): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(artifact)}\n`, "utf8");
}

function inputSizeMap(input: LayoutInput): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const node of [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))) sizes[node.id] = node.size;
  return sizes;
}

function withinTier1Drift(cached: LayoutCacheArtifact, input: LayoutInput): boolean {
  const cachedIds = Object.keys(cached.inputSizes);
  if (cachedIds.length !== input.nodes.length) return false;
  for (const node of input.nodes) {
    const previous = cached.inputSizes[node.id];
    if (previous === undefined) return false;
    if (Math.abs(node.size - previous) / Math.max(previous, 1) > TIER1_SIZE_DRIFT_TOLERANCE) return false;
  }
  return true;
}

/**
 * Incremental warm start: surviving nodes keep their cached positions,
 * newcomers are PRNG-placed near the surviving centroid, and the layout
 * runs at half the configured iteration count. Deterministic for a given
 * (cached artifact, input, seed) triple.
 */
export function planWarmStart(
  cached: LayoutCacheArtifact,
  input: LayoutInput,
  seed: number,
  iterations: number,
): { initialPositions: Record<string, { x: number; y: number; z: number }>; iterations: number } | null {
  const previous = new Map(cached.result.positions.map((position) => [position.id, position]));
  const survivors = input.nodes.filter((node) => previous.has(node.id));
  if (survivors.length === 0) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const node of survivors) {
    const position = previous.get(node.id);
    if (!position) continue;
    cx += position.x;
    cy += position.y;
    cz += position.z;
  }
  cx /= survivors.length;
  cy /= survivors.length;
  cz /= survivors.length;
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const initialPositions: Record<string, { x: number; y: number; z: number }> = {};
  for (const node of [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const position = previous.get(node.id);
    if (position) {
      initialPositions[node.id] = { x: position.x, y: position.y, z: position.z };
    } else {
      initialPositions[node.id] = {
        x: cx + (rand() * 2 - 1) * WARM_START_JITTER,
        y: cy + (rand() * 2 - 1) * WARM_START_JITTER,
        z: cz + (rand() * 2 - 1) * WARM_START_JITTER,
      };
    }
  }
  return { initialPositions, iterations: Math.max(1, Math.floor(iterations / 2)) };
}

async function clusterInput(conn: Connection, repoId: string): Promise<LayoutInput> {
  return getClusterLayoutInputRows(conn, repoId);
}

async function symbolInput(conn: Connection, repoId: string, clusterId: string): Promise<LayoutInput> {
  return getSymbolLayoutInputRows(conn, repoId, clusterId);
}

async function computeWithEngine(
  input: LayoutInput,
  seed: number,
  iterations: number,
  engine: LayoutServiceOptions["engine"],
): Promise<LayoutResult> {
  const nativeResult = engine === "typescript" ? null : computeNativeLayout(input, seed, iterations);
  if (engine === "rust" && !nativeResult) {
    throw new Error("native layout engine unavailable");
  }
  return nativeResult ?? computeForceLayout(input, seed, iterations);
}

/**
 * Iteration budget for large graphs: a full O(n^2) force pass at the
 * configured iteration count is too slow past ~1,500 nodes, so the count
 * scales down quadratically. Pure function of (nodeCount, iterations) so
 * layouts stay deterministic.
 */
export function effectiveIterations(nodeCount: number, iterations: number): number {
  if (nodeCount <= 1500) return iterations;
  const scaled = Math.floor((iterations * (1500 * 1500)) / (nodeCount * nodeCount));
  return Math.max(50, Math.min(iterations, scaled));
}

export async function getLayout(
  conn: Connection,
  repoId: string,
  lod: LayoutLod,
  clusterId: string | undefined,
  options: LayoutServiceOptions,
): Promise<LayoutResult> {
  const input = lod === "cluster" ? await clusterInput(conn, repoId) : await symbolInput(conn, repoId, clusterId ?? "");
  if (lod === "symbol" && input.nodes.length > options.maxSymbolsPerClusterExpand) {
    throw new Error("cluster expansion limit exceeded");
  }
  const seed = fnv1a32(`${repoId}:${clusterId ?? "cluster"}:${LAYOUT_SCHEMA_VERSION}`);
  const iterations = effectiveIterations(input.nodes.length, options.iterations);
  const inputHash = hashLayoutInput(input);
  const file = lod === "cluster"
    ? resolve(cacheRoot(options), cacheSegment(repoId), "tier1.json")
    : resolve(cacheRoot(options), cacheSegment(repoId), `cluster-${cacheSegment(clusterId ?? "")}.json`);
  const cached = await readCachedArtifact(file, seed);
  if (cached && cached.result.inputHash === inputHash) return cached.result;
  if (cached && lod === "cluster" && withinTier1Drift(cached, input)) return cached.result;
  const warmStart = cached ? planWarmStart(cached, input, seed, iterations) : null;
  const result = warmStart
    ? await computeWithEngine({ ...input, initialPositions: warmStart.initialPositions }, seed, warmStart.iterations, options.engine)
    : await computeWithEngine(input, seed, iterations, options.engine);
  await writeCachedArtifact(file, { result, inputSizes: inputSizeMap(input) });
  return result;
}
