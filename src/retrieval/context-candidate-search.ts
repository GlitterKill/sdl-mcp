import type { Connection } from "kuzu";

import { estimateSymbolCardContentTokens } from "../context/card-content.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { FileRow, SymbolRow } from "../db/ladybug-queries.js";
import {
  getGraphSnapshot,
  getGraphSnapshotCreatedAt,
  loadAndCacheGraphSnapshot,
} from "../graph/graphSnapshotCache.js";
import {
  rankOverlaySymbolsForQuery,
  type OverlaySnapshot,
} from "../live-index/overlay-reader.js";
import { logger } from "../util/logger.js";
import { parseTestCaseFacetJson } from "../util/test-case.js";
import { normalizePath } from "../util/paths.js";
import { isTestCandidate } from "./task-query-ranking.js";
import { extractQualifiedTermsFromContext } from "./identifier-extraction.js";
import {
  rrfFuseContextCandidates,
  type ContextCandidateSource,
  type ContextCandidateProvenance,
  type ContextCandidateFusionItem,
  type ContextEntitySourceRanking,
  type ContextSourceRanks,
  type EntitySourceRanking,
} from "./fusion.js";
import {
  collectEntitySourceRankings,
  type EntitySourceRankingCollection,
} from "./orchestrator.js";
import { applyPprBoost, computePpr } from "./ppr.js";
import { resolveSeedSymbols } from "./seed-resolver.js";
import type {
  HybridSearchResultItem,
  RetrievalCapabilities,
  RetrievalEvidence,
  RetrievalQueryContext,
} from "./types.js";

export interface ContextCandidateSearchOptions {
  repoId: string;
  /** Durable graph version admitted by the caller's read transaction. */
  graphVersionId?: string;
  query: string;
  limit: number;
  includeFileSummary: boolean;
  includeTests: boolean;
  symbolsPerFileSummary: number;
  chatMentions?: string[];
  includeEvidence?: boolean;
  /** Resolved directory prefixes that softly prioritize the bounded fused pool. */
  focusPathPrefixes?: readonly string[];
  /** Resolved exact candidates that must sort before the fused pool. */
  pinnedSymbolIds?: readonly string[];
  /** Resolved exact candidates that participate in the same weighted fusion. */
  exactIdentifierSymbolIds?: readonly string[];
}

export interface ContextCandidateSearchRow {
  symbolId: string;
  filePath: string;
  hasTestCaseFacet: boolean;
  cardContentTokens?: number;
  testCaseQualifiedMatch?: boolean;
  score: number;
  source: ContextCandidateSource;
  tier: 0 | 1;
  sourceRanks: ContextSourceRanks;
  provenance: ContextCandidateProvenance;
}

export interface ContextCandidateSearchResult {
  rows: ContextCandidateSearchRow[];
  capabilities: RetrievalCapabilities;
  evidence?: RetrievalEvidence;
}

/** Only explicit qualified test discovery narrows answer candidates to matching cases. */
export function qualifiedTestCaseMatch(
  query: string,
  testCaseJson: string | null | undefined,
): boolean | undefined {
  if (!/\b(?:find|locate|list|show|identify)\s+(?:the\s+)?(?:(?:unit|integration)\s+)?tests?\b/i.test(query)) {
    return undefined;
  }
  const identifiers = new Set(extractQualifiedTermsFromContext(query, []));
  if (identifiers.size === 0) return undefined;
  const facet = parseTestCaseFacetJson(testCaseJson);
  if (!facet) return false;
  return extractQualifiedTermsFromContext(facet.title, [])
    .some((identifier) => identifiers.has(identifier));
}

