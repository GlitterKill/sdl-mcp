import { DeltaGetRequestSchema, type DeltaGetResponse } from "../tools.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { truncateArray } from "../../util/truncation.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import {
  getSliceHandle,
  updateSliceHandleSpillover,
} from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  DEFAULT_MAX_CARDS,
} from "../../config/constants.js";
import {
  prefetchDeltaBlastRadius,
  consumePrefetchedKey,
} from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";
import { attachRawContext } from "../token-usage.js";
import { IndexError } from "../errors.js";

/** Default max changed symbols for delta responses (tighter than slice default). */
const DEFAULT_DELTA_MAX_CARDS = 10;
/** Default max tokens for delta responses (tighter than slice default). */
const DEFAULT_DELTA_MAX_TOKENS = 4000;
/** Hard cap on blast-radius items returned to the caller. */
const MAX_BLAST_RADIUS_ITEMS = 25;

/**
 * Handles delta pack requests.
 * Computes and returns changes between two ledger versions with blast radius analysis.
 * Supports truncation for large delta sets and spillover handling.
 *
 * @param args - Raw arguments containing repoId, fromVersion, toVersion, and optional budget
 * @returns Delta pack response with changed symbols and blast radius
 * @throws {Error} If delta computation fails
 */
export async function handleDeltaGet(args: unknown): Promise<DeltaGetResponse> {
  const validated = DeltaGetRequestSchema.parse(args);

  recordToolTrace({
    repoId: validated.repoId,
    taskType: "delta",
    tool: "delta.get",
  });

  const executeDelta = async () => {
    // Resolve version defaults when not provided
    const resolveConn = await getLadybugConn();
    let toVersion = validated.toVersion;
    let fromVersion = validated.fromVersion;
    if (!toVersion) {
      const latest = await ladybugDb.getLatestVersion(resolveConn, validated.repoId);
      if (!latest) {
        throw new IndexError("No versions found. Run indexing first.");
      }
      toVersion = latest.versionId;
    }
    if (!fromVersion) {
      const versions = await ladybugDb.getVersionsByRepo(resolveConn, validated.repoId, 2);
      fromVersion = versions.length >= 2 ? versions[1].versionId : toVersion;
    }

    
    const singleVersionHint = fromVersion === toVersion
      ? "Only one ledger version exists — delta is empty. Run index.refresh after making changes to create a new version."
      : undefined;
    let delta;
    try {
      delta = await computeDelta(
        validated.repoId,
        fromVersion,
        toVersion,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to compute delta pack.";
      throw new IndexError(`Delta pack error: ${message}`);
    }

    const changedSymbolIds = delta.changedSymbols.map(
      (change) => change.symbolId,
    );

    // Consume prefetched blast-radius keys
    for (const symbolId of changedSymbolIds) {
      consumePrefetchedKey(validated.repoId, `blast:${symbolId}`);
    }

    prefetchDeltaBlastRadius(validated.repoId, changedSymbolIds);

    const config = loadConfig();
    const rawBudget = validated.budget ?? {
      maxCards: DEFAULT_DELTA_MAX_CARDS,
      maxEstimatedTokens:
        config.slice?.defaultMaxTokens ?? DEFAULT_DELTA_MAX_TOKENS,
    };

    // Hard cap to prevent unbounded responses
    const budget = {
      ...rawBudget,
      maxCards: Math.min(rawBudget.maxCards ?? DEFAULT_MAX_CARDS, 100),
      maxEstimatedTokens: Math.min(rawBudget.maxEstimatedTokens ?? DEFAULT_DELTA_MAX_TOKENS, 20000),
    };
    const governorOptions = {
      repoId: validated.repoId,
      budget,
      runDiagnostics: true,
      diagnosticsTimeoutMs: 5000,
      fromVersionId: fromVersion,
      toVersionId: toVersion,
    };

    const conn = await getLadybugConn();
    const governorResult = await runGovernorLoop(
      conn,
      changedSymbolIds,
      governorOptions,
    );

    delta.blastRadius = governorResult.blastRadius;
    delta.trimmedSet = governorResult.trimmedSet;

    if (governorResult.spilloverHandle) {
      const spilloverHandle = governorResult.spilloverHandle;
      delta.spilloverHandle = spilloverHandle;

      await withWriteConn(async (wConn) => {
        // Ensure the handle exists so slice.spillover.get can retrieve it
        const handleRow = await getSliceHandle(conn, spilloverHandle);
        if (!handleRow) {
          await ladybugDb.upsertSliceHandle(wConn, {
            handle: spilloverHandle,
            repoId: validated.repoId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            minVersion: null,
            maxVersion: validated.toVersion ?? null,
            sliceHash: spilloverHandle,
            spilloverRef: null,
          });
        }
        await updateSliceHandleSpillover(
          wConn,
          spilloverHandle,
          JSON.stringify(governorResult.trimmedSet.droppedSymbols),
        );
      })
    }

    const maxChanges = DEFAULT_DELTA_MAX_CARDS;
    const maxBlastRadius = MAX_BLAST_RADIUS_ITEMS;

    const changedSymbolsTruncation = truncateArray(delta.changedSymbols, {
      maxItems: maxChanges,
    });

    const blastRadiusTruncation = truncateArray(delta.blastRadius, {
      maxItems: maxBlastRadius,
    });

    if (changedSymbolsTruncation.truncated) {
      delta.changedSymbols = changedSymbolsTruncation.items;
    }

    if (blastRadiusTruncation.truncated) {
      delta.blastRadius = blastRadiusTruncation.items;
    }

    delta.blastRadius = delta.blastRadius.map(
      ({ reason: _reason, ...rest }) =>
        rest as (typeof delta.blastRadius)[number],
    );

    if (changedSymbolsTruncation.truncated || blastRadiusTruncation.truncated) {
      delta.truncation = {
        truncated: true,
        droppedChanges: changedSymbolsTruncation.droppedCount,
        droppedBlastRadius: blastRadiusTruncation.droppedCount,
        howToResume:
          changedSymbolsTruncation.howToResume ??
          blastRadiusTruncation.howToResume ??
          null,
      };
    }

    // Collect all symbol IDs for enrichment (changed + blast radius)
    const blastRadiusSymbolIds = delta.blastRadius.map((item) => item.symbolId);
    const allSymbolIds = [
      ...new Set([...changedSymbolIds, ...blastRadiusSymbolIds]),
    ];

    const symbolMap = await ladybugDb.getSymbolsByIds(conn, allSymbolIds);

    // Build fileId-to-relPath map for enrichment
    const allFileIds = [
      ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
    ];
    const fileMap = await ladybugDb.getFilesByIds(conn, allFileIds);

    // Enrich changedSymbols with human-readable fields
    delta.changedSymbols = delta.changedSymbols.map((change) => {
      const sym = symbolMap.get(change.symbolId);
      if (!sym) return change;
      const file = fileMap.get(sym.fileId);
      return {
        ...change,
        name: sym.name,
        kind: sym.kind,
        file: file?.relPath ?? undefined,
      };
    });

    // Enrich blastRadius with human-readable fields
    delta.blastRadius = delta.blastRadius.map((item) => {
      const sym = symbolMap.get(item.symbolId);
      if (!sym) return item;
      const file = fileMap.get(sym.fileId);
      return {
        ...item,
        name: sym.name,
        kind: sym.kind,
        file: file?.relPath ?? undefined,
      };
    });

    // Apply MAX_BLAST_RADIUS_ITEMS hard cap
    let blastRadiusTruncatedFlag = false;
    if (delta.blastRadius.length > MAX_BLAST_RADIUS_ITEMS) {
      delta.blastRadius = delta.blastRadius.slice(0, MAX_BLAST_RADIUS_ITEMS);
      blastRadiusTruncatedFlag = true;
    }

    const amplifiers = delta.blastRadius
      .filter((item) => item.fanInTrend?.isAmplifier)
      .map((item) => ({
        symbolId: item.symbolId,
        growthRate: item.fanInTrend!.growthRate,
        previous: item.fanInTrend!.previous,
        current: item.fanInTrend!.current,
      }));

    const fileIds = allFileIds;

    const response: Record<string, unknown> = { delta, ...(singleVersionHint ? { hint: singleVersionHint } : {}), amplifiers };
    if (blastRadiusTruncatedFlag) {
      response.blastRadiusTruncated = true;
    }
    return attachRawContext(response, { fileIds }) as DeltaGetResponse;
  };

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = {
      repoId: validated.repoId,
      versionId: `${validated.fromVersion}..${validated.toVersion}`,
      budget: validated.budget ?? {},
    };
    return withSpan(
      SPAN_NAMES.DELTA_GET,
      async (span) => {
        const result = await executeDelta();
        span.setAttributes({
          "counts.changedSymbols": result.delta.changedSymbols.length,
          "counts.blastRadius": result.delta.blastRadius.length,
        });
        return result;
      },
      attrs,
    );
  }

  return executeDelta();
}
