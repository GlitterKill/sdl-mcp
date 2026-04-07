import type { Connection } from "kuzu";
import { basename } from "node:path";

import * as ladybugDb from "../db/ladybug-queries.js";
import { searchSymbolsWithOverlay } from "../live-index/overlay-reader.js";
import { normalizePath } from "./paths.js";
import { splitCamelSubwords, computeRelevance } from "./symbol-relevance.js";

export interface SymbolRefInput {
  name: string;
  file?: string;
  kind?: string;
  exportedOnly?: boolean;
}

export interface SymbolRefCandidate {
  symbolId: string;
  name: string;
  file: string;
  kind: string;
  exported: boolean;
  score: number;
}

export type SymbolRefResolution =
  | {
      status: "resolved";
      symbolId: string;
      candidate: SymbolRefCandidate;
      candidates: SymbolRefCandidate[];
    }
  | {
      status: "ambiguous";
      message: string;
      candidates: SymbolRefCandidate[];
    }
  | {
      status: "not_found";
      message: string;
      candidates: SymbolRefCandidate[];
    };

interface RankedCandidate extends SymbolRefCandidate {
  readonly nameMatchLevel: number;
  readonly fileMatchLevel: number;
}

const SEARCH_LIMIT = 25;
const MIN_FUZZY_AUTO_RESOLVE_SCORE = 120;
const MIN_FUZZY_SCORE_GAP = 20;

/**
 * Perform a broader fuzzy search to find candidate suggestions when exact match fails.
 * Splits the query into camelCase subwords and searches for each, then scores results
 * by relevance to the original query.
 */
