import { IndexOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  indexRepo,
  watchRepository,
  IndexWatchHandle,
  IndexResult,
} from "../../indexer/indexer.js";
import type {
  ProviderFirstCoverageSummary,
  ProviderFirstExecutionSummary,
  ProviderFirstLegacyFallbackDiagnostics,
  ProviderFirstPhaseTimings,
} from "../../indexer/provider-first/executor.js";
import {
  disableDerivedRefreshQueue,
  enableDerivedRefreshQueue,
  shutdownDerivedRefreshQueue,
} from "../../indexer/derived-refresh-queue.js";
import type {
  IndexProgress,
  IndexProgressSubstage,
} from "../../indexer/indexer.js";
import { initGraphDb, resolveGraphDbPath } from "../../db/initGraphDb.js";
import {
  getLadybugConn,
  withWriteConn,
  closeLadybugDb,
} from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { findExistingProcess, type PidfileData } from "../../util/pidfile.js";
import { connectSSE, type SSEEvent } from "../../util/sse-client.js";
import { loadConfiguredAdapterPlugins } from "../../startup/plugins.js";
import { printBanner } from "../../util/banner.js";
import {
  createRuntimeIdentity,
  formatRuntimeIdentityLine,
  type RuntimeIdentity,
} from "../../util/runtime-identity.js";
import { normalizePath } from "../../util/paths.js";

// ---------------------------------------------------------------------------
// Progress renderer
// ---------------------------------------------------------------------------
//
// Renders indexer and SCIP progress in-place when stdout is a TTY (using
// carriage return + clear-to-EOL) and falls back to throttled line printing
// in non-TTY contexts (CI logs, piped output). The renderer is stateful so it
// can emit a newline when the active stage changes — without this, in-place
// updates from stage N would collide with stage N+1 on the same line.

/** @internal exported for tests; do not import from product code. */
export interface ProgressState {
  /** Key identifying the currently-rendered stage (e.g. "pass1", "scip:label:documents"). */
  currentStage: string | null;
  /** Last line written, used to dedupe identical updates from high-frequency callbacks. */
  lastLine: string;
  /** Last file line written (shown below the progress bar). */
  lastFileLine: string;
  /** Last percentage printed in non-TTY mode (throttles to ~10% increments). */
  lastPrintedPct: number;
  /**
   * Per-model embedding progress. Two models (jina + nomic) emit interleaved
   * events through the same onProgress callback; without per-model state the
   * displayed count would flicker between each model's last reported value.
   * Map preserves insertion order so the rendered line keeps a stable column
   * ordering across updates. Cleared on stage transitions away from
   * embeddings.
   */
  embeddingsByModel: Map<
    string,
    { current: number; total: number; message?: string }
  >;
}

/** @internal exported for tests; do not import from product code. */
export function createProgressState(): ProgressState {
  return {
    currentStage: null,
    lastLine: "",
    lastFileLine: "",
    lastPrintedPct: -1,
    embeddingsByModel: new Map(),
  };
}

/**
 * Shorten a model identifier for display in the per-model progress line.
 * Model names like "jina-embeddings-v2-base-code" or "nomic-embed-text-v1.5"
 * are too long for a multi-model status line; the first dash-separated token
 * gives a stable, recognisable abbreviation.
 */
/** @internal exported for tests; do not import from product code. */
export function shortModelLabel(model: string): string {
  const head = model.split("-")[0] ?? model;
  return head.toLowerCase();
}

function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function buildBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

/**
 * Map an IndexProgress stage to a user-facing label. The indexer emits
 * internal stage names (snake/camel); the CLI shows human-friendly strings.
 */
function indexStageLabel(stage: IndexProgress["stage"]): string {
  switch (stage) {
    case "scanning":
      return "Scanning files";
    case "parsing":
      return "Parsing";
    case "pass1":
      return "Pass 1 (symbols)";
    case "scipIngest":
      return "SCIP ingest";
    case "providerFirst":
      return "Provider-first";
    case "pass2":
      return "Pass 2 (edges)";
    case "finalizing":
      return "Finalizing";
    case "summaries":
      return "Summaries";
    case "embeddings":
      return "Embeddings";
    default:
      return stage;
  }
}

function providerFirstSubstageLabel(substage?: IndexProgressSubstage): string {
  switch (substage) {
    case "coverageScan":
      return "Provider-first coverage scan";
    case "providerCollection.metadata":
      return "Provider-first metadata";
    case "providerCollection.documents":
      return "Provider-first documents";
    case "providerCollection.externalSymbols":
      return "Provider-first external symbols";
    case "providerCollection.sourceLines":
      return "Provider-first source lines";
    case "providerCollection.normalize":
      return "Provider-first normalization";
    case "providerCollection.rows":
      return "Provider-first row shaping";
    case "providerCollection.validate":
      return "Provider-first validation";
    case "coverageAnalyze":
      return "Provider-first coverage analysis";
    case "materialize.deleteFileSymbols":
      return "Provider-first materialize: delete file symbols";
    case "materialize.upsertFiles":
      return "Provider-first materialize: upsert files";
    case "materialize.upsertSymbols":
      return "Provider-first materialize: upsert symbols";
    case "materialize.upsertSymbols.nodeAndRelCreate":
      return "Provider-first materialize: symbol COPY";
    case "materialize.upsertSymbols.nodeUpsert":
      return "Provider-first materialize: symbol nodes";
    case "materialize.upsertSymbols.fileRelCreate":
      return "Provider-first materialize: symbol-file links";
    case "materialize.upsertSymbols.repoRelCreate":
      return "Provider-first materialize: symbol-repo links";
    case "materialize.pruneExternalSymbols":
      return "Provider-first materialize: prune externals";
    case "materialize.mergeExternalSymbols":
      return "Provider-first materialize: merge externals";
    case "materialize.insertEdges":
      return "Provider-first materialize: insert edges";
    case "legacyFallbackInit":
      return "Provider-first legacy fallback";
    case "shadowStage":
      return "Provider-first shadow staging";
    case "shadowFinalize":
      return "Provider-first shadow finalization";
    case "shadowActivate":
      return "Provider-first shadow activation";
    default:
      return "Provider-first";
  }
}

/**
 * Human-facing label for a finalize substage. Used to keep CLI / SSE / MCP
 * progress consumers reading the same vocabulary as the plan.
 */
function indexSubstageLabel(substage: IndexProgressSubstage): string {
  switch (substage) {
    case "pass1Drain":
      return "Flushing pass 1 writes";
    case "importReresolution":
      return "Import re-resolution";
    case "edgeFinalize":
      return "Finalize pending/config edges";
    case "versionSnapshot":
      return "Create version snapshot";
    case "metrics":
      return "Update metrics";
    case "fileSummaries":
      return "Materialize file summaries";
    case "audit":
      return "Audit events";
    case "semanticSummaries":
      return "Semantic summaries";
    case "semanticEmbeddings":
      return "Semantic embeddings";
    case "clusterRefresh":
      return "Cluster refresh";
    case "processRefresh":
      return "Process refresh";
    case "algorithmRefresh":
      return "Algorithm refresh";
    default:
      return substage;
  }
}

type PrintableProviderFirstExecutionSummary = Omit<
  ProviderFirstExecutionSummary,
  "executor" | "coverage"
> & {
  executor?: string;
  coverage?: ProviderFirstCoverageSummary;
};

