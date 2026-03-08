import {
  SymbolSearchRequestSchema,
  SymbolSearchResponse,
  SymbolGetCardRequestSchema,
  SymbolGetCardResponse,
  SymbolGetCardsRequestSchema,
  SymbolGetCardsResponse,
} from "../tools.js";
import {
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_PROCESSES,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_SEARCH_DEFAULT_LIMIT,
} from "../../config/constants.js";
import type { SymbolKind } from "../../db/schema.js";
import type {
  CardWithETag,
  NotModifiedResponse,
  CallResolution,
  SymbolCard,
  SymbolDeps,
  SymbolMetrics,
  SymbolSignature,
} from "../types.js";
import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import { symbolCardCache } from "../../graph/cache.js";
import { consumePrefetchedKey, prefetchCardsForSymbols, prefetchSliceFrontier } from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { loadConfig } from "../../config/loadConfig.js";
import { pickDepLabel } from "../../util/depLabels.js";
import { hashCard } from "../../util/hashing.js";
import { DatabaseError, createPolicyDenial } from "../errors.js";
import { PolicyEngine, type PolicyRequestContext } from "../../policy/engine.js";
import { logPolicyDecision, logSemanticSearchTelemetry } from "../telemetry.js";
import { attachRawContext } from "../token-usage.js";
import { uniqueLimit } from "../../graph/slice/slice-serializer.js";
import { toLegacySymbolRow } from "./symbol-utils.js";
import {
  getOverlaySnapshot,
  getOverlaySymbol,
  getShadowedDurableSymbol,
  getTargetNamesWithOverlay,
  searchSymbolsWithOverlay,
} from "../../live-index/overlay-reader.js";


function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

interface BuildCardOptions {
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
}

function getEffectiveMinCallConfidence(
  requestedMinCallConfidence: number | undefined,
): number | undefined {
  if (requestedMinCallConfidence !== undefined) {
    return requestedMinCallConfidence;
  }

  return loadConfig().policy.defaultMinCallConfidence;
}

export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const startedAt = Date.now();
  const request = SymbolSearchRequestSchema.parse(args);
  const limit = request.limit ?? SYMBOL_SEARCH_DEFAULT_LIMIT;

  recordToolTrace({
    repoId: request.repoId,
    taskType: "search",
    tool: "symbol.search",
  });

  const conn = await getKuzuConn();
  const rows = await searchSymbolsWithOverlay(
    conn,
    request.repoId,
    request.query,
    limit,
  );

  const results = rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    file: row.filePath,
    kind: row.kind as SymbolKind,
  }));

  // Prefetch cards for top search results (anticipating getCard calls)
  const topSymbolIds = rows.slice(0, 5).map((row) => row.symbolId);
  if (topSymbolIds.length > 0) {
    prefetchCardsForSymbols(request.repoId, topSymbolIds);
  }

  logSemanticSearchTelemetry({
    repoId: request.repoId,
    semanticEnabled: false,
    latencyMs: Date.now() - startedAt,
    candidateCount: rows.length,
    alpha: loadConfig().semantic?.alpha ?? 0.6,
  });

  const response = { results };
  attachRawContext(response, {
    fileIds: [...new Set(rows.map((row) => row.fileId))],
  });
  return response;
}

