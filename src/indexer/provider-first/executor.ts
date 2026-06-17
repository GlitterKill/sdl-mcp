import { deserialize, serialize } from "node:v8";
import { hash } from "node:crypto";
import {
  access,
  readdir,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_FILE_BYTES } from "../../config/constants.js";
import type {
  AppConfig,
  ScipConfig,
  SemanticEnrichmentLspServerConfig,
} from "../../config/types.js";
import type { Range } from "../../domain/types.js";
import type {
  Diagnostic,
  DocumentSymbol,
  DocumentSymbolParams,
  InitializeResult,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import { createScipDecoder } from "../../scip/decoder-factory.js";
import {
  isClangStyleSymbolScheme,
  parseScipSymbol,
} from "../../scip/kind-mapping.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
} from "../../scip/diagnostics.js";
import {
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from "../../scip/symbol-matcher.js";
import type { ScipDocument, ScipExternalSymbol } from "../../scip/types.js";
import { logger } from "../../util/logger.js";
import { hashValue } from "../../util/hashing.js";
import { getRelativePath, normalizePath } from "../../util/paths.js";
import type { IndexProgress, IndexProgressSubstage } from "../indexer-init.js";
import type { Pass2ResolverTelemetry } from "../edge-builder/telemetry.js";
import {
  normalizeScipProviderFacts,
  PROVIDER_FIRST_OCCURRENCE_FACT_RETENTION_LIMIT,
  type SourceLineUnavailableReasonByPath,
  type SourceLinesByPath,
} from "./scip-normalizer.js";
import {
  providerFactsToGraphRows,
  providerFirstGraphRowTotal,
  type ProviderFirstGraphRows,
} from "./materializer.js";
import { validateProviderFirstGraphRows } from "./graph-validation.js";
import type { ProviderFirstShadowBuildSummary } from "./shadow-build.js";
import type {
  CallProofUnavailableReasonCode,
  ProviderFactSet,
  ProviderFactBase,
  ProviderFirstPipelineSelection,
} from "./types.js";
import {
  SemanticLspClient,
  type LspClientOptions,
} from "../../semantic/providers/lsp/client.js";
import {
  normalizeLspProviderFacts,
  type LspProviderDocument,
} from "./lsp-normalizer.js";

const SOURCE_TEXT_READ_CONCURRENCY = 32;
const SOURCE_TEXT_IMPORT_ALIAS_BLOCK_SCAN_LIMIT = 80;
const CPP_CALL_PROOF_LINE_WINDOW_RADIUS = 2;
const PROVIDER_FIRST_DOCUMENT_PROGRESS_INTERVAL = 250;
const PROVIDER_FIRST_SOURCE_LINE_PROGRESS_INTERVAL = 250;
const PROVIDER_FIRST_PROGRESS_HEARTBEAT_MS = 2_000;
const PROVIDER_COLLECTION_CACHE_SCHEMA_VERSION = 1;
const PROVIDER_COLLECTION_CACHE_NORMALIZER_VERSION = 1;
const DEFAULT_PROVIDER_COLLECTION_CACHE_DIR = join(
  homedir(),
  ".sdl-mcp",
  "cache",
  "provider-first",
);
type ProviderFirstPhaseTimingRecorder = (
  phaseName: string,
  durationMs: number,
) => void;

export type ProviderFirstExecutorKind = "scipFull" | "lspFull";
export type ProviderFirstFallbackReasonCode =
  | "incrementalUnsupported"
  | "lspUnsupported"
  | "providerUnavailable";

export interface ProviderFirstCoverageSummary {
  scannedFiles: number;
  semanticEligibleFiles?: number;
  providerFiles: number;
  providerCoveredFiles?: number;
  providerPrimaryFiles: number;
  fullyCoveredFiles: number;
  partialFiles: number;
  ignoredProviderFiles?: number;
  ignoredProviderFileSamples?: string[];
  callProofIncompleteFiles?: number;
  callProofIncompleteReasons?: ProviderFirstCallProofIssueSummary[];
  providerUnusableReasons?: ProviderFirstProviderUnusableReasonSummary[];
  fullFallbackFiles: number;
  uncoveredFiles: number;
  legacyFallbackSkippedFiles?: number;
  legacyFallbackFileLimit?: number;
  semanticEligibleFallbackFiles?: number;
  semanticEligibleFallbackFileLimit?: number;
  fallbackFiles: number;
  semanticEligibilityGap?: ProviderFirstSemanticEligibilityGapSummary;
}

export interface ProviderFirstSemanticEligibilityGapSummary {
  totalFiles: number;
  uncoveredFiles: number;
  providerUnusableFiles: number;
  outsideSemanticEligibilityFiles: number;
  semanticEligibleUncoveredSamples: string[];
  semanticEligibleProviderUnusableSamples: string[];
  outsideSemanticEligibilitySamples: string[];
}

export type ProviderFirstProviderUnusableReasonCode =
  | "missingCoverage"
  | "noUsableProviderSymbols"
  | "unknown";

export interface ProviderFirstProviderUnusableReasonSummary {
  code: ProviderFirstProviderUnusableReasonCode;
  files: number;
  samplePaths: string[];
  skippedSymbolReasons?: ProviderFirstSkippedSymbolReasonSummary[];
}

export interface ProviderFirstSkippedSymbolReasonSummary {
  reason: string;
  symbols: number;
  samplePaths: string[];
}

export interface ProviderFirstCallProofIssueSummary {
  code: CallProofUnavailableReasonCode;
  references: number;
  files: number;
  samplePaths: string[];
  samples?: ProviderFirstCallProofIssueSample[];
}

export interface ProviderFirstCallProofIssueSample {
  relPath: string;
  range: Range;
  expectedText?: string;
  actualText?: string;
}

export interface ProviderFirstExecutionPlan {
  canExecute: boolean;
  shouldFallbackToLegacy: boolean;
  executor?: ProviderFirstExecutorKind;
  fallbackReasonCode?: ProviderFirstFallbackReasonCode;
  reasons: string[];
}

export interface ProviderFirstExecutionSummary {
  status: "executed" | "fallback" | "unsupported";
  executor?: ProviderFirstExecutorKind;
  generationId?: string;
  reasons: string[];
  filesProcessed: number;
  symbolsIndexed: number;
  edgesCreated: number;
  externalSymbolsIndexed: number;
  shadowBuild?: ProviderFirstShadowBuildSummary;
  coverage?: ProviderFirstCoverageSummary;
  phaseTimings?: ProviderFirstPhaseTimings;
  legacyFallbackDiagnostics?: ProviderFirstLegacyFallbackDiagnostics;
}

export interface ProviderFirstPhaseTimings {
  totalMs: number;
  phases: Record<string, number>;
}

export interface ProviderFirstLegacyFallbackDiagnostics {
  files: number;
  durationMs: number;
  averageMsPerFile: number;
  samplePaths: string[];
  omittedPathCount?: number;
  phases: Record<string, number>;
  pass1Drain?: import("../parser/batch-persist.js").BatchPersistDrainDiagnostics;
  pass2WriteStats?: ProviderFirstLegacyFallbackPass2WriteStats;
  resolverBreakdown?: Record<string, Pass2ResolverTelemetry>;
}

export interface ProviderFirstLegacyFallbackPass2WriteStats {
  flushes?: number;
  totalEdges?: number;
  incrementalEdges?: number;
  knownEndpointEdges?: number;
  repairEdges?: number;
  copyFlushes?: number;
  copyEdges?: number;
  copyPlaceholderTargets?: number;
  copyPlaceholderRows?: number;
  copyEnsuredPlaceholderRows?: number;
  copySkippedPlaceholderRows?: number;
  copyUnresolvedPlaceholderRows?: number;
  copyExternalPlaceholderRows?: number;
  copyEnsureMs?: number;
  copyEnsureSymbolMetadataMs?: number;
  copyEnsureSymbolProbeMs?: number;
  copyEnsureSymbolCopyMissingCsvMs?: number;
  copyEnsureSymbolCopyMissingFromMs?: number;
  copyEnsureSymbolMatchExistingMs?: number;
  copyEnsureSymbolMergeFallbackMs?: number;
  copyEnsureRepoLinkMs?: number;
  copyInsertMs?: number;
  copyInsertCsvMaterializeMs?: number;
  copyInsertCopyFromMs?: number;
  smallKnownEndpointFlushes?: number;
  smallKnownEndpointEdges?: number;
  repairUnresolvedSourceEdges?: number;
  repairUnsafeSourceEndpointEdges?: number;
  repairUnsafeTargetEndpointEdges?: number;
  repairUnsafeBothEndpointEdges?: number;
  repairOtherCauseEdges?: number;
  repairFlushes?: number;
  repairInsertEdges?: number;
  repairInsertMs?: number;
}

export interface ProviderFirstScipExecutionResult {
  generationId: string;
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
  summary: ProviderFirstExecutionSummary;
}

export interface ProviderFirstLspExecutionResult {
  generationId: string;
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
  summary: ProviderFirstExecutionSummary;
}

export interface ProviderFirstLspClientLike {
  start(timeoutMs?: number): Promise<InitializeResult>;
  openDocument(document: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  }): Promise<void>;
  documentSymbol(
    params: DocumentSymbolParams,
    timeoutMs?: number,
  ): Promise<Array<DocumentSymbol | SymbolInformation> | null>;
  diagnostics?(uri: string): Diagnostic[];
  pullDiagnostics?(uri: string, timeoutMs?: number): Promise<Diagnostic[]>;
  waitForDiagnostics?(
    uris: readonly string[],
    timeoutMs: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

interface ExecuteProviderFirstScipFullParams {
  repoId: string;
  repoRoot: string;
  config: AppConfig;
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  generatorCacheKey?: string;
  scannedPaths?: readonly string[];
  scannedFiles?: readonly ProviderFirstSourceFileMetadata[];
  recordPhaseTiming?: ProviderFirstPhaseTimingRecorder;
  onProgress?: (progress: {
    stage: IndexProgress["stage"];
    current: number;
    total: number;
    substage?: IndexProgressSubstage;
    stageCurrent?: number;
    stageTotal?: number;
    message?: string;
  }) => void;
  signal?: AbortSignal;
}

interface ExecuteProviderFirstLspFullParams {
  repoId: string;
  repoRoot: string;
  config: AppConfig;
  scannedFiles?: readonly ProviderFirstSourceFileMetadata[];
  recordPhaseTiming?: ProviderFirstPhaseTimingRecorder;
  clientFactory?: (options: LspClientOptions) => ProviderFirstLspClientLike;
  signal?: AbortSignal;
}

interface CollectedLspProviderDocument extends LspProviderDocument {
  uri: string;
  text: string;
  symbols?: Array<DocumentSymbol | SymbolInformation>;
  diagnostics?: Diagnostic[];
}

interface ProviderFirstSourceFileMetadata {
  path: string;
  size: number;
  contentHash: string;
}

type ProviderFirstProgressCallback =
  ExecuteProviderFirstScipFullParams["onProgress"];

function emitProviderFirstProgress(
  onProgress: ProviderFirstProgressCallback,
  substage: IndexProgressSubstage,
  options: {
    current?: number;
    total?: number;
    stageCurrent?: number;
    stageTotal?: number;
    message?: string;
  } = {},
): void {
  const stageCurrent = options.stageCurrent ?? options.current;
  const stageTotal = options.stageTotal ?? options.total;
  onProgress?.({
    stage: "providerFirst",
    current: options.current ?? stageCurrent ?? 0,
    total: options.total ?? stageTotal ?? 0,
    substage,
    ...(stageCurrent !== undefined ? { stageCurrent } : {}),
    ...(stageTotal !== undefined ? { stageTotal } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
  });
}

export function resolveProviderFirstExecutionPlan(params: {
  selection: ProviderFirstPipelineSelection;
  mode: "full" | "incremental";
  scip?: ScipConfig;
}): ProviderFirstExecutionPlan {
  const { selection, mode, scip } = params;
  if (selection.selectedPipeline === "legacy") {
    return {
      canExecute: false,
      shouldFallbackToLegacy: true,
      reasons: ["provider-first pipeline was not selected"],
    };
  }

  const explicitProviderFirst = selection.requestedMode === "providerFirst";
  const fallbackAllowed = !explicitProviderFirst;
  const selectedSources = selection.sources.filter(
    (source) => source.type !== "legacy",
  );
  const hasScipSource = selectedSources.some(
    (source) => source.type === "scip",
  );
  const hasLspSource = selectedSources.some((source) => source.type === "lsp");

  if (mode !== "full") {
    return unsupportedPlan({
      fallbackAllowed: fallbackAllowed || selectedSources.length > 0,
      fallbackReasonCode: "incrementalUnsupported",
      reason:
        "provider-first execution currently supports full refreshes only; incremental provider generations are not materialized yet",
    });
  }

  if (hasScipSource && scipExecutionConfigured(scip)) {
    return {
      canExecute: true,
      shouldFallbackToLegacy: false,
      executor: "scipFull",
      reasons: [],
    };
  }

  if (hasLspSource && !hasScipSource) {
    return {
      canExecute: true,
      shouldFallbackToLegacy: false,
      executor: "lspFull",
      reasons: [],
    };
  }

  return unsupportedPlan({
    fallbackAllowed,
    fallbackReasonCode: "providerUnavailable",
    reason:
      "provider-first execution needs a configured SCIP index or enabled SCIP generator",
  });
}

export async function executeProviderFirstScipFull(
  params: ExecuteProviderFirstScipFullParams,
): Promise<ProviderFirstScipExecutionResult> {
  const generationId = `provider-first:${Date.now()}`;
  const measureCollectionPhase = providerFirstPhaseMeasurer(
    params.recordPhaseTiming,
  );
  const indexedAt = new Date().toISOString();
  const cacheContext = providerCollectionCacheContext({
    repoId: params.repoId,
    repoRoot: params.repoRoot,
    scip: params.config.scip,
    generatedIndexes: params.generatedIndexes ?? [],
    generatorCacheKey: params.generatorCacheKey,
    sourceTextMaxBytes: resolveSourceTextMaxBytes(
      params.repoId,
      params.repoRoot,
      params.config,
    ),
    scannedPaths: params.scannedPaths,
    scannedFiles: params.scannedFiles,
  });
  const cachedCollection =
    cacheContext &&
    (await measureCollectionPhase("cacheRead", () =>
      tryReadProviderCollectionCache({
        context: cacheContext,
        generationId,
        indexedAt,
      }),
    ));
  const collected: Awaited<ReturnType<typeof collectScipProviderFacts>> =
    cachedCollection
      ? {
          facts: cachedCollection.facts,
          generatedIndexes: [...(params.generatedIndexes ?? [])],
          failures: [...(params.generatorFailures ?? [])],
        }
      : // This phase is intentionally SCIP-only: collect provider facts and validate
        // graph rows before the indexer decides whether coverage is complete enough
        // to materialize or must fall back to the legacy parser.
        await collectScipProviderFacts({
          ...params,
          generationId,
        });

  if (collected.facts.files.length === 0) {
    const diagnostics = formatNoScipFactsDiagnostics({
      failures: collected.failures,
      generatedIndexes: collected.generatedIndexes,
    });
    throw new Error(
      `Provider-first SCIP execution produced no file facts.${diagnostics} Check scip.indexes paths or scip.generator output.`,
    );
  }

  await measureCollectionPhase("sourceMetadata", () =>
    hydrateProviderFileFactsFromSource({
      repoRoot: params.repoRoot,
      facts: collected.facts,
      scannedFiles: params.scannedFiles,
    }),
  );

  const rows =
    cachedCollection?.rows ??
    (await measureCollectionPhase("rows", () => {
      const shapedRows = providerFactsToGraphRows({
        facts: collected.facts,
        indexedAt,
        onProgress: params.onProgress,
      });
      const shapedRowTotal = providerFirstGraphRowTotal(shapedRows);
      emitProviderFirstProgress(params.onProgress, "providerCollection.rows", {
        stageCurrent: shapedRowTotal,
        stageTotal: shapedRowTotal,
        message: `graph rows files=${shapedRows.files.length} symbols=${shapedRows.symbols.length} edges=${shapedRows.edges.length}`,
      });
      return shapedRows;
    }));
  applyProviderFileFactMetadataToRows(rows, collected.facts);
  await measureCollectionPhase("validate", () => {
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.validate",
      {
        stageCurrent: 0,
        stageTotal: 1,
        message: "validating provider graph rows",
      },
    );
    validateProviderFirstGraphRows(rows, {
      repoId: params.repoId,
      context: "Provider-first",
    });
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.validate",
      {
        stageCurrent: 1,
        stageTotal: 1,
        message: "provider graph rows validated",
      },
    );
  });
  if (!cachedCollection && cacheContext) {
    await measureCollectionPhase("cacheWrite", () =>
      writeProviderCollectionCache({
        context: cacheContext,
        facts: collected.facts,
        rows,
      }),
    );
  }

  emitProviderFirstProgress(params.onProgress, "providerCollection.validate", {
    message: "provider facts staged for materialization",
  });

  return {
    generationId,
    facts: collected.facts,
    rows,
    generatedIndexes: collected.generatedIndexes,
    failures: collected.failures,
    summary: {
      status: "executed",
      executor: "scipFull",
      generationId,
      reasons: [],
      filesProcessed: rows.files.length,
      symbolsIndexed: rows.symbols.length + rows.externalSymbols.length,
      edgesCreated: rows.edges.length,
      externalSymbolsIndexed: rows.externalSymbols.length,
    },
  };
}

export async function executeProviderFirstLspFull(
  params: ExecuteProviderFirstLspFullParams,
): Promise<ProviderFirstLspExecutionResult> {
  const generationId = `provider-first-lsp:${Date.now()}`;
  const indexedAt = new Date().toISOString();
  const measurePhase = providerFirstPhaseMeasurer(params.recordPhaseTiming);
  const lspConfig = params.config.semanticEnrichment?.providers.lsp;
  const providerLspConfig = params.config.indexing?.providerFirst?.lsp;
  const semanticTimeoutMs = params.config.semanticEnrichment?.timeoutMs;
  const documentSymbolTimeoutMs = Math.min(
    providerLspConfig?.documentSymbolTimeoutMs ?? 10_000,
    semanticTimeoutMs ?? 300_000,
  );
  const documentSymbolFailureLimit =
    providerLspConfig?.documentSymbolFailureLimit ?? 20;
  const documentSymbolCollectionTimeoutMs =
    providerLspConfig?.documentSymbolCollectionTimeoutMs ?? 120_000;
  const diagnosticsTimeoutMs = Math.min(
    providerLspConfig?.diagnosticsTimeoutMs ?? 5_000,
    semanticTimeoutMs ?? 300_000,
  );
  const servers = Object.entries(lspConfig?.servers ?? {}).filter(
    ([, server]) => server.enabled !== false,
  );
  const facts: ProviderFactSet = emptyProviderFactSet();
  const clientFactory =
    params.clientFactory ??
    ((options: LspClientOptions): ProviderFirstLspClientLike =>
      new SemanticLspClient(options));

  for (const [serverKey, server] of servers) {
    params.signal?.throwIfAborted();
    const providerId = server.serverId || serverKey;
    const serverStartedAt = new Date().toISOString();
    const documents = await measurePhase(`lsp.${providerId}.documents`, () =>
      collectLspProviderDocuments({
        repoRoot: params.repoRoot,
        server,
        scannedFiles: params.scannedFiles,
        fileLimit:
          params.config.indexing?.providerFirst?.lsp.documentSymbolFileLimit ??
          500,
      }),
    );
    if (documents.length === 0) {
      appendProviderFactSet(
        facts,
        normalizeLspProviderFacts({
          repoId: params.repoId,
          generationId,
          providerId,
          providerVersion: lspConfig?.providerVersion,
          emittedAt: indexedAt,
          documents: [],
          run: {
            runId: `${generationId}:${providerId}`,
            status: "skipped",
            startedAt: serverStartedAt,
            finishedAt: new Date().toISOString(),
            errorMessage: "no matching documents for configured LSP server",
          },
        }),
      );
      continue;
    }

    if (server.documentSessionMode === "document") {
      const documentFailures: string[] = [];
      const documentCollectionDeadline =
        Date.now() + documentSymbolCollectionTimeoutMs;
      for (const [documentIndex, document] of documents.entries()) {
        params.signal?.throwIfAborted();
        if (Date.now() >= documentCollectionDeadline) {
          markRemainingLspDocumentsSkipped(
            documents,
            documentIndex,
            documentFailures,
            "documentSymbol skipped after collection timeout",
          );
          break;
        }
        const client = clientFactory({
          serverId: providerId,
          command: server.command,
          args: server.args,
          workspaceRoot: params.repoRoot,
          timeoutMs: params.config.semanticEnrichment?.timeoutMs ?? 300_000,
          env: server.env,
          initializationOptions: server.initializationOptions,
        });
        try {
          await collectLspProviderDocumentWithClient({
            client,
            document,
            timeoutMs: params.config.semanticEnrichment?.timeoutMs,
            documentSymbolTimeoutMs,
            diagnosticsTimeoutMs,
          });
        } catch (error) {
          const message = errorMessage(error);
          document.symbolError = message;
          document.symbols = [];
          document.diagnostics = [];
          documentFailures.push(`${document.relPath}: ${message}`);
          if (documentFailures.length >= documentSymbolFailureLimit) {
            markRemainingLspDocumentsSkipped(
              documents,
              documentIndex + 1,
              documentFailures,
              "documentSymbol skipped after failure limit",
            );
            break;
          }
        } finally {
          await client.dispose().catch(() => undefined);
        }
      }
      appendProviderFactSet(
        facts,
        normalizeLspProviderFacts({
          repoId: params.repoId,
          generationId,
          providerId,
          providerVersion: lspConfig?.providerVersion,
          emittedAt: indexedAt,
          documents,
          run: {
            runId: `${generationId}:${providerId}`,
            status: "succeeded",
            startedAt: serverStartedAt,
            finishedAt: new Date().toISOString(),
            errorMessage:
              documentFailures.length > 0
                ? summarizeLspDocumentFailures(documentFailures)
                : undefined,
          },
        }),
      );
      continue;
    }

    const client = clientFactory({
      serverId: providerId,
      command: server.command,
      args: server.args,
      workspaceRoot: params.repoRoot,
      timeoutMs: params.config.semanticEnrichment?.timeoutMs ?? 300_000,
      env: server.env,
      initializationOptions: server.initializationOptions,
    });
    try {
      const initializeResult = await measurePhase(
        `lsp.${providerId}.initialize`,
        () => client.start(params.config.semanticEnrichment?.timeoutMs),
      );
      const canCollectSymbols = Boolean(
        initializeResult.capabilities.documentSymbolProvider,
      );
      const documentFailures: string[] = [];
      const documentCollectionDeadline =
        Date.now() + documentSymbolCollectionTimeoutMs;
      for (const [documentIndex, document] of documents.entries()) {
        params.signal?.throwIfAborted();
        if (Date.now() >= documentCollectionDeadline) {
          markRemainingLspDocumentsSkipped(
            documents,
            documentIndex,
            documentFailures,
            "documentSymbol skipped after collection timeout",
          );
          break;
        }
        try {
          await client.openDocument({
            uri: document.uri,
            languageId: document.languageId ?? "plaintext",
            version: 1,
            text: document.text,
          });
        } catch (error) {
          const message = `openDocument failed: ${errorMessage(error)}`;
          document.symbolError = message;
          document.symbols = [];
          document.diagnostics = [];
          documentFailures.push(`${document.relPath}: ${message}`);
          if (documentFailures.length >= documentSymbolFailureLimit) {
            markRemainingLspDocumentsSkipped(
              documents,
              documentIndex + 1,
              documentFailures,
              "documentSymbol skipped after failure limit",
            );
            break;
          }
          continue;
        }
        if (canCollectSymbols) {
          try {
            document.symbols =
              (await client.documentSymbol(
                { textDocument: { uri: document.uri } },
                documentSymbolTimeoutMs,
              )) ?? [];
          } catch (error) {
            const message = `documentSymbol failed: ${errorMessage(error)}`;
            document.symbolError = message;
            document.symbols = [];
            documentFailures.push(`${document.relPath}: ${message}`);
            if (documentFailures.length >= documentSymbolFailureLimit) {
              markRemainingLspDocumentsSkipped(
                documents,
                documentIndex + 1,
                documentFailures,
                "documentSymbol skipped after failure limit",
              );
              break;
            }
          }
        }
        if (Date.now() >= documentCollectionDeadline) {
          markRemainingLspDocumentsSkipped(
            documents,
            documentIndex + 1,
            documentFailures,
            "documentSymbol skipped after collection timeout",
          );
          break;
        }
        document.diagnostics = await collectLspProviderDiagnostics({
          client,
          uri: document.uri,
          timeoutMs: diagnosticsTimeoutMs,
        });
      }
      appendProviderFactSet(
        facts,
        normalizeLspProviderFacts({
          repoId: params.repoId,
          generationId,
          providerId,
          providerVersion:
            lspConfig?.providerVersion ?? initializeResult.serverInfo?.version,
          emittedAt: indexedAt,
          documents,
          run: {
            runId: `${generationId}:${providerId}`,
            status: "succeeded",
            startedAt: serverStartedAt,
            finishedAt: new Date().toISOString(),
            errorMessage:
              documentFailures.length > 0
                ? summarizeLspDocumentFailures(documentFailures)
                : undefined,
          },
        }),
      );
    } catch (error) {
      appendProviderFactSet(
        facts,
        normalizeLspProviderFacts({
          repoId: params.repoId,
          generationId,
          providerId,
          providerVersion: lspConfig?.providerVersion,
          emittedAt: indexedAt,
          documents: [],
          run: {
            runId: `${generationId}:${providerId}`,
            status: "failed",
            startedAt: serverStartedAt,
            finishedAt: new Date().toISOString(),
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }

  const rows = await measurePhase("lsp.rows", () =>
    providerFactsToGraphRows({ facts, indexedAt }),
  );
  validateProviderFirstGraphRows(rows, {
    repoId: params.repoId,
    context: "Provider-first LSP execution",
  });
  const summary: ProviderFirstExecutionSummary = {
    status: "executed",
    executor: "lspFull",
    generationId,
    reasons: [],
    filesProcessed: facts.files.length,
    symbolsIndexed: facts.symbols.length,
    edgesCreated: facts.edges.length,
    externalSymbolsIndexed: facts.externalSymbols.length,
    coverage: {
      scannedFiles: facts.files.length,
      providerFiles: facts.files.length,
      providerCoveredFiles: facts.files.length,
      providerPrimaryFiles: facts.files.length,
      fullyCoveredFiles: facts.coverage.filter(
        (coverage) => coverage.symbolCoverage === "full",
      ).length,
      partialFiles: facts.coverage.filter(
        (coverage) => coverage.symbolCoverage === "partial",
      ).length,
      fullFallbackFiles: 0,
      uncoveredFiles: facts.coverage.filter(
        (coverage) => coverage.symbolCoverage === "none",
      ).length,
      fallbackFiles: facts.coverage.filter(
        (coverage) => coverage.legacyFallback !== "skip",
      ).length,
    },
  };
  return { generationId, facts, rows, summary };
}

async function collectLspProviderDocumentWithClient(params: {
  client: ProviderFirstLspClientLike;
  document: CollectedLspProviderDocument;
  timeoutMs?: number;
  documentSymbolTimeoutMs: number;
  diagnosticsTimeoutMs: number;
}): Promise<void> {
  const initializeResult = await params.client.start(params.timeoutMs);
  await params.client.openDocument({
    uri: params.document.uri,
    languageId: params.document.languageId ?? "plaintext",
    version: 1,
    text: params.document.text,
  });
  if (initializeResult.capabilities.documentSymbolProvider) {
    params.document.symbols =
      (await params.client.documentSymbol(
        { textDocument: { uri: params.document.uri } },
        params.documentSymbolTimeoutMs,
      )) ?? [];
  }
  params.document.diagnostics = await collectLspProviderDiagnostics({
    client: params.client,
    uri: params.document.uri,
    timeoutMs: params.diagnosticsTimeoutMs,
  });
}

async function collectLspProviderDocuments(params: {
  repoRoot: string;
  server: SemanticEnrichmentLspServerConfig;
  scannedFiles?: readonly ProviderFirstSourceFileMetadata[];
  fileLimit: number;
}): Promise<CollectedLspProviderDocument[]> {
  const candidates =
    params.scannedFiles?.map((file) => file.path) ??
    (await collectLspProviderCandidatePaths(params.repoRoot, params.server));
  const documents: CollectedLspProviderDocument[] = [];
  for (const candidate of candidates) {
    if (documents.length >= params.fileLimit) break;
    const relPath = normalizePath(candidate);
    if (!matchesLspProviderFilePatterns(relPath, params.server.filePatterns)) {
      continue;
    }
    const absolutePath = resolve(params.repoRoot, relPath);
    let content: string;
    let byteSize: number;
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) continue;
      content = await readFile(absolutePath, "utf8");
      byteSize = fileStat.size;
    } catch {
      continue;
    }
    documents.push({
      relPath,
      uri: pathToFileURL(absolutePath).toString(),
      text: content,
      languageId: documentLanguageIdForLspPath(relPath, params.server),
      contentHash: hash("sha256", content, "hex"),
      byteSize,
      symbols: [],
      diagnostics: [],
    });
  }
  return documents;
}

async function collectLspProviderCandidatePaths(
  repoRoot: string,
  server: SemanticEnrichmentLspServerConfig,
): Promise<string[]> {
  const paths: string[] = [];
  await walkLspProviderCandidatePaths(repoRoot, "", server, paths);
  return paths.sort((a, b) => a.localeCompare(b));
}

async function walkLspProviderCandidatePaths(
  repoRoot: string,
  relativeDir: string,
  server: SemanticEnrichmentLspServerConfig,
  paths: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(resolve(repoRoot, relativeDir), {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relPath = normalizePath(join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (shouldSkipLspProviderDirectory(entry.name)) continue;
      await walkLspProviderCandidatePaths(repoRoot, relPath, server, paths);
      continue;
    }
    if (
      entry.isFile() &&
      matchesLspProviderFilePatterns(relPath, server.filePatterns)
    ) {
      paths.push(relPath);
    }
  }
}

function shouldSkipLspProviderDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
  ]).has(name);
}

function matchesLspProviderFilePatterns(
  relPath: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    const normalizedPattern = normalizePath(pattern);
    if (normalizedPattern.startsWith("**/*")) {
      return relPath.endsWith(normalizedPattern.slice(4));
    }
    if (normalizedPattern.startsWith("*")) {
      return relPath.endsWith(normalizedPattern.slice(1));
    }
    return relPath === normalizedPattern || relPath.endsWith(normalizedPattern);
  });
}

