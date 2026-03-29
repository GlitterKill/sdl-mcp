import {
  type SliceBuildRequest,
  SliceBuildResponse,
  SliceBuildWireFormat,
  type SliceRefreshRequest,
  SliceRefreshResponse,
  type SliceSpilloverGetRequest,
  SliceSpilloverGetResponse,
  type RetrievalEvidenceItem,
} from "../tools.js";
import type {
  GraphSlice,
  SliceHandle,
  SliceLease,
  SliceEtag,
  DeltaPackWithGovernance,
  SymbolSignature,
} from "../types.js";
import { buildSlice } from "../../graph/slice.js";
import type { RetrievalSource } from "../../retrieval/types.js";
import { classifySymptomType } from "../../retrieval/evidence.js";
import { entitySearch } from "../../retrieval/index.js";
import {
  type SliceErrorResponse,
  sliceErrorToResponse,
} from "../../graph/slice/result.js";
import * as crypto from "crypto";
import { computeDelta } from "../../delta/diff.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolKind } from "../../domain/types.js";
import {
  PolicyEngine,
  type PolicyRequestContext,
} from "../../policy/engine.js";
import { logPolicyDecision } from "../telemetry.js";
import { logger } from "../../util/logger.js";
import {
  consumePrefetchedKey,
  prefetchSliceFrontier,
} from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SLICE_LEASE_TTL_MS,
  SPILLOVER_DEFAULT_PAGE_SIZE,
} from "../../config/constants.js";
import { loadConfig } from "../../config/loadConfig.js";
import { PolicyConfigSchema } from "../../config/types.js";
import { DEFAULT_MEMORY_SURFACE_LIMIT } from "../../config/constants.js";
import {
  createPolicyDenial,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { pickDepLabel } from "../../util/depLabels.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import type { ToolContext } from "../../server.js";
import {
  safeJsonParseOptional,
  safeJsonParseOrThrow,
  safeJsonParse,
  StringArraySchema,
  SignatureSchema,
  ConfigObjectSchema,
} from "../../util/safeJson.js";
import { z } from "zod";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";
import { attachRawContext } from "../token-usage.js";
import {
  serializeSliceForWireFormat,
  normalizeVisibility,
} from "./slice-wire-format.js";
import { surfaceRelevantMemories } from "../../memory/surface.js";
import type { SurfacedMemory } from "../../domain/types.js";

export {
  toCompactGraphSliceV1,
  toCompactGraphSlice,
  toCompactGraphSliceV2,
  toCompactGraphSliceV3,
  decodeCompactGraphSliceV3ToV2,
  decodeCompactEdgesV2ToV1,
  decodeCompactEdgesV3ToV1,
  serializeSliceForWireFormat,
} from "./slice-wire-format.js";

function clampInt(value: number, min: number, max: number): number {
  const v = Math.trunc(value);
  return Math.max(min, Math.min(max, v));
}

/**
 * Generates a unique slice handle identifier.
 *
 * @returns 32-character hex string representing the slice handle
 * @internal
 */
function generateSliceHandle(): SliceHandle {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generates a hash of the slice content for ETag validation.
 * Hash includes repoId, versionId, sorted start symbols, budget, and card count.
 *
 * @param slice - Graph slice to hash
 * @returns SHA-256 hash hex string
 * @internal
 */
function generateSliceHash(slice: GraphSlice): string {
  const cardFingerprint = crypto
    .createHash("sha256")
    .update(slice.cards.map((c) => c.symbolId).sort().join(","))
    .digest("hex");
  const canonical = JSON.stringify({
    repoId: slice.repoId,
    versionId: slice.versionId,
    startSymbols: [...slice.startSymbols].sort(),
    budget: slice.budget,
    cardCount: slice.cards.length,
    cardFingerprint,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Creates a lease for a slice handle with 1-hour TTL.
 *
 * @param ledgerVersion - Current ledger version string
 * @returns Slice lease with expiration and version bounds
 * @internal
 */
function createLease(ledgerVersion: string): SliceLease {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SLICE_LEASE_TTL_MS);
  return {
    expiresAt: expiresAt.toISOString(),
    minVersion: null,
    maxVersion: ledgerVersion,
  };
}

/**
 * Creates an ETag object for slice cache validation.
 *
 * @param handle - Slice handle identifier
 * @param version - Ledger version string
 * @param sliceHash - Hash of slice content
 * @returns Slice ETag object
 * @internal
 */
function createSliceEtag(
  handle: SliceHandle,
  version: string,
  sliceHash: string,
): SliceEtag {
  return {
    handle,
    version,
    sliceHash,
  };
}

/**
 * Handles graph slice build requests.
 * Creates a new slice handle with configurable entry points and budget.
 * Supports policy evaluation and lease-based caching.
 *
 * @param args - Raw arguments containing repoId, task context, and slice parameters
 * @returns Slice build response with handle, lease, ETag, and slice data
 */
export async function handleSliceBuild(
  args: unknown,
  context?: ToolContext,
): Promise<SliceBuildResponse | SliceErrorResponse> {
  // Validate that at least one entry hint is provided. taskText is optional
  // in the schema and the internal handler relies on start-node resolution.
  const request = args as SliceBuildRequest;
  const hasAnyEntryHint =
    (request.entrySymbols && request.entrySymbols.length > 0) ||
    Boolean(request.taskText) ||
    (request.editedFiles && request.editedFiles.length > 0) ||
    Boolean(request.stackTrace) ||
    Boolean(request.failingTestPath);

  if (!hasAnyEntryHint) {
    return sliceErrorToResponse({
      type: "no_symbols",
      repoId: request.repoId ?? "unknown",
    });
  }

  try {
    return await handleSliceBuildInternal(args, context);
  } catch (error) {
    const parsed = args as SliceBuildRequest;

    if (error instanceof NotFoundError) {
      return sliceErrorToResponse({
        type: "invalid_repo",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    if (error instanceof ValidationError) {
      return sliceErrorToResponse({
        type: "no_version",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    // PolicyDenialError (from createPolicyDenial) has code === POLICY_ERROR
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "POLICY_ERROR") {
      return sliceErrorToResponse({
        type: "policy_denied",
        reason: error.message.replace("Policy denied slice request: ", ""),
      });
    }

    // AbortError from context cancellation or timeout
    if (error instanceof Error && error.name === "AbortError") {
      return sliceErrorToResponse({
        type: "no_version",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    // Let unexpected errors propagate to the centralized handler in server.ts
    throw error;
  }
}

async function handleSliceBuildInternal(
  args: unknown,
  context?: ToolContext,
): Promise<SliceBuildResponse> {
  const request = args as SliceBuildRequest;
  const {
    repoId,
    taskText,
    stackTrace,
    failingTestPath,
    editedFiles,
    entrySymbols,
    knownCardEtags,
    cardDetail,
    wireFormat,
    wireFormatVersion,
    budget,
    minConfidence,
    minCallConfidence,
    includeResolutionMetadata,
    includeMemories,
    memoryLimit,
    includeRetrievalEvidence,
  } = request;

  // Resolve any file::name shorthands in entrySymbols
  let resolvedEntrySymbols = entrySymbols;
  if (entrySymbols && entrySymbols.length > 0) {
    const sliceConn = await getLadybugConn();
    resolvedEntrySymbols = await Promise.all(
      entrySymbols.map(async (id) => {
        const { symbolId: resolved } = await resolveSymbolId(sliceConn, repoId, id);
        return resolved;
      }),
    );
  }

  recordToolTrace({
    repoId,
    taskType: "slice",
    tool: "slice.build",
    symbolId: resolvedEntrySymbols?.[0],
  });

  const buildSliceWithTracing = async (): Promise<SliceBuildResponse> => {
    const requestedWireFormat: SliceBuildWireFormat = wireFormat ?? "compact";
    const effectiveWireFormatVersion =
      requestedWireFormat === "compact" ? (wireFormatVersion ?? 2) : undefined;

    const config = loadConfig();

    if (resolvedEntrySymbols && resolvedEntrySymbols.length > 0) {
      for (const symbolId of resolvedEntrySymbols) {
        consumePrefetchedKey(repoId, `slice:${symbolId}`);
      }
    }
    const conn = await getLadybugConn();

    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) {
      throw new NotFoundError(`Repository not found: ${repoId}`);
    }
    const repoConfig = safeJsonParseOrThrow(
      repo.configJson,
      ConfigObjectSchema,
      `configJson for repository ${repoId}`,
    );
    const mergedPolicy = PolicyConfigSchema.parse({
      ...config.policy,
      ...(repoConfig.policy ?? {}),
    });
    const sliceBudgetDefaults = {
      maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
      maxEstimatedTokens:
        config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
    };
    const policyEngine = new PolicyEngine();
    policyEngine.updateConfig({
      maxWindowLines: mergedPolicy.maxWindowLines,
      maxWindowTokens: mergedPolicy.maxWindowTokens,
      requireIdentifiers: mergedPolicy.requireIdentifiers,
      allowBreakGlass: mergedPolicy.allowBreakGlass,
      budgetCaps: sliceBudgetDefaults,
    });

    const policyCaps = policyEngine.getConfig().budgetCaps;
    const requestedBudget = budget ?? {};
    const effectiveBudget = {
      maxCards: clampInt(
        requestedBudget.maxCards ?? sliceBudgetDefaults.maxCards,
        1,
        policyCaps.maxCards,
      ),
      maxEstimatedTokens: clampInt(
        requestedBudget.maxEstimatedTokens ??
          sliceBudgetDefaults.maxEstimatedTokens,
        1,
        policyCaps.maxEstimatedTokens,
      ),
    };
    if (
      (requestedBudget.maxCards &&
        requestedBudget.maxCards > policyCaps.maxCards) ||
      (requestedBudget.maxEstimatedTokens &&
        requestedBudget.maxEstimatedTokens > policyCaps.maxEstimatedTokens)
    ) {
      logger.warn("Clamped slice budget to policy caps", {
        repoId,
        requestedBudget,
        effectiveBudget,
        policyCaps,
      });
    }

    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    if (!latestVersion) {
      throw new ValidationError(
        `No version found for repo ${repoId}. Please run indexing first.`,
      );
    }

    const sliceRequest = {
      repoId,
      versionId: latestVersion.versionId,
      taskText,
      stackTrace,
      failingTestPath,
      editedFiles,
      entrySymbols: resolvedEntrySymbols,
      knownCardEtags,
      cardDetail,
      budget: effectiveBudget,
      minConfidence,
      minCallConfidence:
        minCallConfidence ?? mergedPolicy.defaultMinCallConfidence,
      includeResolutionMetadata,
      signal: context?.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
        : undefined,
    };

    const policyContext: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: request.repoId,
      versionId: latestVersion.versionId,
      budget: effectiveBudget,
    };

    const policyDecision = policyEngine.evaluate(policyContext);
    const { nextBestAction, requiredFieldsForNext } =
      policyEngine.generateNextBestAction(policyDecision, policyContext);

    logPolicyDecision({
      requestType: policyContext.requestType,
      repoId: policyContext.repoId,
      decision: policyDecision.decision,
      auditHash: policyDecision.auditHash,
      evidenceUsed: policyDecision.evidenceUsed,
      deniedReasons: policyDecision.deniedReasons,
      nextBestAction,
      requiredFieldsForNext,
      context: policyContext,
    });

    if (policyDecision.decision === "deny") {
      const error = createPolicyDenial(
        `Policy denied slice request: ${policyDecision.deniedReasons?.join(", ")}`,
        nextBestAction,
        requiredFieldsForNext,
      );
      throw error;
    }

    const { slice, hybridSearchItems } = await buildSlice(sliceRequest);
    const frontierSeeds =
      resolvedEntrySymbols && resolvedEntrySymbols.length > 0
        ? resolvedEntrySymbols
        : slice.cards.slice(0, 12).map((card) => card.symbolId);
    prefetchSliceFrontier(repoId, frontierSeeds);

    const handle = generateSliceHandle();
    const sliceHash = generateSliceHash(slice);
    const lease = createLease(latestVersion.versionId);
    const sliceEtag = createSliceEtag(
      handle,
      latestVersion.versionId,
      sliceHash,
    );

    const handleRow: ladybugDb.SliceHandleRow = {
      handle,
      repoId,
      createdAt: new Date().toISOString(),
      expiresAt: lease.expiresAt,
      minVersion: lease.minVersion,
      maxVersion: lease.maxVersion,
      sliceHash: sliceHash,
      spilloverRef: null,
    };

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSliceHandle(wConn, handleRow);
    });

    // For a fresh build, staleSymbols is always empty since we just built
    // from the current version. Assign explicitly to signal feature is active.
    slice.staleSymbols = [];

    // Surface relevant memories if enabled (default: true)
    if (includeMemories !== false) {
      try {
        const sliceSymbolIds = slice.cards.map((c) => c.symbolId);
        const memories = await surfaceRelevantMemories(conn, {
          repoId,
          symbolIds: sliceSymbolIds,
          limit: memoryLimit ?? DEFAULT_MEMORY_SURFACE_LIMIT,
        });
        if (memories.length > 0) {
          slice.memories = memories;
        }
      } catch (err) {
        // Memory surfacing is non-critical — don't fail the slice build
        logger.warn("Memory surfacing failed; continuing without memories", {
          repoId,
          error: err,
        });
      }

      // Boost memory surfacing with entity retrieval when taskText is provided
      if (taskText) {
        try {
          const entityResult = await entitySearch({
            repoId,
            query: taskText,
            limit: 10,
            entityTypes: ["memory"],
            includeEvidence: false,
          });
          if (entityResult.results.length > 0) {
            const existingIds = new Set(
              (slice.memories ?? []).map((m) => m.memoryId),
            );
            const newMemoryIds = entityResult.results
              .map((r) => r.entityId)
              .filter((id) => !existingIds.has(id));
            if (newMemoryIds.length > 0) {
              const additionalMemories = await Promise.all(
                newMemoryIds.map((id) => ladybugDb.getMemory(conn, id)),
              );
              const validMemories: SurfacedMemory[] = additionalMemories
                .filter((m): m is NonNullable<typeof m> => m !== null && !m.deleted)
                .map((m) => ({
                  memoryId: m.memoryId,
                  type: m.type as SurfacedMemory["type"],
                  title: m.title,
                  content: m.content,
                  confidence: m.confidence,
                  stale: m.stale,
                  linkedSymbols: [],
                  tags: safeJsonParse(m.tagsJson, StringArraySchema, []),
                }));
              if (validMemories.length > 0) {
                slice.memories = [...(slice.memories ?? []), ...validMemories];
              }
            }
          }
        } catch (err) {
          logger.debug(
            "Entity-search memory boost failed; continuing without it",
            { repoId, error: err },
          );
        }
      }
    }

    const cardSymbolIds = slice.cards.map((c) => c.symbolId);
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, cardSymbolIds);
    const fileIds = [
      ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
    ];

    // Build per-symbol retrieval evidence when requested (before response construction)
    let evidenceItems: RetrievalEvidenceItem[] | undefined;
    if (includeRetrievalEvidence && hybridSearchItems && hybridSearchItems.length > 0) {
      evidenceItems = hybridSearchItems.map((item, index) => {
        const mapped: RetrievalEvidenceItem = {
          symbolId: item.symbolId,
          fusionRank: index + 1,
          retrievalSource: mapRetrievalSource(item.source),
        };
        // Assign score to the appropriate field based on source
        if (item.source === "fts") {
          mapped.ftsScore = item.score;
        } else if (item.source.startsWith("vector:")) {
          mapped.vectorScore = item.score;
        } else {
          // hybrid or legacy — use ftsScore as general score
          mapped.ftsScore = item.score;
        }
        return mapped;
      });
    }

    const response = {
      sliceHandle: handle,
      ledgerVersion: latestVersion.versionId,
      lease,
      sliceEtag,
      slice: serializeSliceForWireFormat(
        slice,
        requestedWireFormat,
        effectiveWireFormatVersion,
      ),
      ...(evidenceItems ? { retrievalEvidence: evidenceItems } : {}),
      ...(includeRetrievalEvidence ? { symptomType: classifySymptomType({
        stackTrace,
        failingTestPath,
        editedFiles,
        taskText,
      }) } : {}),
    };
    attachRawContext(response, { fileIds });
    return response;
  };

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = {
      repoId,
      budget: budget ?? {},
    };
    if (resolvedEntrySymbols && resolvedEntrySymbols.length > 0) {
      attrs.entrySymbolsCount = resolvedEntrySymbols.length;
    }
    return withSpan(
      SPAN_NAMES.SLICE_BUILD,
      async (span) => {
        const result = await buildSliceWithTracing();
        if ("slice" in result && result.slice) {
          const sliceData = result.slice as Record<string, unknown>;
          const cards = "c" in sliceData && Array.isArray(sliceData.c) ? sliceData.c : [];
          const edges = "e" in sliceData && Array.isArray(sliceData.e) ? sliceData.e : [];
          span.setAttributes({
            "counts.cards": cards.length,
            "counts.edges": edges.length,
            versionId: result.ledgerVersion,
          });
        }
        return result;
      },
      attrs,
    );
  }

  return buildSliceWithTracing();
}

/**
 * Handles slice refresh requests.
 * Refreshes an existing slice handle and returns delta if version changed.
 * Updates lease expiration and tracks version bounds.
 *
 * @param args - Raw arguments containing sliceHandle and knownVersion
 * @returns Slice refresh response with updated lease and delta if applicable
 * @throws {Error} If handle not found or expired
 */
export async function handleSliceRefresh(
  args: unknown,
): Promise<SliceRefreshResponse> {
  const request = args as SliceRefreshRequest;
  const { sliceHandle } = request;

  const conn = await getLadybugConn();
  const handleRow = await ladybugDb.getSliceHandle(conn, sliceHandle);
  if (handleRow) {
    recordToolTrace({
      repoId: handleRow.repoId,
      taskType: "slice",
      tool: "slice.refresh",
    });
  }
  if (!handleRow) {
    throw new NotFoundError(`Slice handle not found: ${sliceHandle}`);
  }

  // Default knownVersion to the slice handle's maxVersion when not provided
  const knownVersion = request.knownVersion ?? handleRow.maxVersion ?? handleRow.minVersion ?? "";

  const now = new Date();
  if (new Date(handleRow.expiresAt) < now) {
    const error = createPolicyDenial(
      `Slice handle expired at ${handleRow.expiresAt}. Build a new slice instead of refreshing an expired handle.`,
      "buildSlice",
      {
        buildSlice: {
          repoId: handleRow.repoId,
        },
      },
    );
    throw error;
  }

  const latestVersion = await ladybugDb.getLatestVersion(
    conn,
    handleRow.repoId,
  );
  if (!latestVersion) {
    throw new ValidationError(
      `No version found for repo ${handleRow.repoId}. Run indexing first.`,
    );
  }

  if (knownVersion === latestVersion.versionId) {
    const lease = createLease(latestVersion.versionId);
    const newHandleRow: ladybugDb.SliceHandleRow = {
      ...handleRow,
      expiresAt: lease.expiresAt,
    };
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSliceHandle(wConn, newHandleRow);
    });

    return {
      sliceHandle,
      knownVersion,
      currentVersion: latestVersion.versionId,
      notModified: true,
      delta: null,
      lease,
    };
  }

  const delta = await computeDelta(
    handleRow.repoId,
    knownVersion,
    latestVersion.versionId,
  );

  const lease = createLease(latestVersion.versionId);
  const newHandleRow: ladybugDb.SliceHandleRow = {
    ...handleRow,
    handle: sliceHandle,
    createdAt: new Date().toISOString(),
    expiresAt: lease.expiresAt,
    minVersion: knownVersion,
    maxVersion: latestVersion.versionId,
  };
  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertSliceHandle(wConn, newHandleRow);
  });

  const response = {
    sliceHandle,
    knownVersion,
    currentVersion: latestVersion.versionId,
    notModified: false,
    delta: delta as DeltaPackWithGovernance | null,
    lease,
  };

  if (delta && delta.changedSymbols.length > 0) {
    const changedIds = delta.changedSymbols.map((c) => c.symbolId);
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, changedIds);
    attachRawContext(response, {
      fileIds: [
        ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
      ],
    });
  }

  return response;
}

/**
 * Cleans up expired slice handles from the database.
 * Called periodically to remove stale handles.
 *
 * @returns Number of deleted handles
 */
export async function cleanupExpiredSliceHandles(): Promise<number> {
  const now = new Date().toISOString();
  return withWriteConn(async (wConn) => {
    return ladybugDb.deleteExpiredSliceHandles(wConn, now);
  });
}

/**
 * Handles spillover symbol retrieval requests.
 * Fetches symbols that were dropped from a slice in pages.
 * Supports pagination via cursor and optional page size.
 *
 * @param args - Raw arguments containing spilloverHandle, cursor, and pageSize
 * @returns Paged response with symbols and pagination metadata
 * @throws {Error} If spillover handle not found
 */
export async function handleSliceSpilloverGet(
  args: unknown,
): Promise<SliceSpilloverGetResponse> {
  const request = args as SliceSpilloverGetRequest;
  const { spilloverHandle, cursor, pageSize } = request;

  const conn = await getLadybugConn();
  const handleRow = await ladybugDb.getSliceHandle(conn, spilloverHandle);
  if (!handleRow) {
    throw new NotFoundError(`Spillover handle not found: ${spilloverHandle}`);
  }

  recordToolTrace({
    repoId: handleRow.repoId,
    taskType: "slice",
    tool: "slice.spillover",
  });

  if (!handleRow.spilloverRef) {
    return {
      spilloverHandle,
      cursor: undefined,
      hasMore: false,
      symbols: [],
    };
  }

  const droppedSymbols: Array<{
    symbolId: string;
    reason: string;
    priority: "must" | "should" | "optional";
  }> = safeJsonParseOrThrow(
    handleRow.spilloverRef,
    z.array(
      z.object({
        symbolId: z.string(),
        reason: z.string(),
        priority: z.enum(["must", "should", "optional"]),
      }),
    ),
    `spillover data for handle: ${spilloverHandle}`,
  );

  const startIndex = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new ValidationError(
      `Invalid cursor value: ${cursor} must be a non-negative integer`,
    );
  }
  const size = pageSize ?? SPILLOVER_DEFAULT_PAGE_SIZE;
  const endIndex = startIndex + size;

  const pageSymbols = droppedSymbols.slice(startIndex, endIndex);

  const symbolIds = pageSymbols.map((item) => item.symbolId);
  const symbolsById = await ladybugDb.getSymbolsByIds(conn, symbolIds);
  const pageFileIds = [
    ...new Set(Array.from(symbolsById.values()).map((s) => s.fileId)),
  ];
  const filesById = await ladybugDb.getFilesByIds(conn, pageFileIds);
  const metricsById = await ladybugDb.getMetricsBySymbolIds(conn, symbolIds);
  const edgesFromBySymbol = await ladybugDb.getEdgesFromSymbols(
    conn,
    symbolIds,
  );

  const allTargetIds = new Set<string>();
  for (const edges of edgesFromBySymbol.values()) {
    for (const edge of edges) {
      allTargetIds.add(edge.toSymbolId);
    }
  }
  const targetSymbolsById =
    allTargetIds.size > 0
      ? await ladybugDb.getSymbolsByIdsLite(conn, Array.from(allTargetIds))
      : new Map<string, { symbolId: string; name: string; kind: string }>();

  const spilloverFileIds: string[] = [];
  const symbols = pageSymbols
    .map((item) => {
      const symbolRow = symbolsById.get(item.symbolId);
      if (!symbolRow) return null;

      spilloverFileIds.push(symbolRow.fileId);
      const file = filesById.get(symbolRow.fileId) ?? null;
      const metrics = metricsById.get(item.symbolId) ?? null;

      const deps = {
        imports: [] as string[],
        calls: [] as string[],
      };

      const outgoingEdges = edgesFromBySymbol.get(item.symbolId) ?? [];
      for (const edge of outgoingEdges) {
        if (edge.edgeType === "import") {
          const depLabel = pickDepLabel(
            edge.toSymbolId,
            targetSymbolsById.get(edge.toSymbolId)?.name,
          );
          if (depLabel) deps.imports.push(depLabel);
        } else if (edge.edgeType === "call") {
          const depLabel = pickDepLabel(
            edge.toSymbolId,
            targetSymbolsById.get(edge.toSymbolId)?.name,
          );
          if (depLabel) deps.calls.push(depLabel);
        }
      }

      let signature: SymbolSignature = { name: symbolRow.name };
      if (symbolRow.signatureJson) {
        const parsed = safeJsonParseOptional(
          symbolRow.signatureJson,
          SignatureSchema,
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // safeJsonParseOptional returns unknown; the SignatureSchema Zod validation
          // above guarantees the shape matches SymbolSignature, so this cast is safe.
          const candidate = parsed as Partial<SymbolSignature>;
          signature = {
            ...candidate,
            name:
              typeof candidate.name === "string"
                ? candidate.name
                : symbolRow.name,
          };
        }
      }

      const invariants = safeJsonParseOptional(
        symbolRow.invariantsJson,
        StringArraySchema,
      );

      const sideEffects = safeJsonParseOptional(
        symbolRow.sideEffectsJson,
        StringArraySchema,
      );

      let metricsData;
      if (metrics) {
        const testRefs = safeJsonParseOptional(
          metrics.testRefsJson,
          StringArraySchema,
        );

        metricsData = {
          fanIn: metrics.fanIn,
          fanOut: metrics.fanOut,
          churn30d: metrics.churn30d,
          testRefs,
        };
      }

      return {
        symbolId: symbolRow.symbolId,
        repoId: symbolRow.repoId,
        file: file?.relPath ?? "",
        range: {
          startLine: symbolRow.rangeStartLine,
          startCol: symbolRow.rangeStartCol,
          endLine: symbolRow.rangeEndLine,
          endCol: symbolRow.rangeEndCol,
        },
        kind: symbolRow.kind as SymbolKind,
        name: symbolRow.name,
        exported: symbolRow.exported,
        visibility: normalizeVisibility(symbolRow.visibility),
        signature,
        summary: symbolRow.summary ?? undefined,
        invariants,
        sideEffects,
        deps,
        metrics: metricsData,
        version: {
          ledgerVersion: handleRow.maxVersion ?? "",
          astFingerprint: symbolRow.astFingerprint,
        },
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const hasMore = endIndex < droppedSymbols.length;
  const nextCursor = hasMore ? endIndex.toString() : undefined;

  const response = {
    spilloverHandle,
    cursor: nextCursor,
    hasMore,
    symbols,
  };
  attachRawContext(response, { fileIds: [...new Set(spilloverFileIds)] });
  return response;
}

/**
 * Map internal RetrievalSource discriminator to the wire-format enum
 * expected by RetrievalEvidenceItemSchema.
 */
function mapRetrievalSource(
  source: RetrievalSource,
): "fts" | "vector" | "hybrid" | "legacy" {
  if (source === "fts") return "fts";
  if (source.startsWith("vector:")) return "vector";
  if (source === "legacyFallback") return "legacy";
  // overlay or unknown → hybrid
  return "hybrid";
}
