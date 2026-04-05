/**
 * symbol-diff.ts -- Pure diff logic for reconciling existing DB symbols
 * against a fresh tree-sitter parse.
 *
 * The diff matches symbols by (name, kind) as the primary key, using range
 * overlap as a tiebreaker when multiple symbols share the same (name, kind).
 * Unmatched old symbols are partitioned into "removed" (tree-sitter or both
 * source -- safe to delete) vs "preserved" (SCIP-only -- must survive).
 */

import type { SymbolRow } from "../db/ladybug-symbols.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Source provenance for a symbol. */
export type SymbolSource = "treesitter" | "scip" | "both";

/** Lightweight view of an existing DB symbol relevant to diffing. */
export interface ExistingSymbol {
  symbolId: string;
  name: string;
  kind: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  /** Defaults to "treesitter" for backward compatibility with pre-SCIP data. */
  source: SymbolSource;
}

/** Lightweight view of a newly parsed tree-sitter symbol relevant to diffing. */
export interface NewSymbol {
  symbolId: string;
  name: string;
  kind: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
}

export interface SymbolDiffResult {
  /** Symbols present in both old and new sets, matched by (name, kind). */
  matched: Array<{ old: ExistingSymbol; new: NewSymbol }>;
  /** New symbols with no match in the old set -- will be inserted. */
  added: NewSymbol[];
  /** Old symbols whose source != "scip" and have no match -- will be deleted. */
  removed: ExistingSymbol[];
  /** Old symbols whose source == "scip" and have no match -- survive reconciliation. */
  preserved: ExistingSymbol[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute overlap between two line ranges.  Returns a value >= 0 where
 * higher means more overlap.  Zero means no overlap at all.
 */
function rangeOverlap(
  aStartLine: number,
  aEndLine: number,
  bStartLine: number,
  bEndLine: number,
): number {
  const overlapStart = Math.max(aStartLine, bStartLine);
  const overlapEnd = Math.min(aEndLine, bEndLine);
  return Math.max(0, overlapEnd - overlapStart + 1);
}

/**
 * Build a grouping key for (name, kind) pairs.
 */
function groupKey(name: string, kind: string): string {
  return `${kind}\0${name}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Diff an existing set of DB symbols against a newly parsed set from
 * tree-sitter.
 *
 * Matching strategy:
 * 1. Group both sides by (name, kind).
 * 2. For groups with a single member on each side, match directly.
 * 3. For ambiguous groups (multiple same name+kind), use range overlap as
 *    tiebreaker -- greedily assign the best-overlapping pair first.
 * 4. Unmatched old symbols are partitioned by source:
 *    - source "scip" -> preserved
 *    - source "treesitter" or "both" -> removed
 *    - undefined/missing source -> treated as "treesitter" -> removed
 */
export function diffSymbols(
  existingSymbols: ExistingSymbol[],
  newSymbols: NewSymbol[],
): SymbolDiffResult {
  const matched: SymbolDiffResult["matched"] = [];
  const added: NewSymbol[] = [];
  const removed: ExistingSymbol[] = [];
  const preserved: ExistingSymbol[] = [];

  // Group existing symbols by (name, kind)
  const existingByKey = new Map<string, ExistingSymbol[]>();
  for (const sym of existingSymbols) {
    const key = groupKey(sym.name, sym.kind);
    const bucket = existingByKey.get(key);
    if (bucket) {
      bucket.push(sym);
    } else {
      existingByKey.set(key, [sym]);
    }
  }

  // Group new symbols by (name, kind)
  const newByKey = new Map<string, NewSymbol[]>();
  for (const sym of newSymbols) {
    const key = groupKey(sym.name, sym.kind);
    const bucket = newByKey.get(key);
    if (bucket) {
      bucket.push(sym);
    } else {
      newByKey.set(key, [sym]);
    }
  }

  // Track which symbols have been matched
  const matchedExistingIds = new Set<string>();
  const matchedNewIds = new Set<string>();

  // Collect all unique keys from both sides
  const allKeys = new Set<string>([
    ...existingByKey.keys(),
    ...newByKey.keys(),
  ]);

  for (const key of allKeys) {
    const oldGroup = existingByKey.get(key) ?? [];
    const newGroup = newByKey.get(key) ?? [];

    if (oldGroup.length === 0) {
      // All new -- will be added later
      continue;
    }

    if (newGroup.length === 0) {
      // All old -- will be removed/preserved later
      continue;
    }

    if (oldGroup.length === 1 && newGroup.length === 1) {
      // Unambiguous match
      matched.push({ old: oldGroup[0], new: newGroup[0] });
      matchedExistingIds.add(oldGroup[0].symbolId);
      matchedNewIds.add(newGroup[0].symbolId);
      continue;
    }

    // Ambiguous: multiple symbols with the same (name, kind).
    // Greedily match by best range overlap.
    const remainingOld = [...oldGroup];
    const remainingNew = [...newGroup];

    while (remainingOld.length > 0 && remainingNew.length > 0) {
      let bestOverlap = -1;
      let bestOldIdx = -1;
      let bestNewIdx = -1;

      for (let oi = 0; oi < remainingOld.length; oi++) {
        for (let ni = 0; ni < remainingNew.length; ni++) {
          const overlap = rangeOverlap(
            remainingOld[oi].rangeStartLine,
            remainingOld[oi].rangeEndLine,
            remainingNew[ni].rangeStartLine,
            remainingNew[ni].rangeEndLine,
          );
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestOldIdx = oi;
            bestNewIdx = ni;
          }
        }
      }

      if (bestOldIdx === -1 || bestNewIdx === -1) {
        // Should not happen since both arrays are non-empty, but guard anyway
        break;
      }

      const oldSym = remainingOld[bestOldIdx];
      const newSym = remainingNew[bestNewIdx];
      matched.push({ old: oldSym, new: newSym });
      matchedExistingIds.add(oldSym.symbolId);
      matchedNewIds.add(newSym.symbolId);

      // Remove matched items (swap-and-pop for efficiency)
      remainingOld.splice(bestOldIdx, 1);
      remainingNew.splice(bestNewIdx, 1);
    }
    // Any leftover remainingOld/remainingNew will be caught below
  }

  // Collect unmatched new symbols -> added
  for (const sym of newSymbols) {
    if (!matchedNewIds.has(sym.symbolId)) {
      added.push(sym);
    }
  }

  // Partition unmatched existing symbols into removed vs preserved
  for (const sym of existingSymbols) {
    if (matchedExistingIds.has(sym.symbolId)) {
      continue;
    }
    const source = sym.source ?? "treesitter";
    if (source === "scip") {
      preserved.push(sym);
    } else {
      removed.push(sym);
    }
  }

  return { matched, added, removed, preserved };
}

/**
 * Convert a SymbolRow (from the DB) to an ExistingSymbol for diffing.
 * The `source` field may not exist in older data, so we default to "treesitter".
 */
export function toExistingSymbol(
  row: SymbolRow & { source?: string },
): ExistingSymbol {
  let source: SymbolSource = "treesitter";
  if (
    row.source === "scip" ||
    row.source === "both" ||
    row.source === "treesitter"
  ) {
    source = row.source;
  }
  return {
    symbolId: row.symbolId,
    name: row.name,
    kind: row.kind,
    rangeStartLine: row.rangeStartLine,
    rangeStartCol: row.rangeStartCol,
    rangeEndLine: row.rangeEndLine,
    rangeEndCol: row.rangeEndCol,
    source,
  };
}

/**
 * Convert a SymbolRow (from tree-sitter parse) to a NewSymbol for diffing.
 */
export function toNewSymbol(row: SymbolRow): NewSymbol {
  return {
    symbolId: row.symbolId,
    name: row.name,
    kind: row.kind,
    rangeStartLine: row.rangeStartLine,
    rangeStartCol: row.rangeStartCol,
    rangeEndLine: row.rangeEndLine,
    rangeEndCol: row.rangeEndCol,
  };
}
