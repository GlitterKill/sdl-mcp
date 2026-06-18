/**
 * SCIP ingestion pipeline orchestrator.
 *
 * Reads a SCIP index file, correlates its symbols and occurrences with
 * existing SDL symbols, writes enriched edges/properties to the graph DB,
 * and records ingestion metadata for idempotent re-runs.
 *
 * @module scip/ingestion
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

import type { ScipConfig } from "../config/types.js";
import { getRepo, getFileByRepoPath } from "../db/ladybug-repos.js";
import {
  mergeScipSymbolProperties,
  batchMergeScipEdges,
  batchMergeExternalSymbols,
  mergeScipIngestionRecord,
  getScipIngestionRecord,
  getSymbolsForFile,
  batchGetExistingEdges,
  batchReplaceEdgeTargets,
} from "../db/ladybug-scip.js";
import { getLatestVersion } from "../db/ladybug-versions.js";
import {
  getLadybugConn,
  withWriteConn,
} from "../db/ladybug.js";
import { withTransaction } from "../db/ladybug-core.js";
import { ScipFileNotFoundError, ScipIngestionError } from "../domain/errors.js";
import type { SymbolId } from "../domain/types.js";
import { logger } from "../util/logger.js";
import {
  getRelativePath,
  normalizePath,
  validatePathWithinRootAsync,
} from "../util/paths.js";
import { createScipDecoder, getDecoderBackend } from "./decoder-factory.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
} from "./diagnostics.js";
import {
  buildEdgesFromOccurrences,
  buildContainingSymbolMap,
  classifyEdgeAction,
} from "./edge-builder.js";
import type { ExistingEdge, ScipEdgeDescriptor } from "./edge-builder.js";
import { createExternalSymbol } from "./external-symbols.js";
import type { ExternalSymbolRow } from "./external-symbols.js";
import { isExternalSymbol } from "./kind-mapping.js";
import { buildSymbolMatchMap, SCIP_ROLE_DEFINITION } from "./symbol-matcher.js";
import type {
  ScipDecoder,
  ScipFileCoverage,
  ScipIngestRequest,
  ScipIngestResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Progress event types — surfaced to callers (CLI progress bars, MCP logs)
// ---------------------------------------------------------------------------

/**
 * Fine-grained progress event emitted from the ingestion pipeline for a
 * single SCIP index. The `externals` phase has a known total (all external
 * symbols are pre-fetched), so it can drive a true percentage bar; the
 * `documents` phase is streamed from an async iterator with no upfront
 * total, so it is reported as a counter snapshot.
 */
export type ScipIngestProgressEvent =
  | { phase: "externals"; current: number; total: number }
  | {
      phase: "documents";
      current: number;
      matched: number;
      edges: number;
    };

