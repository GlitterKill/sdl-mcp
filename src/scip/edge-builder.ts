/**
 * SCIP Edge Builder
 *
 * Converts SCIP occurrences (references) into SDL DEPENDS_ON edge descriptors.
 * Each non-definition occurrence maps to a call, import, or implements edge
 * between the containing SDL symbol and the referenced SCIP symbol.
 */

import type { SymbolId, EdgeType } from "../domain/types.js";
import type {
  ScipDocument,
  ScipOccurrence,
  ScipRange,
  ScipSymbolMatch,
} from "./types.js";
import { SCIP_ROLE_DEFINITION, SCIP_ROLE_IMPORT } from "./symbol-matcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScipEdgeDescriptor {
  sourceSymbolId: SymbolId;
  targetSymbolId: SymbolId;
  edgeType: EdgeType;
  confidence: number;
  resolution: "exact";
  resolverId: "scip";
  resolutionPhase: 3;
}

export type EdgeAction = "create" | "upgrade" | "replace" | "skip";

export interface ExistingEdge {
  sourceSymbolId: SymbolId;
  targetSymbolId: SymbolId;
  edgeType: EdgeType;
  confidence: number;
  resolution: string;
  resolverId?: string;
}

export interface EdgeActionResult {
  action: EdgeAction;
  edge: ScipEdgeDescriptor;
  existingEdge?: ExistingEdge;
}

// ---------------------------------------------------------------------------
// getImplementationSymbols
// ---------------------------------------------------------------------------

/**
 * Scan the document's `symbols` array and collect SCIP symbol strings that
 * have any relationship with `isImplementation: true`.
 */
export function getImplementationSymbols(document: ScipDocument): Set<string> {
  const result = new Set<string>();
  if (!document.symbols) return result;

  for (const info of document.symbols) {
    if (!info.relationships) continue;
    for (const rel of info.relationships) {
      if (rel.isImplementation) {
        result.add(info.symbol);
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// findContainingSymbol
// ---------------------------------------------------------------------------

/**
 * Find the SDL symbol whose range contains the given SCIP occurrence.
 *
 * SCIP ranges are 0-based; SDL ranges are 1-based. The occurrence line
 * is converted to 1-based before comparison.
 *
 * If multiple symbols contain the occurrence, the narrowest (most specific)
 * range is preferred.
 */
export function findContainingSymbol(
  occurrenceRange: ScipRange,
  sdlSymbols: Array<{
    symbolId: SymbolId;
    rangeStartLine: number;
    rangeEndLine: number;
  }>,
): SymbolId | null {
  // Convert SCIP 0-based line to SDL 1-based
  const occurrenceLine1Based = occurrenceRange.startLine + 1;

  let bestMatch: SymbolId | null = null;
  let bestSpan = Infinity;

  for (const sym of sdlSymbols) {
    if (
      occurrenceLine1Based >= sym.rangeStartLine &&
      occurrenceLine1Based <= sym.rangeEndLine
    ) {
      const span = sym.rangeEndLine - sym.rangeStartLine;
      if (span < bestSpan) {
        bestSpan = span;
        bestMatch = sym.symbolId;
      }
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// buildContainingSymbolMap
// ---------------------------------------------------------------------------

/**
 * Build a map from occurrence index to the containing SDL symbol ID.
 *
 * For each occurrence, we find which SDL symbol's range contains it.
 * SCIP ranges are 0-based; SDL ranges are 1-based — normalization is
 * handled by {@link findContainingSymbol}.
 */
export function buildContainingSymbolMap(
  occurrences: ScipOccurrence[],
  sdlSymbolsInFile: Array<{
    symbolId: SymbolId;
    rangeStartLine: number;
    rangeEndLine: number;
  }>,
): Map<number, SymbolId> {
  const map = new Map<number, SymbolId>();

  for (let i = 0; i < occurrences.length; i++) {
    const occ = occurrences[i];
    const containingId = findContainingSymbol(occ.range, sdlSymbolsInFile);
    if (containingId !== null) {
      map.set(i, containingId);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// buildEdgesFromOccurrences
// ---------------------------------------------------------------------------

/**
 * Convert SCIP occurrences into SDL edge descriptors.
 *
 * For each occurrence in the document:
 * 1. Skip definitions (SCIP_ROLE_DEFINITION)
 * 2. Resolve the containing SDL symbol (source) via containingSymbolMap
 * 3. Resolve the referenced SCIP symbol (target) via symbolMatchMap
 * 4. Determine edge type (implements / import / call)
 * 5. Create edge descriptor
 */
export function buildEdgesFromOccurrences(
  document: ScipDocument,
  symbolMatchMap: Map<string, ScipSymbolMatch>,
  containingSymbolMap: Map<number, SymbolId>,
  confidence: number,
): ScipEdgeDescriptor[] {
  const edges: ScipEdgeDescriptor[] = [];
  const implementationSymbols = getImplementationSymbols(document);

  for (let i = 0; i < document.occurrences.length; i++) {
    const occ = document.occurrences[i];

    // Step 1: Skip definitions — they are handled by symbol matching
    if (occ.symbolRoles & SCIP_ROLE_DEFINITION) {
      continue;
    }

    // Step 2: Find the containing SDL symbol (source)
    const sourceSymbolId = containingSymbolMap.get(i);
    if (sourceSymbolId === undefined) {
      continue;
    }

    // Step 3: Resolve the referenced SCIP symbol to a target
    const targetMatch = symbolMatchMap.get(occ.symbol);
    if (!targetMatch) {
      continue;
    }
    const targetSymbolId = targetMatch.sdlSymbolId;

    // Skip self-edges
    if (sourceSymbolId === targetSymbolId) {
      continue;
    }

    // Step 4: Determine edge type
    let edgeType: EdgeType;
    if (implementationSymbols.has(occ.symbol)) {
      edgeType = "implements";
    } else if (occ.symbolRoles & SCIP_ROLE_IMPORT) {
      edgeType = "import";
    } else {
      edgeType = "call";
    }

    // Step 5: Create edge descriptor
    edges.push({
      sourceSymbolId,
      targetSymbolId,
      edgeType,
      confidence,
      resolution: "exact",
      resolverId: "scip",
      resolutionPhase: 3,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// classifyEdgeAction
// ---------------------------------------------------------------------------

/**
 * Classify the action to take when a SCIP edge encounters an existing edge.
 *
 * - No existing edge → "create"
 * - Same target, lower confidence → "upgrade"
 * - Different target, existing resolution is heuristic/unresolved → "replace"
 * - Same or higher confidence, same target → "skip"
 */
export function classifyEdgeAction(
  existingEdge: ExistingEdge | null,
  newEdge: ScipEdgeDescriptor,
): EdgeAction {
  if (existingEdge === null) {
    return "create";
  }

  const sameTarget = existingEdge.targetSymbolId === newEdge.targetSymbolId;

  if (sameTarget && existingEdge.confidence < newEdge.confidence) {
    return "upgrade";
  }

  if (
    !sameTarget &&
    (existingEdge.resolution === "heuristic" ||
      existingEdge.resolution === "unresolved")
  ) {
    return "replace";
  }

  return "skip";
}
