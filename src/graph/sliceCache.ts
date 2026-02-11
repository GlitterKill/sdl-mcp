import type { GraphSlice } from "../mcp/types.js";
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
  cardDetail?: "compact" | "full";
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

const SLICE_CACHE_TTL_MS = 60_000;
const SLICE_CACHE_MAX = 100;
const sliceCache = new Map<string, SliceCacheEntry>();

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
    cardDetail: request.cardDetail ?? "compact",
    budget: request.budget ?? null,
  };
  return `${request.repoId}:${request.versionId}:${stableStringify(context)}`;
}

export function getCachedSlice(key: string): GraphSlice | null {
  const entry = sliceCache.get(key);
  if (!entry) {
    cacheStats.misses++;
    updateHitRate();
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    sliceCache.delete(key);
    cacheStats.currentSize--;
    cacheStats.misses++;
    updateHitRate();
    return null;
  }
  cacheStats.hits++;
  updateHitRate();
  return entry.slice;
}

export function setCachedSlice(key: string, slice: GraphSlice): void {
  if (sliceCache.size >= SLICE_CACHE_MAX) {
    const oldestKey = sliceCache.keys().next().value;
    if (oldestKey) {
      sliceCache.delete(oldestKey);
      cacheStats.evictions++;
      cacheStats.currentSize--;
    }
  }
  sliceCache.set(key, {
    slice,
    expiresAt: Date.now() + SLICE_CACHE_TTL_MS,
    createdAt: Date.now(),
  });
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
    cacheStats.currentSize--;
  }
}

export function clearSliceCache(): void {
  sliceCache.clear();
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