/** Legacy progress envelope retained for compatibility with older callers. */
export interface AutoIngestProgressEvent {
  indexLabel: string;
  event: ScipIngestProgressEvent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stream-hash a file with SHA-256 and return the hex digest. */
async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Zero-valued counters for short-circuit returns. */
function zeroCounts(): Omit<
  ScipIngestResponse,
  "status" | "decoderBackend" | "durationMs"
> {
  return {
    documentsProcessed: 0,
    documentsSkipped: 0,
    symbolsMatched: 0,
    externalSymbolsCreated: 0,
    edgesCreated: 0,
    edgesUpgraded: 0,
    edgesReplaced: 0,
    unresolvedOccurrences: 0,
    skippedSymbols: 0,
    truncated: false,
    perFileCoverage: [],
  };
}

function normalizeLanguageFilter(languages?: string[]): Set<string> | null {
  if (!languages || languages.length === 0) return null;
  return new Set(
    languages.map((language) => language.trim()).filter(Boolean).sort(),
  );
}

function scopedIngestionRecordPath(
  normalizedIndexPath: string,
  languageFilter: ReadonlySet<string> | null,
): string {
  if (!languageFilter || languageFilter.size === 0) {
    return normalizedIndexPath;
  }
  return `${normalizedIndexPath}#languages=${[...languageFilter].join(",")}`;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Ingest a SCIP index into the SDL graph database.
 *
 * The pipeline:
 *   1. Validate inputs and resolve file path
 *   2. Check for redundant ingestion (content-hash dedup)
 *   3. Initialize decoder (Rust or TS fallback)
 *   4. Ingest external symbols (if enabled)
 *   5. Iterate documents: match symbols, build edges, write to DB
 *   6. Write ingestion metadata
 *   7. Close decoder and return response
 *
 * When `request.dryRun` is true, all DB writes are skipped but counters
 * are still computed.
 */
export async function ingestScipIndex(
  request: ScipIngestRequest,
  config: ScipConfig,
  onProgress?: (event: ScipIngestProgressEvent) => void,
): Promise<ScipIngestResponse> {
  const startMs = Date.now();
  const dryRun = request.dryRun === true;
  const force = request.force === true;
  const languageFilter = normalizeLanguageFilter(request.languages);

  // -----------------------------------------------------------------------
  // Step 1: Validate inputs
  // -----------------------------------------------------------------------
  const conn = await getLadybugConn();
  const repo = await getRepo(conn, request.repoId);
  if (!repo) {
    throw new ScipIngestionError(
      `Repository "${request.repoId}" not found. Register it first.`,
    );
  }

  const repoRoot = normalizePath(repo.rootPath);

  // Resolve index path — may be relative to repo root or absolute
  const rawIndexPath = normalizePath(request.indexPath);
  const absoluteIndexPath = isAbsolute(rawIndexPath)
    ? rawIndexPath
    : resolve(repoRoot, rawIndexPath);

  // Path traversal check: resolved path must be within repo root
  await validatePathWithinRootAsync(repoRoot, absoluteIndexPath);

  // Check the file exists and is readable
  try {
    await access(absoluteIndexPath);
  } catch {
    throw new ScipFileNotFoundError(
      `SCIP index file not found or not readable: ${absoluteIndexPath}`,
    );
  }

  // Compute the relative index path for storage (forward-slash normalized)
  const normalizedIndexPath = normalizePath(
    getRelativePath(repoRoot, absoluteIndexPath),
  );

  // -----------------------------------------------------------------------
  // Step 2: Check for redundant ingestion
  // -----------------------------------------------------------------------
  const decoderBackend = await getDecoderBackend();
  const contentHash = await hashFile(absoluteIndexPath);
  const ingestionRecordPath = scopedIngestionRecordPath(
    normalizedIndexPath,
    languageFilter,
  );
  const existingRecord = await getScipIngestionRecord(
    conn,
    request.repoId,
    ingestionRecordPath,
  );

  if (
    existingRecord &&
    existingRecord.contentHash === contentHash &&
    !dryRun &&
    !force
  ) {
    logger.info("SCIP index already ingested (content hash match)", {
      repoId: request.repoId,
      indexPath: ingestionRecordPath,
      contentHash,
    });
    return {
      status: "alreadyIngested",
      decoderBackend,
      durationMs: Date.now() - startMs,
      ...zeroCounts(),
    };
  }

  // -----------------------------------------------------------------------
  // Step 3: Initialize decoder
  // -----------------------------------------------------------------------
  let decoder: ScipDecoder | null = null;
  try {
    decoder = await createScipDecoder(absoluteIndexPath);
    const metadata = await decoder.metadata();
    logger.info("SCIP index opened", {
      decoderBackend,
      version: metadata.version,
      tool: `${metadata.toolName}@${metadata.toolVersion}`,
      projectRoot: metadata.projectRoot,
    });

    // -------------------------------------------------------------------
    // Step 4: Ingest external symbols
    // -------------------------------------------------------------------
    const scipSymbolToId = new Map<string, SymbolId>();
    let externalSymbolsCreated = 0;
    let truncatedExternals = false;

    if (config.externalSymbols.enabled) {
      const maxExternals = config.externalSymbols.maxPerIndex;
      const allExternals = await decoder.externalSymbols();
      const externalBatch: Array<ExternalSymbolRow & { updatedAt: string }> =
        [];

      // Initial progress tick so callers can render a bar from 0% immediately
      // after the externals list is loaded.
      onProgress?.({
        phase: "externals",
        current: 0,
        total: allExternals.length,
      });

      // Throttle progress emission to avoid flooding callers on large indexes.
      // We emit every ~2% of externals processed (minimum every 25 items).
      const externalsTickEvery = Math.max(
        25,
        Math.floor(allExternals.length / 50),
      );
      let externalsSinceLastTick = 0;

      for (let i = 0; i < allExternals.length; i++) {
        const ext = allExternals[i];

        if (externalBatch.length >= maxExternals) {
          truncatedExternals = true;
          logger.warn("External symbol cap reached", {
            maxPerIndex: maxExternals,
            total: allExternals.length,
          });
          break;
        }

        const row = createExternalSymbol(ext.symbol, ext, request.repoId);
        if (row === null) {
          // Unmappable kind — skip
          externalsSinceLastTick++;
          if (externalsSinceLastTick >= externalsTickEvery) {
            onProgress?.({
              phase: "externals",
              current: i + 1,
              total: allExternals.length,
            });
            externalsSinceLastTick = 0;
          }
          continue;
        }

        scipSymbolToId.set(ext.symbol, row.symbolId);
        externalBatch.push({
          ...row,
          updatedAt: new Date().toISOString(),
        });

        externalsSinceLastTick++;
        if (externalsSinceLastTick >= externalsTickEvery) {
          onProgress?.({
            phase: "externals",
            current: i + 1,
            total: allExternals.length,
          });
          externalsSinceLastTick = 0;
        }
      }

      // Final tick at 100% so the bar reaches the end before the documents
      // phase begins.
      onProgress?.({
        phase: "externals",
        current: allExternals.length,
        total: allExternals.length,
      });

      if (externalBatch.length > 0 && !dryRun) {
        await withWriteConn(async (wConn) => {
          await batchMergeExternalSymbols(wConn, request.repoId, externalBatch);
        });
      }
      externalSymbolsCreated = externalBatch.length;

      logger.info("External symbols processed", {
        created: externalSymbolsCreated,
        truncated: truncatedExternals,
      });
    }

    // -------------------------------------------------------------------
    // Step 5: Iterate documents
    // -------------------------------------------------------------------
    let documentsProcessed = 0;
    let documentsSkipped = 0;
    let symbolsMatched = 0;
    let skippedSymbols = 0;
    let edgesCreated = 0;
    let edgesUpgraded = 0;
    let edgesReplaced = 0;
    let unresolvedOccurrences = 0;
    // Per-document coverage for the pass-2 file-skip optimisation. Each entry
    // captures total / matched / unresolved CALLABLE REFERENCE occurrences
    // (definitions excluded — pass-2 only resolves calls and imports). The
    // pass-2 dispatcher reads this set later to skip files SCIP fully covered.
    const perFileCoverage: ScipFileCoverage[] = [];

    // Fire an initial zero-progress tick so the CLI can render the documents
    // phase indicator immediately, even before the first document arrives
    // from the streaming decoder.
    onProgress?.({
      phase: "documents",
      current: 0,
      matched: 0,
      edges: 0,
    });

    for await (const doc of decoder.documents()) {
      const relPath = normalizePath(doc.relativePath);
      if (languageFilter && !languageFilter.has(doc.language)) {
        documentsSkipped++;
        continue;
      }

      // Check if SDL has indexed this file
      const fileRow = await getFileByRepoPath(conn, request.repoId, relPath);
      if (!fileRow) {
        documentsSkipped++;
        continue;
      }

      documentsProcessed++;

      // Load existing SDL symbols for this file
      const sdlSymbols = await getSymbolsForFile(conn, request.repoId, relPath);

      // Build match map: SCIP symbol -> SDL symbol
      const { matches: matchMap, skippedCount } = buildSymbolMatchMap(
        doc,
        sdlSymbols,
      );
      skippedSymbols += skippedCount;

      // Process matched/created symbols
      for (const [, match] of Array.from(matchMap.entries())) {
        if (match.matchType === "exact" || match.matchType === "nameOnly") {
          symbolsMatched++;
          if (!dryRun) {
            await withWriteConn(async (wConn) => {
              await mergeScipSymbolProperties(wConn, match.sdlSymbolId, {
                scipSymbol: match.scipSymbol,
                source: "both",
              });
            });
          }
        }

        // Register in the combined symbol map for edge resolution
        scipSymbolToId.set(match.scipSymbol, match.sdlSymbolId);
      }

      // Build containing-symbol map for reference occurrences
      const containingMap = buildContainingSymbolMap(
        doc.occurrences,
        sdlSymbols,
      );

      // Merge match map with external symbol map for edge resolution
      const allMatchMap = new Map(matchMap);
      for (const [scipSym, sdlId] of Array.from(scipSymbolToId.entries())) {
        if (!allMatchMap.has(scipSym)) {
          allMatchMap.set(scipSym, {
            scipSymbol: scipSym,
            sdlSymbolId: sdlId,
            matchType: "external",
            kindMismatch: false,
          });
        }
      }

      // Build edges from reference occurrences
      const rawEdges = buildEdgesFromOccurrences(
        doc,
        allMatchMap,
        containingMap,
        config.confidence,
      );

      // Batch-fetch existing edges for all (source, target) pairs
      const edgePairs = rawEdges.map((e) => ({
        sourceId: e.sourceSymbolId,
        targetId: e.targetSymbolId,
      }));
      const existingEdgesMap = await batchGetExistingEdges(conn, edgePairs);

      // Classify and apply each edge action
      const edgeBatchCreate: typeof rawEdges = [];
      const edgeBatchReplace: Array<{
        sourceId: string;
        oldTargetId: string;
        newTargetId: string;
        edgeType: string;
        confidence: number;
        resolution: string;
        resolverId: string;
        resolutionPhase: string;
      }> = [];

      for (const edge of rawEdges) {
        const key = `${edge.sourceSymbolId}:${edge.targetSymbolId}:${edge.edgeType}`;
        const existingRaw = existingEdgesMap.get(key) ?? null;

        // Construct ExistingEdge with source/target for classifyEdgeAction
        const existingEdge: ExistingEdge | null = existingRaw
          ? {
              sourceSymbolId: edge.sourceSymbolId,
              targetSymbolId: edge.targetSymbolId,
              edgeType: existingRaw.edgeType as ScipEdgeDescriptor["edgeType"],
              confidence: existingRaw.confidence,
              resolution: existingRaw.resolution,
              resolverId: existingRaw.resolverId,
            }
          : null;

        const action = classifyEdgeAction(existingEdge, edge);

        if (!dryRun) {
          switch (action) {
            case "create":
              edgeBatchCreate.push(edge);
              edgesCreated++;
              break;
            case "upgrade":
              edgeBatchCreate.push(edge);
              edgesUpgraded++;
              break;
            case "replace":
              if (existingEdge) {
                edgeBatchReplace.push({
                  sourceId: edge.sourceSymbolId,
                  oldTargetId: existingEdge.targetSymbolId,
                  newTargetId: edge.targetSymbolId,
                  edgeType: edge.edgeType,
                  confidence: edge.confidence,
                  resolution: edge.resolution,
                  resolverId: edge.resolverId,
                  resolutionPhase: edge.resolutionPhase,
                });
              }
              edgesReplaced++;
              break;
            case "skip":
              // No action needed
              break;
          }
        } else {
          // Dry run — just count
          switch (action) {
            case "create":
              edgesCreated++;
              break;
            case "upgrade":
              edgesUpgraded++;
              break;
            case "replace":
              edgesReplaced++;
              break;
            case "skip":
              break;
          }
        }
      }

      // Batch write created/upgraded/replaced edges in one transaction per
      // document so a partially failed update cannot leave the edge set in
      // a mixed state.
      if (
        !dryRun &&
        (edgeBatchCreate.length > 0 || edgeBatchReplace.length > 0)
      ) {
        await withWriteConn(async (wConn) => {
          await withTransaction(wConn, async (txConn) => {
            if (edgeBatchCreate.length > 0) {
              await batchMergeScipEdges(txConn, edgeBatchCreate);
            }

            if (edgeBatchReplace.length > 0) {
              await batchReplaceEdgeTargets(txConn, edgeBatchReplace);
            }
          });
        });
      }

      // Track unresolved from this document. We count distinct symbols per
      // document for `unresolvedOccurrences` (so a single unresolved function
      // with N call sites contributes 1 rather than N — preserves prior
      // operator-facing semantics) BUT also produce a per-document coverage
      // row that counts CALLABLE REFERENCE OCCURRENCES (per-occurrence, not
      // per-unique-symbol). The latter feeds the pass-2 file-skip optimisation
      // — pass-2 resolves per call site, so its skip predicate must reason
      // per occurrence. Definitions are excluded since they are not "calls
      // to resolve"; empty / local-prefixed symbols are excluded since they
      // never produce cross-file edges.
      const matchedScipSymbols = new Set(scipSymbolToId.keys());
      const unresolvedInDoc = new Set<string>();
      let docTotalRefs = 0;
      let docMatchedRefs = 0;
      let docUnresolvedRefs = 0;
      for (const occ of doc.occurrences) {
        if (occ.symbolRoles & SCIP_ROLE_DEFINITION) continue;
        if (occ.symbol === "" || occ.symbol.startsWith("local ")) continue;
        docTotalRefs++;
        if (
          matchedScipSymbols.has(occ.symbol) ||
          isExternalSymbol(occ.symbol, metadata.projectRoot)
        ) {
          docMatchedRefs++;
        } else {
          docUnresolvedRefs++;
          unresolvedInDoc.add(occ.symbol);
        }
      }
      unresolvedOccurrences += unresolvedInDoc.size;
      perFileCoverage.push({
        relPath,
        total: docTotalRefs,
        matched: docMatchedRefs,
        unresolved: docUnresolvedRefs,
      });

      // Log + emit progress every 50 documents. We don't know the total
      // upfront with the streaming decoder, so progress is reported as a
      // counter snapshot (current + running totals) rather than a percentage.
      if (documentsProcessed % 50 === 0) {
        logger.info("SCIP ingestion progress", {
          documentsProcessed,
          documentsSkipped,
          symbolsMatched,
          edgesCreated,
        });
        onProgress?.({
          phase: "documents",
          current: documentsProcessed,
          matched: symbolsMatched,
          edges: edgesCreated,
        });
      }

      // Do not run manual CHECKPOINT here. On LadybugDB 0.16.0 / Windows,
      // a checkpoint can leave a native checkpoint task active while SCIP
      // continues issuing read/write work, which can terminate the process
      // with 0xC0000005. Startup and shutdown still perform best-effort WAL
      // cleanup; SCIP's document loop must stay free of manual checkpoints.
    }

    // Final tick after the last document so CLI renderers land on a clean
    // end-state before the response is returned.
    onProgress?.({
      phase: "documents",
      current: documentsProcessed,
      matched: symbolsMatched,
      edges: edgesCreated,
    });

    // -------------------------------------------------------------------
    // Step 6: Write ingestion metadata
    // -------------------------------------------------------------------
    if (!dryRun) {
      const versionRow = await getLatestVersion(conn, request.repoId);
      const ledgerVersion = versionRow ? versionRow.versionId : "unknown";

      const ingestionId = createHash("sha256")
        .update(`${request.repoId}:${ingestionRecordPath}`)
        .digest("hex");

      await withWriteConn(async (wConn) => {
        await mergeScipIngestionRecord(wConn, {
          id: ingestionId,
          repoId: request.repoId,
          indexPath: ingestionRecordPath,
          contentHash,
          ingestedAt: new Date().toISOString(),
          ledgerVersion,
          symbolCount: symbolsMatched,
          edgeCount: edgesCreated + edgesUpgraded + edgesReplaced,
          externalSymbolCount: externalSymbolsCreated,
          truncated: truncatedExternals,
        });
      });
    }

    // -------------------------------------------------------------------
    // Step 7: Return response
    // -------------------------------------------------------------------
    const durationMs = Date.now() - startMs;
    const status = dryRun ? ("dryRun" as const) : ("ingested" as const);

    logger.info("SCIP ingestion complete", {
      status,
      durationMs,
      documentsProcessed,
      documentsSkipped,
      symbolsMatched,
      externalSymbolsCreated,
      edgesCreated,
      edgesUpgraded,
      edgesReplaced,
      unresolvedOccurrences,
    });

    return {
      status,
      decoderBackend,
      documentsProcessed,
      documentsSkipped,
      symbolsMatched,
      externalSymbolsCreated,
      edgesCreated,
      edgesUpgraded,
      edgesReplaced,
      unresolvedOccurrences,
      skippedSymbols,
      truncated: truncatedExternals,
      durationMs,
      perFileCoverage,
    };
  } catch (err) {
    // Re-throw known error types
    if (
      err instanceof ScipFileNotFoundError ||
      err instanceof ScipIngestionError
    ) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new ScipIngestionError(
      `SCIP ingestion failed for "${request.indexPath}": ${message}`,
    );
  } finally {
    // finally runs on both success and error paths, so this is the single
    // authoritative close site for the decoder.
    if (decoder) {
      try {
        decoder.close();
      } catch {
        // Best-effort close
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deprecated auto-ingest compatibility hook
// ---------------------------------------------------------------------------

/**
 * Deprecated no-op compatibility hook for the old index-refresh SCIP overlay.
 * Provider-first indexing owns SCIP/LSP provider facts; legacy indexing and
 * same-run fallback parse source files only.
 */
export async function autoIngestScipIndexes(
  repoId: string,
  config: ScipConfig,
  _repoRootPath: string,
  _onProgress?: (event: AutoIngestProgressEvent) => void,
  _onFailure?: (failure: ScipFailureDiagnostic) => void,
): Promise<ScipIngestResponse[]> {
  logger.debug("Legacy SCIP auto-ingest compatibility hook skipped", {
    repoId,
    enabled: config.enabled,
    autoIngestOnRefresh: config.autoIngestOnRefresh,
    indexCount: config.indexes.length,
  });
  return [];
}

/**
 * Deprecated compatibility predicate for the removed legacy SCIP overlay.
 */
export function scipIngestWillRun(_config: { scip?: ScipConfig }): boolean {
  // Provider-first is the only path that may consume SCIP/LSP provider facts.
  // Legacy indexing and provider-first fallback must never overlay `.scip`
  // edges, even when compatibility config fields are still present.
  return false;
}

/**
 * Build the empty compatibility result for the removed index-refresh overlay.
 */
function buildEmptyInsideIndexResult(params: {
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
}): ScipIngestInsideIndexResult {
  return {
    results: [],
    fullyCoveredPaths: new Set(),
    generatedIndexes: [...(params.generatedIndexes ?? [])],
    failures: [...(params.generatorFailures ?? [])],
  };
}

function shouldLogDeprecatedInsideIndexSkip(config: {
  scip?: ScipConfig;
}): boolean {
  const scip = config.scip;
  if (!scip?.enabled) return false;
  if (!scip.autoIngestOnRefresh) return false;
  return (scip.indexes?.length ?? 0) > 0;
}

function getConfiguredScipIndexCount(config: { scip?: ScipConfig }): number {
  return config.scip?.indexes?.length ?? 0;
}

function getConfiguredGeneratedIndexCount(params: {
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
}): number {
  return params.generatedIndexes?.length ?? 0;
}

function getConfiguredFailureCount(params: {
  generatorFailures?: readonly ScipFailureDiagnostic[];
}): number {
  return params.generatorFailures?.length ?? 0;
}

function hasScipAutoIngestCompatibilityInput(params: {
  config: { scip?: ScipConfig };
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  onProgress?: (progress: {
    stage: "scipIngest";
    current: number;
    total: number;
    currentFile?: string;
    message?: string;
  }) => void;
}): boolean {
  if (shouldLogDeprecatedInsideIndexSkip(params.config)) return true;
  if (getConfiguredGeneratedIndexCount(params) > 0) return true;
  if (getConfiguredFailureCount(params) > 0) return true;
  return params.onProgress !== undefined;
}

/**
 * Deprecated compatibility result shape for the removed legacy overlay.
 */
export interface ScipIngestInsideIndexResult {
  results: ScipIngestResponse[];
  fullyCoveredPaths: ReadonlySet<string>;
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
}

export async function runScipIngestInsideIndex(params: {
  repoId: string;
  repoRoot: string;
  config: { scip?: ScipConfig };
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  onProgress?: (progress: {
    stage: "scipIngest";
    current: number;
    total: number;
    currentFile?: string;
    message?: string;
  }) => void;
}): Promise<ScipIngestInsideIndexResult> {
  if (hasScipAutoIngestCompatibilityInput(params)) {
    logger.debug(
      "Legacy SCIP ingest inside index skipped; provider-first owns SCIP/LSP facts",
      {
        repoId: params.repoId,
        repoRoot: params.repoRoot,
        enabled: params.config.scip?.enabled,
        autoIngestOnRefresh: params.config.scip?.autoIngestOnRefresh,
        indexCount: getConfiguredScipIndexCount(params.config),
        generatedIndexCount: getConfiguredGeneratedIndexCount(params),
        generatorFailureCount: getConfiguredFailureCount(params),
        hasProgressHandler: params.onProgress !== undefined,
      },
    );
  }
  return buildEmptyInsideIndexResult(params);
}