export function formatProviderFirstExecutionSummaryLines(
  execution: PrintableProviderFirstExecutionSummary | null | undefined,
): string[] {
  if (!execution) return [];
  if (execution.status === "fallback") {
    return [`  Provider-first fallback: ${execution.reasons.join("; ")}`];
  }
  if (execution.status !== "executed") return [];

  const lines = [
    `  Provider-first: ${execution.executor} (${execution.generationId})`,
  ];
  if (execution.phaseTimings) {
    lines.push(...formatProviderFirstPhaseTimingLines(execution.phaseTimings));
  }
  if (execution.legacyFallbackDiagnostics) {
    lines.push(
      ...formatProviderFirstLegacyFallbackDiagnosticLines(
        execution.legacyFallbackDiagnostics,
      ),
    );
  }
  const shadowBuild = execution.shadowBuild;
  if (shadowBuild?.status === "staged") {
    const counts = shadowBuild.counts;
    const requested =
      shadowBuild.requestedFormat !== shadowBuild.format
        ? ` (${shadowBuild.requestedFormat} requested)`
        : "";
    lines.push(
      `  Provider-first shadow staging: ${shadowBuild.format} ` +
        `files=${counts.files} symbols=${counts.symbols} ` +
        `externals=${counts.externalSymbols} edges=${counts.edges}` +
        requested,
    );
    if (shadowBuild.shadowDb?.status === "loaded") {
      const loaded = shadowBuild.shadowDb.actualCounts;
      lines.push(
        `  Provider-first shadow DB loaded: files=${loaded.files} ` +
          `symbols=${loaded.symbols} edges=${loaded.edges}`,
      );
      if (shadowBuild.shadowDb.reasons.length > 0) {
        lines.push(
          `  Provider-first shadow DB warning: ${shadowBuild.shadowDb.reasons.join("; ")}`,
        );
      }
    } else if (shadowBuild.shadowDb?.status === "skipped") {
      lines.push(
        `  Provider-first shadow DB load skipped: ${shadowBuild.shadowDb.reasons.join("; ")}`,
      );
    }
    if (
      shadowBuild.finalization?.status === "finalized" &&
      shadowBuild.finalization.actualCounts
    ) {
      const finalized = shadowBuild.finalization.actualCounts;
      const auxiliarySuffix =
        finalized.auxiliarySymbols > 0
          ? ` auxiliarySymbols=${finalized.auxiliarySymbols}`
          : "";
      const copySuffix = shadowBuild.finalization.copyMode
        ? ` copy=${shadowBuild.finalization.copyMode}`
        : "";
      const artifactSuffix = shadowBuild.finalization.bulkLoad
        ? ` artifacts=${shadowBuild.finalization.bulkLoad.artifacts.length}`
        : "";
      lines.push(
        `  Provider-first shadow DB finalized: files=${finalized.files} ` +
          `symbols=${finalized.symbols} edges=${finalized.edges} ` +
          `versions=${finalized.versions} metrics=${finalized.metrics} ` +
          `fileSummaries=${finalized.fileSummaries}${auxiliarySuffix}` +
          `${copySuffix}${artifactSuffix}`,
      );
    } else if (shadowBuild.finalization?.status === "skipped") {
      lines.push(
        `  Provider-first shadow DB finalization skipped: ${shadowBuild.finalization.reasons.join("; ")}`,
      );
    } else if (shadowBuild.finalization?.status === "failed") {
      lines.push(
        `  Provider-first shadow DB finalization failed: ${shadowBuild.finalization.reasons.join("; ")}`,
      );
    }
    if (shadowBuild.activationResult) {
      const activation = shadowBuild.activationResult;
      if (activation.status === "activated") {
        lines.push(
          `  Provider-first shadow DB activated: ${activation.activeDbPath}`,
        );
      } else if (activation.status === "skipped") {
        lines.push(
          `  Provider-first shadow DB activation skipped: ${activation.reasons.join("; ")}`,
        );
      } else {
        lines.push(
          `  Provider-first shadow DB activation failed: ${activation.reasons.join("; ")}`,
        );
      }
    }
  } else if (shadowBuild?.status === "skipped") {
    lines.push(
      `  Provider-first shadow staging skipped: ${shadowBuild.reasons.join("; ")}`,
    );
  }
  const coverage = execution.coverage;
  if (coverage) {
    const providerPrimaryFiles =
      coverage.providerPrimaryFiles ??
      coverage.fullyCoveredFiles + coverage.partialFiles;
    const middle: string[] = [];
    if (coverage.fullFallbackFiles > 0) {
      middle.push(`${coverage.fullFallbackFiles} provider unusable`);
    }
    if (coverage.uncoveredFiles > 0) {
      middle.push(
        coverage.semanticEligibleFiles !== undefined
          ? `${coverage.uncoveredFiles} outside semantic eligibility or uncovered`
          : `${coverage.uncoveredFiles} uncovered`,
      );
    }
    if ((coverage.callProofIncompleteFiles ?? 0) > 0) {
      middle.push(`${coverage.callProofIncompleteFiles} call-proof incomplete`);
    }
    if ((coverage.ignoredProviderFiles ?? 0) > 0) {
      middle.push(
        `${coverage.ignoredProviderFiles} provider file(s) ignored outside scan scope`,
      );
    }

    let line =
      coverage.semanticEligibleFiles !== undefined
        ? `  Provider-first coverage: ${providerPrimaryFiles}/${coverage.semanticEligibleFiles} semantic-eligible files provider-primary ` +
          `(scan scope ${coverage.scannedFiles}, provider docs ${coverage.providerCoveredFiles ?? coverage.providerFiles}; ` +
          `${coverage.fullyCoveredFiles} full, ${coverage.partialFiles} partial)`
        : `  Provider-first coverage: ${providerPrimaryFiles}/${coverage.scannedFiles} files provider-primary ` +
          `(${coverage.fullyCoveredFiles} full, ${coverage.partialFiles} partial)`;
    if (middle.length > 0) {
      line += `; ${middle.join(", ")}`;
    }
    if (coverage.fallbackFiles > 0) {
      line += `; legacy fallback parsed ${coverage.fallbackFiles} file(s)`;
    }
    if ((coverage.legacyFallbackSkippedFiles ?? 0) > 0) {
      let capSuffix = "";
      if (
        coverage.semanticEligibleFallbackFiles !== undefined &&
        coverage.semanticEligibleFallbackFiles > 0 &&
        coverage.semanticEligibleFallbackFileLimit !== undefined &&
        coverage.semanticEligibleFallbackFiles >
          coverage.semanticEligibleFallbackFileLimit
      ) {
        capSuffix =
          ` over semantic cap ${coverage.semanticEligibleFallbackFileLimit}` +
          ` (semantic-eligible ${coverage.semanticEligibleFallbackFiles}, full cap ${coverage.legacyFallbackFileLimit ?? "n/a"})`;
      } else if (coverage.legacyFallbackFileLimit !== undefined) {
        capSuffix = ` over cap ${coverage.legacyFallbackFileLimit}`;
      }
      line +=
        `; legacy fallback skipped ${coverage.legacyFallbackSkippedFiles} file(s)` +
        capSuffix;
    }
    lines.push(line);
    if (
      coverage.providerUnusableReasons &&
      coverage.providerUnusableReasons.length > 0
    ) {
      lines.push("  Provider-first provider-unusable diagnostics:");
      for (const reason of coverage.providerUnusableReasons) {
        const sample =
          reason.samplePaths.length > 0
            ? `: ${reason.samplePaths.join(", ")}`
            : "";
        lines.push(
          `    ${providerFirstProviderUnusableReasonLabel(reason.code)}: ` +
            `${reason.files} file(s)` +
            sample,
        );
        for (const skipped of reason.skippedSymbolReasons ?? []) {
          const skippedSample =
            skipped.samplePaths.length > 0
              ? `: ${skipped.samplePaths.join(", ")}`
              : "";
          lines.push(
            `      skipped symbol reason: ${skipped.reason}, ` +
              `${skipped.symbols} symbol(s)` +
              skippedSample,
          );
        }
      }
    }
    if (coverage.semanticEligibilityGap) {
      const gap = coverage.semanticEligibilityGap;
      if (gap.totalFiles > 0 || gap.outsideSemanticEligibilityFiles > 0) {
        lines.push("  Provider-first semantic eligibility diagnostics:");
        if (gap.uncoveredFiles > 0) {
          lines.push(
            `    semantic-eligible uncovered: ${gap.uncoveredFiles} file(s)` +
              formatProviderFirstPathSamples(
                gap.semanticEligibleUncoveredSamples,
              ),
          );
        }
        if (gap.providerUnusableFiles > 0) {
          lines.push(
            `    semantic-eligible provider-unusable: ${gap.providerUnusableFiles} file(s)` +
              formatProviderFirstPathSamples(
                gap.semanticEligibleProviderUnusableSamples,
              ),
          );
        }
        if (gap.outsideSemanticEligibilityFiles > 0) {
          lines.push(
            `    outside semantic eligibility: ${gap.outsideSemanticEligibilityFiles} scanned file(s)` +
              formatProviderFirstPathSamples(
                gap.outsideSemanticEligibilitySamples,
              ),
          );
        }
      }
    }
    if (
      coverage.callProofIncompleteReasons &&
      coverage.callProofIncompleteReasons.length > 0
    ) {
      lines.push("  Provider-first call-proof diagnostics:");
      for (const reason of coverage.callProofIncompleteReasons) {
        const sample =
          reason.samplePaths.length > 0
            ? `: ${reason.samplePaths.join(", ")}`
            : "";
        lines.push(
          `    ${providerFirstCallProofReasonLabel(reason.code)}: ` +
            `${reason.references} reference(s), ${reason.files} file(s)` +
            sample,
        );
        for (const mismatch of reason.samples ?? []) {
          lines.push(
            `      sample: ${formatProviderFirstCallProofSample(mismatch)}`,
          );
        }
      }
    }
  }
  return lines;
}

function formatProviderFirstPathSamples(paths: readonly string[]): string {
  return paths.length > 0 ? `: ${paths.join(", ")}` : "";
}

/** @internal exported for tests; do not import from product code. */
export function formatIndexWallTimeLine(
  wallDurationMs: number,
  indexedDurationMs?: number,
): string {
  const outsideIndexedPhasesMs =
    typeof indexedDurationMs === "number" && Number.isFinite(indexedDurationMs)
      ? wallDurationMs - indexedDurationMs
      : 0;
  const suffix =
    outsideIndexedPhasesMs > 1_000
      ? ` (includes ${outsideIndexedPhasesMs}ms outside indexed phases)`
      : "";
  return `  Wall time: ${wallDurationMs}ms${suffix}`;
}

/** @internal exported for tests; do not import from product code. */
export function formatScipGeneratorCacheLine(
  cache?: NonNullable<IndexResult["scip"]>["generatorCache"],
): string | undefined {
  if (!cache) return undefined;
  if (cache.status === "disabled" || cache.status === "miss") {
    return undefined;
  }
  const timingParts: string[] = [];
  if (
    cache.status === "stored" &&
    typeof cache.generatorDurationMs === "number"
  ) {
    timingParts.push(`generator ${cache.generatorDurationMs}ms`);
  }
  if (typeof cache.saveDurationMs === "number") {
    timingParts.push(`save ${cache.saveDurationMs}ms`);
  }
  if (typeof cache.restoreDurationMs === "number") {
    timingParts.push(`restore ${cache.restoreDurationMs}ms`);
  }
  if (typeof cache.prepareDurationMs === "number") {
    timingParts.push(`prepare ${cache.prepareDurationMs}ms`);
  }
  const timingPart =
    timingParts.length > 0 ? timingParts.join(", ") : `${cache.durationMs}ms`;
  const filePart =
    typeof cache.fileCount === "number"
      ? `, ${cache.fileCount} input file(s)`
      : "";
  const reasonPart = cache.reason ? `: ${cache.reason}` : "";
  return `  SCIP generator cache: ${cache.status} (${timingPart}${filePart})${reasonPart}`;
}

/** @internal exported for tests; do not import from product code. */
export function formatScipFailureLine(
  failure: NonNullable<IndexResult["scip"]>["failures"][number],
): string {
  const message = failure.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^Error: All \d+ indexer\(s\) failed$/.test(line))
    .join("; ");
  return `  SCIP ${failure.stage} (non-fatal): ${message}${
    failure.path ? ` (${failure.path})` : ""
  }`;
}

const PROVIDER_FIRST_TIMING_LABELS: Array<[string, string]> = [
  ["providerCollection", "collect"],
  ["coverageScan", "scan"],
  ["shadowStage", "shadowStage"],
  ["materialize", "materialize"],
  ["legacyFallback", "legacy"],
  ["shadowStageFinal", "shadowStage"],
  ["shadowFinalize", "shadowFinalize"],
  ["shadowActivate", "activate"],
];

const PROVIDER_FIRST_MATERIALIZE_TIMING_LABELS: Array<[string, string]> = [
  ["materialize.deleteFileSymbols", "deleteFileSymbols"],
  ["materialize.upsertFiles", "upsertFiles"],
  ["materialize.upsertSymbols", "upsertSymbols"],
  ["materialize.pruneExternalSymbols", "pruneExternalSymbols"],
  ["materialize.mergeExternalSymbols", "mergeExternalSymbols"],
  ["materialize.insertEdges", "insertEdges"],
];

const PROVIDER_FIRST_PROVIDER_COLLECTION_TIMING_LABELS: Array<
  [string, string]
> = [
  ["providerCollection.cacheRead", "cacheRead"],
  ["providerCollection.metadata", "metadata"],
  ["providerCollection.documents", "documents"],
  ["providerCollection.externalSymbols", "externalSymbols"],
  ["providerCollection.sourceLines", "sourceLines"],
  ["providerCollection.normalize", "normalize"],
  ["providerCollection.rows", "rows"],
  ["providerCollection.validate", "validate"],
  ["providerCollection.cacheWrite", "cacheWrite"],
];

const PROVIDER_FIRST_NORMALIZE_TIMING_LABELS: Array<[string, string]> = [
  ["providerCollection.normalize.coalesce", "coalesce"],
  ["providerCollection.normalize.symbolInfoRelPaths", "symbolInfoRelPaths"],
  [
    "providerCollection.normalize.symbolDefinitionRelPaths",
    "symbolDefinitionRelPaths",
  ],
  ["providerCollection.normalize.symbols", "symbols"],
  ["providerCollection.normalize.externalSymbols", "externalSymbols"],
  ["providerCollection.normalize.occurrenceFacts", "occurrenceFacts"],
  ["providerCollection.normalize.diagnostics", "diagnostics"],
  ["providerCollection.normalize.coverage", "coverage"],
  ["providerCollection.normalize.relationshipEdges", "relationshipEdges"],
  ["providerCollection.normalize.occurrenceEdges", "occurrenceEdges"],
];

const PROVIDER_FIRST_SYMBOL_MATERIALIZE_TIMING_LABELS: Array<[string, string]> =
  [
    ["materialize.upsertSymbols.nodeAndRelCreate", "nodeAndRelCreate"],
    ["materialize.upsertSymbols.nodeUpsert", "nodeUpsert"],
    ["materialize.upsertSymbols.fileRelCreate", "fileRelCreate"],
    ["materialize.upsertSymbols.repoRelCreate", "repoRelCreate"],
  ];

