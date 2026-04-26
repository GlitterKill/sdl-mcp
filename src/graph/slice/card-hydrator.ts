// =============================================================================
// graph/slice/card-hydrator.ts — Symbol-card hydration for slice builder.
//
// Public exports:
//   - loadSymbolCards(...)
// =============================================================================

import type { Connection } from "kuzu";
import type { RepoId, SymbolId, VersionId } from "../../domain/types.js";
import type { SymbolCard, SliceSymbolDeps, CardDetailLevel } from "../../domain/types.js";
import { CARD_DETAIL_LEVEL_RANK } from "../../domain/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { pickDepLabel } from "../../util/depLabels.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { SYMBOL_CARD_MAX_DEPS_PER_KIND, SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT, SYMBOL_CARD_MAX_INVARIANTS, SYMBOL_CARD_MAX_PROCESSES, SYMBOL_CARD_MAX_SIDE_EFFECTS, SYMBOL_CARD_MAX_TEST_REFS, SYMBOL_CARD_SUMMARY_MAX_CHARS, SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT } from "../../config/constants.js";
import { symbolCardCache } from "../cache.js";
import { toFullCard, toCardAtDetailLevel, uniqueLimit } from "../slice/slice-serializer.js";
import { getOverlaySnapshot, getTargetNamesWithOverlay, mergeEdgeMapWithOverlay, mergeSymbolRowsWithOverlay, type OverlaySnapshot } from "../../live-index/overlay-reader.js";
import { safeJsonParse, safeJsonParseOptional, StringArraySchema, SignatureSchema } from "../../util/safeJson.js";
import { buildCallResolution } from "./detail-level.js";
import { buildSliceDepsBySymbol } from "./edge-projector.js";