async function fuzzySearchCandidates(
  conn: Connection,
  repoId: string,
  name: string,
  limit: number,
): Promise<SymbolRefCandidate[]> {
  const subwords = splitCamelSubwords(name);
  if (subwords.length === 0) return [];

  // Search using each subword and collect unique results
  const seen = new Set<string>();
  const allRows: Array<{ symbolId: string; name: string; filePath: string; kind: string; fileId: string }> = [];
  for (const word of subwords.slice(0, 3)) {
    const rows = await searchSymbolsWithOverlay(conn, repoId, word, limit);
    for (const row of rows) {
      if (!seen.has(row.symbolId)) {
        seen.add(row.symbolId);
        allRows.push(row);
      }
    }
  }

  // Score by relevance to the original name and sort
  return allRows
    .map((row) => ({
      symbolId: row.symbolId,
      name: row.name,
      file: row.filePath,
      kind: row.kind,
      exported: true,
      score: Math.round(computeRelevance(row.name, name) * 100) / 100,
    }))
    .filter((c) => c.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
export async function resolveSymbolRef(
  conn: Connection,
  repoId: string,
  symbolRef: SymbolRefInput,
): Promise<SymbolRefResolution> {
  const rows = await searchSymbolsWithOverlay(conn, repoId, symbolRef.name, SEARCH_LIMIT);
  if (rows.length === 0) {
    // No exact search results — try broader fuzzy search for suggestions
    const fuzzyCandidates = await fuzzySearchCandidates(conn, repoId, symbolRef.name, SEARCH_LIMIT);
    const hint = fuzzyCandidates.length > 0
      ? ` Did you mean: ${fuzzyCandidates.slice(0, 3).map(c => `"${c.name}" (${c.file})`).join(", ")}?`
      : "";
    return {
      status: "not_found",
      message: `No symbol matching "${symbolRef.name}" was found in repo "${repoId}".${hint}`,
      candidates: fuzzyCandidates,
    };
  }

  const symbolMap = await ladybugDb.getSymbolsByIds(
    conn,
    rows.map((row) => row.symbolId),
  );
  const normalizedFile = symbolRef.file ? normalizePath(symbolRef.file) : undefined;
  const ranked = rows
    .map((row) => {
      const symbol = symbolMap.get(row.symbolId);
      if (!symbol || symbol.repoId !== repoId) {
        return null;
      }
      if (symbolRef.kind && row.kind !== symbolRef.kind) {
        return null;
      }
      if (symbolRef.exportedOnly === true && !symbol.exported) {
        return null;
      }

      const nameMatchLevel = getNameMatchLevel(symbolRef.name, row.name);
      if (nameMatchLevel === 0) {
        return null;
      }

      const fileMatchLevel = getFileMatchLevel(normalizedFile, row.filePath);
      if (normalizedFile && fileMatchLevel === 0) {
        return null;
      }

      return {
        symbolId: row.symbolId,
        name: row.name,
        file: row.filePath,
        kind: row.kind,
        exported: symbol.exported,
        score: scoreCandidate({
          nameMatchLevel,
          fileMatchLevel,
          kindMatched: symbolRef.kind ? row.kind === symbolRef.kind : false,
          exportedMatched:
            symbolRef.exportedOnly === undefined
              ? false
              : symbol.exported === symbolRef.exportedOnly,
        }),
        nameMatchLevel,
        fileMatchLevel,
      } satisfies RankedCandidate;
    })
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort(compareCandidates);

  if (ranked.length === 0) {
    const qualifier = normalizedFile ? ` in file "${normalizedFile}"` : "";
    // We had search results but none passed filters — use original rows as fuzzy suggestions
    const fuzzyCandidates = rows
      .map((row) => {
        const symbol = symbolMap.get(row.symbolId);
        if (!symbol || symbol.repoId !== repoId) return null;
        return {
          symbolId: row.symbolId,
          name: row.name,
          file: row.filePath,
          kind: row.kind,
          exported: symbol.exported,
          score: Math.round(computeRelevance(row.name, symbolRef.name) * 100) / 100,
        };
      })
      .filter((c): c is SymbolRefCandidate => c !== null && c.score >= 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const hint = fuzzyCandidates.length > 0
      ? ` Did you mean: ${fuzzyCandidates.slice(0, 3).map(c => `"${c.name}" (${c.file})`).join(", ")}?`
      : "";
    return {
      status: "not_found",
      message: `No symbol matching "${symbolRef.name}"${qualifier} was found in repo "${repoId}".${hint}`,
      candidates: fuzzyCandidates,
    };
  }

  const strictMatches = ranked.filter((candidate) =>
    normalizedFile
      ? candidate.nameMatchLevel >= 2 && candidate.fileMatchLevel >= 2
      : candidate.nameMatchLevel >= 2,
  );
  if (strictMatches.length === 1) {
    return resolved(strictMatches[0], ranked);
  }
  if (strictMatches.length > 1) {
    return {
      status: "ambiguous",
      message: buildAmbiguousMessage(symbolRef),
      candidates: strictMatches,
    };
  }

  const [topCandidate, runnerUp] = ranked;
  if (
    topCandidate &&
    topCandidate.score >= MIN_FUZZY_AUTO_RESOLVE_SCORE &&
    (!runnerUp || topCandidate.score - runnerUp.score >= MIN_FUZZY_SCORE_GAP)
  ) {
    return resolved(topCandidate, ranked);
  }

  return {
    status: "ambiguous",
    message: buildAmbiguousMessage(symbolRef),
    candidates: ranked,
  };
}

function resolved(
  candidate: RankedCandidate,
  ranked: RankedCandidate[],
): SymbolRefResolution {
  return {
    status: "resolved",
    symbolId: candidate.symbolId,
    candidate,
    candidates: ranked,
  };
}

function getNameMatchLevel(query: string, candidateName: string): number {
  if (candidateName === query) {
    return 3;
  }

  const loweredQuery = query.toLowerCase();
  const loweredName = candidateName.toLowerCase();
  if (loweredName === loweredQuery) {
    return 2;
  }
  if (loweredName.includes(loweredQuery)) {
    return 1;
  }
  return 0;
}

function getFileMatchLevel(
  normalizedRequestedFile: string | undefined,
  candidateFile: string,
): number {
  if (!normalizedRequestedFile) {
    return 0;
  }

  const normalizedCandidate = normalizePath(candidateFile);
  if (normalizedCandidate === normalizedRequestedFile) {
    return 3;
  }
  if (normalizedCandidate.endsWith(`/${normalizedRequestedFile}`)) {
    return 2;
  }
  if (basename(normalizedCandidate) === basename(normalizedRequestedFile)) {
    return 1;
  }
  return 0;
}

function scoreCandidate(input: {
  nameMatchLevel: number;
  fileMatchLevel: number;
  kindMatched: boolean;
  exportedMatched: boolean;
}): number {
  let score = 0;
  score += input.nameMatchLevel * 40;
  score += input.fileMatchLevel * 25;
  if (input.kindMatched) {
    score += 10;
  }
  if (input.exportedMatched) {
    score += 5;
  }
  return score;
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.score - left.score ||
    right.nameMatchLevel - left.nameMatchLevel ||
    right.fileMatchLevel - left.fileMatchLevel ||
    left.file.localeCompare(right.file) ||
    left.symbolId.localeCompare(right.symbolId)
  );
}

function buildAmbiguousMessage(symbolRef: SymbolRefInput): string {
  const fileHint = symbolRef.file ? ` in "${normalizePath(symbolRef.file)}"` : "";
  return `Multiple symbols matched "${symbolRef.name}"${fileHint}. Refine the symbol reference or use sdl.symbol.search.`;
}