const PROVIDER_FIRST_LEGACY_FALLBACK_PHASE_LABELS: Array<[string, string]> = [
  ["pass1", "pass1"],
  ["pass1Drain", "pass1Drain"],
  ["pass2", "pass2"],
  ["finalizeIndexing", "finalize"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_PASS2_LABELS: Array<[string, string]> = [
  ["pass2.targetSelection", "targetSelection"],
  ["pass2.importCache", "importCache"],
  ["pass2.resolverWarmup", "resolverWarmup"],
  ["pass2.resolverDispatch", "resolverDispatch"],
  ["pass2.writeActive", "writeActive"],
  ["pass2.writeQueue", "writeQueue"],
  ["pass2.write.copyEnsure", "copyEnsure"],
  ["pass2.write.copyEnsure.symbolMetadata", "copyEnsure.symbols"],
  [
    "pass2.write.copyEnsure.symbolMetadata.probeExisting",
    "copyEnsure.symbols.probe",
  ],
  [
    "pass2.write.copyEnsure.symbolMetadata.copyMissing.csvMaterialize",
    "copyEnsure.symbols.copyMissing.csv",
  ],
  [
    "pass2.write.copyEnsure.symbolMetadata.copyMissing.copyFrom",
    "copyEnsure.symbols.copyMissing.copy",
  ],
  [
    "pass2.write.copyEnsure.symbolMetadata.matchExisting",
    "copyEnsure.symbols.matchExisting",
  ],
  [
    "pass2.write.copyEnsure.symbolMetadata.mergeFallback",
    "copyEnsure.symbols.mergeFallback",
  ],
  ["pass2.write.copyEnsure.repoLink", "copyEnsure.repoLinks"],
  ["pass2.write.copyInsert", "copyInsert"],
  ["pass2.write.copyInsert.txnBegin", "copyInsert.txnBegin"],
  ["pass2.write.copyInsert.txnBody", "copyInsert.txnBody"],
  ["pass2.write.copyInsert.txnCommit", "copyInsert.txnCommit"],
  ["pass2.write.copyInsert.csvMaterialize", "copyInsert.csvMaterialize"],
  ["pass2.write.copyInsert.copyFrom", "copyInsert.copyFrom"],
  ["pass2.write.copyInsert.tempCleanup", "copyInsert.tempCleanup"],
  ["pass2.write.repairInsert", "repairInsert"],
  ["pass2.write.repairInsert.prepareRows", "repairInsert.prepareRows"],
  [
    "pass2.write.repairInsert.sourceRepoLink.symbolMetadata",
    "repairInsert.sourceRepoLink.symbolMetadata",
  ],
  [
    "pass2.write.repairInsert.sourceRepoLink.repoLink",
    "repairInsert.sourceRepoLink.repoLink",
  ],
  [
    "pass2.write.repairInsert.endpointMetadata",
    "repairInsert.endpointMetadata",
  ],
  ["pass2.write.repairInsert.targetMetadata", "repairInsert.targetMetadata"],
  ["pass2.write.repairInsert.targetRepoLink", "repairInsert.targetRepoLink"],
  [
    "pass2.write.repairInsert.relationshipCreate",
    "repairInsert.relationshipCreate",
  ],
  [
    "pass2.write.repairInsert.relationshipUpdate",
    "repairInsert.relationshipUpdate",
  ],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_PASS1_DRAIN_LABELS: Array<
  [string, string]
> = [
  ["pass1Drain.write.deleteOldSymbols", "deleteOldSymbols"],
  ["pass1Drain.write.deleteIncomingSymbols", "deleteIncoming"],
  ["pass1Drain.write.upsertFiles", "upsertFiles"],
  ["pass1Drain.write.insertSymbolReferences", "symbolRefs"],
  ["pass1Drain.write.upsertSymbols", "upsertSymbols"],
  ["pass1Drain.write.insertEdges", "insertEdges"],
  ["pass1Drain.write.insertEdges.split", "insertEdges.split"],
  ["pass1Drain.write.insertEdges.knownEnsure", "insertEdges.knownEnsure"],
  [
    "pass1Drain.write.insertEdges.knownEnsure.symbolMetadata.probeExisting",
    "insertEdges.knownEnsure.probe",
  ],
  [
    "pass1Drain.write.insertEdges.knownEnsure.symbolMetadata.copyMissing.csvMaterialize",
    "insertEdges.knownEnsure.copyMissing.csv",
  ],
  [
    "pass1Drain.write.insertEdges.knownEnsure.symbolMetadata.copyMissing.copyFrom",
    "insertEdges.knownEnsure.copyMissing.copy",
  ],
  [
    "pass1Drain.write.insertEdges.knownEnsure.symbolMetadata.matchExisting",
    "insertEdges.knownEnsure.matchExisting",
  ],
  [
    "pass1Drain.write.insertEdges.knownEnsure.symbolMetadata.mergeFallback",
    "insertEdges.knownEnsure.mergeFallback",
  ],
  [
    "pass1Drain.write.insertEdges.knownEnsure.repoLink",
    "insertEdges.knownEnsure.repoLink",
  ],
  ["pass1Drain.write.insertEdges.knownCopy", "insertEdges.knownCopy"],
  ["pass1Drain.write.insertEdges.knownCopy.txnBegin", "insertEdges.knownCopy.txnBegin"],
  ["pass1Drain.write.insertEdges.knownCopy.txnBody", "insertEdges.knownCopy.txnBody"],
  ["pass1Drain.write.insertEdges.knownCopy.txnCommit", "insertEdges.knownCopy.txnCommit"],
  ["pass1Drain.write.insertEdges.knownCopy.csvMaterialize", "insertEdges.knownCopy.csv"],
  ["pass1Drain.write.insertEdges.knownCopy.copyFrom", "insertEdges.knownCopy.copy"],
  ["pass1Drain.write.insertEdges.knownCopy.tempCleanup", "insertEdges.knownCopy.cleanup"],
  ["pass1Drain.write.insertEdges.repair", "insertEdges.repair"],
  ["pass1Drain.write.insertEdges.repair.dedupe", "insertEdges.repair.dedupe"],
  ["pass1Drain.write.insertEdges.repair.groupByRepo", "insertEdges.repair.groupByRepo"],
  ["pass1Drain.write.insertEdges.repair.prepareRows", "insertEdges.repair.prepareRows"],
  [
    "pass1Drain.write.insertEdges.repair.sourceRepoLink.symbolMetadata",
    "insertEdges.repair.sourceRepoLink.symbolMetadata",
  ],
  [
    "pass1Drain.write.insertEdges.repair.sourceRepoLink.repoLink",
    "insertEdges.repair.sourceRepoLink.repoLink",
  ],
  ["pass1Drain.write.insertEdges.repair.endpointMetadata", "insertEdges.repair.endpointMetadata"],
  ["pass1Drain.write.insertEdges.repair.targetMetadata", "insertEdges.repair.targetMetadata"],
  ["pass1Drain.write.insertEdges.repair.targetRepoLink", "insertEdges.repair.targetRepoLink"],
  [
    "pass1Drain.write.insertEdges.repair.relationshipCreate",
    "insertEdges.repair.relationshipCreate",
  ],
  [
    "pass1Drain.write.insertEdges.repair.relationshipUpdate",
    "insertEdges.repair.relationshipUpdate",
  ],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_FINALIZE_LABELS: Array<[string, string]> =
  [
    ["finalizeIndexing.symbolStatusNormalize", "symbolStatus"],
    ["finalizeIndexing.metrics", "metrics"],
    ["finalizeIndexing.metrics.loadRepoState", "metrics.loadRepo"],
    ["finalizeIndexing.metrics.loadFilesAndSymbols", "metrics.loadGraph"],
    ["finalizeIndexing.metrics.fanMetrics", "metrics.fan"],
    ["finalizeIndexing.metrics.churn", "metrics.churn"],
    ["finalizeIndexing.metrics.testRefs", "metrics.testRefs"],
    ["finalizeIndexing.metrics.canonicalTests", "metrics.canonicalTests"],
    ["finalizeIndexing.metrics.centralityFold", "metrics.centralityFold"],
    ["finalizeIndexing.metrics.loadExistingCanonical", "metrics.loadExisting"],
    ["finalizeIndexing.metrics.metricsFingerprint", "metrics.fingerprint"],
    ["finalizeIndexing.metrics.writeMetrics", "metrics.writeMetrics"],
    ["finalizeIndexing.metrics.writeWait", "metrics.writeWait"],
    ["finalizeIndexing.metrics.writeRows", "metrics.writeRows"],
    [
      "finalizeIndexing.metrics.writeRows.csvMaterialize",
      "metrics.writeRows.csvMaterialize",
    ],
    [
      "finalizeIndexing.metrics.writeRows.deleteExisting",
      "metrics.writeRows.deleteExisting",
    ],
    ["finalizeIndexing.metrics.writeRows.copyFrom", "metrics.writeRows.copyFrom"],
    ["finalizeIndexing.metrics.writeRows.prepareRows", "metrics.writeRows.prepare"],
    ["finalizeIndexing.metrics.writeRows.probeExisting", "metrics.writeRows.probe"],
    [
      "finalizeIndexing.metrics.writeRows.copyMissing.csvMaterialize",
      "metrics.writeRows.copyMissing.csv",
    ],
    [
      "finalizeIndexing.metrics.writeRows.copyMissing.copyFrom",
      "metrics.writeRows.copyMissing.copy",
    ],
    [
      "finalizeIndexing.metrics.writeRows.createMissing",
      "metrics.writeRows.createMissing",
    ],
    [
      "finalizeIndexing.metrics.writeRows.mergeExisting",
      "metrics.writeRows.mergeExisting",
    ],
    ["finalizeIndexing.fileSummaries", "fileSummaries"],
    ["finalizeIndexing.fileSummaries.loadFiles", "fileSummaries.loadFiles"],
    [
      "finalizeIndexing.fileSummaries.loadExportedSymbols",
      "fileSummaries.exports",
    ],
    [
      "finalizeIndexing.fileSummaries.loadSymbolFacts",
      "fileSummaries.symbolFacts",
    ],
    [
      "finalizeIndexing.fileSummaries.loadExistingSummaries",
      "fileSummaries.existing",
    ],
    ["finalizeIndexing.fileSummaries.buildPayloads", "fileSummaries.build"],
    ["finalizeIndexing.fileSummaries.writeSummaries", "fileSummaries.write"],
    ["finalizeIndexing.fileSummaries.writeWait", "fileSummaries.writeWait"],
    [
      "finalizeIndexing.fileSummaries.writeExistingSummaries",
      "fileSummaries.writeExisting",
    ],
    [
      "finalizeIndexing.fileSummaries.writeNewSummaries",
      "fileSummaries.writeNew",
    ],
    ["finalizeIndexing.audit", "audit"],
    ["finalizeIndexing.qualityAudit", "qualityAudit"],
  ];

const PROVIDER_FIRST_LEGACY_FALLBACK_DERIVED_LABELS: Array<[string, string]> = [
  ["clustersAndProcesses.loadSymbols", "loadSymbols"],
  ["clustersAndProcesses.loadEdges", "loadEdges"],
  ["clustersAndProcesses.clusterCompute", "clusterCompute"],
  ["clustersAndProcesses.loadFiles", "loadFiles"],
  ["clustersAndProcesses.clusterWrite", "clusterWrite"],
  ["clustersAndProcesses.processCompute", "processCompute"],
  ["clustersAndProcesses.processWrite", "processWrite"],
  ["clustersAndProcesses.algorithmStage", "algorithmStage"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_CLUSTER_WRITE_LABELS: Array<
  [string, string]
> = [
  ["clustersAndProcesses.clusterWrite.loadExisting", "loadExisting"],
  ["clustersAndProcesses.clusterWrite.writeRows", "writeRows"],
  ["clustersAndProcesses.clusterWrite.deleteRows", "deleteRows"],
  ["clustersAndProcesses.clusterWrite.upsertClusters", "upsertClusters"],
  ["clustersAndProcesses.clusterWrite.upsertMembers", "upsertMembers"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_PROCESS_WRITE_LABELS: Array<
  [string, string]
> = [
  ["clustersAndProcesses.processWrite.loadExisting", "loadExisting"],
  ["clustersAndProcesses.processWrite.writeRows", "writeRows"],
  ["clustersAndProcesses.processWrite.deleteRows", "deleteRows"],
  ["clustersAndProcesses.processWrite.upsertProcesses", "upsertProcesses"],
  ["clustersAndProcesses.processWrite.upsertSteps", "upsertSteps"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_ALGORITHM_LABELS: Array<
  [string, string]
> = [
  ["clustersAndProcesses.algorithmStage.centralityWorker", "centralityWorker"],
  ["clustersAndProcesses.algorithmStage.centralityPrepare", "centralityPrepare"],
  ["clustersAndProcesses.algorithmStage.centralityWrite", "centralityWrite"],
  [
    "clustersAndProcesses.algorithmStage.centralityWrite.prepareRows",
    "centralityWrite.prepare",
  ],
  [
    "clustersAndProcesses.algorithmStage.centralityWrite.probeExisting",
    "centralityWrite.probe",
  ],
  [
    "clustersAndProcesses.algorithmStage.centralityWrite.updateExisting",
    "centralityWrite.updateExisting",
  ],
  [
    "clustersAndProcesses.algorithmStage.centralityWrite.mergeMissing",
    "centralityWrite.mergeMissing",
  ],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_VERSION_LABELS: Array<[string, string]> = [
  ["versionSnapshot.latestVersion", "latest"],
  ["versionSnapshot.createVersion", "create"],
  ["versionSnapshot.snapshot", "snapshot"],
  ["versionSnapshot.snapshot.readPages", "readPages"],
  ["versionSnapshot.snapshot.writePages", "writePages"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_DEFERRED_INDEX_LABELS: Array<
  [string, string]
> = [
  ["buildDeferredIndexes.secondaryIndexes", "secondary"],
  ["buildDeferredIndexes.configLoad", "config"],
  ["buildDeferredIndexes.retrievalIndexes", "retrieval"],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_RETRIEVAL_INDEX_LABELS: Array<
  [string, string]
> = [
  ["buildDeferredIndexes.retrieval.symbolDiscovery", "symbolDiscovery"],
  ["buildDeferredIndexes.retrieval.symbolFts", "symbolFts"],
  ["buildDeferredIndexes.retrieval.symbolVectors", "symbolVectors"],
  ["buildDeferredIndexes.retrieval.entityDiscovery", "entityDiscovery"],
  ["buildDeferredIndexes.retrieval.entityFts", "entityFts"],
  ["buildDeferredIndexes.retrieval.fileSummaryVectors", "fileSummaryVectors"],
  [
    "buildDeferredIndexes.retrieval.agentFeedbackVectors",
    "agentFeedbackVectors",
  ],
];

const PROVIDER_FIRST_LEGACY_FALLBACK_OTHER_LABELS: Array<[string, string]> = [
  ["preDeleteExistingSymbols", "preDelete"],
  ["initSharedState", "initSharedState"],
  ["refreshSymbolIndex", "refreshSymbolIndex"],
  ["resolveUnresolvedImports", "imports"],
  ["finalizeEdges", "finalizeEdges"],
  ["versionSnapshot", "version"],
  ["buildDeferredIndexes", "deferredIndexes"],
  ["memorySync", "memorySync"],
];

function formatProviderFirstLegacyFallbackDiagnosticLines(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string[] {
  const phaseEntries = Object.entries(diagnostics.phases)
    .filter(
      ([phaseName]) =>
        !hasFallbackDiagnosticChildPhase(diagnostics.phases, phaseName) &&
        !isProviderFirstLegacyFallbackCounterPhase(phaseName),
    )
    .filter(([, durationMs]) => Number.isFinite(durationMs))
    .map(([phaseName, durationMs]) => ({ phaseName, durationMs }));
  const slowest = phaseEntries.reduce<
    { phaseName: string; durationMs: number } | undefined
  >((current, entry) => {
    if (!current || entry.durationMs > current.durationMs) return entry;
    return current;
  }, undefined);
  const slowestSuffix = slowest
    ? `; slowest=${slowest.phaseName} ${slowest.durationMs}ms`
    : "";
  const lines = [
    `  Provider-first legacy fallback diagnostics: files=${diagnostics.files} ` +
      `total=${diagnostics.durationMs}ms avg=${diagnostics.averageMsPerFile}ms/file` +
      slowestSuffix,
  ];
  const selectedPhases = PROVIDER_FIRST_LEGACY_FALLBACK_PHASE_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [`${label}=${durationMs}ms`]
        : [];
    },
  );
  if (selectedPhases.length > 0) {
    lines.push(`    ${selectedPhases.join(", ")}`);
  }
  const pass1DrainPhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_PASS1_DRAIN_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (pass1DrainPhases.length > 0) {
    lines.push(`    pass1Drain: ${pass1DrainPhases.join(", ")}`);
  }
  const pass1EdgeStatsLine =
    formatProviderFirstLegacyFallbackPass1EdgeStatsLine(diagnostics);
  if (pass1EdgeStatsLine) {
    lines.push(pass1EdgeStatsLine);
  }
  const pass1EdgePhaseStatsLine =
    formatProviderFirstLegacyFallbackPass1EdgePhaseStatsLine(diagnostics);
  if (pass1EdgePhaseStatsLine) {
    lines.push(pass1EdgePhaseStatsLine);
  }
  const pass2Phases = PROVIDER_FIRST_LEGACY_FALLBACK_PASS2_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [`${label}=${durationMs}ms`]
        : [];
    },
  );
  if (pass2Phases.length > 0) {
    lines.push(`    pass2: ${pass2Phases.join(", ")}`);
  }
  const pass1ExtractionCacheLine =
    formatProviderFirstLegacyFallbackPass1ExtractionCacheLine(diagnostics);
  if (pass1ExtractionCacheLine) {
    lines.push(pass1ExtractionCacheLine);
  }
  const pass2DispatchLine =
    formatProviderFirstLegacyFallbackPass2DispatchLine(diagnostics);
  if (pass2DispatchLine) {
    lines.push(pass2DispatchLine);
  }
  const pass2WriteLine = formatProviderFirstLegacyFallbackPass2WriteLine(
    diagnostics,
  );
  if (pass2WriteLine) {
    lines.push(pass2WriteLine);
  }
  const resolverLine =
    formatProviderFirstLegacyFallbackResolverDiagnosticLine(diagnostics);
  if (resolverLine) {
    lines.push(resolverLine);
  }
  const resolverPhaseLine =
    formatProviderFirstLegacyFallbackResolverPhaseDiagnosticLine(diagnostics);
  if (resolverPhaseLine) {
    lines.push(resolverPhaseLine);
  }
  const resolverMetricLine =
    formatProviderFirstLegacyFallbackResolverMetricDiagnosticLine(diagnostics);
  if (resolverMetricLine) {
    lines.push(resolverMetricLine);
  }
  const resolverTopFilesLine =
    formatProviderFirstLegacyFallbackResolverTopFilesDiagnosticLine(diagnostics);
  if (resolverTopFilesLine) {
    lines.push(resolverTopFilesLine);
  }
  const finalizePhases = PROVIDER_FIRST_LEGACY_FALLBACK_FINALIZE_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [`${label}=${durationMs}ms`]
        : [];
    },
  );
  if (finalizePhases.length > 0) {
    lines.push(`    finalize: ${finalizePhases.join(", ")}`);
  }
  const derivedPhases = PROVIDER_FIRST_LEGACY_FALLBACK_DERIVED_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [`${label}=${durationMs}ms`]
        : [];
    },
  );
  if (derivedPhases.length > 0) {
    lines.push(`    derived: ${derivedPhases.join(", ")}`);
  }
  const clusterWritePhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_CLUSTER_WRITE_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (clusterWritePhases.length > 0) {
    lines.push(`    derived.clusterWrite: ${clusterWritePhases.join(", ")}`);
  }
  const processWritePhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_PROCESS_WRITE_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (processWritePhases.length > 0) {
    lines.push(`    derived.processWrite: ${processWritePhases.join(", ")}`);
  }
  const algorithmPhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_ALGORITHM_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (algorithmPhases.length > 0) {
    lines.push(`    derived.algorithm: ${algorithmPhases.join(", ")}`);
  }
  const versionPhases = PROVIDER_FIRST_LEGACY_FALLBACK_VERSION_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [`${label}=${durationMs}ms`]
        : [];
    },
  );
  if (versionPhases.length > 0) {
    lines.push(`    version: ${versionPhases.join(", ")}`);
  }
  const deferredIndexPhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_DEFERRED_INDEX_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (deferredIndexPhases.length > 0) {
    lines.push(`    deferredIndexes: ${deferredIndexPhases.join(", ")}`);
  }
  const retrievalIndexPhases =
    PROVIDER_FIRST_LEGACY_FALLBACK_RETRIEVAL_INDEX_LABELS.flatMap(
      ([phaseName, label]) => {
        const durationMs = diagnostics.phases[phaseName];
        return typeof durationMs === "number" && Number.isFinite(durationMs)
          ? [`${label}=${durationMs}ms`]
          : [];
      },
    );
  if (retrievalIndexPhases.length > 0) {
    lines.push(
      `    deferredIndexes.retrieval: ${retrievalIndexPhases.join(", ")}`,
    );
  }
  const otherPhaseEntries = PROVIDER_FIRST_LEGACY_FALLBACK_OTHER_LABELS.flatMap(
    ([phaseName, label]) => {
      const durationMs = diagnostics.phases[phaseName];
      return typeof durationMs === "number" && Number.isFinite(durationMs)
        ? [{ phaseName, label, durationMs }]
        : [];
    },
  );
  if (otherPhaseEntries.length > 0) {
    const accountedMs = sumKnownLegacyFallbackDiagnosticPhases(
      diagnostics.phases,
    );
    const unaccountedMs = Math.max(0, diagnostics.durationMs - accountedMs);
    lines.push(
      `    other: ${[
        ...otherPhaseEntries.map(
          (entry) => `${entry.label}=${entry.durationMs}ms`,
        ),
        `unaccounted=${unaccountedMs}ms`,
      ].join(", ")}`,
    );
  }
  if (diagnostics.samplePaths.length > 0) {
    const omittedSuffix =
      diagnostics.omittedPathCount && diagnostics.omittedPathCount > 0
        ? ` (+${diagnostics.omittedPathCount} more)`
        : "";
    lines.push(
      `    fallback files: ${diagnostics.samplePaths.join(", ")}${omittedSuffix}`,
    );
  }
  return lines;
}

function formatProviderFirstLegacyFallbackPass1EdgeStatsLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const stats = diagnostics.pass1Drain?.edgeStats;
  if (!stats || stats.totalEdges === 0) return undefined;
  const primaryCauseSum =
    (stats.repairCauseBelowThresholdKnownEdges ?? 0) +
    (stats.repairCauseUnresolvedSourceEdges ?? 0) +
    (stats.repairCauseBothEndpointsUnsafeEdges ?? 0) +
    (stats.repairCauseSourceEndpointUnsafeOnlyEdges ?? 0) +
    (stats.repairCauseTargetEndpointUnsafeOnlyEdges ?? 0) +
    (stats.repairCauseTargetRealNotKnownEdges ?? 0) +
    (stats.repairCauseTargetUnresolvedOrPlaceholderEdges ?? 0) +
    (stats.repairCauseOtherEdges ?? 0);
  const causeDrift = stats.repairEdges - primaryCauseSum;
  const entries: Array<[string, number]> = [
    ["schema", stats.edgeStatsSchemaVersion],
    ["splitCalls", stats.splitCalls],
    ["totalEdges", stats.totalEdges],
    ["knownEndpointEdges", stats.knownEndpointEdges],
    ["initialRepairEdges", stats.initialRepairEdges],
    ["belowThresholdKnownEdges", stats.belowThresholdKnownEdges],
    ["knownCopyFlushes", stats.knownCopyFlushes],
    ["knownCopyEdges", stats.knownCopyEdges],
    ["repairCalls", stats.repairCalls],
    ["repairEdges", stats.repairEdges],
    ["repairCauseBelowThresholdKnown", stats.repairCauseBelowThresholdKnownEdges],
    ["repairCauseUnresolvedSource", stats.repairCauseUnresolvedSourceEdges],
    ["repairCauseBothUnsafe", stats.repairCauseBothEndpointsUnsafeEdges],
    [
      "repairCauseSourceUnsafeOnly",
      stats.repairCauseSourceEndpointUnsafeOnlyEdges,
    ],
    [
      "repairCauseTargetUnsafeOnly",
      stats.repairCauseTargetEndpointUnsafeOnlyEdges,
    ],
    ["repairCauseTargetRealNotKnown", stats.repairCauseTargetRealNotKnownEdges],
    [
      "repairCauseTargetNonReal",
      stats.repairCauseTargetUnresolvedOrPlaceholderEdges,
    ],
    ["repairCauseOther", stats.repairCauseOtherEdges],
    ["repairCauseSum", primaryCauseSum],
    ["repairCauseDrift", causeDrift],
    ["repairSourceKnown", stats.repairSourceKnownEdges],
    ["repairSourceUnknownOrUnsafe", stats.repairSourceUnknownOrUnsafeEdges],
    ["repairSourceKnownTargetOnly", stats.repairSourceKnownTargetOnlyEdges],
    [
      "repairSourceKnownTargetRealNotKnown",
      stats.repairSourceKnownTargetRealNotKnownEdges,
    ],
    [
      "repairSourceKnownTargetUnsafe",
      stats.repairSourceKnownTargetUnsafeEdges,
    ],
    [
      "repairSourceKnownTargetNonReal",
      stats.repairSourceKnownTargetUnresolvedEdges,
    ],
  ];
  const rendered = entries.flatMap(([label, value]) =>
    Number.isFinite(value) ? [`${label}=${value}`] : [],
  );
  return rendered.length > 0
    ? `    pass1Drain.edges: ${rendered.join(", ")}`
    : undefined;
}

const PROVIDER_FIRST_LEGACY_FALLBACK_PASS1_EDGE_PHASE_STATS: Array<
  [string, string]
> = [
  [
    "insertEdges.knownEnsure.symbolMetadata.mergeFallback",
    "knownEnsure.mergeFallback",
  ],
  ["insertEdges.knownEnsure.repoLink", "knownEnsure.repoLink"],
  ["insertEdges.knownCopy.copyFrom", "knownCopy.copy"],
  ["insertEdges.repair.endpointMetadata", "repair.endpointMetadata"],
  ["insertEdges.repair.targetMetadata", "repair.targetMetadata"],
  ["insertEdges.repair.targetRepoLink", "repair.targetRepoLink"],
  ["insertEdges.repair.relationshipCreate", "repair.relationshipCreate"],
];

function formatProviderFirstLegacyFallbackPass1EdgePhaseStatsLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const phases = diagnostics.pass1Drain?.phases;
  if (!phases) return undefined;
  const rendered = PROVIDER_FIRST_LEGACY_FALLBACK_PASS1_EDGE_PHASE_STATS.flatMap(
    ([phaseName, label]) => {
      const phase = phases[phaseName as keyof typeof phases];
      if (!phase || (phase.count === 0 && phase.rows === 0 && phase.maxMs === 0)) {
        return [];
      }
      return [
        `${label}.count=${phase.count}`,
        `${label}.rows=${phase.rows}`,
        `${label}.maxMs=${phase.maxMs}`,
      ];
    },
  );
  return rendered.length > 0
    ? `    pass1Drain.edgePhaseStats: ${rendered.join(", ")}`
    : undefined;
}

function formatProviderFirstLegacyFallbackPass1ExtractionCacheLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const phase = (name: string): number | undefined => {
    const value = diagnostics.phases[`pass2.cache.pass1Extraction.${name}`];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  const bucket = (name: string, metric: string): number | undefined => {
    const value =
      diagnostics.phases[
        `pass2.cache.pass1Extraction.bucket.${name}.${metric}`
      ];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  const entries: Array<[string, number | undefined]> = [
    ["entries", phase("entries")],
    ["protectedEntries", phase("protectedEntries")],
    ["protectedBytes", phase("protectedBytes")],
    ["unprotectedEntries", phase("unprotectedEntries")],
    ["protectedStores", phase("protectedStores")],
    ["protectedStoreBytes", phase("protectedStoreBytes")],
    ["unprotectedStores", phase("unprotectedStores")],
    ["unprotectedStoreBytes", phase("unprotectedStoreBytes")],
    ["protectedEvictions", phase("protectedEvictions")],
    ["protectedEvictionBytes", phase("protectedEvictionBytes")],
    ["unprotectedEvictions", phase("unprotectedEvictions")],
    ["unprotectedEvictionBytes", phase("unprotectedEvictionBytes")],
    ["target.targets", phase("target.targets")],
    ["target.live", phase("target.live")],
    ["target.evicted", phase("target.evicted")],
    ["target.neverStored", phase("target.neverStored")],
    ["target.targetBytes", phase("target.targetBytes")],
    ["target.liveBytes", phase("target.liveBytes")],
    ["target.evictedBytes", phase("target.evictedBytes")],
    ["target.neverStoredBytes", phase("target.neverStoredBytes")],
  ];
  for (const bucketName of ["c", "h", "cc", "cpp", "hpp", "other"]) {
    for (const metric of [
      "entries",
      "bytes",
      "stores",
      "storeBytes",
      "evictions",
      "evictionBytes",
    ]) {
      entries.push([
        `${bucketName}.${metric}`,
        bucket(bucketName, metric),
      ]);
    }
    for (const metric of [
      "targets",
      "live",
      "evicted",
      "neverStored",
      "targetBytes",
      "liveBytes",
      "evictedBytes",
      "neverStoredBytes",
    ]) {
      entries.push([
        `target.${bucketName}.${metric}`,
        phase(`target.bucket.${bucketName}.${metric}`),
      ]);
    }
  }
  const rendered = entries.flatMap(([label, value]) =>
    typeof value === "number" && Number.isFinite(value)
      ? [`${label}=${value}`]
      : [],
  );
  return rendered.length > 0
    ? `    pass2.cache.pass1Extraction: ${rendered.join(", ")}`
    : undefined;
}

function isProviderFirstLegacyFallbackCounterPhase(phaseName: string): boolean {
  return (
    phaseName.startsWith("pass2.cache.pass1Extraction.") ||
    phaseName.startsWith("pass2.dispatch.")
  );
}

function formatProviderFirstLegacyFallbackPass2DispatchLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const skippedNoExistingSymbols =
    diagnostics.phases["pass2.dispatch.skippedNoExistingSymbols"];
  if (
    typeof skippedNoExistingSymbols !== "number" ||
    !Number.isFinite(skippedNoExistingSymbols) ||
    skippedNoExistingSymbols === 0
  ) {
    return undefined;
  }
  return `    pass2.dispatch: skippedNoExistingSymbols=${skippedNoExistingSymbols}`;
}

function formatProviderFirstLegacyFallbackPass2WriteLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const stats = diagnostics.pass2WriteStats;
  if (!stats) return undefined;
  const repairCauseSum: number = [
    stats.repairUnresolvedSourceEdges,
    stats.repairUnsafeSourceEndpointEdges,
    stats.repairUnsafeTargetEndpointEdges,
    stats.repairUnsafeBothEndpointEdges,
    stats.repairOtherCauseEdges,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const repairCauseDrift =
    typeof stats.repairEdges === "number"
      ? stats.repairEdges - repairCauseSum
      : undefined;
  const effectiveRepairRows =
    typeof stats.repairEdges === "number"
      ? stats.repairEdges + (stats.smallKnownEndpointEdges ?? 0)
      : undefined;
  const entries: Array<[string, number | undefined]> = [
    ["flushes", stats.flushes],
    ["edges", stats.totalEdges],
    ["copyFlushes", stats.copyFlushes],
    ["copyEdges", stats.copyEdges],
    ["copyPlaceholders", stats.copyPlaceholderTargets],
    ["copyPlaceholderRows", stats.copyPlaceholderRows],
    ["copyEnsuredRows", stats.copyEnsuredPlaceholderRows],
    ["copySkippedRows", stats.copySkippedPlaceholderRows],
    ["copyUnresolvedRows", stats.copyUnresolvedPlaceholderRows],
    ["copyExternalRows", stats.copyExternalPlaceholderRows],
    ["repairFlushes", stats.repairFlushes],
    ["repairEdges", stats.repairInsertEdges],
    ["repairPrimaryEdges", stats.repairEdges],
    ["repairUnresolvedSource", stats.repairUnresolvedSourceEdges],
    ["repairUnsafeSource", stats.repairUnsafeSourceEndpointEdges],
    ["repairUnsafeTarget", stats.repairUnsafeTargetEndpointEdges],
    ["repairUnsafeBoth", stats.repairUnsafeBothEndpointEdges],
    ["repairOther", stats.repairOtherCauseEdges],
    ["repairCauseSum", repairCauseSum],
    ["repairCauseDrift", repairCauseDrift],
    ["effectiveRepairRows", effectiveRepairRows],
    ["smallCopyFlushes", stats.smallKnownEndpointFlushes],
    ["smallCopyEdges", stats.smallKnownEndpointEdges],
  ];
  const rendered = entries.flatMap(([label, value]) =>
    typeof value === "number" && Number.isFinite(value)
      ? [`${label}=${value}`]
      : [],
  );
  return rendered.length > 0
    ? `    pass2.write: ${rendered.join(", ")}`
    : undefined;
}

function formatProviderFirstLegacyFallbackResolverDiagnosticLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const entries = Object.entries(diagnostics.resolverBreakdown ?? {})
    .filter(([, resolver]) =>
      [
        resolver.targets,
        resolver.filesProcessed,
        resolver.edgesCreated,
        resolver.elapsedMs,
      ].some((value) => value > 0),
    )
    .sort(([, left], [, right]) => right.elapsedMs - left.elapsedMs);
  if (entries.length === 0) return undefined;
  const selected = entries.slice(0, 5).map(([resolverId, resolver]) =>
    [
      `${resolverId} targets=${resolver.targets}`,
      `files=${resolver.filesProcessed}`,
      `edges=${resolver.edgesCreated}`,
      `cumulative=${resolver.elapsedMs}ms`,
      `unresolved=${resolver.unresolved}`,
      `ambiguous=${resolver.ambiguous}`,
      `broken=${resolver.brokenChain}`,
    ].join(" "),
  );
  const omittedCount = entries.length - selected.length;
  const omittedSuffix = omittedCount > 0 ? ` (+${omittedCount} more)` : "";
  return `    pass2.resolvers: ${selected.join("; ")}${omittedSuffix}`;
}

function formatProviderFirstLegacyFallbackResolverPhaseDiagnosticLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const entries = Object.entries(diagnostics.resolverBreakdown ?? {})
    .map(([resolverId, resolver]) => {
      const phaseEntries = Object.entries(resolver.phases ?? {})
        .filter(([, value]) => value > 0)
        .sort(([, left], [, right]) => right - left);
      return { resolverId, elapsedMs: resolver.elapsedMs, phaseEntries };
    })
    .filter((entry) => entry.phaseEntries.length > 0)
    .sort((left, right) => right.elapsedMs - left.elapsedMs);
  if (entries.length === 0) return undefined;
  const selected = entries.slice(0, 5).map((entry) => {
    const phases = entry.phaseEntries
      .map(([phaseName, durationMs]) => `${phaseName}=${durationMs}ms`)
      .join(",");
    return `${entry.resolverId} ${phases}`;
  });
  const omittedCount = entries.length - selected.length;
  const omittedSuffix = omittedCount > 0 ? ` (+${omittedCount} more)` : "";
  return `    pass2.resolverPhases: ${selected.join("; ")}${omittedSuffix}`;
}

function formatProviderFirstLegacyFallbackResolverMetricDiagnosticLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const entries = Object.entries(diagnostics.resolverBreakdown ?? {})
    .map(([resolverId, resolver]) => {
      const metricEntries = Object.entries(resolver.metrics ?? {})
        .filter(([, value]) => value > 0)
        .sort(([, left], [, right]) => right - left);
      return { resolverId, elapsedMs: resolver.elapsedMs, metricEntries };
    })
    .filter((entry) => entry.metricEntries.length > 0)
    .sort((left, right) => right.elapsedMs - left.elapsedMs);
  if (entries.length === 0) return undefined;
  const selected = entries.slice(0, 5).map((entry) => {
    const metrics = entry.metricEntries
      .slice(0, 20)
      .map(([metricName, value]) => `${metricName}=${value}`)
      .join(",");
    return `${entry.resolverId} ${metrics}`;
  });
  const omittedCount = entries.length - selected.length;
  const omittedSuffix = omittedCount > 0 ? ` (+${omittedCount} more)` : "";
  return `    pass2.resolverMetrics: ${selected.join("; ")}${omittedSuffix}`;
}