function documentLanguageIdForLspPath(
  relPath: string,
  server: SemanticEnrichmentLspServerConfig,
): string {
  if (server.documentLanguageIds.length > 0) {
    return server.documentLanguageIds[0] ?? server.languages[0] ?? "plaintext";
  }
  if (server.languages.length > 0) return server.languages[0] ?? "plaintext";
  if (relPath.endsWith(".php") || relPath.endsWith(".phtml")) return "php";
  if (/\.(?:sh|bash|zsh)$/u.test(relPath)) return "shellscript";
  if (/\.(?:ps1|psm1|psd1)$/u.test(relPath)) return "powershell";
  if (/\.(?:rb|rake)$/u.test(relPath)) return "ruby";
  if (relPath.endsWith(".lua")) return "lua";
  if (relPath.endsWith(".dart")) return "dart";
  if (relPath.endsWith(".swift")) return "swift";
  if (/\.(?:groovy|gradle|gvy|gy|gsh)$/u.test(relPath)) return "groovy";
  if (/\.(?:pl|pm|t|pod)$/u.test(relPath)) return "perl";
  if (/\.[Rr]$/u.test(relPath)) return "r";
  if (/\.(?:ex|exs)$/u.test(relPath)) return "elixir";
  if (/\.(?:fs|fsi|fsx)$/u.test(relPath)) return "fsharp";
  if (/\.(?:f90|f95|f03|f08|f|for|f77)$/u.test(relPath)) {
    return "fortran";
  }
  if (/\.(?:hs|lhs)$/u.test(relPath)) return "haskell";
  return "plaintext";
}

