export const SYMBOL_SEARCH_FALLBACK = Object.freeze({
  tools: Object.freeze(["sdl.symbol.search", "sdl.action.search"]),
  rationale:
    "Use sdl.symbol.search to discover the canonical symbol identifier.",
});

export interface SymbolSearchFallback {
  fallbackTools: string[];
  fallbackRationale: string;
}

/** Build a fresh error-envelope fragment from the shared search guidance. */
export function createSymbolSearchFallback(
  rationale: string = SYMBOL_SEARCH_FALLBACK.rationale,
): SymbolSearchFallback {
  return {
    fallbackTools: [...SYMBOL_SEARCH_FALLBACK.tools],
    fallbackRationale: rationale,
  };
}