/** Preserve exact test-title evidence when a task explicitly asks for tests. */
export function prioritizeQualifiedTestCases(
  rows: readonly ContextCandidateSearchRow[],
  query: string,
  symbols: ReadonlyMap<string, Pick<SymbolRow, "testCaseJson">>,
): ContextCandidateSearchRow[] {
  if (!/\btests?\b/i.test(query)) return [...rows];
  const identifiers = new Set(extractQualifiedTermsFromContext(query, []));
  if (identifiers.size === 0) return [...rows];
  const matches = new Map(rows.map((row) => {
    const title = parseTestCaseFacetJson(symbols.get(row.symbolId)?.testCaseJson)?.title;
    const count = title === undefined ? 0 : extractQualifiedTermsFromContext(title, [])
      .filter((identifier) => identifiers.has(identifier)).length;
    return [row.symbolId, count] as const;
  }));
  return [...rows].sort((left, right) =>
    left.tier - right.tier ||
    (left.tier === 0 ? 0 : matches.get(right.symbolId)! - matches.get(left.symbolId)!),
  );
}

/** Stable-partitions bounded fused rows without changing their contents. */
export function prioritizeContextCandidateRowsByFocus(
  rows: readonly ContextCandidateSearchRow[],
  focusPathPrefixes: readonly string[],
): ContextCandidateSearchRow[] {
  const normalizedPrefixes = [
    ...new Set(
      focusPathPrefixes
        .filter(Boolean)
        .map((prefix) =>
          normalizePath(prefix).replace(/^\.\//, "").replace(/\/+$/, ""),
        )
        .filter((prefix) => prefix !== "."),
    ),
  ];
  if (normalizedPrefixes.length === 0) return [...rows];

  const pinned: ContextCandidateSearchRow[] = [];
  const focused: ContextCandidateSearchRow[] = [];
  const remaining: ContextCandidateSearchRow[] = [];
  for (const row of rows) {
    if (row.tier === 0) {
      pinned.push(row);
      continue;
    }
    const normalizedPath = normalizePath(row.filePath).replace(/^\.\//, "");
    const destination = normalizedPrefixes.some(
      (prefix) =>
        normalizedPath === prefix ||
        normalizedPath.startsWith(`${prefix}/`),
    )
      ? focused
      : remaining;
    destination.push(row);
  }
  return [...pinned, ...focused, ...remaining];
}

async function mapFileSummariesToSymbols(
  collection: EntitySourceRankingCollection,
  options: ContextCandidateSearchOptions,
  overlaySnapshot: OverlaySnapshot,
  directSymbolsByRank: readonly SymbolRow[],
): Promise<{
  symbolIdsByFileId: Map<string, readonly string[]>;
  symbols: Map<string, SymbolRow>;
  files: Map<string, FileRow>;
}> {
  const fileSummaryRankings = collection.rankings.filter(
    (ranking) => ranking.entityType === "fileSummary",
  );
  const bestRankByFileId = new Map<string, number>();
  for (const ranking of fileSummaryRankings) {
    for (const [fileId, rank] of ranking.ranks) {
      const current = bestRankByFileId.get(fileId);
      if (current === undefined || rank < current) {
        bestRankByFileId.set(fileId, rank);
      }
    }
  }
  const maxCandidateFiles =
    Math.max(0, options.limit) * fileSummaryRankings.length;
  const fileIds = [...bestRankByFileId]
    .sort(
      ([leftId, leftRank], [rightId, rightRank]) =>
        leftRank - rightRank || leftId.localeCompare(rightId),
    )
    .slice(0, maxCandidateFiles)
    .map(([fileId]) => fileId);
  const files = await ladybugDb.getFilesByIds(collection.conn, fileIds);
  const symbolIdsByFileId = new Map<string, readonly string[]>();
  const symbols = new Map<string, SymbolRow>();
  const eligibleFileIds = fileIds.filter((fileId) => {
    const file = files.get(fileId);
    return file !== undefined &&
      file.repoId === options.repoId &&
      !overlaySnapshot.touchedFileIds.has(fileId) &&
      (options.includeTests || !isTestCandidate(file.relPath, false));
  });
  const directByFile = new Map(eligibleFileIds.map((fileId) => [
    fileId,
    directSymbolsByRank
      .filter((symbol) => symbol.fileId === fileId)
      .slice(0, options.symbolsPerFileSummary),
  ]));
  const fallbackIds = eligibleFileIds.filter(
    (fileId) => directByFile.get(fileId)!.length === 0,
  );
  const fallback = fallbackIds.length > 0
    ? await ladybugDb.getSymbolsByFileIdsLimited(
        collection.conn,
        fallbackIds,
        options.symbolsPerFileSummary,
      )
    : new Map<string, SymbolRow[]>();

  for (const fileId of eligibleFileIds) {
    const directlyRanked = directByFile.get(fileId)!;
    const mapped = (
      directlyRanked.length > 0
        ? directlyRanked
        : fallback.get(fileId) ?? []
    ).filter(
      (symbol) =>
        symbol.repoId === options.repoId && symbol.external !== true,
    );
    symbolIdsByFileId.set(
      fileId,
      mapped.map((symbol) => symbol.symbolId),
    );
    for (const symbol of mapped) symbols.set(symbol.symbolId, symbol);
  }

  return { symbolIdsByFileId, symbols, files };
}

/** @internal Exported for focused non-fatal fallback coverage. */
export async function applyContextPpr(
  conn: Connection,
  options: ContextCandidateSearchOptions,
  fused: ContextCandidateFusionItem[],
): Promise<ContextCandidateFusionItem[]> {
  if (!options.chatMentions || options.chatMentions.length === 0) return fused;
  try {
    const seeds = await resolveSeedSymbols(
      conn,
      options.repoId,
      options.chatMentions,
    );
    let snapshot = getGraphSnapshot(options.repoId, options.graphVersionId);
    if (!snapshot) {
      snapshot = await loadAndCacheGraphSnapshot(
        conn,
        options.repoId,
        options.graphVersionId,
      );
    }
    if (!snapshot || seeds.seeds.size === 0) return fused;
    const ppr = await computePpr({
      graph: snapshot,
      graphVersionId: options.graphVersionId,
      snapshotCreatedAt:
        getGraphSnapshotCreatedAt(options.repoId, options.graphVersionId) ??
        Date.now(),
      repoId: options.repoId,
      options: { seeds: seeds.seeds },
    });
    const pinnedIdSet = new Set(options.pinnedSymbolIds ?? []);
    const pinned = fused.filter((item) =>
      pinnedIdSet.has(item.symbolId),
    );
    const boostable = fused.filter(
      (item) => !pinnedIdSet.has(item.symbolId),
    );
    const originalScores = new Map(
      boostable.map((item) => [item.symbolId, item.score] as const),
    );
    const byId = new Map(
      boostable.map((item) => [item.symbolId, item]),
    );
    // PPR reads only IDs and scores; restore context-only provenance below.
    const pprItems: HybridSearchResultItem[] = boostable.map((item) => ({
      symbolId: item.symbolId,
      score: item.score,
      source: "fts",
      sourceRanks: {},
    }));
    const boosted = applyPprBoost(pprItems, ppr.scores, {
      combinedCap: 4,
      originalScores,
    });
    return [
      ...pinned,
      ...boosted.items.map((item) => ({
        ...(byId.get(item.symbolId) as ContextCandidateFusionItem),
        score: item.score,
      })),
    ];
  } catch (error) {
    logger.debug("Context PPR boost failed; using unboosted candidates", {
      repoId: options.repoId,
      error,
    });
    return fused;
  }
}

function buildContextCandidateEvidence(
  rankings: readonly ContextEntitySourceRanking[],
  rows: readonly ContextCandidateSearchRow[],
  fusionLatencyMs: number,
): RetrievalEvidence {
  const publicRankings = rankings.filter(
    (ranking): ranking is EntitySourceRanking =>
      ranking.source !== "exactIdentifier",
  );
  const sources = [
    ...new Set(
      publicRankings
        .filter((ranking) => ranking.ranks.size > 0)
        .map((ranking) => ranking.source),
    ),
  ];
  const candidateCountPerSource: Record<string, number> = {};
  for (const ranking of publicRankings) {
    candidateCountPerSource[ranking.source] =
      (candidateCountPerSource[ranking.source] ?? 0) +
      ranking.candidateCount;
  }
  const topRanksPerSource = Object.fromEntries(
    sources.map((source) => [
      source,
      rows.flatMap((row, index) =>
        row.sourceRanks[source] === undefined ? [] : [index + 1],
      ),
    ]),
  );
  return {
    sources,
    candidateCountPerSource,
    topRanksPerSource,
    fusionLatencyMs,
  };
}

/**
 * Shared Context V2 candidate core. Durable symbol and FileSummary lanes use
 * one connection/query context, map to symbol identities, and enter one RRF.
 */
export async function searchContextCandidates(
  conn: Connection,
  options: ContextCandidateSearchOptions,
  queryContext: RetrievalQueryContext,
  overlaySnapshot: OverlaySnapshot,
): Promise<ContextCandidateSearchResult> {
  const collection = await collectEntitySourceRankings(
    {
      repoId: options.repoId,
      query: options.query,
      limit: options.limit,
      entityTypes: options.includeFileSummary
        ? ["symbol", "fileSummary"]
        : ["symbol"],
      includeEvidence: false,
      chatMentions: options.chatMentions,
    },
    queryContext,
  );
  const pinnedIds = [...new Set(options.pinnedSymbolIds ?? [])];
  const pinnedIdSet = new Set(pinnedIds);
  const exactIdentifierIds = [
    ...new Set([
      ...pinnedIds,
      ...(options.exactIdentifierSymbolIds ?? []),
    ]),
  ];
  const contextRankings: ContextEntitySourceRanking[] = [
    ...collection.rankings,
  ];
  if (exactIdentifierIds.length > 0) {
    contextRankings.push({
      source: "exactIdentifier",
      entityType: "symbol",
      ranks: new Map(
        exactIdentifierIds.map((symbolId, index) => [
          symbolId,
          index + 1,
        ]),
      ),
      candidateCount: exactIdentifierIds.length,
    });
  }
  const directRankById = new Map<string, number>();
  for (const ranking of contextRankings) {
    if (ranking.entityType !== "symbol") continue;
    for (const [symbolId, rank] of ranking.ranks) {
      const current = directRankById.get(symbolId);
      if (current === undefined || rank < current) {
        directRankById.set(symbolId, rank);
      }
    }
  }
  const directIds = [...directRankById]
    .sort(
      ([leftId, leftRank], [rightId, rightRank]) =>
        leftRank - rightRank || leftId.localeCompare(rightId),
    )
    .map(([symbolId]) => symbolId);
  const durableDirectSymbols = await ladybugDb.getSearchableSymbolsByIds(
    conn,
    options.repoId,
    directIds,
    true,
  );
  const directSymbols = new Map(
    [...durableDirectSymbols].filter(
      ([symbolId, symbol]) =>
        !overlaySnapshot.touchedFileIds.has(symbol.fileId) ||
        overlaySnapshot.symbolsById.has(symbolId),
    ),
  );
  for (const symbolId of directIds) {
    const overlaySymbol = overlaySnapshot.symbolsById.get(symbolId);
    if (overlaySymbol?.repoId === options.repoId) {
      directSymbols.set(symbolId, overlaySymbol);
    }
  }
  const directFiles = await ladybugDb.getFilesByIds(
    conn,
    [...new Set([...directSymbols.values()].map((symbol) => symbol.fileId))],
  );
  for (const symbol of directSymbols.values()) {
    const overlayFile = overlaySnapshot.filesById.get(symbol.fileId);
    if (overlayFile?.repoId === options.repoId) {
      directFiles.set(symbol.fileId, overlayFile);
    }
  }
  const eligibleDirectIds = new Set(
    [...directSymbols.values()]
      .filter((symbol) => {
        const file = directFiles.get(symbol.fileId);
        const isOverlay = overlaySnapshot.symbolsById.has(symbol.symbolId);
        return (
          file !== undefined &&
          (isOverlay ||
            !overlaySnapshot.touchedFileIds.has(symbol.fileId)) &&
          (pinnedIdSet.has(symbol.symbolId) ||
            options.includeTests ||
            !isTestCandidate(
              file.relPath,
              parseTestCaseFacetJson(symbol.testCaseJson) !== undefined,
            ))
        );
      })
      .map((symbol) => symbol.symbolId),
  );
  const filteredRankings = contextRankings.map((ranking) => ({
    ...ranking,
    ranks:
      ranking.entityType === "symbol"
        ? new Map(
            [...ranking.ranks].filter(([symbolId]) =>
              eligibleDirectIds.has(symbolId),
            ),
          )
        : new Map(ranking.ranks),
  }));

  const overlayRows = rankOverlaySymbolsForQuery(
    overlaySnapshot,
    options.repoId,
    options.query,
    eligibleDirectIds,
  ).filter(
    (row) =>
      options.includeTests ||
      !isTestCandidate(
        row.filePath,
        parseTestCaseFacetJson(
          overlaySnapshot.symbolsById.get(row.symbolId)?.testCaseJson,
        ) !== undefined,
      ),
  );
  if (overlayRows.length > 0) {
    filteredRankings.push({
      source: "overlay",
      entityType: "symbol",
      ranks: new Map(
        overlayRows.map((row, index) => [
          row.symbolId,
          row.sourceRanks?.overlay ?? index + 1,
        ]),
      ),
      candidateCount: overlayRows.length,
    });
  }

  const mapped = await mapFileSummariesToSymbols(
    collection,
    options,
    overlaySnapshot,
    directIds.flatMap((symbolId) => {
      const symbol = directSymbols.get(symbolId);
      return symbol ? [symbol] : [];
    }),
  );
  const fused = await applyContextPpr(
    conn,
    options,
    rrfFuseContextCandidates(
      filteredRankings,
      mapped.symbolIdsByFileId,
      collection.rrfK,
      collection.limit,
      {
        weights: collection.config.fusion.weights,
        coveragePermille: collection.capabilities.coveragePermille,
        pinnedIds,
      },
    ),
  );
  const overlayById = new Map(
    overlayRows.map((row) => [row.symbolId, row]),
  );
  const symbols = new Map([...directSymbols, ...mapped.symbols]);
  const missingFileIds = [
    ...new Set(
      [...symbols.values()]
        .map((symbol) => symbol.fileId)
        .filter((fileId) => !directFiles.has(fileId)),
    ),
  ];
  const missingFiles = await ladybugDb.getFilesByIds(conn, missingFileIds);
  const files = new Map([...directFiles, ...mapped.files, ...missingFiles]);
  const rows: ContextCandidateSearchRow[] = [];
  for (const item of fused) {
    const overlay = overlayById.get(item.symbolId);
    const symbol = symbols.get(item.symbolId);
    const filePath =
      overlay?.filePath ??
      (symbol ? files.get(symbol.fileId)?.relPath : undefined);
    if (!filePath) continue;
    const metadata = symbol ?? overlaySnapshot.symbolsById.get(item.symbolId);
    const hasTestCaseFacet =
      parseTestCaseFacetJson(
        metadata?.testCaseJson,
      ) !== undefined;
    if (
      !pinnedIdSet.has(item.symbolId) &&
      !options.includeTests &&
      isTestCandidate(filePath, hasTestCaseFacet)
    ) {
      continue;
    }
    rows.push({
      symbolId: item.symbolId,
      filePath,
      hasTestCaseFacet,
      cardContentTokens: metadata
        ? estimateSymbolCardContentTokens(metadata)
        : undefined,
      testCaseQualifiedMatch: qualifiedTestCaseMatch(options.query, metadata?.testCaseJson),
      score: item.score,
      source: item.source,
      tier: pinnedIdSet.has(item.symbolId) ? 0 : 1,
      sourceRanks: item.sourceRanks,
      provenance: item.provenance,
    });
  }
  const orderedRows = prioritizeContextCandidateRowsByFocus(
    prioritizeQualifiedTestCases(
      rows,
      options.query,
      new Map([...symbols, ...overlaySnapshot.symbolsById]),
    ),
    options.focusPathPrefixes ?? [],
  );
  return {
    rows: orderedRows,
    capabilities: collection.capabilities,
    ...(options.includeEvidence
      ? {
          evidence: buildContextCandidateEvidence(
            filteredRankings,
            orderedRows,
            collection.fusionLatencyMs,
          ),
        }
      : {}),
  };
}