function formatProviderFirstLegacyFallbackResolverTopFilesDiagnosticLine(
  diagnostics: ProviderFirstLegacyFallbackDiagnostics,
): string | undefined {
  const entries = Object.entries(diagnostics.resolverBreakdown ?? {})
    .map(([resolverId, resolver]) => {
      const topFileEntries = Object.entries(resolver.topFiles ?? {})
        .filter(([, files]) => files.length > 0)
        .sort(([left], [right]) => left.localeCompare(right));
      return { resolverId, elapsedMs: resolver.elapsedMs, topFileEntries };
    })
    .filter((entry) => entry.topFileEntries.length > 0)
    .sort((left, right) => right.elapsedMs - left.elapsedMs);
  if (entries.length === 0) return undefined;
  const selected = entries.slice(0, 3).map((entry) => {
    const phases = entry.topFileEntries
      .slice(0, 6)
      .map(([phaseName, files]) => {
        const renderedFiles = files
          .map((file) => {
            const bytesSuffix =
              typeof file.bytes === "number" && Number.isFinite(file.bytes)
                ? `:${file.bytes}b`
                : "";
            return `${encodeURIComponent(file.filePath)}:${file.elapsedMs}ms${bytesSuffix}`;
          })
          .join("|");
        return `${phaseName}=[${renderedFiles}]`;
      })
      .join(",");
    return `${entry.resolverId} ${phases}`;
  });
  const omittedCount = entries.length - selected.length;
  const omittedSuffix = omittedCount > 0 ? ` (+${omittedCount} more)` : "";
  return `    pass2.resolverTopFiles: ${selected.join("; ")}${omittedSuffix}`;
}

