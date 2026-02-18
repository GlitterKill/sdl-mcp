import { DeltaGetRequestSchema, type DeltaGetResponse } from "../tools.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { loadGraphForRepo } from "../../graph/buildGraph.js";
import { truncateArray } from "../../util/truncation.js";
import { loadConfig } from "../../config/loadConfig.js";
import * as db from "../../db/queries.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
} from "../../config/constants.js";
import { prefetchDeltaBlastRadius } from "../../graph/prefetch.js";

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

  let delta;
  try {
    delta = computeDelta(
      validated.repoId,
      validated.fromVersion,
      validated.toVersion,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute delta pack.";
    throw new Error(`Delta pack error: ${message}`);
  }

  const graph = loadGraphForRepo(validated.repoId);

  const changedSymbolIds = delta.changedSymbols.map(
    (change) => change.symbolId,
  );
  prefetchDeltaBlastRadius(validated.repoId, changedSymbolIds);

  const config = loadConfig();
  const budget = validated.budget ?? {
    maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
    maxEstimatedTokens: config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
  };
  const governorOptions = {
    repoId: validated.repoId,
    budget,
    runDiagnostics: true,
    diagnosticsTimeoutMs: 5000,
  };

  const governorResult = await runGovernorLoop(
    changedSymbolIds,
    graph,
    governorOptions,
  );

  delta.blastRadius = governorResult.blastRadius;
  delta.trimmedSet = governorResult.trimmedSet;

  if (governorResult.spilloverHandle) {
    delta.spilloverHandle = governorResult.spilloverHandle;

    const handleRow = db.getSliceHandle(governorResult.spilloverHandle);
    if (handleRow) {
      db.updateSliceHandleSpillover(
        governorResult.spilloverHandle,
        JSON.stringify(governorResult.trimmedSet.droppedSymbols),
      );
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

  // Strip verbose reason strings from blast radius items to save tokens.
  // The signal + distance fields convey the same information more compactly.
  delta.blastRadius = delta.blastRadius.map(
    ({ reason: _reason, ...rest }) => rest as typeof delta.blastRadius[number],
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

  return {
    delta,
  };
}
