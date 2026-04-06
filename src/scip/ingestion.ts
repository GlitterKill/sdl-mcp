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
import { access, stat } from "node:fs/promises";
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
  replaceEdgeTarget,
} from "../db/ladybug-scip.js";
import { getLatestVersion } from "../db/ladybug-versions.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import { ScipFileNotFoundError, ScipIngestionError } from "../domain/errors.js";
import type { SymbolId } from "../domain/types.js";
import { logger } from "../util/logger.js";
import {
  getRelativePath,
  normalizePath,
  validatePathWithinRootAsync,
} from "../util/paths.js";
import { createScipDecoder, getDecoderBackend } from "./decoder-factory.js";
import {
  buildEdgesFromOccurrences,
  buildContainingSymbolMap,
  classifyEdgeAction,
} from "./edge-builder.js";
import type { ExistingEdge, ScipEdgeDescriptor } from "./edge-builder.js";
import { createExternalSymbol } from "./external-symbols.js";
import type { ExternalSymbolRow } from "./external-symbols.js";
import { isExternalSymbol } from "./kind-mapping.js";
import { buildSymbolMatchMap } from "./symbol-matcher.js";
import type {
  ScipDecoder,
  ScipIngestRequest,
  ScipIngestResponse,
} from "./types.js";

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
  };
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
): Promise<ScipIngestResponse> {
  const startMs = Date.now();
  const dryRun = request.dryRun === true;

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
  const existingRecord = await getScipIngestionRecord(
    conn,
    request.repoId,
    normalizedIndexPath,
  );

  if (existingRecord && existingRecord.contentHash === contentHash && !dryRun) {
    logger.info("SCIP index already ingested (content hash match)", {
      repoId: request.repoId,
      indexPath: normalizedIndexPath,
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

      for (const ext of allExternals) {
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
          continue;
        }

        scipSymbolToId.set(ext.symbol, row.symbolId);
        externalBatch.push({
          ...row,
          updatedAt: new Date().toISOString(),
        });
      }

      if (externalBatch.length > 0 && !dryRun) {
        await withWriteConn(async (wConn) => {
          await batchMergeExternalSymbols(wConn, externalBatch);
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

    for await (const doc of decoder.documents()) {
      const relPath = normalizePath(doc.relativePath);

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

      for (const edge of rawEdges) {
        const key = `${edge.sourceSymbolId}:${edge.targetSymbolId}`;
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
                await withWriteConn(async (wConn) => {
                  await replaceEdgeTarget(
                    wConn,
                    edge.sourceSymbolId,
                    existingEdge.targetSymbolId,
                    edge.targetSymbolId,
                    edge.edgeType,
                    edge.confidence,
                    edge.resolution,
                    edge.resolverId,
                    edge.resolutionPhase,
                  );
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

      // Batch write created/upgraded edges
      if (edgeBatchCreate.length > 0 && !dryRun) {
        await withWriteConn(async (wConn) => {
          await batchMergeScipEdges(wConn, edgeBatchCreate);
        });
      }

      // Track unresolved from this document (occurrences that had no match)
      const matchedScipSymbols = new Set(scipSymbolToId.keys());
      for (const occ of doc.occurrences) {
        if (occ.symbol === "" || occ.symbol.startsWith("local ")) continue;
        if (
          !matchedScipSymbols.has(occ.symbol) &&
          !isExternalSymbol(occ.symbol, metadata.projectRoot)
        ) {
          unresolvedOccurrences++;
        }
      }

      // Log progress milestones (we don't know total upfront with async gen,
      // so log every 50 documents)
      if (documentsProcessed % 50 === 0) {
        logger.info("SCIP ingestion progress", {
          documentsProcessed,
          documentsSkipped,
          symbolsMatched,
          edgesCreated,
        });
      }
    }

    // -------------------------------------------------------------------
    // Step 6: Write ingestion metadata
    // -------------------------------------------------------------------
    if (!dryRun) {
      const versionRow = await getLatestVersion(conn, request.repoId);
      const ledgerVersion = versionRow ? versionRow.versionId : "unknown";

      const ingestionId = createHash("sha256")
        .update(`${request.repoId}:${normalizedIndexPath}`)
        .digest("hex");

      await withWriteConn(async (wConn) => {
        await mergeScipIngestionRecord(wConn, {
          id: ingestionId,
          repoId: request.repoId,
          indexPath: normalizedIndexPath,
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
// Auto-ingest hook (called from index.refresh)
// ---------------------------------------------------------------------------

/**
 * Auto-ingest SCIP indexes that are newer than the last ingestion.
 *
 * Called during `sdl.index.refresh` when `config.autoIngestOnRefresh` is true.
 * For each configured index entry, checks if the file exists and whether
 * it has been modified since the last ingestion. If so, triggers a full
 * ingest.
 */
export async function autoIngestScipIndexes(
  repoId: string,
  config: ScipConfig,
  repoRootPath: string,
): Promise<ScipIngestResponse[]> {
  if (!config.enabled || !config.autoIngestOnRefresh) {
    return [];
  }

  if (config.indexes.length === 0) {
    return [];
  }

  const results: ScipIngestResponse[] = [];
  const conn = await getLadybugConn();
  const normalizedRoot = normalizePath(repoRootPath);

  for (const entry of config.indexes) {
    const indexPath = normalizePath(entry.path);
    const absolutePath = isAbsolute(indexPath)
      ? indexPath
      : resolve(normalizedRoot, indexPath);

    // Check file exists
    try {
      await access(absolutePath);
    } catch {
      logger.debug("SCIP index file not found for auto-ingest, skipping", {
        path: absolutePath,
        label: entry.label,
      });
      continue;
    }

    // Compute relative path for record lookup
    const relIndexPath = normalizePath(
      absolutePath.startsWith(normalizedRoot)
        ? absolutePath.slice(normalizedRoot.length).replace(/^\//, "")
        : entry.path,
    );

    // Check mtime against last ingestion
    const existingRecord = await getScipIngestionRecord(
      conn,
      repoId,
      relIndexPath,
    );

    if (existingRecord) {
      try {
        const fileStat = await stat(absolutePath);
        const ingestedAt = new Date(existingRecord.ingestedAt);
        if (fileStat.mtime <= ingestedAt) {
          logger.debug("SCIP index not modified since last ingest, skipping", {
            path: relIndexPath,
            ingestedAt: existingRecord.ingestedAt,
            mtime: fileStat.mtime.toISOString(),
          });
          continue;
        }
      } catch {
        // If stat fails, fall through to re-ingest
      }
    }

    // Ingest
    try {
      logger.info("Auto-ingesting SCIP index", {
        repoId,
        path: relIndexPath,
        label: entry.label,
      });
      const result = await ingestScipIndex(
        { repoId, indexPath: entry.path },
        config,
      );
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Auto-ingest of SCIP index failed", {
        repoId,
        path: relIndexPath,
        error: message,
      });
      // Continue with next index — don't fail the entire refresh
    }
  }

  return results;
}
