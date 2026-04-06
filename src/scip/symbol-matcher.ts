/**
 * Match SCIP symbols to existing SDL symbols.
 *
 * SCIP occurrences reference symbols by their SCIP symbol string.
 * This module resolves those references to SDL symbolIds by matching
 * on name, kind, and source range.
 */

import type { SymbolKind } from "../domain/types.js";
import type { ScipSymbolMatch, ScipDocument, ScipRange } from "./types.js";
import {
  mapScipKind,
  parseScipSymbol,
  extractNameFromDescriptors,
  normalizeClangDescriptors,
} from "./kind-mapping.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal SDL symbol representation for matching purposes.
 * All fields mirror the DB row; ranges are 1-based (SDL convention).
 */
export interface SdlSymbolForMatching {
  symbolId: string;
  name: string;
  kind: string;
  rangeStartLine: number; // 1-based (SDL convention)
  rangeEndLine: number;
  source?: string;
}

// ---------------------------------------------------------------------------
// SCIP symbolRoles bitmask constants
// ---------------------------------------------------------------------------

/** The occurrence is a definition of the symbol. */
export const SCIP_ROLE_DEFINITION = 1;

/** The occurrence is an import of the symbol. */
export const SCIP_ROLE_IMPORT = 2;

/** The occurrence writes to the symbol. */
export const SCIP_ROLE_WRITE_ACCESS = 4;

/** The occurrence reads from the symbol. */
export const SCIP_ROLE_READ_ACCESS = 8;

// ---------------------------------------------------------------------------
// Range conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SCIP 0-based line number to SDL 1-based.
 */
function scipLineToSdl(scipLine: number): number {
  return scipLine + 1;
}

/**
 * Compute the overlap between a SCIP occurrence range and an SDL symbol range.
 *
 * SCIP ranges are 0-based; SDL ranges are 1-based.
 * Returns a score in [0, 1] where 1 means the SCIP occurrence falls entirely
 * within the SDL symbol range, and 0 means no overlap.
 */
function rangeOverlap(
  scipRange: ScipRange,
  sdlStartLine: number,
  sdlEndLine: number,
): number {
  const scipStart = scipLineToSdl(scipRange.startLine);
  const scipEnd = scipLineToSdl(scipRange.endLine);

  const overlapStart = Math.max(scipStart, sdlStartLine);
  const overlapEnd = Math.min(scipEnd, sdlEndLine);

  if (overlapStart > overlapEnd) return 0;

  const overlapSize = overlapEnd - overlapStart + 1;
  const scipSize = Math.max(scipEnd - scipStart + 1, 1);

  return overlapSize / scipSize;
}

// ---------------------------------------------------------------------------
// Single-symbol matching
// ---------------------------------------------------------------------------

/**
 * Match a single SCIP symbol occurrence to the best SDL symbol in a file.
 *
 * Matching strategy:
 *  1. Filter SDL symbols by name equality.
 *  2. Prefer symbols whose kind matches `sdlKind`.
 *  3. Tiebreak by range overlap (SCIP 0-based -> SDL 1-based).
 *  4. Return the best match, or `null` if no name match exists.
 *
 * @param scipSymbol   The SCIP symbol string (e.g., `scip-typescript npm pkg 1.0 Foo#bar().`)
 * @param scipOccurrence  The occurrence with range and symbolRoles
 * @param sdlSymbolsInFile  All SDL symbols in the same file
 * @param sdlKind  The mapped SDL kind for this SCIP symbol
 * @returns The best match, or `null` if no candidate matches by name
 */
export function matchScipToSdl(
  scipSymbol: string,
  scipOccurrence: { range: ScipRange; symbolRoles: number },
  sdlSymbolsInFile: SdlSymbolForMatching[],
  sdlKind: SymbolKind,
): ScipSymbolMatch | null {
  // Extract the name from the SCIP symbol for matching
  // The name is embedded in the SDL symbols, so we match against sdlSymbol.name
  const nameFromScip = extractNameFromScipSymbol(scipSymbol);

  if (nameFromScip === "") return null;

  // Step 1: Filter by name
  const nameCandidates = sdlSymbolsInFile.filter(
    (s) => s.name === nameFromScip,
  );

  if (nameCandidates.length === 0) return null;

  // Step 2: Separate kind-matching and kind-mismatching candidates
  const kindMatches = nameCandidates.filter((s) => s.kind === sdlKind);
  const kindMismatches = nameCandidates.filter((s) => s.kind !== sdlKind);

  // Step 3: Pick best from kind-matching first, then kind-mismatching
  const bestKindMatch = pickBestByRange(kindMatches, scipOccurrence.range);
  if (bestKindMatch) {
    return {
      scipSymbol,
      sdlSymbolId: bestKindMatch.symbolId as string,
      matchType: "exact",
      kindMismatch: false,
    };
  }

  const bestMismatch = pickBestByRange(kindMismatches, scipOccurrence.range);
  if (bestMismatch) {
    return {
      scipSymbol,
      sdlSymbolId: bestMismatch.symbolId as string,
      matchType: "nameOnly",
      kindMismatch: true,
    };
  }

  return null;
}