function sumKnownLegacyFallbackDiagnosticPhases(
  phases: Record<string, number>,
): number {
  const phaseNames = new Set([
    ...PROVIDER_FIRST_LEGACY_FALLBACK_PHASE_LABELS.map(
      ([phaseName]) => phaseName,
    ),
    ...PROVIDER_FIRST_LEGACY_FALLBACK_DERIVED_LABELS.map(
      ([phaseName]) => phaseName,
    ),
    ...PROVIDER_FIRST_LEGACY_FALLBACK_OTHER_LABELS.map(
      ([phaseName]) => phaseName,
    ),
  ]);
  let total = 0;
  for (const phaseName of phaseNames) {
    const durationMs = phases[phaseName];
    if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
      total += durationMs;
    }
  }
  return total;
}

function hasFallbackDiagnosticChildPhase(
  phases: Record<string, number>,
  phaseName: string,
): boolean {
  const prefix = `${phaseName}.`;
  return Object.keys(phases).some((candidate) => candidate.startsWith(prefix));
}

function formatProviderFirstPhaseTimingLines(
  timings: ProviderFirstPhaseTimings,
): string[] {
  const phaseEntries = PROVIDER_FIRST_TIMING_LABELS.flatMap(
    ([phaseName, label]) => {
      const ms = timings.phases[phaseName];
      return typeof ms === "number" && Number.isFinite(ms)
        ? [{ phaseName, label, ms }]
        : [];
    },
  );
  const slowest = phaseEntries.reduce<
    { label: string; ms: number } | undefined
  >((current, entry) => {
    if (!current || entry.ms > current.ms) {
      return { label: entry.label, ms: entry.ms };
    }
    return current;
  }, undefined);
  const header = slowest
    ? `  Provider-first timings: total=${timings.totalMs}ms; slowest=${slowest.label} ${slowest.ms}ms`
    : `  Provider-first timings: total=${timings.totalMs}ms`;
  const lines = [header];
  if (phaseEntries.length > 0) {
    lines.push(
      `    ${phaseEntries
        .map((entry) => `${entry.label}=${entry.ms}ms`)
        .join(", ")}`,
    );
  }
  const providerCollectionEntries =
    PROVIDER_FIRST_PROVIDER_COLLECTION_TIMING_LABELS.flatMap(
      ([phaseName, label]) => {
        const ms = timings.phases[phaseName];
        return typeof ms === "number" && Number.isFinite(ms)
          ? [{ label, ms }]
          : [];
      },
    );
  if (providerCollectionEntries.length > 0) {
    lines.push(
      `    collect: ${providerCollectionEntries
        .map((entry) => `${entry.label}=${entry.ms}ms`)
        .join(", ")}`,
    );
  }
  const normalizeEntries = PROVIDER_FIRST_NORMALIZE_TIMING_LABELS.flatMap(
    ([phaseName, label]) => {
      const ms = timings.phases[phaseName];
      return typeof ms === "number" && Number.isFinite(ms)
        ? [{ label, ms }]
        : [];
    },
  );
  if (normalizeEntries.length > 0) {
    lines.push(
      `    collect.normalize: ${normalizeEntries
        .map((entry) => `${entry.label}=${entry.ms}ms`)
        .join(", ")}`,
    );
  }
  const materializeEntries = PROVIDER_FIRST_MATERIALIZE_TIMING_LABELS.flatMap(
    ([phaseName, label]) => {
      const ms = timings.phases[phaseName];
      return typeof ms === "number" && Number.isFinite(ms)
        ? [{ label, ms }]
        : [];
    },
  );
  if (materializeEntries.length > 0) {
    lines.push(
      `    materialize: ${materializeEntries
        .map((entry) => `${entry.label}=${entry.ms}ms`)
        .join(", ")}`,
    );
  }
  const symbolMaterializeEntries =
    PROVIDER_FIRST_SYMBOL_MATERIALIZE_TIMING_LABELS.flatMap(
      ([phaseName, label]) => {
        const ms = timings.phases[phaseName];
        return typeof ms === "number" && Number.isFinite(ms)
          ? [{ label, ms }]
          : [];
      },
    );
  if (symbolMaterializeEntries.length > 0) {
    lines.push(
      `    materialize.upsertSymbols: ${symbolMaterializeEntries
        .map((entry) => `${entry.label}=${entry.ms}ms`)
        .join(", ")}`,
    );
  }
  return lines;
}