async function buildOverlayCardForSymbol(
  conn: Awaited<ReturnType<typeof getKuzuConn>>,
  repoId: string,
  symbolId: string,
  ifNoneMatch: string | undefined,
  effectiveMinCallConfidence: number | undefined,
  includeResolutionMetadata: boolean | undefined,
) {
  const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);
  const overlaySnapshot = getOverlaySnapshot(repoId);
  const overlay = getOverlaySymbol(overlaySnapshot, symbolId);
  if (!overlay) {
    return null;
  }

  const metrics = await kuzuDb.getMetrics(conn, symbolId);
  const [clusterRow, processesRows] = await Promise.all([
    kuzuDb.getClusterForSymbol(conn, symbolId).catch(() => null),
    kuzuDb.getProcessesForSymbol(conn, symbolId).catch(() => []),
  ]);

  const signature = parseJson<SymbolSignature>(overlay.symbol.signatureJson);
  const invariants = parseJson<string[]>(overlay.symbol.invariantsJson);
  const sideEffects = parseJson<string[]>(overlay.symbol.sideEffectsJson);

  const callTargetIds = overlay.outgoingEdges
    .filter((edge) => edge.edgeType === "call")
    .map((edge) => edge.toSymbolId);
  const importTargetIds = overlay.outgoingEdges
    .filter((edge) => edge.edgeType === "import")
    .map((edge) => edge.toSymbolId);
  const targetNamesById = await getTargetNamesWithOverlay(conn, overlaySnapshot, [
    ...new Set([...callTargetIds, ...importTargetIds]),
  ]);

  const deps: SymbolDeps = {
    imports: uniqueLimit(
      importTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
    calls: uniqueLimit(
      callTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
  };

  const callResolution: CallResolution | undefined = includeResolutionMetadata
    ? {
        minCallConfidence: effectiveMinCallConfidence,
        calls: overlay.outgoingEdges
          .filter((edge) => edge.edgeType === "call")
          .map((edge) => ({
            symbolId: edge.toSymbolId,
            label:
              pickDepLabel(edge.toSymbolId, targetNamesById.get(edge.toSymbolId)?.name) ??
              edge.toSymbolId,
            confidence: edge.confidence,
            resolutionReason: edge.resolution,
            resolverId: edge.resolverId,
            resolutionPhase: edge.resolutionPhase,
          })),
      }
    : undefined;

  const card: SymbolCard = {
    symbolId: overlay.symbol.symbolId,
    repoId: overlay.symbol.repoId,
    file: overlay.file.relPath,
    range: {
      startLine: overlay.symbol.rangeStartLine,
      startCol: overlay.symbol.rangeStartCol,
      endLine: overlay.symbol.rangeEndLine,
      endCol: overlay.symbol.rangeEndCol,
    },
    kind: overlay.symbol.kind as SymbolCard["kind"],
    name: overlay.symbol.name,
    exported: overlay.symbol.exported,
    visibility: (overlay.symbol.visibility ?? undefined) as SymbolCard["visibility"],
    signature,
    summary: overlay.symbol.summary
      ? overlay.symbol.summary.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS)
      : undefined,
    invariants: invariants
      ? invariants.slice(0, SYMBOL_CARD_MAX_INVARIANTS)
      : undefined,
    sideEffects: sideEffects
      ? sideEffects.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS)
      : undefined,
    cluster: clusterRow
      ? {
          clusterId: clusterRow.clusterId,
          label: clusterRow.label,
          memberCount: clusterRow.symbolCount,
        }
      : undefined,
    processes:
      processesRows.length > 0
        ? processesRows.slice(0, SYMBOL_CARD_MAX_PROCESSES).map((row) => ({
            processId: row.processId,
            label: row.label,
            role:
              row.role === "entry" || row.role === "exit" || row.role === "intermediate"
                ? row.role
                : "intermediate",
            depth: row.depth,
          }))
        : undefined,
    callResolution:
      callResolution && callResolution.calls.length > 0
        ? callResolution
        : undefined,
    deps,
    metrics: metrics
      ? {
          fanIn: metrics.fanIn,
          fanOut: metrics.fanOut,
          churn30d: metrics.churn30d,
          testRefs: metrics.testRefsJson
            ? uniqueLimit(
                JSON.parse(metrics.testRefsJson) as string[],
                SYMBOL_CARD_MAX_TEST_REFS,
              )
            : undefined,
          canonicalTest: metrics.canonicalTestJson
            ? parseJson(metrics.canonicalTestJson)
            : undefined,
        }
      : undefined,
    detailLevel: "full",
    version: {
      ledgerVersion: latestVersion?.versionId ?? "current",
      astFingerprint: overlay.symbol.astFingerprint,
    },
  };

  const etag = hashCard(card);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return {
      notModified: true as const,
      etag,
      ledgerVersion: latestVersion?.versionId ?? "current",
    };
  }

  return {
    ...card,
    etag,
  };
}

