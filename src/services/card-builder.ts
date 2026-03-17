import {
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_PROCESSES,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
} from "../config/constants.js";
import type {
  CardWithETag,
  NotModifiedResponse,
  CallResolution,
  SymbolCard,
  SymbolDeps,
  SymbolMetrics,
  SymbolSignature,
} from "../mcp/types.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { symbolCardCache } from "../graph/cache.js";
import { loadConfig } from "../config/loadConfig.js";
import { pickDepLabel } from "../util/depLabels.js";
import { hashCard } from "../util/hashing.js";
import { DatabaseError, createPolicyDenial } from "../mcp/errors.js";
import { PolicyEngine, type PolicyRequestContext } from "../policy/engine.js";
import { logPolicyDecision } from "../mcp/telemetry.js";
import { uniqueLimit } from "../graph/slice/slice-serializer.js";
import { toLegacySymbolRow } from "../mcp/tools/symbol-utils.js";
import {
  getOverlaySnapshot,
  getOverlaySymbol,
  getShadowedDurableSymbol,
  getTargetNamesWithOverlay,
} from "../live-index/overlay-reader.js";
import { logger } from "../util/logger.js";
import { safeJsonParse, StringArraySchema } from "../util/safeJson.js";

export interface BuildCardOptions {
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function getEffectiveMinCallConfidence(
  requestedMinCallConfidence: number | undefined,
): number | undefined {
  if (requestedMinCallConfidence !== undefined) {
    return requestedMinCallConfidence;
  }

  return loadConfig().policy.defaultMinCallConfidence;
}

async function buildOverlayCardForSymbol(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  repoId: string,
  symbolId: string,
  ifNoneMatch: string | undefined,
  effectiveMinCallConfidence: number | undefined,
  includeResolutionMetadata: boolean | undefined,
) {
  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  const overlaySnapshot = getOverlaySnapshot(repoId);
  const overlay = getOverlaySymbol(overlaySnapshot, symbolId);
  if (!overlay) {
    return null;
  }

  const metrics = await ladybugDb.getMetrics(conn, symbolId);
  const [clusterRow, processesRows] = await Promise.all([
    ladybugDb.getClusterForSymbol(conn, symbolId).catch((err) => {
      logger.warn("Failed to get cluster for symbol", {
        symbolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    ladybugDb.getProcessesForSymbol(conn, symbolId).catch((err) => {
      logger.warn("Failed to get processes for symbol", {
        symbolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }),
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
  const targetNamesById = await getTargetNamesWithOverlay(
    conn,
    overlaySnapshot,
    [...new Set([...callTargetIds, ...importTargetIds])],
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

  const callResolution: CallResolution | undefined = includeResolutionMetadata
    ? {
        minCallConfidence: effectiveMinCallConfidence,
        calls: overlay.outgoingEdges
          .filter((edge) => edge.edgeType === "call")
          .map((edge) => ({
            symbolId: edge.toSymbolId,
            label:
              pickDepLabel(
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
    visibility: (overlay.symbol.visibility ??
      undefined) as SymbolCard["visibility"],
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
              row.role === "entry" ||
              row.role === "exit" ||
              row.role === "intermediate"
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
                safeJsonParse(metrics.testRefsJson, StringArraySchema, []),
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

export async function buildCardForSymbol(
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

  const conn = await getLadybugConn();
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
  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);

  if (useCache && latestVersion) {
    const cachedCard = symbolCardCache.get(
      repoId,
      symbolId,
      latestVersion.versionId,
    );
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

  const fileRow = (await ladybugDb.getFilesByIds(conn, [symbol.fileId])).get(
    symbol.fileId,
  );
  if (!fileRow) {
    throw new DatabaseError(`File not found: ${symbol.fileId}`);
  }

  const [edgesFrom, metrics, clusterRow, processesRows] = await Promise.all([
    ladybugDb.getEdgesFrom(conn, symbolId, {
      minCallConfidence: effectiveMinCallConfidence,
    }),
    ladybugDb.getMetrics(conn, symbolId),
    ladybugDb.getClusterForSymbol(conn, symbolId).catch((err) => {
      logger.warn("Failed to get cluster for symbol", {
        symbolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    ladybugDb.getProcessesForSymbol(conn, symbolId).catch((err) => {
      logger.warn("Failed to get processes for symbol", {
        symbolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }),
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

  const callResolution: CallResolution | undefined =
    options.includeResolutionMetadata
      ? {
          minCallConfidence: effectiveMinCallConfidence,
          calls: edgesFrom
            .filter((edge) => edge.edgeType === "call")
            .map((edge) => ({
              symbolId: edge.toSymbolId,
              label:
                pickDepLabel(
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
              safeJsonParse(metrics.testRefsJson, StringArraySchema, []),
              SYMBOL_CARD_MAX_TEST_REFS,
            )
          : undefined,
        canonicalTest: metrics.canonicalTestJson
          ? parseJson(metrics.canonicalTestJson)
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
        ? processesRows.slice(0, SYMBOL_CARD_MAX_PROCESSES).map((row) => ({
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
    await symbolCardCache.set(
      repoId,
      symbolId,
      latestVersion.versionId,
      cacheCard,
    );
  }

  return cardWithETag;
}
