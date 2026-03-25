import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  getSymbolEmbeddingsFromNodes,
  type SymbolNodeEmbeddingRow,
} from "../db/ladybug-symbol-embeddings.js";
import { hashContent } from "../util/hashing.js";
import { LEGACY_ANN_MAINTENANCE_MODE } from "../config/constants.js";
import { logger } from "../util/logger.js";

/** @deprecated Use provider.getDimension() instead. Kept for backward compat. */
export const EMBEDDING_DIMENSION = 64;

/**
 * Internal embedding row shape used by the ANN index.
 * Bridges the legacy SymbolEmbeddingRow (embeddingVector field) and the
 * new SymbolNodeEmbeddingRow (vector field) from the Symbol-node helpers.
 */
export interface AnnEmbeddingRow {
  symbolId: string;
  model: string;
  embeddingVector: string;
  cardHash: string;
  version?: string;
}

/** Convert a SymbolNodeEmbeddingRow map into AnnEmbeddingRow[] for the given model. */
function nodeEmbeddingsToAnnRows(
  map: Map<string, SymbolNodeEmbeddingRow>,
  model: string,
): AnnEmbeddingRow[] {
  const rows: AnnEmbeddingRow[] = [];
  for (const [symbolId, row] of map) {
    rows.push({
      symbolId,
      model,
      embeddingVector: row.vector,
      cardHash: row.cardHash,
    });
  }
  return rows;
}

export interface AnnConfig {
  enabled: boolean;
  m: number;
  efConstruction: number;
  efSearch: number;
  maxElements: number;
}

export const DEFAULT_ANN_CONFIG: AnnConfig = {
  enabled: true,
  m: 16,
  efConstruction: 200,
  efSearch: 50,
  maxElements: 200000,
};

interface HnswNode {
  id: number;
  symbolId: string;
  vector: number[];
  level: number;
  neighbors: Map<number, Set<number>>;
}

export interface SearchResult {
  symbolId: string;
  score: number;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  if (norm <= 1e-9) return vector;
  return vector.map((v) => v / norm);
}

function fromFloat16Blob(blob: string): number[] {
  if (!blob) return [];
  const buffer = Buffer.from(blob, "base64");
  const view = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 2,
  );
  const vector = new Array<number>(view.length);
  for (let i = 0; i < view.length; i++) {
    vector[i] = view[i] / 10000;
  }
  return normalizeVector(vector);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-9) return 0;
  return dot / denom;
}

function computeVersionHash(rows: AnnEmbeddingRow[]): string {
  const payload = rows
    .map((r) => `${r.symbolId}:${r.model}:${r.version ?? "v1"}:${r.cardHash}`)
    .sort()
    .join("|");
  return hashContent(payload);
}

class SimplePseudoRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1103515245) + 12345) & 0x7fffffff;
    return this.state / 0x7fffffff;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

export class HnswIndex {
  private nodes: Map<number, HnswNode> = new Map();
  private symbolToId: Map<string, number> = new Map();
  private idToSymbol: Map<number, string> = new Map();
  private nextId = 0;
  private maxLevel = -1;
  private entryPoint: number | null = null;
  private config: AnnConfig;
  private versionHash: string | null = null;
  private model: string | null = null;
  private dimension = 0; // Set from first inserted vector or config

  constructor(config: AnnConfig = DEFAULT_ANN_CONFIG) {
    this.config = config;
  }

  private randomLevel(rng: SimplePseudoRandom): number {
    let level = 0;
    while (rng.next() < 1 / Math.E && level < 16) {
      level++;
    }
    return level;
  }

  private getNeighbors(node: HnswNode, level: number): Set<number> {
    if (!node.neighbors.has(level)) {
      node.neighbors.set(level, new Set());
    }
    return node.neighbors.get(level)!;
  }