async function buildCardForSymbol(
  repoId: string,
  symbolId: string,
  ifNoneMatch: string | undefined,
  options: BuildCardOptions = {},
): Promise<CardWithETag | NotModifiedResponse> {
  const config = loadConfig();
  const cacheEnabled = config.cache?.enabled ?? true;
  const effectiveMinCallConfidence = getEffectiveMinCallConfidence(
    options.minCallConfidence,
  );
  const useCache =
    cacheEnabled &&
    effectiveMinCallConfidence === undefined &&
    !options.includeResolutionMetadata;

  const conn = await getKuzuConn();
  const overlaySnapshot = getOverlaySnapshot(repoId);
  const overlayCard = await buildOverlayCardForSymbol(
    conn,
    repoId,
    symbolId,
    ifNoneMatch,
    effectiveMinCallConfidence,
    options.includeResolutionMetadata,
  );
  if (overlayCard) {
    return overlayCard;
  }
  const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);

  if (useCache && latestVersion) {
    const cachedCard = symbolCardCache.get(repoId, symbolId, latestVersion.versionId);
    if (cachedCard && cachedCard.detailLevel !== "compact") {
      const normalizedCachedCard: SymbolCard = {
        ...cachedCard,
        detailLevel: "full",
      };
      delete normalizedCachedCard.etag;
      const cachedETag = hashCard(normalizedCachedCard);
      if (ifNoneMatch && ifNoneMatch === cachedETag) {
        return {
          notModified: true,
          etag: cachedETag,
          ledgerVersion: latestVersion.versionId,
        };
      }
      return {
        ...normalizedCachedCard,
        etag: cachedETag,
      };
    }
  }

  const symbol = await getShadowedDurableSymbol(
    conn,
    repoId,
    symbolId,
    overlaySnapshot,
  );
  if (!symbol) {
    throw new DatabaseError(`Symbol not found: ${symbolId}`);
  }
  if (symbol.repoId !== repoId) {
    throw new DatabaseError(
      `Symbol ${symbolId} belongs to repo "${symbol.repoId}", not "${repoId}"`,
    );
  }

  const legacySymbol = toLegacySymbolRow(symbol);

  const policyEngine = new PolicyEngine();
  const policyContext: PolicyRequestContext = {
    requestType: "symbolCard",
    repoId,
    symbolId,
    symbolData: legacySymbol,
  };

  const policyDecision = policyEngine.evaluate(policyContext);
  const { nextBestAction, requiredFieldsForNext } =
    policyEngine.generateNextBestAction(policyDecision, policyContext);

  logPolicyDecision({
    requestType: policyContext.requestType,
    repoId: policyContext.repoId,
    symbolId: policyContext.symbolId,
    decision: policyDecision.decision,
    auditHash: policyDecision.auditHash,
    evidenceUsed: policyDecision.evidenceUsed,
    deniedReasons: policyDecision.deniedReasons,
    nextBestAction,
    requiredFieldsForNext,
    context: policyContext,
  });

  if (policyDecision.decision === "deny") {
    throw createPolicyDenial(
      `Policy denied symbol card request: ${policyDecision.deniedReasons?.join(", ")}`,
      nextBestAction,
      requiredFieldsForNext,
    );
  }

  const fileRow = (await kuzuDb.getFilesByIds(conn, [symbol.fileId])).get(symbol.fileId);
  if (!fileRow) {
    throw new DatabaseError(`File not found: ${symbol.fileId}`);
  }

  const [edgesFrom, metrics, clusterRow, processesRows] = await Promise.all([
    kuzuDb.getEdgesFrom(conn, symbolId, {
      minCallConfidence: effectiveMinCallConfidence,
    }),
    kuzuDb.getMetrics(conn, symbolId),
    kuzuDb.getClusterForSymbol(conn, symbolId).catch(() => null),
    kuzuDb.getProcessesForSymbol(conn, symbolId).catch(() => []),
  ]);

  const signature = parseJson<SymbolSignature>(symbol.signatureJson);
  const invariants = parseJson<string[]>(symbol.invariantsJson);
  const sideEffects = parseJson<string[]>(symbol.sideEffectsJson);

  const cardSummary = symbol.summary
    ? symbol.summary.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS)
    : undefined;

  const importTargetIds = edgesFrom
    .filter((edge) => edge.edgeType === "import")
    .map((edge) => edge.toSymbolId);
  const callTargetIds = edgesFrom
    .filter((edge) => edge.edgeType === "call")
    .map((edge) => edge.toSymbolId);

  const targetIds = Array.from(new Set([...importTargetIds, ...callTargetIds]));
  const targetNamesById = await getTargetNamesWithOverlay(
    conn,
    overlaySnapshot,
    targetIds,
  );

  const deps: SymbolDeps = {
    imports: uniqueLimit(
      importTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
    calls: uniqueLimit(
      callTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
  };

  const callResolution: CallResolution | undefined = options.includeResolutionMetadata
    ? {
        minCallConfidence: effectiveMinCallConfidence,
        calls: edgesFrom
          .filter((edge) => edge.edgeType === "call")
          .map((edge) => ({
            symbolId: edge.toSymbolId,
            label: pickDepLabel(
              edge.toSymbolId,
              targetNamesById.get(edge.toSymbolId)?.name,
            ) ?? edge.toSymbolId,
            confidence: edge.confidence,
            resolutionReason: edge.resolution,
            resolverId: edge.resolverId,
            resolutionPhase: edge.resolutionPhase,
          })),
      }
    : undefined;

  const cardMetrics: SymbolMetrics | undefined = metrics
    ? {
        fanIn: metrics.fanIn,
        fanOut: metrics.fanOut,
        churn30d: metrics.churn30d,
        testRefs: metrics.testRefsJson
          ? uniqueLimit(
              JSON.parse(metrics.testRefsJson) as string[],
              SYMBOL_CARD_MAX_TEST_REFS,
            )
          : undefined,
        canonicalTest: metrics.canonicalTestJson
          ? (parseJson(metrics.canonicalTestJson))
          : undefined,
      }
    : undefined;

  const card: SymbolCard = {
    symbolId: symbol.symbolId,
    repoId: symbol.repoId,
    file: fileRow.relPath,
    range: {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    },
    kind: symbol.kind as SymbolCard["kind"],
    name: symbol.name,
    exported: symbol.exported,
    visibility: (symbol.visibility ?? undefined) as SymbolCard["visibility"],
    signature,
    summary: cardSummary,
    invariants: invariants
      ? invariants.slice(0, SYMBOL_CARD_MAX_INVARIANTS)
      : undefined,
    sideEffects: sideEffects
      ? sideEffects.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS)
      : undefined,
    cluster: clusterRow
      ? {
          clusterId: clusterRow.clusterId,
          label: clusterRow.label,
          memberCount: clusterRow.symbolCount,
        }
      : undefined,
    processes:
      processesRows && processesRows.length > 0
        ? processesRows
            .slice(0, SYMBOL_CARD_MAX_PROCESSES)
            .map((row) => ({
              processId: row.processId,
              label: row.label,
              role:
                row.role === "entry" || row.role === "exit" || row.role === "intermediate"
                  ? row.role
                  : "intermediate",
              depth: row.depth,
            }))
        : undefined,
    callResolution:
      callResolution && callResolution.calls.length > 0
        ? callResolution
        : undefined,
    deps,
    metrics: cardMetrics,
    detailLevel: "full",
    version: {
      ledgerVersion: latestVersion?.versionId ?? "current",
      astFingerprint: symbol.astFingerprint,
    },
  };

  const etag = hashCard(card);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return {
      notModified: true,
      etag,
      ledgerVersion: latestVersion?.versionId ?? "current",
    };
  }

  const cardWithETag: CardWithETag = { ...card, etag };

  if (useCache && latestVersion) {
    const cacheCard: SymbolCard = { ...card, detailLevel: "full" };
    delete cacheCard.etag;
    await symbolCardCache.set(repoId, symbolId, latestVersion.versionId, cacheCard);
  }

  return cardWithETag;
}

