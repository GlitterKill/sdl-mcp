export class ChainEtagCache {
  private cache: Map<string, string> = new Map();

  /** Inject ifNoneMatch into card request args if we have a cached ETag */
  injectEtags(action: string, args: Record<string, unknown>): void {
    if (action === "symbol.getCard") {
      const symbolId = args.symbolId;
      if (
        typeof symbolId === "string" &&
        this.cache.has(symbolId) &&
        !args.ifNoneMatch
      ) {
        args.ifNoneMatch = this.cache.get(symbolId);
      }
    } else if (action === "symbol.getCards") {
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
    }
  }

  /** Extract ETags from card response results */
  extractEtags(action: string, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const r = result as Record<string, unknown>;

    if (action === "symbol.getCard") {
      const etag = r.etag;
      const card = r.card;
      if (typeof etag === "string" && card && typeof card === "object") {
        const symbolId = (card as Record<string, unknown>).symbolId;
        if (typeof symbolId === "string") {
          this.cache.set(symbolId, etag);
        }
      }
    } else if (action === "symbol.getCards") {
      const cards = r.cards;
      if (Array.isArray(cards)) {
        for (const entry of cards) {
          if (entry && typeof entry === "object") {
            const e = entry as Record<string, unknown>;
            const card = e.card ?? e;
            const etag = e.etag;
            if (typeof etag === "string" && card && typeof card === "object") {
              const symbolId = (card as Record<string, unknown>).symbolId;
              if (typeof symbolId === "string") {
                this.cache.set(symbolId, etag);
              }
            }
          }
        }
      }
    }
  }

  /** Get the current cache state (for returning in ChainResponse) */
  getCache(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }

  /** Pre-seed from a prior chain's etagCache */
  seed(cache: Record<string, string>): void {
    for (const [key, value] of Object.entries(cache)) {
      this.cache.set(key, value);
    }
  }
}
