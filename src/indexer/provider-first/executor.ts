import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { AppConfig, ScipConfig } from "../../config/types.js";
import { createScipDecoder } from "../../scip/decoder-factory.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
} from "../../scip/diagnostics.js";
import type { ScipDocument, ScipExternalSymbol } from "../../scip/types.js";
import { logger } from "../../util/logger.js";
import { getRelativePath, normalizePath } from "../../util/paths.js";
import { normalizeScipProviderFacts } from "./scip-normalizer.js";
import {
  providerFactsToGraphRows,
  type ProviderFirstGraphRows,
} from "./materializer.js";
import type {
  ProviderFactSet,
  ProviderFirstPipelineSelection,
} from "./types.js";

export type ProviderFirstExecutorKind = "scipFull";

export interface ProviderFirstExecutionPlan {
  canExecute: boolean;
  shouldFallbackToLegacy: boolean;
  executor?: ProviderFirstExecutorKind;
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
}

export interface ProviderFirstScipExecutionResult {
  generationId: string;
  facts: ProviderFactSet;
  rows: ProviderFirstGraphRows;
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
  summary: ProviderFirstExecutionSummary;
}

const SHADOW_ACTIVATION_PENDING_REASON =
  "provider-first SCIP full execution is gated until shadow LadybugDB activation and partial-coverage fallback are implemented";

interface ExecuteProviderFirstScipFullParams {
  repoId: string;
  repoRoot: string;
  config: AppConfig;
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  onProgress?: (progress: {
    stage: "scipIngest" | "finalizing";
    current: number;
    total: number;
    message?: string;
  }) => void;
  signal?: AbortSignal;
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
  const hasScipSource = selectedSources.some((source) => source.type === "scip");
  const hasLspSource = selectedSources.some((source) => source.type === "lsp");

  if (mode !== "full") {
    return unsupportedPlan({
      fallbackAllowed,
      reason:
        "provider-first execution currently supports full refreshes only; incremental provider generations are not materialized yet",
    });
  }

  if (hasScipSource && scipExecutionConfigured(scip)) {
    return unsupportedPlan({
      fallbackAllowed,
      reason: SHADOW_ACTIVATION_PENDING_REASON,
    });
  }

  if (hasLspSource && !hasScipSource) {
    return unsupportedPlan({
      fallbackAllowed,
      reason:
        "LSP provider-first execution is still capped-planning only; the next executable phase is SCIP full refresh",
    });
  }

  return unsupportedPlan({
    fallbackAllowed,
    reason:
      "provider-first execution needs a configured SCIP index or enabled SCIP generator",
  });
}

export async function executeProviderFirstScipFull(
  params: ExecuteProviderFirstScipFullParams,
): Promise<ProviderFirstScipExecutionResult> {
  const generationId = `provider-first:${Date.now()}`;
  // This phase is intentionally SCIP-only and non-destructive: collect facts
  // and validate graph rows, but do not mutate the active DB until the shadow
  // loader can hand off atomically.
  const collected = await collectScipProviderFacts({
    ...params,
    generationId,
  });
  const indexedAt = new Date().toISOString();

  if (collected.facts.files.length === 0) {
    throw new Error(
      "Provider-first SCIP execution produced no file facts. Check scip.indexes paths or scip.generator output.",
    );
  }

  const rows = providerFactsToGraphRows({
    facts: collected.facts,
    indexedAt,
  });
  validateProviderGraphRows(rows);

  params.onProgress?.({
    stage: "finalizing",
    current: 0,
    total: 0,
    message: "provider facts staged; shadow activation pending",
  });

  return {
    generationId,
    facts: collected.facts,
    rows,
    generatedIndexes: collected.generatedIndexes,
    failures: collected.failures,
    summary: {
      status: "unsupported",
      executor: "scipFull",
      generationId,
      reasons: [SHADOW_ACTIVATION_PENDING_REASON],
      filesProcessed: rows.files.length,
      symbolsIndexed: rows.symbols.length + rows.externalSymbols.length,
      edgesCreated: rows.edges.length,
      externalSymbolsIndexed: rows.externalSymbols.length,
    },
  };
}

function unsupportedPlan(params: {
  fallbackAllowed: boolean;
  reason: string;
}): ProviderFirstExecutionPlan {
  return {
    canExecute: false,
    shouldFallbackToLegacy: params.fallbackAllowed,
    reasons: [params.reason],
  };
}