  private searchLayer(
    query: number[],
    entryPoints: number[],
    ef: number,
    level: number,
  ): { id: number; score: number }[] {
    const visited = new Set<number>(entryPoints);
    const candidates: { id: number; score: number }[] = [];
    const results: { id: number; score: number }[] = [];

    for (const ep of entryPoints) {
      const node = this.nodes.get(ep);
      if (!node) continue;
      const score = cosineSimilarity(query, node.vector);
      candidates.push({ id: ep, score });
      results.push({ id: ep, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    results.sort((a, b) => b.score - a.score);

    while (candidates.length > 0) {
      const nearest = candidates.shift()!;
      const worstResult = results[results.length - 1];

      if (worstResult && nearest.score < worstResult.score) {
        break;
      }

      const nearestNode = this.nodes.get(nearest.id);
      if (!nearestNode) continue;

      const neighbors = this.getNeighbors(nearestNode, level);
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const score = cosineSimilarity(query, neighborNode.vector);

        if (results.length < ef || score > results[results.length - 1].score) {
          candidates.push({ id: neighborId, score });
          candidates.sort((a, b) => b.score - a.score);

          results.push({ id: neighborId, score });
          results.sort((a, b) => b.score - a.score);

          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results;
  }

  private selectNeighbors(
    candidates: { id: number; score: number }[],
    m: number,
  ): number[] {
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, m).map((c) => c.id);
  }

  insert(symbolId: string, vector: number[], rng?: SimplePseudoRandom): void {
    if (this.symbolToId.has(symbolId)) {
      return;
    }

    // Auto-detect dimension from first vector
    if (this.dimension === 0 && vector.length > 0) {
      this.dimension = vector.length;
    }

    const id = this.nextId++;
    const localRng = rng ?? new SimplePseudoRandom(id);
    const level = this.randomLevel(localRng);
    const normalizedVector = normalizeVector(vector);

    const node: HnswNode = {
      id,
      symbolId,
      vector: normalizedVector,
      level,
      neighbors: new Map(),
    };

    this.nodes.set(id, node);
    this.symbolToId.set(symbolId, id);
    this.idToSymbol.set(id, symbolId);

    if (this.entryPoint === null) {
      this.entryPoint = id;
      this.maxLevel = level;
      return;
    }

    let currNode = this.nodes.get(this.entryPoint);
    if (!currNode) return;

    for (let lc = this.maxLevel; lc > level; lc--) {
      const results = this.searchLayer(normalizedVector, [currNode.id], 1, lc);
      if (results.length > 0) {
        const nextNode = this.nodes.get(results[0].id);
        if (nextNode) currNode = nextNode;
      }
    }

    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const entryPoints = currNode
        ? [currNode.id]
        : this.entryPoint !== null
          ? [this.entryPoint]
          : [];
      if (entryPoints.length === 0) continue;

      const results = this.searchLayer(
        normalizedVector,
        entryPoints,
        this.config.efConstruction,
        lc,
      );
      const neighbors = this.selectNeighbors(results, this.config.m);

      const nodeNeighbors = this.getNeighbors(node, lc);
      for (const neighborId of neighbors) {
        nodeNeighbors.add(neighborId);
        const neighborNode = this.nodes.get(neighborId);
        if (neighborNode) {
          const neighborNeighbors = this.getNeighbors(neighborNode, lc);
          neighborNeighbors.add(id);
          if (neighborNeighbors.size > this.config.m) {
            const scores = Array.from(neighborNeighbors).map((nid) => ({
              id: nid,
              score: cosineSimilarity(
                neighborNode.vector,
                this.nodes.get(nid)?.vector ?? [],
              ),
            }));
            const selected = this.selectNeighbors(scores, this.config.m);
            neighborNeighbors.clear();
            selected.forEach((nid) => neighborNeighbors.add(nid));
          }
        }
      }

      if (results.length > 0) {
        const nextNode = this.nodes.get(results[0].id);
        if (nextNode) currNode = nextNode;
      }
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = id;
    }
  }

  search(query: number[], k: number): SearchResult[] {
    if (this.entryPoint === null || this.nodes.size === 0) {
      return [];
    }

    const normalizedQuery = normalizeVector(query);
    let currNode = this.nodes.get(this.entryPoint);
    if (!currNode) return [];

    for (let lc = this.maxLevel; lc > 0; lc--) {
      const results = this.searchLayer(normalizedQuery, [currNode.id], 1, lc);
      if (results.length > 0) {
        const nextNode = this.nodes.get(results[0].id);
        if (nextNode) currNode = nextNode;
      }
    }

    const results = this.searchLayer(
      normalizedQuery,
      [currNode.id],
      Math.max(k, this.config.efSearch),
      0,
    );

    return results
      .slice(0, k)
      .map((r) => ({
        symbolId: this.idToSymbol.get(r.id) ?? "",
        score: r.score,
      }))
      .filter((r) => r.symbolId.length > 0);
  }

  size(): number {
    return this.nodes.size;
  }

  getVersionHash(): string | null {
    return this.versionHash;
  }

  setVersionHash(hash: string): void {
    this.versionHash = hash;
  }

  getModel(): string | null {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getDimension(): number {
    return this.dimension;
  }

  clear(): void {
    this.nodes.clear();
    this.symbolToId.clear();
    this.idToSymbol.clear();
    this.nextId = 0;
    this.maxLevel = -1;
    this.entryPoint = null;
    this.versionHash = null;
    this.model = null;
  }
}

export type AnnIndexStatus = "uninitialized" | "ready" | "stale" | "error";

export interface AnnIndexState {
  status: AnnIndexStatus;
  index: HnswIndex | null;
  versionHash: string | null;
  model: string | null;
  symbolCount: number;
  lastBuiltAt: string | null;
  error: string | null;
}

export class AnnIndexManager {
  private state: AnnIndexState = {
    status: "uninitialized",
    index: null,
    versionHash: null,
    model: null,
    symbolCount: 0,
    lastBuiltAt: null,
    error: null,
  };

  private config: AnnConfig;
  private buildPromise: Promise<{ indexed: number; skipped: number }> | null =
    null;

  constructor(config: AnnConfig = DEFAULT_ANN_CONFIG) {
    this.config = config;
  }

  getStatus(): AnnIndexStatus {
    return this.state.status;
  }

  getState(): AnnIndexState {
    return { ...this.state };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async buildIndex(params: {
    repoId: string;
    model: string;
    embeddingRows?: AnnEmbeddingRow[];
  }): Promise<{ indexed: number; skipped: number }> {
    if (!LEGACY_ANN_MAINTENANCE_MODE) {
      logger.debug("[ann-index] ANN index build skipped \u2014 legacy maintenance mode is off");
      return { indexed: 0, skipped: 0 };
    }
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this._buildIndexInternal(params);
    try {
      return await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
  }

  private async _buildIndexInternal(params: {
    repoId: string;
    model: string;
    embeddingRows?: AnnEmbeddingRow[];
  }): Promise<{ indexed: number; skipped: number }> {
    if (!this.config.enabled) {
      return { indexed: 0, skipped: 0 };
    }

    try {
      const conn = await getLadybugConn();
      const allSymbols = await ladybugDb.getSymbolsByRepo(conn, params.repoId);
      const symbolIds = allSymbols.map((s) => s.symbolId);

      let embeddingRows: AnnEmbeddingRow[];
      if (params.embeddingRows) {
        embeddingRows = params.embeddingRows;
      } else {
        const nodeMap = await getSymbolEmbeddingsFromNodes(
          conn,
          symbolIds,
          params.model,
        );
        embeddingRows = nodeEmbeddingsToAnnRows(nodeMap, params.model);
      }

      const newVersionHash = computeVersionHash(embeddingRows);
      const newIndex = new HnswIndex(this.config);

      const rng = new SimplePseudoRandom(42);
      let indexed = 0;
      let skipped = 0;

      for (const row of embeddingRows) {
        if (row.model !== params.model) {
          skipped++;
          continue;
        }
        const vector = fromFloat16Blob(row.embeddingVector);
        if (vector.length === 0) {
          skipped++;
          continue;
        }
        newIndex.insert(row.symbolId, vector, rng);
        indexed++;
      }

      this.state = {
        status: "ready",
        index: newIndex,
        versionHash: newVersionHash,
        model: params.model,
        symbolCount: indexed,
        lastBuiltAt: new Date().toISOString(),
        error: null,
      };

      return { indexed, skipped };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.state = {
        ...this.state,
        status: "error",
        error: errorMessage,
      };
      throw error;
    }
  }

  checkStaleness(params: {
    model: string;
    embeddingRows: AnnEmbeddingRow[];
  }): boolean {
    if (this.state.status !== "ready" || !this.state.index) {
      return true;
    }

    if (this.state.model !== params.model) {
      return true;
    }

    const currentHash = computeVersionHash(params.embeddingRows);
    return this.state.versionHash !== currentHash;
  }

  search(query: number[], k: number): SearchResult[] {
    if (
      !this.config.enabled ||
      this.state.status !== "ready" ||
      !this.state.index
    ) {
      return [];
    }

    return this.state.index.search(query, k);
  }

  async searchWithFallback(params: {
    query: number[];
    k: number;
    symbolIds: string[];
  }): Promise<SearchResult[]> {
    if (
      !this.config.enabled ||
      this.state.status !== "ready" ||
      !this.state.index
    ) {
      return this.exactSearch(params.query, params.symbolIds, params.k);
    }

    const annResults = this.state.index.search(params.query, params.k * 2);

    const annSet = new Set(annResults.map((r) => r.symbolId));
    const missing = params.symbolIds.filter((id) => !annSet.has(id));

    if (missing.length > 0) {
      const exactResults = await this.exactSearch(
        params.query,
        missing,
        Math.ceil(params.k * 0.2),
      );
      const combined = [...annResults, ...exactResults];
      combined.sort((a, b) => b.score - a.score);
      return combined.slice(0, params.k);
    }

    return annResults.slice(0, params.k);
  }

  private async exactSearch(
    query: number[],
    symbolIds: string[],
    k: number,
  ): Promise<SearchResult[]> {
    const normalizedQuery = normalizeVector(query);
    const conn = await getLadybugConn();
    const model = this.state.model ?? "all-MiniLM-L6-v2";
    const nodeMap = await getSymbolEmbeddingsFromNodes(conn, symbolIds, model);

    const results: SearchResult[] = [];
    for (const symbolId of symbolIds) {
      const row = nodeMap.get(symbolId);
      if (!row) continue;

      const vector = fromFloat16Blob(row.vector);
      if (vector.length === 0) continue;

      const score = cosineSimilarity(normalizedQuery, vector);
      results.push({ symbolId, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  invalidate(): void {
    if (this.state.index) {
      this.state.index.clear();
    }
    this.state = {
      status: "stale",
      index: null,
      versionHash: null,
      model: null,
      symbolCount: 0,
      lastBuiltAt: this.state.lastBuiltAt,
      error: null,
    };
  }

  clear(): void {
    if (this.state.index) {
      this.state.index.clear();
    }
    this.state = {
      status: "uninitialized",
      index: null,
      versionHash: null,
      model: null,
      symbolCount: 0,
      lastBuiltAt: null,
      error: null,
    };
  }
}

let globalAnnManager: AnnIndexManager | null = null;

export function getAnnIndexManager(config?: AnnConfig): AnnIndexManager {
  if (!globalAnnManager) {
    globalAnnManager = new AnnIndexManager(config ?? DEFAULT_ANN_CONFIG);
  }
  return globalAnnManager;
}

export function resetAnnIndexManager(): void {
  if (globalAnnManager) {
    globalAnnManager.clear();
  }
  globalAnnManager = null;
}

export function exactCosineSearch(params: {
  query: number[];
  symbolIds: string[];
  k: number;
  model?: string;
}): Promise<SearchResult[]> {
  const normalizedQuery = normalizeVector(params.query);
  const model = params.model ?? "all-MiniLM-L6-v2";

  return (async () => {
    const conn = await getLadybugConn();
    const nodeMap = await getSymbolEmbeddingsFromNodes(
      conn,
      params.symbolIds,
      model,
    );

    const results: SearchResult[] = [];
    for (const symbolId of params.symbolIds) {
      const row = nodeMap.get(symbolId);
      if (!row) continue;

      const vector = fromFloat16Blob(row.vector);
      if (vector.length === 0) continue;

      const score = cosineSimilarity(normalizedQuery, vector);
      results.push({ symbolId, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, params.k);
  })();
}

export { cosineSimilarity, normalizeVector };