export async function loadSymbolCards(
  conn: Connection,
  symbolIds: SymbolId[],
  versionId: VersionId,
  repoId: RepoId,
  effectiveLevel: CardDetailLevel,
  minCallConfidence?: number,
  includeResolutionMetadata?: boolean,
  overlaySnapshot?: OverlaySnapshot,
): Promise<{
  cards: SymbolCard[];
  sliceDepsBySymbol: Map<SymbolId, SliceSymbolDeps>;
}> {
  if (symbolIds.length === 0) {
    return {
      cards: [],
      sliceDepsBySymbol: new Map<SymbolId, SliceSymbolDeps>(),
    };
  }

  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;
  const canUseCache = cacheEnabled && !includeResolutionMetadata;

  const cards: SymbolCard[] = [];
  const uncachedSymbolIds: SymbolId[] = [];
  const snapshot = overlaySnapshot ?? getOverlaySnapshot(repoId);

  if (canUseCache) {
    for (const symbolId of symbolIds) {
      if (snapshot.symbolsById.has(symbolId)) {
        uncachedSymbolIds.push(symbolId);
        continue;
      }
      const cachedCard = symbolCardCache.get(repoId, symbolId, versionId);

      if (!cachedCard) {
        uncachedSymbolIds.push(symbolId);
        continue;
      }

      const cardAtLevel = toCardAtDetailLevel(cachedCard, effectiveLevel);
      cards.push(cardAtLevel);
    }
  } else {
    uncachedSymbolIds.push(...symbolIds);
  }

  if (uncachedSymbolIds.length === 0) {
    return {
      cards,
      sliceDepsBySymbol: await buildSliceDepsBySymbol(
        conn,
        symbolIds,
        undefined,
        minCallConfidence,
      ),
    };
  }

  uncachedSymbolIds.sort();

  const durableSymbolsMap = await ladybugDb.getSymbolsByIds(
    conn,
    uncachedSymbolIds,
  );
  const symbolsMap = mergeSymbolRowsWithOverlay(
    snapshot,
    uncachedSymbolIds,
    durableSymbolsMap,
  );

  const fileIds = new Set<string>();
  for (const symbol of symbolsMap.values()) {
    if (symbol.repoId !== repoId) continue;
    fileIds.add(symbol.fileId);
  }
  const filesMap = await ladybugDb.getFilesByIds(conn, [...fileIds]);
  for (const [fileId, file] of snapshot.filesById) {
    if (fileIds.has(fileId)) {
      filesMap.set(fileId, file);
    }
  }

  const metricsMap = await ladybugDb.getMetricsBySymbolIds(
    conn,
    uncachedSymbolIds,
  );

  const durableEdgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(
    conn,
    uncachedSymbolIds,
    { minCallConfidence },
  );
  const edgesMap = mergeEdgeMapWithOverlay(
    snapshot,
    uncachedSymbolIds,
    durableEdgesMap,
    minCallConfidence,
  );

  const importedSymbolIds = new Set<string>();
  const calledSymbolIds = new Set<string>();
  for (const edges of edgesMap.values()) {
    for (const edge of edges) {
      if (edge.edgeType === "import") {
        importedSymbolIds.add(edge.toSymbolId);
      } else if (edge.edgeType === "call") {
        calledSymbolIds.add(edge.toSymbolId);
      }
    }
  }
  const importedSymbolsMap = await getTargetNamesWithOverlay(conn, snapshot, [
    ...importedSymbolIds,
  ]);
  const calledSymbolsMap = await getTargetNamesWithOverlay(conn, snapshot, [
    ...calledSymbolIds,
  ]);

  const includeDeps =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.deps;
  const includeSignature =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.signature;
  const includeFullDetails = effectiveLevel === "full";

  const clustersBySymbolId = await ladybugDb.getClustersForSymbols(
    conn,
    uncachedSymbolIds,
  );
  const processesBySymbolId = includeDeps
    ? await ladybugDb.getProcessesForSymbols(conn, uncachedSymbolIds)
    : new Map<string, ladybugDb.ProcessForSymbolRow[]>();

  for (const symbolId of uncachedSymbolIds) {
    const symbolRow = symbolsMap.get(symbolId);
    if (!symbolRow || symbolRow.repoId !== repoId) continue;

    const clusterRow = clustersBySymbolId.get(symbolId);
    const processRows = includeDeps
      ? (processesBySymbolId.get(symbolId) ?? [])
      : [];

    const file = filesMap.get(symbolRow.fileId);
    const metrics = metricsMap.get(symbolId);
    const outgoingEdges = edgesMap.get(symbolId) ?? [];

    const importDeps: string[] = [];
    const callDeps: string[] = [];

    if (includeDeps) {
      for (const edge of outgoingEdges) {
        if (edge.edgeType === "import") {
          const importedSymbol = importedSymbolsMap.get(edge.toSymbolId);
          const depLabel = pickDepLabel(edge.toSymbolId, importedSymbol?.name);
          if (depLabel) {
            importDeps.push(depLabel);
          }
        } else if (edge.edgeType === "call") {
          const calledSymbol = calledSymbolsMap.get(edge.toSymbolId);
          const depLabel = pickDepLabel(edge.toSymbolId, calledSymbol?.name);
          if (depLabel) {
            callDeps.push(depLabel);
          }
        }
      }
    }

    const depLimit = includeFullDetails
      ? SYMBOL_CARD_MAX_DEPS_PER_KIND
      : SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT;
    const deps = {
      imports: includeDeps ? uniqueLimit(importDeps, depLimit) : [],
      calls: includeDeps ? uniqueLimit(callDeps, depLimit) : [],
    };

    let signature;
    if (includeSignature && symbolRow.signatureJson) {
      signature = safeJsonParse(symbolRow.signatureJson, SignatureSchema, {
        name: symbolRow.name,
      }) as unknown as SymbolCard["signature"];
    } else if (includeSignature) {
      signature = { name: symbolRow.name };
    }

    let invariants: string[] | undefined;
    if (includeFullDetails && symbolRow.invariantsJson) {
      const parsed = safeJsonParseOptional(
        symbolRow.invariantsJson,
        StringArraySchema,
      );
      if (parsed) {
        invariants = parsed.slice(0, SYMBOL_CARD_MAX_INVARIANTS);
      }
    }

    let sideEffects: string[] | undefined;
    if (includeFullDetails && symbolRow.sideEffectsJson) {
      const parsed = safeJsonParseOptional(
        symbolRow.sideEffectsJson,
        StringArraySchema,
      );
      if (parsed) {
        sideEffects = parsed.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS);
      }
    }

    let metricsData;
    if (includeFullDetails && metrics) {
      const rawTestRefs = safeJsonParseOptional(
        metrics.testRefsJson,
        StringArraySchema,
      );
      const testRefs = rawTestRefs
        ? uniqueLimit(rawTestRefs, SYMBOL_CARD_MAX_TEST_REFS)
        : undefined;

      metricsData = {
        fanIn: metrics.fanIn,
        fanOut: metrics.fanOut,
        churn30d: metrics.churn30d,
        testRefs,
      };
    }

    const summaryMaxLength = includeFullDetails
      ? SYMBOL_CARD_SUMMARY_MAX_CHARS
      : SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT;

    const baseCard: SymbolCard = {
      symbolId: symbolRow.symbolId,
      repoId: symbolRow.repoId,
      file: file?.relPath ?? "",
      range: {
        startLine: symbolRow.rangeStartLine,
        startCol: symbolRow.rangeStartCol,
        endLine: symbolRow.rangeEndLine,
        endCol: symbolRow.rangeEndCol,
      },
      kind: symbolRow.kind as SymbolCard["kind"],
      name: symbolRow.name,
      exported: symbolRow.exported,
      visibility:
        (symbolRow.visibility as SymbolCard["visibility"]) ?? undefined,
      signature: includeSignature ? signature : undefined,
      summary: symbolRow.summary
        ? symbolRow.summary.slice(0, summaryMaxLength)
        : undefined,
      invariants: invariants && invariants.length > 0 ? invariants : undefined,
      sideEffects:
        sideEffects && sideEffects.length > 0 ? sideEffects : undefined,
      cluster: clusterRow
        ? {
            clusterId: clusterRow.clusterId,
            label: clusterRow.label,
            memberCount: clusterRow.symbolCount,
          }
        : undefined,
      processes:
        includeDeps && processRows.length > 0
          ? processRows.slice(0, SYMBOL_CARD_MAX_PROCESSES).map((row) => ({
              processId: row.processId,
              label: row.label,
              role:
                row.role === "entry" ||
                row.role === "exit" ||
                row.role === "intermediate"
                  ? row.role
                  : "intermediate",
              depth: row.depth,
            }))
          : undefined,
      callResolution: includeResolutionMetadata
        ? buildCallResolution(
            outgoingEdges,
            calledSymbolsMap,
            minCallConfidence,
          )
        : undefined,
      deps,
      metrics: includeFullDetails ? metricsData : undefined,
      detailLevel: effectiveLevel,
      version: {
        ledgerVersion: versionId,
        astFingerprint: symbolRow.astFingerprint,
      },
    };

    const card = toCardAtDetailLevel(baseCard, effectiveLevel);
    cards.push(card);

    if (canUseCache && !snapshot.symbolsById.has(symbolRow.symbolId)) {
      await symbolCardCache.set(
        repoId,
        symbolRow.symbolId,
        versionId,
        toFullCard(baseCard),
      );
    }
  }

  return {
    cards,
    sliceDepsBySymbol: await buildSliceDepsBySymbol(
      conn,
      symbolIds,
      edgesMap,
      minCallConfidence,
    ),
  };
}