function validateProviderGraphRows(rows: ProviderFirstGraphRows): void {
  const fileIds = new Set(rows.files.map((file) => file.fileId));
  const symbolIds = new Set(rows.symbols.map((symbol) => symbol.symbolId));
  for (const external of rows.externalSymbols) {
    symbolIds.add(external.symbolId);
  }

  for (const symbol of rows.symbols) {
    if (!fileIds.has(symbol.fileId)) {
      throw new Error(
        `Provider-first symbol ${symbol.symbolId} references missing file ${symbol.fileId}`,
      );
    }
  }

  for (const edge of rows.edges) {
    if (!symbolIds.has(edge.fromSymbolId) || !symbolIds.has(edge.toSymbolId)) {
      throw new Error(
        `Provider-first edge ${edge.fromSymbolId} -> ${edge.toSymbolId} has a missing endpoint`,
      );
    }
  }
}

function scipExecutionConfigured(scip: ScipConfig | undefined): boolean {
  if (!scip?.enabled) return false;
  return scip.indexes.length > 0 || scip.generator.enabled === true;
}

async function collectScipProviderFacts(params: {
  repoId: string;
  repoRoot: string;
  config: AppConfig;
  generationId: string;
  generatedIndexes?: readonly ScipGeneratedIndexDiagnostic[];
  generatorFailures?: readonly ScipFailureDiagnostic[];
  onProgress?: ExecuteProviderFirstScipFullParams["onProgress"];
  signal?: AbortSignal;
}): Promise<{
  facts: ProviderFactSet;
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
}> {
  const scip = params.config.scip;
  if (!scip?.enabled) {
    throw new Error("Provider-first SCIP execution requested without enabled SCIP config");
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
    const relIndexPath = relativeIndexPath(params.repoRoot, indexPath, entry.path);
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

    params.onProgress?.({
      stage: "scipIngest",
      current: currentIndex,
      total: entries.length,
      message: `[${entry.label ?? relIndexPath}] decoding`,
    });
    const facts = await decodeScipIndexToFacts({
      repoId: params.repoId,
      generationId: params.generationId,
      indexPath,
      relIndexPath,
      entryLabel: entry.label,
      scip,
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
  generationId: string;
  indexPath: string;
  relIndexPath: string;
  entryLabel?: string;
  scip: ScipConfig;
  onProgress?: ExecuteProviderFirstScipFullParams["onProgress"];
  signal?: AbortSignal;
}): Promise<ProviderFactSet> {
  const decoder = await createScipDecoder(params.indexPath);
  const providerId = providerIdForScipEntry(params.entryLabel, params.relIndexPath);
  try {
    const metadata = await decoder.metadata();
    const documents: ScipDocument[] = [];
    let documentsSeen = 0;
    for await (const document of decoder.documents()) {
      params.signal?.throwIfAborted();
      documents.push(document);
      documentsSeen++;
      if (documentsSeen === 1 || documentsSeen % 250 === 0) {
        params.onProgress?.({
          stage: "scipIngest",
          current: documentsSeen,
          total: 0,
          message: `[${providerId}] documents=${documentsSeen}`,
        });
      }
    }

    const externalSymbols = await loadExternalSymbols(decoder, params.scip);
    logger.info("provider-first SCIP facts decoded", {
      repoId: params.repoId,
      providerId,
      documents: documents.length,
      externalSymbols: externalSymbols.length,
      indexPath: params.relIndexPath,
    });

    return normalizeScipProviderFacts({
      repoId: params.repoId,
      generationId: params.generationId,
      providerId,
      providerVersion: metadata.toolVersion,
      documents,
      externalSymbols,
      sourceIndexPath: params.relIndexPath,
      confidence: params.scip.confidence,
    });
  } finally {
    decoder.close();
  }
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

function resolveScipIndexPath(repoRoot: string, configuredPath: string): string {
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
  };
}

function appendProviderFactSet(
  target: ProviderFactSet,
  source: ProviderFactSet,
): void {
  target.files.push(...source.files);
  target.symbols.push(...source.symbols);
  target.occurrences.push(...source.occurrences);
  target.edges.push(...source.edges);
  target.externalSymbols.push(...source.externalSymbols);
  target.diagnostics.push(...source.diagnostics);
  target.coverage.push(...source.coverage);
  target.providerRuns.push(...source.providerRuns);
}