/**
 * Pick the SDL symbol with the best range overlap to the SCIP occurrence.
 * Returns `null` if the candidates array is empty.
 */
function pickBestByRange(
  candidates: SdlSymbolForMatching[],
  scipRange: ScipRange,
): SdlSymbolForMatching | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  let best = candidates[0]!;
  let bestScore = rangeOverlap(
    scipRange,
    best.rangeStartLine,
    best.rangeEndLine,
  );

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const score = rangeOverlap(
      scipRange,
      candidate.rangeStartLine,
      candidate.rangeEndLine,
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Extract the display name from a SCIP symbol string.
 *
 * This is a simplified version that extracts the last identifier before
 * the descriptor suffix.
 */
/**
 * Extract the display name from a SCIP symbol string.
 *
 * Delegates to `parseScipSymbol` + `extractNameFromDescriptors` from
 * kind-mapping so the parser logic lives in exactly one place, and applies
 * `normalizeClangDescriptors` for scip-clang symbols so C++ parameter lists
 * and overload disambiguator hashes are stripped before name extraction.
 *
 * Header/impl unification for C++ is handled implicitly at the ingestion
 * layer: the SCIP symbol → SDL symbolId map is global across documents, so a
 * class declared in `include/widget.h` and its methods defined in
 * `src/widget.cpp` both resolve correctly as long as each has a Definition
 * occurrence in its own document (which scip-clang always emits).
 */
function extractNameFromScipSymbol(scipSymbol: string): string {
  const parsed = parseScipSymbol(scipSymbol);

  // Local symbols have no scheme/package and descriptors is the identifier.
  if (parsed.scheme === "local") {
    return parsed.descriptors;
  }

  const descriptors =
    parsed.scheme === "scip-clang"
      ? normalizeClangDescriptors(parsed.descriptors)
      : parsed.descriptors;

  return extractNameFromDescriptors(descriptors);
}

// ---------------------------------------------------------------------------
// Batch matching for a whole document
// ---------------------------------------------------------------------------

/**
 * Build a map from SCIP symbol string -> ScipSymbolMatch for all
 * definition occurrences in a document.
 *
 * Only processes occurrences whose `symbolRoles` includes the
 * `SCIP_ROLE_DEFINITION` bit. Each SCIP symbol string is matched
 * at most once (first definition occurrence wins).
 *
 * @param scipDocument  A decoded SCIP document with occurrences and symbols
 * @param sdlSymbolsInFile  All SDL symbols in the corresponding file
 * @returns Map keyed by SCIP symbol string -> match result
 */
export function buildSymbolMatchMap(
  scipDocument: ScipDocument,
  sdlSymbolsInFile: SdlSymbolForMatching[],
): { matches: Map<string, ScipSymbolMatch>; skippedCount: number } {
  const result = new Map<string, ScipSymbolMatch>();
  let skippedCount = 0;

  // Build a lookup from SCIP symbol string -> ScipSymbolInfo for kind info
  const symbolInfoMap = new Map<string, number>();
  for (const info of scipDocument.symbols) {
    symbolInfoMap.set(info.symbol, info.kind);
  }

  for (const occ of scipDocument.occurrences) {
    // Only process definition occurrences
    if ((occ.symbolRoles & SCIP_ROLE_DEFINITION) === 0) continue;

    // Skip if already matched
    if (result.has(occ.symbol)) continue;

    // Skip empty / local symbols
    if (occ.symbol === "" || occ.symbol.startsWith("local ")) continue;

    // Map SCIP kind to SDL kind
    const lspKind = symbolInfoMap.get(occ.symbol);
    const kindResult = mapScipKind(occ.symbol, lspKind);

    if (kindResult.skip) {
      skippedCount++;
      continue;
    }

    const match = matchScipToSdl(
      occ.symbol,
      occ,
      sdlSymbolsInFile,
      kindResult.sdlKind,
    );

    if (match !== null) {
      result.set(occ.symbol, match);
    }
  }

  return { matches: result, skippedCount };
}
