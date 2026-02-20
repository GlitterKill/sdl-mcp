import type { GraphSlice, CardDetailLevel } from "../mcp/types.js";
import type { RepoId, VersionId, SymbolId } from "../db/schema.js";

interface SliceBuildRequest {
  repoId: RepoId;
  versionId: VersionId;
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  knownCardEtags?: Record<SymbolId, string>;
  cardDetail?: CardDetailLevel;
  budget?: {
    maxCards?: number;
    maxEstimatedTokens?: number;
  };
}

interface SliceCacheEntry {
  slice: GraphSlice;
  expiresAt: number;
  createdAt: number;
}

const DEFAULT_SLICE_CACHE_TTL_MS = 60_000;
const DEFAULT_SLICE_CACHE_MAX = 100;
let sliceCacheTtlMs = DEFAULT_SLICE_CACHE_TTL_MS;
let sliceCacheMax = DEFAULT_SLICE_CACHE_MAX;
const sliceCache = new Map<string, SliceCacheEntry>();
const accessOrder: string[] = [];

export function configureSliceCache(options: {
  maxEntries?: number;
  ttlMs?: number;
}): void {
  if (options.maxEntries !== undefined && options.maxEntries >= 1) {
    sliceCacheMax = options.maxEntries;
  }
  if (options.ttlMs !== undefined && options.ttlMs >= 1000) {
    sliceCacheTtlMs = options.ttlMs;
  }
}

interface SliceCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  hitRate: number;
}

let cacheStats: SliceCacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  currentSize: 0,
  hitRate: 0,
};

function updateHitRate(): void {
  const total = cacheStats.hits + cacheStats.misses;
  cacheStats.hitRate = total > 0 ? cacheStats.hits / total : 0;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `"${key}":${stableStringify(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getSliceCacheKey(request: SliceBuildRequest): string {
  const context: Record<string, unknown> = {
    taskText: request.taskText ?? null,
    stackTrace: request.stackTrace ?? null,
    failingTestPath: request.failingTestPath ?? null,
    editedFiles: request.editedFiles ? [...request.editedFiles].sort() : null,
    entrySymbols: request.entrySymbols
      ? [...request.entrySymbols].sort()
      : null,
    cardDetail: request.cardDetail ?? "deps",
    budget: request.budget ?? null,
  };
  return `${request.repoId}:${request.versionId}:${stableStringify(context)}`;
}

function promoteAccessOrder(key: string): void {
  const index = accessOrder.indexOf(key);
  if (index !== -1) {
    accessOrder.splice(index, 1);
  }
  accessOrder.push(key);
}

export function getCachedSlice(key: string): GraphSlice | null {
  const entry = sliceCache.get(key);
  if (!entry) {
    cacheStats.misses++;
    updateHitRate();
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    sliceCache.delete(key);
    removeFromAccessOrder(key);
    cacheStats.currentSize--;
    cacheStats.misses++;
    updateHitRate();
    return null;
  }
  promoteAccessOrder(key);
  cacheStats.hits++;
  updateHitRate();
  return entry.slice;
}

function removeFromAccessOrder(key: string): void {
  const index = accessOrder.indexOf(key);
  if (index !== -1) {
    accessOrder.splice(index, 1);
  }
}

export function setCachedSlice(key: string, slice: GraphSlice): void {
  if (sliceCache.has(key)) {
    sliceCache.delete(key);
    removeFromAccessOrder(key);
    cacheStats.currentSize--;
  }
  if (sliceCache.size >= sliceCacheMax) {
    const lruKey = accessOrder.shift();
    if (lruKey) {
      sliceCache.delete(lruKey);
      cacheStats.evictions++;
      cacheStats.currentSize--;
    }
  }
  const now = Date.now();
  sliceCache.set(key, {
    slice,
    expiresAt: now + sliceCacheTtlMs,
    createdAt: now,
  });
  accessOrder.push(key);
  cacheStats.currentSize++;
}

export function invalidateVersion(versionId: VersionId): void {
  const keysToDelete: string[] = [];
  for (const key of sliceCache.keys()) {
    if (key.includes(`:${versionId}:`)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    sliceCache.delete(key);
    removeFromAccessOrder(key);
    cacheStats.currentSize--;
  }
}

export function clearSliceCache(): void {
  sliceCache.clear();
  accessOrder.length = 0;
  cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    hitRate: 0,
  };
}

export function getSliceCacheStats(): SliceCacheStats {
  return { ...cacheStats };
}

export function resetSliceCacheStats(): void {
  cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: sliceCache.size,
    hitRate: 0,
  };
}
