const MAX_ETAG_CACHE_SIZE = 2000;
const MAX_KNOWN_CARD_ETAGS = 1000;

export class WorkflowEtagCache {
  private cache: Map<string, string> = new Map();

  /** Inject ifNoneMatch into card request args if we have a cached ETag. */
  injectEtags(action: string, args: Record<string, unknown>): void {
    if (action === "symbol.getCard") {
      const symbolId = args.symbolId;
      if (
        typeof symbolId === "string"
        && this.cache.has(symbolId)
        && !args.ifNoneMatch
      ) {
        args.ifNoneMatch = this.cache.get(symbolId);
      }
    } else if (action === "symbol.getCard") {
      const symbolIds = args.symbolIds;
      if (Array.isArray(symbolIds) && !args.knownEtags) {
        const knownEtags: Record<string, string> = {};
        let found = false;
        for (const id of symbolIds) {
          if (typeof id === "string" && this.cache.has(id)) {
            knownEtags[id] = this.cache.get(id)!;
            found = true;
          }
        }
        if (found) {
          args.knownEtags = knownEtags;
        }
      }
    } else if (action === "slice.build" && !args.knownCardEtags) {
      const knownCardEtags = this.getRecentEtags(MAX_KNOWN_CARD_ETAGS);
      if (Object.keys(knownCardEtags).length > 0) {
        args.knownCardEtags = knownCardEtags;
      }
    }
  }

  /** Extract ETags from card response results. */
  extractEtags(action: string, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const record = result as Record<string, unknown>;

    if (action === "symbol.getCard") {
      const etag = record.etag;
      const card = record.card;
      if (typeof etag === "string" && card && typeof card === "object") {
        const symbolId = (card as Record<string, unknown>).symbolId;
        if (typeof symbolId === "string") {
          this.cache.set(symbolId, etag);
          this.evictIfNeeded();
        }
      }
    } else if (action === "symbol.getCard") {
      const cards = record.cards;
      if (Array.isArray(cards)) {
        for (const entry of cards) {
          if (entry && typeof entry === "object") {
            const item = entry as Record<string, unknown>;
            const card = item.card ?? item;
            const etag = item.etag;
            if (typeof etag === "string" && card && typeof card === "object") {
              const symbolId = (card as Record<string, unknown>).symbolId;
              if (typeof symbolId === "string") {
                this.cache.set(symbolId, etag);
                this.evictIfNeeded();
              }
            }
          }
        }
      }
    } else if (action === "slice.build") {
      this.extractSliceEtags(record.slice);
    }
  }

  private extractSliceEtags(slice: unknown): void {
    if (!slice || typeof slice !== "object") return;

    const record = slice as Record<string, unknown>;
    const cardRefs = record.cardRefs;
    if (Array.isArray(cardRefs)) {
      for (const entry of cardRefs) {
        if (!entry || typeof entry !== "object") continue;
        const ref = entry as Record<string, unknown>;
        const symbolId = ref.symbolId;
        const etag = ref.etag;
        if (typeof symbolId === "string" && typeof etag === "string") {
          this.cache.set(symbolId, etag);
          this.evictIfNeeded();
        }
      }
      return;
    }

    const compactRefs = record.cr;
    if (!Array.isArray(compactRefs)) return;

    const symbolIndex = Array.isArray(record.si) ? record.si : [];
    for (const entry of compactRefs) {
      if (!entry || typeof entry !== "object") continue;
      const ref = entry as Record<string, unknown>;
      const etag = ref.e;
      if (typeof etag !== "string") continue;

      const symbolId =
        typeof ref.sid === "string"
          ? ref.sid
          : typeof ref.ci === "number"
            ? symbolIndex[ref.ci]
            : undefined;

      if (typeof symbolId === "string") {
        this.cache.set(symbolId, etag);
        this.evictIfNeeded();
      }
    }
  }

  private getRecentEtags(limit: number): Record<string, string> {
    const entries = Array.from(this.cache.entries());
    return Object.fromEntries(entries.slice(-limit));
  }

  private evictIfNeeded(): void {
    if (this.cache.size > MAX_ETAG_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  /** Get the current cache state for returning in WorkflowResponse. */
  getCache(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }

  /** Pre-seed from a prior workflow etagCache. */
  seed(cache: Record<string, string>): void {
    for (const [key, value] of Object.entries(cache)) {
      this.cache.set(key, value);
      this.evictIfNeeded();
    }
  }
}