async function collectLspProviderDiagnostics(params: {
  client: ProviderFirstLspClientLike;
  uri: string;
  timeoutMs?: number;
}): Promise<Diagnostic[]> {
  if (params.client.pullDiagnostics) {
    try {
      return await params.client.pullDiagnostics(params.uri, params.timeoutMs);
    } catch {
      // Some LSP servers advertise diagnostics through LSP-IO metadata but do
      // not implement textDocument/diagnostic. Keep symbol facts usable and
      // fall back to publishDiagnostics snapshots when available.
    }
  }
  if (params.client.waitForDiagnostics) {
    try {
      await params.client.waitForDiagnostics([params.uri], 2_000);
    } catch {
      // Diagnostics are enrichment, not a provider-primary symbol gate.
    }
  }
  try {
    return params.client.diagnostics?.(params.uri) ?? [];
  } catch {
    return [];
  }
}

function formatNoScipFactsDiagnostics(params: {
  failures: readonly ScipFailureDiagnostic[];
  generatedIndexes: readonly ScipGeneratedIndexDiagnostic[];
}): string {
  const parts: string[] = [];
  for (const failure of params.failures.slice(0, 5)) {
    const location = failure.path ? ` ${failure.path}` : "";
    parts.push(`${failure.stage}${location}: ${failure.message}`);
  }

  for (const index of params.generatedIndexes
    .filter((candidate) => candidate.skipped)
    .slice(0, 3)) {
    parts.push(
      `generated ${index.path}: skipped ${index.skipReason ?? "unknown"}`,
    );
  }

  if (parts.length === 0) return "";

  const omitted =
    params.failures.length +
    params.generatedIndexes.filter((candidate) => candidate.skipped).length -
    parts.length;
  const suffix = omitted > 0 ? `; ${omitted} more` : "";
  return ` Diagnostics: ${parts.join("; ")}${suffix}. `;
}