function providerFirstProviderUnusableReasonLabel(code: string): string {
  switch (code) {
    case "missingCoverage":
      return "missing coverage fact";
    case "noUsableProviderSymbols":
      return "no usable provider symbols";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

function formatProviderFirstCallProofSample(sample: {
  relPath: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  expectedText?: string;
  actualText?: string;
}): string {
  const range =
    `${sample.range.startLine}:${sample.range.startCol}-` +
    `${sample.range.endLine}:${sample.range.endCol}`;
  const expected = sample.expectedText ?? "";
  const actual = sample.actualText ?? "";
  return (
    `${sample.relPath}:${range} ` +
    `expected "${escapeProviderFirstSampleText(expected)}", ` +
    `actual "${escapeProviderFirstSampleText(actual)}"`
  );
}

function escapeProviderFirstSampleText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function providerFirstCallProofReasonLabel(code: string): string {
  switch (code) {
    case "missingExpectedSymbolName":
      return "missing expected symbol name";
    case "sourceUnavailable":
      return "source unavailable";
    case "sourcePathOutsideRoot":
      return "source path outside repo";
    case "sourceRealPathOutsideRoot":
      return "source real path outside repo";
    case "sourceReadFailed":
      return "source read failed";
    case "sourceTooLarge":
      return "source file too large";
    case "multiLineRange":
      return "multi-line range";
    case "missingSourceLine":
      return "missing source line";
    case "rangeOutOfBounds":
      return "range out of bounds";
    case "symbolTextMismatch":
      return "symbol text mismatch";
    default:
      return "unknown";
  }
}

interface PrintableSummaryStats {
  generated: number;
  skipped: number;
  failed: number;
  totalCostUsd: number;
  provider?: string | null;
}

export function formatSummaryStatsLine(
  summaryStats: PrintableSummaryStats,
): string {
  const cost =
    summaryStats.provider === "api"
      ? " ($" + summaryStats.totalCostUsd.toFixed(4) + ")"
      : "";
  return (
    `  Summaries: ${summaryStats.generated} new${cost}, ` +
    `${summaryStats.skipped} cached, ${summaryStats.failed} failed`
  );
}

export function formatSemanticReadinessLines(
  semanticDeferred: boolean | null | undefined,
): string[] {
  return semanticDeferred ? ["  Semantic readiness: deferred"] : [];
}

function embeddingStageLabel(substage?: IndexProgressSubstage): string {
  return substage === "fileSummaryEmbeddings"
    ? "Summary Embeddings"
    : "Symbol Embeddings";
}

/**
 * Write a progress line to stdout, either in-place (TTY) or throttled
 * (non-TTY). When switching between stages, the previous line is finalized
 * with a newline so it remains visible in scrollback.
 */
function writeProgressLine(
  state: ProgressState,
  stageKey: string,
  line: string,
  pct: number | null,
  fileLine?: string,
  forcePrint = false,
): void {
  const stageChanged =
    state.currentStage !== null && state.currentStage !== stageKey;
  // Stage transition — finalize the previous line so the new stage starts
  // on a fresh line and scrollback shows all stages.
  if (stageChanged) {
    if (isTty()) {
      // Clear file line if present, then move to new line
      if (state.lastFileLine) {
        process.stdout.write("\n"); // Move past file line
      }
      process.stdout.write("\n");
    }
    state.lastLine = "";
    state.lastFileLine = "";
    state.lastPrintedPct = -1;
  }
  state.currentStage = stageKey;

  const sameContent =
    line === state.lastLine && (fileLine ?? "") === state.lastFileLine;
  if (sameContent) return;

  if (isTty()) {
    // If we previously had a file line, move up one line first
    if (state.lastFileLine) {
      process.stdout.write("\x1b[1A"); // Move cursor up one line
    }
    // \r returns to line start; \x1b[K clears from cursor to end of line.
    process.stdout.write(`\r${line}\x1b[K`);
    state.lastLine = line;
    // Write file line below if provided
    if (fileLine) {
      process.stdout.write(`\n    ${fileLine}\x1b[K`);
      state.lastFileLine = fileLine;
    } else if (state.lastFileLine) {
      // Clear old file line if we no longer have one
      process.stdout.write("\n\x1b[K\x1b[1A");
      state.lastFileLine = "";
    }
  } else {
    // Non-TTY: throttle to ~1% boundaries unless a bounded diagnostic stage
    // explicitly requests every update.
    // Large provider-first fallback runs can spend minutes before 10%; a
    // one-line-per-percent heartbeat keeps redirected CLI logs useful without
    // dumping every file.
    // Pass pct=null for "always print" lines (stage headers, spinners).
    if (
      forcePrint ||
      stageChanged ||
      pct === null ||
      pct === 100 ||
      pct - state.lastPrintedPct >= 1
    ) {
      console.log(line);
      if (fileLine) {
        console.log(`    ${fileLine}`);
      }
      state.lastLine = line;
      state.lastFileLine = fileLine ?? "";
      state.lastPrintedPct = pct ?? -1;
    }
  }
}

/** Finalize any in-flight progress line with a newline so output that follows starts cleanly. */
function finishProgress(state: ProgressState): void {
  if (state.currentStage !== null && isTty()) {
    // If we have a file line displayed, we're already on that line, so one \n is enough
    // Otherwise we need to move past the progress line
    if (state.lastFileLine) {
      process.stdout.write("\n");
    } else {
      process.stdout.write("\n");
    }
  }
  state.currentStage = null;
  state.lastLine = "";
  state.lastFileLine = "";
  state.lastPrintedPct = -1;
}

/**
 * Render a single IndexProgress event. Handles stages with a known total
 * (parsing, pass1, pass2, summaries, embeddings — drawn as a bar), stages
 * without progress (scanning — spinner/label), and the finalizing stage
 * which now carries explicit substages for the post-pass2 pipeline.
 */
/** @internal exported for tests; do not import from product code. */
export function renderIndexProgress(
  state: ProgressState,
  p: IndexProgress,
): void {
  const label = indexStageLabel(p.stage);
  let line: string;
  let pct: number | null = null;
  // Dedupe key includes substage so transitions inside `finalizing` are not
  // swallowed by the identical-stage check in writeProgressLine.
  const stageKey = `${p.stage}:${p.substage ?? ""}`;

  // Drop accumulated per-model embedding state when the active stage moves
  // away from embeddings — keeps a re-entered embeddings phase (a second
  // index.refresh) from showing a stale combined line.
  if (p.stage !== "embeddings" && state.embeddingsByModel.size > 0) {
    state.embeddingsByModel.clear();
  }

  if (p.stage === "scanning") {
    line = `  ${label}...`;
  } else if (p.stage === "parsing") {
    // parsing fires only once with current=0 before pass1 begins; show file
    // count without a progress bar to avoid the misleading 0% that never updates.
    line = `  Parsing ${p.total} files:`;
  } else if (p.stage === "scipIngest") {
    // SCIP emits two phase shapes: an `externals` phase with a known total
    // (rendered as a percentage bar) and a streaming `documents` phase with
    // no upfront total (rendered as a counter via `message`). Without this
    // branch the documents phase falls through to the generic "no total"
    // case and shows just `SCIP ingest...` for the entire ingest, which
    // looks indistinguishable from a hang on multi-MB index files.
    if (p.total > 0) {
      pct = Math.min(100, Math.floor((p.current / p.total) * 100));
      const bar = buildBar(pct);
      line = `  ${label}: ${bar} ${String(pct).padStart(3)}% (${p.current}/${p.total})`;
    } else if (p.message) {
      line = `  ${label} — ${p.message}`;
    } else {
      line = `  ${label}...`;
    }
  } else if (p.stage === "providerFirst") {
    const subLabel = providerFirstSubstageLabel(p.substage);
    const stageCur = p.stageCurrent;
    const stageTot = p.stageTotal;
    if (
      typeof stageCur === "number" &&
      typeof stageTot === "number" &&
      stageTot > 0
    ) {
      pct = Math.min(100, Math.floor((stageCur / stageTot) * 100));
      const bar = buildBar(pct);
      line = `  ${subLabel}: ${bar} ${String(pct).padStart(3)}% (${stageCur}/${stageTot})`;
      if (p.message) line += ` — ${p.message}`;
    } else if (p.message) {
      line = `  ${subLabel} — ${p.message}`;
    } else {
      line = `  ${subLabel}...`;
    }
  } else if (p.stage === "finalizing") {
    const subLabel = p.substage ? indexSubstageLabel(p.substage) : "Finalizing";
    const stageCur = p.stageCurrent;
    const stageTot = p.stageTotal;
    if (
      typeof stageCur === "number" &&
      typeof stageTot === "number" &&
      stageTot > 0
    ) {
      pct = Math.min(100, Math.floor((stageCur / stageTot) * 100));
      const bar = buildBar(pct);
      line = `  ${subLabel}: ${bar} ${String(pct).padStart(3)}% (${stageCur}/${stageTot})`;
    } else if (p.message) {
      line = `  ${subLabel} — ${p.message}`;
    } else {
      line = `  ${subLabel}...`;
    }
  } else if (p.stage === "embeddings") {
    if (
      state.currentStage !== null &&
      state.currentStage !== stageKey &&
      state.currentStage.startsWith("embeddings:")
    ) {
      state.embeddingsByModel.clear();
    }
    // Per-model rendering: each model's progress lives in its own column of
    // a single status line. Two models emitting interleaved events used to
    // overwrite each other's counts, producing a flickering current-value
    // (e.g. 21 → 25 → 22 → 26). The Map preserves insertion order so the
    // displayed columns stay stable across updates.
    const modelKey = p.model ?? "default";
    state.embeddingsByModel.set(
      modelKey,
      p.message
        ? { current: p.current, total: p.total, message: p.message }
        : { current: p.current, total: p.total },
    );
    const segments: string[] = [];
    let combinedCurrent = 0;
    let combinedTotal = 0;
    for (const [model, st] of state.embeddingsByModel) {
      const modelLabel = shortModelLabel(model);
      if (st.message) {
        segments.push(`${modelLabel}: ${st.message}`);
      } else if (st.total > 0) {
        const modelPct = Math.min(
          100,
          Math.floor((st.current / st.total) * 100),
        );
        const bar = buildBar(modelPct, 12);
        segments.push(
          `${modelLabel} ${bar} ${String(modelPct).padStart(3)}% (${st.current}/${st.total})`,
        );
      } else {
        segments.push(`${modelLabel}...`);
      }
      if (!st.message) {
        combinedCurrent += st.current;
        combinedTotal += st.total;
      }
    }
    if (combinedTotal > 0) {
      pct = Math.min(100, Math.floor((combinedCurrent / combinedTotal) * 100));
    }
    if (p.message) pct = null;
    line = `  ${embeddingStageLabel(p.substage)}: ${segments.join(" | ")}`;
  } else if (p.total > 0) {
    pct = Math.min(100, Math.floor((p.current / p.total) * 100));
    const bar = buildBar(pct);
    line = `  ${label}: ${bar} ${String(pct).padStart(3)}% (${p.current}/${p.total})`;
  } else {
    line = `  ${label}...`;
  }

  const forcePrint =
    p.stage === "pass1" && p.total > 0 && p.total <= 5000 && p.currentFile;
  writeProgressLine(
    state,
    stageKey,
    line,
    pct,
    p.currentFile,
    Boolean(forcePrint),
  );
}

interface DelegatedIndexResult {
  ok: boolean;
  message?: string;
}

function isDispatchQueueTimeoutMessage(message: string | undefined): boolean {
  return /Tool dispatch queue timed out/.test(message ?? "");
}

/**
 * Delegate indexing for a single repo to the running HTTP server via SSE.
 * When delegation fails the caller reports a retryable server-side failure
 * instead of opening the graph DB directly while the live server owns its lock.
 */
async function delegateIndexToServer(
  server: PidfileData,
  repoId: string,
  mode: "full" | "incremental",
): Promise<DelegatedIndexResult> {
  console.log(
    `  Delegating to running server (PID ${server.pid}, port ${server.port})...`,
  );

  const wallStartedAt = Date.now();
  const progressState = createProgressState();
  let completed = false;
  let serverError: string | undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (server.authToken) {
    headers.Authorization = `Bearer ${server.authToken}`;
  }

  try {
    await connectSSE({
      host: "localhost",
      port: server.port!,
      path: `/api/repo/${encodeURIComponent(repoId)}/reindex-stream`,
      method: "POST",
      headers,
      body: JSON.stringify({ mode }),
      onEvent: (evt: SSEEvent) => {
        if (evt.event === "progress") {
          try {
            // The server forwards every stage the indexer emits
            // (scanning/parsing/pass1/pass2/finalizing/summaries/embeddings),
            // so cast to IndexProgress once validated and defer all
            // formatting to the shared renderer.
            const p = JSON.parse(evt.data) as {
              stage: IndexProgress["stage"];
              current: number;
              total: number;
              currentFile?: string;
              substage?: IndexProgressSubstage;
              stageCurrent?: number;
              stageTotal?: number;
              message?: string;
              model?: string;
            };
            renderIndexProgress(progressState, p);
          } catch {
            // Skip malformed SSE event
          }
        } else if (evt.event === "complete") {
          // Finalize the in-flight progress line so summary prints cleanly.
          finishProgress(progressState);
          try {
            const c = JSON.parse(evt.data) as {
              filesProcessed: number;
              symbolsIndexed: number;
              totalSymbols: number;
              edgesCreated: number;
              totalEdges: number;
              durationMs: number;
              providerFirstExecution?: {
                status: "executed" | "fallback" | "unsupported";
                executor?: string;
                generationId?: string;
                reasons: string[];
                filesProcessed: number;
                symbolsIndexed: number;
                edgesCreated: number;
                externalSymbolsIndexed: number;
                shadowBuild?: ProviderFirstExecutionSummary["shadowBuild"];
                coverage?: ProviderFirstExecutionSummary["coverage"];
                phaseTimings?: ProviderFirstExecutionSummary["phaseTimings"];
              } | null;
              semanticDeferred?: boolean | null;
              summaryStats?: {
                generated: number;
                totalCostUsd: number;
                skipped: number;
                failed: number;
              } | null;
              scip?: IndexResult["scip"] | null;
              runtimeIdentity?: RuntimeIdentity | null;
            };
            if (c.runtimeIdentity) {
              console.log(
                formatRuntimeIdentityLine(
                  c.runtimeIdentity,
                  "  Server runtime",
                ),
              );
            }
            for (const line of formatProviderFirstExecutionSummaryLines(
              c.providerFirstExecution,
            )) {
              console.log(line);
            }
            for (const line of formatSemanticReadinessLines(
              c.semanticDeferred,
            )) {
              console.log(line);
            }
            console.log(`  Files: ${c.filesProcessed}`);
            console.log(
              `  Symbols: ${c.symbolsIndexed} new (${c.totalSymbols} total)`,
            );
            console.log(
              `  Edges: ${c.edgesCreated} new (${c.totalEdges} total)`,
            );
            console.log(`  Duration: ${c.durationMs}ms`);
            console.log(
              formatIndexWallTimeLine(Date.now() - wallStartedAt, c.durationMs),
            );
            const cacheLine = formatScipGeneratorCacheLine(
              c.scip?.generatorCache,
            );
            if (cacheLine) console.log(cacheLine);
            if (c.summaryStats) {
              const s = c.summaryStats;
              console.log(formatSummaryStatsLine(s));
            }
            completed = true;
          } catch {
            // Skip malformed SSE event
          }
        } else if (evt.event === "error") {
          // Finalize any in-flight progress line so the error message isn't
          // glued to a half-written stage bar.
          finishProgress(progressState);
          try {
            const e = JSON.parse(evt.data) as { message: string };
            serverError = e.message;
            console.error(`  Error from server: ${serverError}`);
          } catch {
            serverError = "Server sent a malformed indexing error event.";
          }
        }
      },
    });

    // Defensive finalize in case the SSE stream closed without emitting
    // complete/error (network drop, server crash).
    finishProgress(progressState);
    if (completed) {
      return { ok: true };
    }
    return {
      ok: false,
      message:
        serverError ?? "Delegated indexing stream closed before completion.",
    };
  } catch (error) {
    finishProgress(progressState);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to delegate to server: ${msg}`);
    return { ok: false, message: msg };
  }
}

async function cleanupOneShotIndexing(
  dbInitialized: boolean,
  derivedRefreshDisabled: boolean,
): Promise<void> {
  try {
    await shutdownDerivedRefreshQueue();
    if (dbInitialized) {
      await closeLadybugDb();
    }
  } finally {
    if (derivedRefreshDisabled) {
      enableDerivedRefreshQueue();
    }
  }
}

export function canDelegateIndexToServer(
  existing: PidfileData | null,
  httpAuthEnabled: boolean,
): existing is PidfileData & { transport: "http"; port: number } {
  if (!existing || existing.transport !== "http" || existing.port == null) {
    return false;
  }

  // Auth-disabled HTTP servers intentionally omit authToken from the pidfile.
  // Delegating avoids opening LadybugDB directly while the server owns the lock.
  if (!httpAuthEnabled) {
    return true;
  }

  return (
    typeof existing.authToken === "string" && existing.authToken.length > 0
  );
}

export function formatIndexStartupLines(params: {
  repoCount: number;
  runtimeIdentity: RuntimeIdentity;
  graphDbPath: string;
}): string[] {
  return [
    `Indexing ${params.repoCount} repo(s)...`,
    formatRuntimeIdentityLine(params.runtimeIdentity),
    `Graph DB: ${normalizePath(params.graphDbPath)}`,
  ];
}

export async function indexCommand(options: IndexOptions): Promise<void> {
  printBanner();

  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  // Check if an HTTP server is already running on this database.
  const graphDbPath = resolveGraphDbPath(config, configPath);
  const existing = findExistingProcess(graphDbPath);

  const canDelegate = canDelegateIndexToServer(
    existing,
    config.httpAuth?.enabled === true,
  );

  if (canDelegate) {
    console.log(
      `Detected running SDL-MCP HTTP server (PID ${existing.pid}, port ${existing.port}).`,
    );
    console.log("Delegating indexing to the running server.\n");

    if (options.watch) {
      console.log(
        "Note: --watch flag is ignored when delegating to a running server " +
          "(the server manages its own file watchers).\n",
      );
    }
  }

  const reposToIndex = options.repoId
    ? config.repos.filter((r) => r.repoId === options.repoId)
    : config.repos;

  if (reposToIndex.length === 0) {
    console.error(
      options.repoId
        ? `Repository not found: ${options.repoId}`
        : "No repositories configured",
    );
    await closeLadybugDb();
    process.exit(1);
  }

  for (const line of formatIndexStartupLines({
    repoCount: reposToIndex.length,
    runtimeIdentity: createRuntimeIdentity(import.meta.url),
    graphDbPath,
  })) {
    console.log(line);
  }

  // If we cannot delegate, initialize the DB for direct indexing. When a live
  // HTTP server owns the graph DB, failed delegation remains a retryable
  // server-side error instead of falling through to local DB initialization.
  let dbInitialized = false;
  if (!canDelegate) {
    await initGraphDb(config, configPath);
    await loadConfiguredAdapterPlugins(config, configPath, (message) => {
      console.log(message);
    });
    dbInitialized = true;
  }

  const errors: Array<{ repoId: string; error: string }> = [];
  const isOneShot = !options.watch;
  let derivedRefreshDisabled = false;
  if (isOneShot) {
    // One-shot CLI invocations should mark derived state dirty but must not
    // start background work that keeps the command prompt alive after indexing.
    disableDerivedRefreshQueue();
    derivedRefreshDisabled = true;
  }

  for (const repo of reposToIndex) {
    const requestedMode = options.force ? "full" : "incremental";

    // Try delegating to the running server first. The server auto-upgrades
    // 'incremental' → 'full' when the repo has no indexed files (see
    // indexRepoImpl), so we display the requested mode and trust the server
    // to do the right thing — its log surfaces the upgrade if it fires.
    if (canDelegate) {
      console.log(
        `\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${requestedMode}]...`,
      );
      const delegated = await delegateIndexToServer(
        existing,
        repo.repoId,
        requestedMode,
      );
      if (delegated.ok) {
        continue;
      }
      // Delegation failed while the live server owns the graph DB lock.
      const delegationMessage =
        delegated.message ?? "Delegated indexing did not complete.";
      console.error(
        `  Delegated indexing did not complete: ${delegationMessage}`,
      );
      console.error(
        "  Not falling back to direct indexing because the HTTP server owns the graph DB lock.",
      );
      if (isDispatchQueueTimeoutMessage(delegationMessage)) {
        console.error(
          "  Retry after deferred server work finishes. Increase concurrency.toolQueueTimeoutMs only if longer foreground waits are acceptable.",
        );
      }
      errors.push({
        repoId: repo.repoId,
        error: `Delegation to running HTTP server failed: ${delegationMessage}`,
      });
      continue;
    }

    // Direct indexing path (original behavior).
    const conn = await getLadybugConn();

    const existingRepo = await ladybugDb.getRepo(conn, repo.repoId);

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertRepo(wConn, {
        repoId: repo.repoId,
        rootPath: repo.rootPath,
        configJson: JSON.stringify(repo),
        createdAt: existingRepo?.createdAt ?? getCurrentTimestamp(),
      });
    });

    const directMode = options.force || !existingRepo ? "full" : "incremental";

    // Direct-path display reflects the actual mode that will run — fresh
    // repos correctly show `[mode=full]` even without --force. If we got
    // here via delegation fallback the requested-mode line was already
    // printed; otherwise this is the first per-repo banner.
    if (!canDelegate) {
      console.log(
        `\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${directMode}]...`,
      );
    }
    if (!existingRepo) {
      console.log(`  Registering repository: ${repo.repoId}`);
    }

    try {
      // Shared progress state across indexer + SCIP so stage transitions
      // between them (e.g. embeddings -> SCIP externals) produce a clean
      // newline boundary in TTY mode.
      const progressState = createProgressState();
      const wallStartedAt = Date.now();
      const stats: IndexResult = await indexRepo(
        repo.repoId,
        directMode,
        (progress) => {
          renderIndexProgress(progressState, progress);
        },
        undefined,
        { includeTimings: Boolean(options.diagnostics) },
      );
      // Finalize the last indexer stage line before printing summary lines.
      finishProgress(progressState);
      const statsConn = await getLadybugConn();
      const totalSymbols = await ladybugDb.getSymbolCount(
        statsConn,
        repo.repoId,
      );
      const totalEdges = await ladybugDb.getEdgeCount(statsConn, repo.repoId);
      for (const line of formatProviderFirstExecutionSummaryLines(
        stats.providerFirstExecution,
      )) {
        console.log(line);
      }
      for (const line of formatSemanticReadinessLines(stats.semanticDeferred)) {
        console.log(line);
      }
      console.log(`  Files: ${stats.filesProcessed}`);
      console.log(
        `  Symbols: ${stats.symbolsIndexed} new (${totalSymbols} total)`,
      );
      console.log(`  Edges: ${stats.edgesCreated} new (${totalEdges} total)`);
      console.log(`  Duration: ${stats.durationMs}ms`);
      console.log(
        formatIndexWallTimeLine(Date.now() - wallStartedAt, stats.durationMs),
      );
      const cacheLine = formatScipGeneratorCacheLine(
        stats.scip?.generatorCache,
      );
      if (cacheLine) console.log(cacheLine);
      if (stats.scip) {
        const skippedGenerated = stats.scip.generatedIndexes.filter(
          (index) => index.skipped,
        );
        for (const index of skippedGenerated) {
          console.log(
            `  SCIP skipped ${index.path}: ${index.skipReason ?? "skipped"} (${index.sizeBytes} bytes)`,
          );
        }
        for (const failure of stats.scip.failures) {
          console.log(formatScipFailureLine(failure));
        }
      }
      if (stats.summaryStats) {
        const s = stats.summaryStats;
        console.log(formatSummaryStatsLine(s));
      }

      if (options.diagnostics && stats.timings) {
        console.log(`\n  Timings (total=${stats.timings.totalMs}ms):`);
        const entries = Object.entries(stats.timings.phases)
          .filter(
            ([phase]) => !isProviderFirstLegacyFallbackCounterPhase(phase),
          )
          .sort((a, b) => b[1] - a[1]);
        for (const [phase, ms] of entries) {
          console.log(`    ${ms.toString().padStart(6)}ms  ${phase}`);
        }
        if (stats.timings.pass1Drain) {
          const drain = stats.timings.pass1Drain;
          console.log(
            `\n  Pass 1 write batches: ${drain.batches} batch(es), ${drain.rows.total} row(s), ${drain.totalMs}ms write wall`,
          );
          console.log(
            `    rows: files=${drain.rows.files}, symbols=${drain.rows.symbols}, refs=${drain.rows.refs}, edges=${drain.rows.edges}, existingFiles=${drain.rows.existingFiles}`,
          );
          const writeEntries = Object.entries(drain.phases).sort(
            (a, b) => b[1].totalMs - a[1].totalMs,
          );
          for (const [phase, detail] of writeEntries) {
            console.log(
              `    ${detail.totalMs.toString().padStart(6)}ms  ${phase} (${detail.rows} row(s), ${detail.count} call(s), max=${detail.maxMs}ms)`,
            );
          }
          if (drain.largestBatch) {
            console.log(
              `    largest batch: ${drain.largestBatch.rows} row(s), ${drain.largestBatch.totalMs}ms`,
            );
          }
        }
      }

      // Incremental runs defer cluster/process/algorithm/summary/embedding
      // recompute; surface that explicitly so the operator knows derived
      // state lags after this run.
      if (options.diagnostics) {
        try {
          const { getDerivedStateSummary } =
            await import("../../db/ladybug-derived-state.js");
          const ds = await getDerivedStateSummary(repo.repoId);
          if (ds?.stale) {
            const flags = [
              ds.clustersDirty && "clusters",
              ds.processesDirty && "processes",
              ds.algorithmsDirty && "algorithms",
              ds.summariesDirty && "summaries",
              ds.embeddingsDirty && "embeddings",
            ]
              .filter((x): x is string => Boolean(x))
              .join(", ");
            console.log(`  Derived-state deferred: ${flags}`);
          }
        } catch {
          // Non-fatal: diagnostics reporting is best-effort.
        }
      }

      // SCIP provider facts are now collected by provider-first indexing.
      // The CLI does not run a post-refresh SCIP block; doing so would
      // reintroduce legacy overlay ingestion outside the provider-first
      // ownership boundary.
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Error indexing: ${msg}`);
      errors.push({ repoId: repo.repoId, error: msg });
    }
  }

  // Announce watch mode intention only if all repos indexed successfully
  if (options.watch && errors.length === 0) {
    for (const repo of reposToIndex) {
      console.log(`  File watcher will start for ${repo.repoId}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nFailed to index ${errors.length} repo(s):`);
    for (const e of errors) {
      console.error(`  - ${e.repoId}: ${e.error}`);
    }
    await cleanupOneShotIndexing(dbInitialized, derivedRefreshDisabled);
    process.exit(1);
  }

  if (options.watch && !canDelegate) {
    console.log("\nWatching for file changes (Ctrl+C to stop)...");

    const watchers: IndexWatchHandle[] = [];
    const results = await Promise.allSettled(
      reposToIndex.map(async (repo) => {
        try {
          return {
            repoId: repo.repoId,
            handle: await watchRepository(repo.repoId),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`[${repo.repoId}] ${msg}`);
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        watchers.push(result.value.handle);
      } else {
        console.error(`Failed to start watcher: ${String(result.reason)}`);
      }
    }

    console.log(`Watching ${watchers.length} repo(s)`);

    let shutdownCalled = false;
    const shutdown = async (): Promise<void> => {
      if (shutdownCalled) {
        return;
      }
      shutdownCalled = true;
      console.log("\nStopping watchers...");
      for (const watcher of watchers) {
        await watcher.close();
      }
      await shutdownDerivedRefreshQueue();
      await closeLadybugDb();
      process.exit(0);
    };

    const handleShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
      void shutdown().catch((error) => {
        console.error(
          `Failed to handle ${signal}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      });
    };

    process.once("SIGINT", () => handleShutdown("SIGINT"));
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));

    await new Promise(() => {});
  }

  if (!options.watch) {
    await cleanupOneShotIndexing(dbInitialized, derivedRefreshDisabled);
  }

  console.log("\n✓ Indexing complete");
}