export async function handleSymbolGetCard(
  args: unknown,
): Promise<SymbolGetCardResponse | NotModifiedResponse> {
  const request = SymbolGetCardRequestSchema.parse(args);
  const {
    repoId,
    symbolId,
    ifNoneMatch,
    minCallConfidence,
    includeResolutionMetadata,
  } = request;

  recordToolTrace({
    repoId,
    taskType: "card",
    tool: "symbol.getCard",
    symbolId,
  });
  consumePrefetchedKey(repoId, `card:${symbolId}`);

  const result = await buildCardForSymbol(repoId, symbolId, ifNoneMatch, {
    minCallConfidence,
    includeResolutionMetadata,
  });
  if ("notModified" in result) {
    return result;
  }

  // Prefetch edge targets for anticipated slice.build
  prefetchSliceFrontier(repoId, [symbolId]);

  const response = { card: result };
  const conn = await getKuzuConn();
  const symbol = await kuzuDb.getSymbol(conn, symbolId);
  if (symbol) {
    attachRawContext(response, { fileIds: [symbol.fileId] });
  }
  return response;
}

export async function handleSymbolGetCards(
  args: unknown,
): Promise<SymbolGetCardsResponse> {
  const {
    repoId,
    symbolIds,
    knownEtags,
    minCallConfidence,
    includeResolutionMetadata,
  } =
    SymbolGetCardsRequestSchema.parse(args);

  for (const symbolId of symbolIds) {
    consumePrefetchedKey(repoId, `card:${symbolId}`);
  }

  const cards = await Promise.all(
    symbolIds.map((id) =>
      buildCardForSymbol(repoId, id, knownEtags?.[id], {
        minCallConfidence,
        includeResolutionMetadata,
      })
    ),
  );

  const conn = await getKuzuConn();
  const symbolMap = await kuzuDb.getSymbolsByIds(conn, symbolIds);
  const fileIds = [
    ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
  ];

  const response = { cards };
  attachRawContext(response, { fileIds });
  return response;
}
