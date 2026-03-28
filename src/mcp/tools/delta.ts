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
  DEFAULT_MAX_TOKENS_SLICE,
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
    const budget = validated.budget ?? {
      maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
      maxEstimatedTokens:
        config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
    };
    const governorOptions = {
      repoId: validated.repoId,
      budget,
      runDiagnostics: true,
      diagnosticsTimeoutMs: 5000,
      fromVersionId: validated.fromVersion,
      toVersionId: validated.toVersion,
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

      const handleRow = await getSliceHandle(
        conn,
        spilloverHandle,
      );
      if (handleRow) {
        await withWriteConn(async (wConn) => {
          await updateSliceHandleSpillover(
            wConn,
            spilloverHandle,
            JSON.stringify(governorResult.trimmedSet.droppedSymbols),
          );
        });
      }
    }

    const maxChanges = config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS;
    const maxBlastRadius = config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS;

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

    const amplifiers = delta.blastRadius
      .filter((item) => item.fanInTrend?.isAmplifier)
      .map((item) => ({
        symbolId: item.symbolId,
        growthRate: item.fanInTrend!.growthRate,
        previous: item.fanInTrend!.previous,
        current: item.fanInTrend!.current,
      }));

    const symbolMap = await ladybugDb.getSymbolsByIds(conn, changedSymbolIds);
    const fileIds = [
      ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
    ];

    const response = { delta, amplifiers };
    attachRawContext(response, { fileIds });
    return response;
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