function unsupportedPlan(params: {
  fallbackAllowed: boolean;
  fallbackReasonCode?: ProviderFirstFallbackReasonCode;
  reason: string;
}): ProviderFirstExecutionPlan {
  return {
    canExecute: false,
    shouldFallbackToLegacy: params.fallbackAllowed,
    fallbackReasonCode: params.fallbackReasonCode,
    reasons: [params.reason],
  };
}

interface ProviderCollectionCacheContext {
  cacheKey: string;
  cachePath: string;
}

interface CachedProviderCollection {
  schemaVersion: number;
  cacheKey: string;
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
}

function providerCollectionCacheContext(params: {
  repoId: string;
  repoRoot: string;
  scip: ScipConfig | undefined;
  generatedIndexes: readonly ScipGeneratedIndexDiagnostic[];
  generatorCacheKey?: string;
  sourceTextMaxBytes: number;
  scannedPaths?: readonly string[];
  scannedFiles?: readonly ProviderFirstSourceFileMetadata[];
}): ProviderCollectionCacheContext | null {
  // Full provider fact caching is experimental: on large repos the serialized
  // payload can be multiple GB, so keep it opt-in until a lean summary cache is
  // available.
  if (process.env.SDL_PROVIDER_COLLECTION_CACHE !== "1") return null;
  if (!params.generatorCacheKey) return null;
  if (!params.scip?.enabled) return null;
  const acceptedGenerated = params.generatedIndexes
    .filter((index) => !index.skipped)
    .map((index) => ({
      path: normalizePath(index.path),
      label: index.label,
      mode: index.mode,
      sizeBytes: index.sizeBytes,
      contentHash: index.contentHash ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (acceptedGenerated.length === 0) return null;

  const cacheKey = hashValue({
    schemaVersion: PROVIDER_COLLECTION_CACHE_SCHEMA_VERSION,
    normalizerVersion: PROVIDER_COLLECTION_CACHE_NORMALIZER_VERSION,
    repoId: params.repoId,
    repoRoot: normalizePath(params.repoRoot),
    generatorCacheKey: params.generatorCacheKey,
    generatedIndexes: acceptedGenerated,
    scip: {
      confidence: params.scip.confidence,
      externalSymbols: params.scip.externalSymbols,
    },
    sourceTextMaxBytes: params.sourceTextMaxBytes,
    scannedFilesHash: params.scannedFiles
      ? hashValue(
          params.scannedFiles
            .map((file) => ({
              path: normalizePath(file.path),
              size: file.size,
              contentHash: file.contentHash,
            }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        )
      : params.scannedPaths
        ? hashValue([...params.scannedPaths].map(normalizePath).sort())
        : null,
  });
  const repoKey = safeCacheKeyPart(params.repoId);
  return {
    cacheKey,
    cachePath: join(providerCollectionCacheDir(), repoKey, `${cacheKey}.bin`),
  };
}

async function tryReadProviderCollectionCache(params: {
  context: ProviderCollectionCacheContext;
  generationId: string;
  indexedAt: string;
}): Promise<{ facts: ProviderFactSet; rows: ProviderFirstGraphRows } | null> {
  try {
    const payload = deserialize(
      await readFile(params.context.cachePath),
    ) as Partial<CachedProviderCollection>;
    if (
      payload.schemaVersion !== PROVIDER_COLLECTION_CACHE_SCHEMA_VERSION ||
      payload.cacheKey !== params.context.cacheKey ||
      !payload.facts ||
      !payload.rows
    ) {
      return null;
    }
    rebaseProviderCollectionPayload({
      facts: payload.facts,
      rows: payload.rows,
      generationId: params.generationId,
      indexedAt: params.indexedAt,
    });
    logger.info("provider-first collection cache hit", {
      cacheKey: params.context.cacheKey,
      cachePath: params.context.cachePath,
    });
    return { facts: payload.facts, rows: payload.rows };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.debug("provider-first collection cache read failed", {
        cacheKey: params.context.cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

async function writeProviderCollectionCache(params: {
  context: ProviderCollectionCacheContext;
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
}): Promise<void> {
  let tempPath: string | undefined;
  try {
    const payload: CachedProviderCollection = {
      schemaVersion: PROVIDER_COLLECTION_CACHE_SCHEMA_VERSION,
      cacheKey: params.context.cacheKey,
      facts: params.facts,
      rows: params.rows,
    };
    tempPath = `${params.context.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(params.context.cachePath), { recursive: true });
    await writeFile(tempPath, serialize(payload));
    await rename(tempPath, params.context.cachePath);
    logger.info("provider-first collection cache stored", {
      cacheKey: params.context.cacheKey,
      cachePath: params.context.cachePath,
    });
  } catch (err) {
    logger.debug("provider-first collection cache write failed", {
      cacheKey: params.context.cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
    if (tempPath) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function rebaseProviderCollectionPayload(params: {
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
  generationId: string;
  indexedAt: string;
}): void {
  const rebaseFact = (fact: ProviderFactBase): void => {
    fact.generationId = params.generationId;
    fact.emittedAt = params.indexedAt;
  };
  params.facts.files.forEach(rebaseFact);
  params.facts.symbols.forEach(rebaseFact);
  params.facts.occurrences.forEach(rebaseFact);
  params.facts.edges.forEach(rebaseFact);
  params.facts.externalSymbols.forEach(rebaseFact);
  params.facts.diagnostics.forEach((diagnostic, index) => {
    rebaseFact(diagnostic);
    diagnostic.diagnosticId = [
      params.generationId,
      diagnostic.relPath,
      index,
    ].join(":");
  });
  params.facts.coverage.forEach(rebaseFact);
  params.facts.providerRuns.forEach((run) => {
    rebaseFact(run);
    run.runId = `${params.generationId}:${run.providerId}`;
    run.startedAt = params.indexedAt;
    run.finishedAt = params.indexedAt;
  });

  for (const file of params.rows.files) {
    file.lastIndexedAt = params.indexedAt;
  }
  for (const symbol of params.rows.symbols) {
    symbol.updatedAt = params.indexedAt;
  }
  for (const symbol of params.rows.externalSymbols) {
    symbol.updatedAt = params.indexedAt;
  }
  for (const edge of params.rows.edges) {
    edge.createdAt = params.indexedAt;
  }
}

function providerCollectionCacheDir(): string {
  return (
    process.env.SDL_PROVIDER_COLLECTION_CACHE_DIR ??
    DEFAULT_PROVIDER_COLLECTION_CACHE_DIR
  );
}

function safeCacheKeyPart(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "repo"
  );
}

function scipExecutionConfigured(scip: ScipConfig | undefined): boolean {
  if (!scip?.enabled) return false;
  return scip.indexes.length > 0 || scip.generator.enabled === true;
}

async function hydrateProviderFileFactsFromSource(params: {
  repoRoot: string;
  facts: ProviderFactSet;
  scannedFiles?: readonly ProviderFirstSourceFileMetadata[];
}): Promise<void> {
  const scannedByPath = new Map(
    params.scannedFiles?.map((file) => [normalizePath(file.path), file]) ?? [],
  );
  for (const fact of params.facts.files) {
    const relPath = normalizePath(fact.relPath);
    const scanned = scannedByPath.get(relPath);
    if (scanned) {
      fact.contentHash = scanned.contentHash;
      fact.byteSize = scanned.size;
      continue;
    }

    const sourcePath = resolveDocumentPath(params.repoRoot, relPath);
    if (!sourcePath) continue;
    try {
      const content = await readFile(sourcePath);
      fact.contentHash = hash("sha256", content, "hex");
      fact.byteSize = content.byteLength;
    } catch {
      // Validation reports the missing raw hash/size with file context.
    }
  }
}

function applyProviderFileFactMetadataToRows(
  rows: ProviderFirstGraphRows,
  facts: ProviderFactSet,
): void {
  const factsByPath = new Map(
    facts.files.map((fact) => [normalizePath(fact.relPath), fact]),
  );
  for (const row of rows.files) {
    const fact = factsByPath.get(normalizePath(row.relPath));
    if (!fact) continue;
    row.contentHash = fact.contentHash ?? "";
    row.byteSize = fact.byteSize ?? -1;
  }
}

async function collectScipProviderFacts(params: {
  repoId: string;
  repoRoot: string;
  config: AppConfig;
  generationId: string;
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  scannedPaths?: readonly string[];
  onProgress?: ExecuteProviderFirstScipFullParams["onProgress"];
  recordPhaseTiming?: ProviderFirstPhaseTimingRecorder;
  signal?: AbortSignal;
}): Promise<{
  facts: ProviderFactSet;
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
}> {
  const scip = params.config.scip;
  if (!scip?.enabled) {
    throw new Error(
      "Provider-first SCIP execution requested without enabled SCIP config",
    );
  }
  const combinedFacts = emptyProviderFactSet();
  const failures = [...(params.generatorFailures ?? [])];
  const generatedIndexes = [...(params.generatedIndexes ?? [])];
  const entries = resolveEffectiveScipEntries(scip, generatedIndexes);
  let currentIndex = 0;

  for (const entry of entries) {
    params.signal?.throwIfAborted();
    currentIndex++;
    const indexPath = resolveScipIndexPath(params.repoRoot, entry.path);
    const relIndexPath = relativeIndexPath(
      params.repoRoot,
      indexPath,
      entry.path,
    );
    try {
      await access(indexPath);
    } catch {
      failures.push({
        stage: "ingest",
        message: "SCIP index file not found",
        path: relIndexPath,
      });
      continue;
    }

    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.documents",
      {
        stageCurrent: currentIndex,
        stageTotal: entries.length,
        message: `[${entry.label ?? relIndexPath}] decoding`,
      },
    );
    const facts = await decodeScipIndexToFacts({
      repoId: params.repoId,
      repoRoot: params.repoRoot,
      generationId: params.generationId,
      indexPath,
      relIndexPath,
      entryLabel: entry.label,
      scip,
      recordPhaseTiming: params.recordPhaseTiming,
      scannedPaths: params.scannedPaths,
      sourceTextMaxBytes: resolveSourceTextMaxBytes(
        params.repoId,
        params.repoRoot,
        params.config,
      ),
      onProgress: params.onProgress,
      signal: params.signal,
    });
    appendProviderFactSet(combinedFacts, facts);
  }

  return {
    facts: combinedFacts,
    generatedIndexes,
    failures,
  };
}

async function decodeScipIndexToFacts(params: {
  repoId: string;
  repoRoot: string;
  generationId: string;
  indexPath: string;
  relIndexPath: string;
  entryLabel?: string;
  scip: ScipConfig;
  sourceTextMaxBytes: number;
  scannedPaths?: readonly string[];
  recordPhaseTiming?: ProviderFirstPhaseTimingRecorder;
  onProgress?: ExecuteProviderFirstScipFullParams["onProgress"];
  signal?: AbortSignal;
}): Promise<ProviderFactSet> {
  const decoder = await createScipDecoder(params.indexPath);
  const measureCollectionPhase = providerFirstPhaseMeasurer(
    params.recordPhaseTiming,
  );
  const providerId = providerIdForScipEntry(
    params.entryLabel,
    params.relIndexPath,
  );
  try {
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.metadata",
      {
        stageCurrent: 0,
        stageTotal: 1,
        message: `[${providerId}] reading metadata`,
      },
    );
    const metadata = await measureCollectionPhase("metadata", () =>
      decoder.metadata(),
    );
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.metadata",
      {
        stageCurrent: 1,
        stageTotal: 1,
        message:
          `[${providerId}] metadata ${metadata.toolName ?? "unknown"} ${metadata.toolVersion ?? ""}`.trim(),
      },
    );
    const documents: ScipDocument[] = [];
    const scannedPathSet = params.scannedPaths
      ? new Set(params.scannedPaths.map(normalizePath))
      : undefined;
    await measureCollectionPhase("documents", async () => {
      let seen = 0;
      let retained = 0;
      for await (const document of decoder.documents()) {
        params.signal?.throwIfAborted();
        seen++;
        if (
          scannedPathSet &&
          !scannedPathSet.has(normalizePath(document.relativePath))
        ) {
          if (
            seen === 1 ||
            seen % PROVIDER_FIRST_DOCUMENT_PROGRESS_INTERVAL === 0
          ) {
            emitProviderFirstProgress(
              params.onProgress,
              "providerCollection.documents",
              {
                current: retained,
                total: 0,
                message: `[${providerId}] documents=${retained} retained (${seen} scanned)`,
              },
            );
          }
          continue;
        }
        documents.push(document);
        retained++;
        if (
          seen === 1 ||
          seen % PROVIDER_FIRST_DOCUMENT_PROGRESS_INTERVAL === 0
        ) {
          emitProviderFirstProgress(
            params.onProgress,
            "providerCollection.documents",
            {
              current: retained,
              total: 0,
              message: scannedPathSet
                ? `[${providerId}] documents=${retained} retained (${seen} scanned)`
                : `[${providerId}] documents=${seen}`,
            },
          );
        }
      }
      if (seen > 0 && seen % PROVIDER_FIRST_DOCUMENT_PROGRESS_INTERVAL !== 0) {
        emitProviderFirstProgress(
          params.onProgress,
          "providerCollection.documents",
          {
            current: retained,
            total: 0,
            message: scannedPathSet
              ? `[${providerId}] documents=${retained} retained (${seen} scanned)`
              : `[${providerId}] documents=${seen}`,
          },
        );
      }
      return retained;
    });

    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.externalSymbols",
      {
        stageCurrent: 0,
        stageTotal: 0,
        message: `[${providerId}] loading external symbols`,
      },
    );
    const externalSymbols = await measureCollectionPhase(
      "externalSymbols",
      () => loadExternalSymbols(decoder, params.scip),
    );
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.externalSymbols",
      {
        stageCurrent: externalSymbols.length,
        stageTotal: externalSymbols.length,
        message: `[${providerId}] externalSymbols=${externalSymbols.length}`,
      },
    );
    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.sourceLines",
      {
        stageCurrent: 0,
        stageTotal: documents.length,
        message: `[${providerId}] loading source lines`,
      },
    );
    const sourceLineLoad = await measureCollectionPhase("sourceLines", () =>
      loadDocumentSourceLines(
        params.repoRoot,
        documents,
        params.sourceTextMaxBytes,
        {
          onProgress: params.onProgress,
          providerId,
        },
      ),
    );
    const retainOccurrenceFacts =
      countScipOccurrences(documents) <=
      PROVIDER_FIRST_OCCURRENCE_FACT_RETENTION_LIMIT;
    logger.info("provider-first SCIP facts decoded", {
      repoId: params.repoId,
      providerId,
      documents: documents.length,
      externalSymbols: externalSymbols.length,
      indexPath: params.relIndexPath,
    });

    emitProviderFirstProgress(
      params.onProgress,
      "providerCollection.normalize",
      {
        stageCurrent: 0,
        stageTotal: documents.length,
        message: `[${providerId}] normalizing provider facts`,
      },
    );
    return await measureCollectionPhase("normalize", async () => {
      const facts = await normalizeScipProviderFacts({
        repoId: params.repoId,
        generationId: params.generationId,
        providerId,
        providerVersion: metadata.toolVersion,
        documents,
        externalSymbols,
        sourceLinesByPath: sourceLineLoad.sourceLinesByPath,
        sourceLineUnavailableReasonByPath:
          sourceLineLoad.sourceLineUnavailableReasonByPath,
        sourceIndexPath: params.relIndexPath,
        confidence: params.scip.confidence,
        recordPhaseTiming: params.recordPhaseTiming,
        retainOccurrenceFacts,
        onProgress: params.onProgress,
      });
      return scannedPathSet ? pruneUnreferencedExternalSymbols(facts) : facts;
    });
  } finally {
    decoder.close();
  }
}

function providerFirstPhaseMeasurer(
  recordPhaseTiming: ProviderFirstPhaseTimingRecorder | undefined,
): <T>(phaseName: string, fn: () => Promise<T> | T) => Promise<T> {
  return async <T>(phaseName: string, fn: () => Promise<T> | T): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      recordPhaseTiming?.(
        `providerCollection.${phaseName}`,
        Date.now() - startedAt,
      );
    }
  };
}

function countScipOccurrences(documents: readonly ScipDocument[]): number {
  let count = 0;
  for (const document of documents) {
    count += document.occurrences.length;
  }
  return count;
}

function pruneUnreferencedExternalSymbols(
  facts: ProviderFactSet,
): ProviderFactSet {
  const referencedSymbolIds = new Set<string>();
  for (const edge of facts.edges) {
    referencedSymbolIds.add(edge.targetSymbolId);
  }
  facts.externalSymbols = facts.externalSymbols.filter((symbol) =>
    referencedSymbolIds.has(symbol.symbolId),
  );
  return facts;
}

async function loadExternalSymbols(
  decoder: Awaited<ReturnType<typeof createScipDecoder>>,
  scip: ScipConfig,
): Promise<ScipExternalSymbol[]> {
  if (!scip.externalSymbols.enabled) return [];
  const externalSymbols = await decoder.externalSymbols();
  return externalSymbols.slice(0, scip.externalSymbols.maxPerIndex);
}

function resolveEffectiveScipEntries(
  scip: ScipConfig,
  generatedIndexes: readonly ScipGeneratedIndexDiagnostic[],
): ScipConfig["indexes"] {
  const acceptedGenerated = generatedIndexes.filter((index) => !index.skipped);
  const hasSplitGeneratedIndexes = acceptedGenerated.some(
    (index) => index.mode === "split",
  );
  const configured = hasSplitGeneratedIndexes
    ? scip.indexes.filter(
        (entry) =>
          normalizePath(entry.path) !== "index.scip" ||
          (entry.label !== undefined && entry.label !== "scip-io"),
      )
    : scip.indexes;
  const byPath = new Map(
    configured.map((entry) => [normalizePath(entry.path), entry]),
  );

  if (scip.generator.enabled && !hasSplitGeneratedIndexes) {
    byPath.set("index.scip", { path: "index.scip", label: "scip-io" });
  }
  for (const generated of acceptedGenerated) {
    byPath.set(normalizePath(generated.path), {
      path: generated.path,
      label: generated.label,
    });
  }
  return [...byPath.values()];
}

function resolveScipIndexPath(
  repoRoot: string,
  configuredPath: string,
): string {
  const normalizedPath = normalizePath(configuredPath);
  return isAbsolute(normalizedPath)
    ? normalizedPath
    : normalizePath(resolve(normalizePath(repoRoot), normalizedPath));
}

function relativeIndexPath(
  repoRoot: string,
  absolutePath: string,
  configuredPath: string,
): string {
  const normalizedRoot = normalizePath(repoRoot);
  const normalizedAbsolute = normalizePath(absolutePath);
  const comparisonRoot = normalizedRoot.toLowerCase();
  const comparisonPath = normalizedAbsolute.toLowerCase();
  if (
    comparisonPath === comparisonRoot ||
    comparisonPath.startsWith(`${comparisonRoot}/`)
  ) {
    return normalizePath(getRelativePath(normalizedRoot, normalizedAbsolute));
  }
  return normalizePath(configuredPath);
}

function providerIdForScipEntry(
  label: string | undefined,
  relIndexPath: string,
): string {
  if (label && label.trim().length > 0) return label.trim();
  return `scip:${normalizePath(relIndexPath)}`;
}

function emptyProviderFactSet(): ProviderFactSet {
  return {
    files: [],
    symbols: [],
    occurrences: [],
    edges: [],
    externalSymbols: [],
    diagnostics: [],
    coverage: [],
    providerRuns: [],
    sourceLinesByPath: new Map(),
  };
}

function appendProviderFactSet(
  target: ProviderFactSet,
  source: ProviderFactSet,
): void {
  const existingRelPaths = collectProviderFactRelPaths(target);
  const targetFileIds = new Set(target.files.map((file) => file.fileId));
  const targetSymbolIds = new Set(
    target.symbols.map((symbol) => symbol.symbolId),
  );
  const targetSymbolKeys = new Set(target.symbols.map(providerSymbolFactKey));
  const targetOccurrenceIds = new Set(
    target.occurrences.map((occurrence) => occurrence.occurrenceId),
  );
  const targetOccurrenceKeys = new Set(
    target.occurrences.map(providerOccurrenceFactKey),
  );
  const targetEdgeKeys = new Set(target.edges.map(providerEdgeFactKey));
  const targetExternalSymbolIds = new Set(
    target.externalSymbols.map((symbol) => symbol.symbolId),
  );
  const targetExternalSymbolKeys = new Set(
    target.externalSymbols.map(providerExternalSymbolFactKey),
  );
  const targetDiagnosticIds = new Set(
    target.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
  );
  const targetDiagnosticKeys = new Set(
    target.diagnostics.map(providerDiagnosticFactKey),
  );
  const targetCoverageRelPaths = new Set(
    target.coverage.map((coverage) => normalizePath(coverage.relPath)),
  );
  const skippedRelPaths = new Set<string>();
  const skippedSymbolIds = new Set<string>();

  // One provider payload owns each repo-relative file. Overlapping SCIP indexes
  // still report provider runs, but duplicate file-local facts would violate
  // graph primary keys and inflate occurrence/edge counts.
  for (const file of source.files) {
    const relPath = normalizePath(file.relPath);
    if (targetFileIds.has(file.fileId) || existingRelPaths.has(relPath)) {
      skippedRelPaths.add(relPath);
      continue;
    }
    target.files.push(file);
    targetFileIds.add(file.fileId);
  }

  for (const symbol of source.symbols) {
    const relPath = normalizePath(symbol.relPath);
    const symbolKey = providerSymbolFactKey(symbol);
    if (
      skippedRelPaths.has(relPath) ||
      existingRelPaths.has(relPath) ||
      targetSymbolIds.has(symbol.symbolId) ||
      targetSymbolKeys.has(symbolKey)
    ) {
      skippedSymbolIds.add(symbol.symbolId);
      continue;
    }
    target.symbols.push(symbol);
    targetSymbolIds.add(symbol.symbolId);
    targetSymbolKeys.add(symbolKey);
  }

  for (const occurrence of source.occurrences) {
    const relPath = normalizePath(occurrence.relPath);
    const occurrenceKey = providerOccurrenceFactKey(occurrence);
    if (
      skippedRelPaths.has(relPath) ||
      existingRelPaths.has(relPath) ||
      (occurrence.symbolId && skippedSymbolIds.has(occurrence.symbolId)) ||
      targetOccurrenceIds.has(occurrence.occurrenceId) ||
      targetOccurrenceKeys.has(occurrenceKey)
    ) {
      continue;
    }
    target.occurrences.push(occurrence);
    targetOccurrenceIds.add(occurrence.occurrenceId);
    targetOccurrenceKeys.add(occurrenceKey);
  }

  for (const edge of source.edges) {
    const relPath = edge.relPath ? normalizePath(edge.relPath) : null;
    const edgeKey = providerEdgeFactKey(edge);
    if (
      (relPath &&
        (skippedRelPaths.has(relPath) || existingRelPaths.has(relPath))) ||
      skippedSymbolIds.has(edge.sourceSymbolId) ||
      skippedSymbolIds.has(edge.targetSymbolId) ||
      targetEdgeKeys.has(edgeKey)
    ) {
      continue;
    }
    target.edges.push(edge);
    targetEdgeKeys.add(edgeKey);
  }

  for (const externalSymbol of source.externalSymbols) {
    const externalKey = providerExternalSymbolFactKey(externalSymbol);
    if (
      targetExternalSymbolIds.has(externalSymbol.symbolId) ||
      targetExternalSymbolKeys.has(externalKey)
    ) {
      continue;
    }
    target.externalSymbols.push(externalSymbol);
    targetExternalSymbolIds.add(externalSymbol.symbolId);
    targetExternalSymbolKeys.add(externalKey);
  }

  for (const diagnostic of source.diagnostics) {
    const relPath = normalizePath(diagnostic.relPath);
    const diagnosticKey = providerDiagnosticFactKey(diagnostic);
    if (
      skippedRelPaths.has(relPath) ||
      existingRelPaths.has(relPath) ||
      targetDiagnosticIds.has(diagnostic.diagnosticId) ||
      targetDiagnosticKeys.has(diagnosticKey)
    ) {
      continue;
    }
    target.diagnostics.push(diagnostic);
    targetDiagnosticIds.add(diagnostic.diagnosticId);
    targetDiagnosticKeys.add(diagnosticKey);
  }

  for (const coverage of source.coverage) {
    const relPath = normalizePath(coverage.relPath);
    if (
      skippedRelPaths.has(relPath) ||
      existingRelPaths.has(relPath) ||
      targetCoverageRelPaths.has(relPath)
    ) {
      continue;
    }
    target.coverage.push(coverage);
    targetCoverageRelPaths.add(relPath);
  }

  appendMany(target.providerRuns, source.providerRuns);
  target.sourceLinesByPath = mergeSourceLinesByPath(
    target.sourceLinesByPath,
    source.sourceLinesByPath,
    existingRelPaths,
    skippedRelPaths,
  );
}

function mergeSourceLinesByPath(
  target: ProviderFactSet["sourceLinesByPath"],
  source: ProviderFactSet["sourceLinesByPath"],
  existingRelPaths: ReadonlySet<string> = new Set(),
  skippedRelPaths: ReadonlySet<string> = new Set(),
): ProviderFactSet["sourceLinesByPath"] {
  if (!source) return target;
  const merged = new Map(target ?? []);
  for (const [relPath, lines] of source) {
    const normalizedRelPath = normalizePath(relPath);
    if (
      existingRelPaths.has(normalizedRelPath) ||
      skippedRelPaths.has(normalizedRelPath)
    ) {
      continue;
    }
    merged.set(normalizedRelPath, lines);
  }
  return merged;
}

function collectProviderFactRelPaths(facts: ProviderFactSet): Set<string> {
  const relPaths = new Set<string>();
  for (const file of facts.files) relPaths.add(normalizePath(file.relPath));
  for (const symbol of facts.symbols)
    relPaths.add(normalizePath(symbol.relPath));
  for (const occurrence of facts.occurrences) {
    relPaths.add(normalizePath(occurrence.relPath));
  }
  for (const diagnostic of facts.diagnostics) {
    relPaths.add(normalizePath(diagnostic.relPath));
  }
  for (const coverage of facts.coverage) {
    relPaths.add(normalizePath(coverage.relPath));
  }
  for (const relPath of facts.sourceLinesByPath?.keys() ?? []) {
    relPaths.add(normalizePath(relPath));
  }
  return relPaths;
}

function providerSymbolFactKey(
  symbol: ProviderFactSet["symbols"][number],
): string {
  return [
    normalizePath(symbol.relPath),
    symbol.providerSymbolId,
    symbol.symbolKind,
    providerRangeKey(symbol.range),
  ].join("\u0000");
}

function providerOccurrenceFactKey(
  occurrence: ProviderFactSet["occurrences"][number],
): string {
  return [
    normalizePath(occurrence.relPath),
    occurrence.providerSymbolId,
    occurrence.role,
    providerRangeKey(occurrence.range),
  ].join("\u0000");
}

function providerEdgeFactKey(edge: ProviderFactSet["edges"][number]): string {
  return [
    edge.sourceSymbolId,
    edge.targetSymbolId,
    edge.edgeType,
    edge.providerId,
    edge.dedupeKey,
  ].join("\u0000");
}

function providerExternalSymbolFactKey(
  symbol: ProviderFactSet["externalSymbols"][number],
): string {
  return [
    symbol.providerSymbolId,
    symbol.packageName ?? "",
    symbol.packageVersion ?? "",
  ].join("\u0000");
}

function providerDiagnosticFactKey(
  diagnostic: ProviderFactSet["diagnostics"][number],
): string {
  return [
    normalizePath(diagnostic.relPath),
    diagnostic.severity,
    diagnostic.code ?? "",
    diagnostic.message,
    providerRangeKey(diagnostic.range),
  ].join("\u0000");
}

function providerRangeKey(range: Range | undefined): string {
  if (!range) return "";
  return [range.startLine, range.startCol, range.endLine, range.endCol].join(
    ":",
  );
}

async function loadDocumentSourceLines(
  repoRoot: string,
  documents: readonly ScipDocument[],
  maxBytes: number,
  progress?: {
    onProgress?: ProviderFirstProgressCallback;
    providerId: string;
  },
): Promise<{
  sourceLinesByPath: SourceLinesByPath;
  sourceLineUnavailableReasonByPath: SourceLineUnavailableReasonByPath;
}> {
  const sourceLinesByPath = new Map<string, ReadonlyMap<number, string>>();
  const sourceLineUnavailableReasonByPath = new Map<
    string,
    CallProofUnavailableReasonCode
  >();
  const neededLinesByPath = collectNeededSourceLines(documents);
  const sourcePaths: Array<{ relPath: string; sourcePath: string }> = [];
  let normalizedRoot = normalizePath(repoRoot);
  try {
    // Compare canonical paths so Windows short-path expansion cannot make an
    // in-repo source file look like it escaped the configured repository root.
    normalizedRoot = normalizePath(await realpath(repoRoot));
  } catch {
    normalizedRoot = normalizePath(repoRoot);
  }

  for (const relPath of neededLinesByPath.keys()) {
    const sourcePath = resolveDocumentPath(repoRoot, relPath);
    if (!sourcePath) {
      sourceLineUnavailableReasonByPath.set(relPath, "sourcePathOutsideRoot");
      continue;
    }
    sourcePaths.push({ relPath, sourcePath });
  }

  let nextIndex = 0;
  const workerCount = Math.min(
    SOURCE_TEXT_READ_CONCURRENCY,
    sourcePaths.length,
  );
  if (sourcePaths.length === 0) {
    emitProviderFirstProgress(
      progress?.onProgress,
      "providerCollection.sourceLines",
      {
        stageCurrent: 0,
        stageTotal: 0,
        message: `[${progress?.providerId ?? "scip"}] no source lines required`,
      },
    );
  }
  let completedSourcePaths = 0;
  let lastProgressAt = 0;
  const reportSourceLineProgress = (): void => {
    completedSourcePaths++;
    const now = Date.now();
    if (
      completedSourcePaths === 1 ||
      completedSourcePaths === sourcePaths.length ||
      completedSourcePaths % PROVIDER_FIRST_SOURCE_LINE_PROGRESS_INTERVAL ===
        0 ||
      now - lastProgressAt >= PROVIDER_FIRST_PROGRESS_HEARTBEAT_MS
    ) {
      lastProgressAt = now;
      emitProviderFirstProgress(
        progress?.onProgress,
        "providerCollection.sourceLines",
        {
          stageCurrent: completedSourcePaths,
          stageTotal: sourcePaths.length,
          message: `[${progress?.providerId ?? "scip"}] sourceLines=${completedSourcePaths}/${sourcePaths.length}`,
        },
      );
    }
  };
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < sourcePaths.length) {
        const entry = sourcePaths[nextIndex];
        nextIndex++;
        if (!entry) continue;

        try {
          const realSourcePath = normalizePath(
            await realpath(entry.sourcePath),
          );
          if (!isPathInsideRoot(normalizedRoot, realSourcePath)) {
            sourceLineUnavailableReasonByPath.set(
              entry.relPath,
              "sourceRealPathOutsideRoot",
            );
            continue;
          }
          const sourceStats = await stat(realSourcePath);
          if (sourceStats.size > maxBytes) {
            sourceLineUnavailableReasonByPath.set(
              entry.relPath,
              "sourceTooLarge",
            );
            continue;
          }
          const selectedLines = selectNeededLines(
            await readFile(realSourcePath, "utf8"),
            neededLinesByPath.get(entry.relPath) ?? new Set(),
          );
          sourceLinesByPath.set(entry.relPath, selectedLines);
        } catch {
          // Missing or unreadable source leaves the occurrence as a neutral
          // fact. Coverage validation later decides whether the file can still
          // be provider-primary or must fall back to legacy parsing.
          sourceLineUnavailableReasonByPath.set(
            entry.relPath,
            "sourceReadFailed",
          );
        } finally {
          reportSourceLineProgress();
        }
      }
    }),
  );
  return { sourceLinesByPath, sourceLineUnavailableReasonByPath };
}

function collectNeededSourceLines(
  documents: readonly ScipDocument[],
): Map<string, Set<number>> {
  const neededLinesByPath = new Map<string, Set<number>>();
  for (const document of documents) {
    const relPath = normalizePath(document.relativePath);
    const isCppDocument = isCppLikeScipDocument(document);
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) continue;
      if ((occurrence.symbolRoles & SCIP_ROLE_IMPORT) !== 0) {
        const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
        // Import alias recovery only needs the wide block scan when the import
        // line contains an alias. `selectNeededLines` expands those lines after
        // reading the file, which avoids retaining broad import windows for the
        // common no-alias case in large provider-first runs.
        lines.add(occurrence.range.startLine);
        neededLinesByPath.set(relPath, lines);
        continue;
      }
      if (occurrence.range.startLine !== occurrence.range.endLine) continue;

      const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
      if (isCppDocument || isClangStyleSymbol(occurrence.symbol)) {
        addLineWindow(
          lines,
          occurrence.range.startLine,
          CPP_CALL_PROOF_LINE_WINDOW_RADIUS,
        );
      } else {
        lines.add(occurrence.range.startLine);
      }
      neededLinesByPath.set(relPath, lines);
    }
  }
  return neededLinesByPath;
}

function isCppLikeScipDocument(document: ScipDocument): boolean {
  return /^(c|cc|cpp|c\+\+|cxx|objc|objective-c)$/i.test(document.language);
}

function isClangStyleSymbol(symbol: string): boolean {
  return isClangStyleSymbolScheme(parseScipSymbol(symbol).scheme);
}

function addLineWindow(
  lines: Set<number>,
  lineNumber: number,
  radius: number,
): void {
  const startLine = Math.max(0, lineNumber - radius);
  const endLine = lineNumber + radius;
  for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
    lines.add(currentLine);
  }
}

function selectNeededLines(
  sourceText: string,
  neededLines: ReadonlySet<number>,
): ReadonlyMap<number, string> {
  const sourceLines = sourceText.split(/\r?\n/);
  const selectedLineNumbers = new Set(neededLines);
  for (const lineNumber of neededLines) {
    const line = sourceLines[lineNumber];
    if (!line?.includes(" as ")) continue;
    addLineWindow(
      selectedLineNumbers,
      lineNumber,
      SOURCE_TEXT_IMPORT_ALIAS_BLOCK_SCAN_LIMIT,
    );
  }

  const selected = new Map<number, string>();
  for (const [lineNumber, line] of sourceLines.entries()) {
    if (selectedLineNumbers.has(lineNumber)) {
      selected.set(lineNumber, line);
    }
  }
  return selected;
}

function resolveSourceTextMaxBytes(
  repoId: string,
  repoRoot: string,
  config: AppConfig,
): number {
  const normalizedRoot = normalizePath(repoRoot).toLowerCase();
  const repoConfig = config.repos.find((repo) => {
    return (
      repo.repoId === repoId ||
      normalizePath(repo.rootPath).toLowerCase() === normalizedRoot
    );
  });
  return repoConfig?.maxFileBytes ?? MAX_FILE_BYTES;
}

function resolveDocumentPath(repoRoot: string, relPath: string): string | null {
  const normalizedRoot = normalizePath(repoRoot);
  const absolutePath = normalizePath(
    resolve(normalizedRoot, normalizePath(relPath)),
  );
  if (isPathInsideRoot(normalizedRoot, absolutePath)) {
    return absolutePath;
  }
  return null;
}

function isPathInsideRoot(
  normalizedRoot: string,
  candidatePath: string,
): boolean {
  const comparisonRoot = normalizedRoot.toLowerCase();
  const comparisonPath = normalizePath(candidatePath).toLowerCase();
  return (
    comparisonPath === comparisonRoot ||
    comparisonPath.startsWith(`${comparisonRoot}/`)
  );
}

function appendMany<T>(target: T[], source: readonly T[]): void {
  for (const item of source) {
    target.push(item);
  }
}

function markRemainingLspDocumentsSkipped(
  documents: CollectedLspProviderDocument[],
  startIndex: number,
  failures: string[],
  message: string,
): void {
  for (const document of documents.slice(startIndex)) {
    document.symbolError = message;
    document.symbols = [];
    document.diagnostics = [];
    failures.push(`${document.relPath}: ${message}`);
  }
}

function summarizeLspDocumentFailures(failures: readonly string[]): string {
  const sample = failures.slice(0, 5).join("; ");
  const omitted = failures.length - Math.min(failures.length, 5);
  const suffix = omitted > 0 ? `; ${omitted} more` : "";
  return `LSP document collection failed for ${failures.length} document(s): ${sample}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
