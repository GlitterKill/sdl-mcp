import { logger } from "../util/logger.js";
import { getEmbeddingProvider, buildRawEmbeddingText } from "../indexer/embeddings.js";
import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";
import { loadConfig } from "../config/loadConfig.js";
import type { SymbolRow } from "../db/ladybug-queries.js";

interface CachedEmbedding {
  model: string;
  embedding: number[];
  updatedAt: string;
}

const MAX_EMBEDDING_CACHE_ENTRIES = 500;

/**
 * In-memory cache for draft symbol embeddings. Lazily populated —
 * embeddings are computed on first access, never on push.
 */
class OverlayEmbeddingCache {
  private cache = new Map<string, Map<string, CachedEmbedding>>();
  // symbolId -> model -> CachedEmbedding

  /**
   * Get cached embedding for a symbol and model.
   * Returns null if not cached.
   */
  get(symbolId: string, model: string): CachedEmbedding | null {
    return this.cache.get(symbolId)?.get(model) ?? null;
  }

  /**
   * Compute embeddings for a draft symbol and cache them.
   * Uses all active real models. Skips mock-fallback providers.
   * Never throws — logs and returns on failure.
   */
  async computeAndCache(symbolId: string, searchText: string): Promise<void> {
    if (!searchText) return;

    let providerType: "api" | "local" | "mock" = "local";
    try {
      const appConfig = loadConfig();
      providerType = appConfig.semantic?.provider ?? "local";
    } catch {
      // Config unavailable — fall back to "local"
    }

    for (const [modelName] of Object.entries(EMBEDDING_MODELS)) {
      try {
        const provider = getEmbeddingProvider(providerType, modelName);
        if (provider.isMockFallback?.()) continue;

        const embeddings = await provider.embed([searchText]);
        if (!embeddings[0] || embeddings[0].length === 0) continue;

        let modelCache = this.cache.get(symbolId);
        if (!modelCache) {
          modelCache = new Map();
          this.cache.set(symbolId, modelCache);
          if (this.cache.size > MAX_EMBEDDING_CACHE_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
        modelCache.set(modelName, {
          model: modelName,
          embedding: embeddings[0],
          updatedAt: new Date().toISOString(),
        });
        logger.debug(
          `[overlay-embedding-cache] Cached embedding for ${symbolId} model ${modelName}`,
        );
      } catch (err) {
        logger.debug(
          `[overlay-embedding-cache] Failed to compute embedding for ${symbolId} model ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Compute and cache embeddings for a draft SymbolRow, using its natural
   * embedding text (same text used by the indexer for durable symbols).
   * Fire-and-forget — callers should .catch(() => {}) if they don't await.
   */
  async computeAndCacheSymbol(symbol: SymbolRow): Promise<void> {
    const searchText = buildRawEmbeddingText(symbol);
    if (!searchText) return;
    await this.computeAndCache(symbol.symbolId, searchText);
  }

  /**
   * Invalidate all cached embeddings for a symbol.
   * Called when a draft buffer changes.
   */
  invalidate(symbolId: string): void {
    this.cache.delete(symbolId);
  }

  /**
   * Invalidate all embeddings for a set of symbol IDs (e.g. all symbols in
   * an affected file).
   */
  invalidateMany(symbolIds: string[]): void {
    for (const sid of symbolIds) {
      this.cache.delete(sid);
    }
  }

  /** Clear all cached embeddings. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of symbols with cached embeddings. */
  get size(): number {
    return this.cache.size;
  }
}

/** Singleton instance. */
let instance: OverlayEmbeddingCache | null = null;

export function getOverlayEmbeddingCache(): OverlayEmbeddingCache {
  if (!instance) {
    instance = new OverlayEmbeddingCache();
  }
  return instance;
}

export function resetOverlayEmbeddingCache(): void {
  instance?.clear();
  instance = null;
}

export type { CachedEmbedding };
export { OverlayEmbeddingCache };
