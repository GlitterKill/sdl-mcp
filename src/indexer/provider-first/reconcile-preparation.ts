import { hash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AppConfig, RepoConfig } from "../../config/types.js";
import { IndexError } from "../../domain/errors.js";
import { prepareSavedFilePatch } from "../../live-index/file-patcher.js";
import { runScipIoBeforeIndex } from "../../scip/scip-io-runner.js";
import { hashContent, hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import {
  executeProviderFirstLspIncremental,
  executeProviderFirstScipIncremental,
  readRepositoryFileBounded,
  resolveProviderFirstExecutionPlan,
  type ProviderFirstSourceFileMetadata,
} from "./executor.js";
import { resolveProviderFirstPipeline } from "./planner.js";

type ScipDiagnostics = Awaited<ReturnType<typeof runScipIoBeforeIndex>>;
type IncrementalParams = Parameters<
  typeof executeProviderFirstScipIncremental
>[0];
type LspClientFactory = Parameters<
  typeof executeProviderFirstLspIncremental
>[0]["clientFactory"];

export interface ReconcileSourceSnapshot extends ProviderFirstSourceFileMetadata {
  content: string;
  language?: string;
  version?: number;
}

export interface ReconcilePreparationRequest {
  repoId: string;
  repoRoot: string;
  repoConfig: RepoConfig;
  appConfig: AppConfig;
  files: readonly ReconcileSourceSnapshot[];
  /** Selected dependency/project/config inputs, relative to this repository. */
  dependencyInputs: readonly { path: string; contentHash: string }[];
  /**
   * Rechecks the worker's captured repository source/inventory generation and
   * configuration ownership. Provider read sets can exceed selected files, so
   * relevant repository events must invalidate this ownership conservatively.
   */
  assertCurrent(): void;
  signal?: AbortSignal;
}

interface PreparationDependencies {
  runScipIo?: typeof runScipIoBeforeIndex;
  clientFactory?: LspClientFactory;
}

/** Scoped generation owns its output even if the generator rejects or aborts. */
export async function runProviderFirstIncrementalScipIo(
  params: {
    repoId: string;
    repoRoot: string;
    repoConfig: RepoConfig;
    appConfig: AppConfig;
    changedFiles: readonly { path: string }[];
    signal?: AbortSignal;
  },
  runScipIo = runScipIoBeforeIndex,
): Promise<{
  diagnostics: ScipDiagnostics;
  tempPaths: string[];
}> {
  const generatorCfg = params.appConfig.scip?.generator;
  if (!generatorCfg?.enabled) {
    throw new IndexError(
      "Provider-first SCIP incremental execution requires an enabled scip.generator",
    );
  }
  const tempRoot = join(
    params.repoRoot,
    ".sdl-mcp",
    "provider-first-incremental",
  );
  await mkdir(tempRoot, { recursive: true });
  const runKey = randomUUID();
  const manifestPath = join(tempRoot, `${runKey}.files.txt`);
  const outputPath = join(tempRoot, `${runKey}.scip`);
  const tempPaths = [manifestPath, outputPath];
  try {
    await writeFile(
      manifestPath,
      `${params.changedFiles.map((file) => normalizePath(file.path)).join("\n")}\n`,
      "utf-8",
    );
    const diagnostics = await runScipIo({
      repoRootPath: params.repoRoot,
      generatorCfg,
      signal: params.signal,
      repoLanguages: params.repoConfig.languages,
      repoConfig: params.repoConfig,
      repoId: params.repoId,
      filesFromPath: manifestPath,
      outputPath,
    });
    return { diagnostics, tempPaths };
  } catch (error) {
    await cleanupProviderFirstIncrementalTempPaths(tempPaths);
    throw error;
  }
}

export async function cleanupProviderFirstIncrementalTempPaths(
  tempPaths: readonly string[],
): Promise<void> {
  await Promise.all(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
}

/** The explicit indexer and background preparation share scoped executor choice. */
export function executeProviderFirstIncremental(
  executor: "scipIncremental" | "lspIncremental",
  params: IncrementalParams,
  clientFactory?: LspClientFactory,
) {
  return executor === "scipIncremental"
    ? executeProviderFirstScipIncremental(params)
    : executeProviderFirstLspIncremental({ ...params, clientFactory });
}

/** No dispatch admission, index gate, writer, or write-heavy lock is acquired. */
export async function prepareReconcileFiles(
  request: ReconcilePreparationRequest,
  dependencies: PreparationDependencies = {},
) {
  // Capture caller-owned objects before awaiting. The worker still owns the
  // generation check; hashes catch disk writes that arrive before watcher events.
  const files = request.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  const dependencyInputs = request.dependencyInputs.map((file) => ({
    ...file,
  }));
  const repoConfig = structuredClone(request.repoConfig);
  const appConfig = structuredClone(request.appConfig);
  const configurationHash = hashValue({ repoConfig, appConfig });
  const assertInputsCurrent = async () => {
    request.signal?.throwIfAborted();
    request.assertCurrent();
    if (
      configurationHash !==
      hashValue({
        repoConfig: request.repoConfig,
        appConfig: request.appConfig,
      })
    ) {
      throw new IndexError(
        "Reconciliation configuration changed during preparation",
      );
    }
    for (const file of [...files, ...dependencyInputs]) {
      const source = await readRepositoryFileBounded(
        request.repoRoot,
        file.path,
        repoConfig.maxFileBytes,
      );
      if (
        source.kind !== "ok" ||
        hash("sha256", source.content, "hex") !== file.contentHash
      ) {
        throw new IndexError(
          `Reconciliation input changed or is unavailable: ${file.path}`,
        );
      }
    }
    request.assertCurrent();
  };
  if (
    files.length === 0 ||
    new Set(files.map((file) => file.path)).size !== files.length
  ) {
    throw new IndexError("Reconciliation requires distinct selected files");
  }
  for (const file of files) {
    if (
      hashContent(file.content) !== file.contentHash ||
      Buffer.byteLength(file.content) !== file.size
    ) {
      throw new IndexError(
        `Reconciliation source snapshot is stale: ${file.path}`,
      );
    }
  }
  await assertInputsCurrent();
  const selection = resolveProviderFirstPipeline({
    indexing: appConfig.indexing,
    scip: appConfig.scip,
    semanticEnrichment: appConfig.semanticEnrichment,
  });
  const plan = resolveProviderFirstExecutionPlan({
    selection,
    mode: "incremental",
    scip: appConfig.scip,
  });
  if (selection.selectedPipeline === "legacy") {
    const patches = [];
    for (const file of files) {
      patches.push(
        await prepareSavedFilePatch({
          repoId: request.repoId,
          filePath: file.path,
          content: file.content,
          language: file.language,
          version: file.version,
        }),
      );
    }
    await assertInputsCurrent();
    return {
      kind: "parser" as const,
      files,
      dependencyInputs,
      configurationHash,
      patches,
    };
  }
  // A failed/unavailable configured provider is not fresh parser coverage.
  if (
    !plan.canExecute ||
    (plan.executor !== "scipIncremental" && plan.executor !== "lspIncremental")
  ) {
    throw new IndexError(plan.reasons.join("; "));
  }
  let tempPaths: string[] = [];
  try {
    let diagnostics: ScipDiagnostics | undefined;
    if (plan.executor === "scipIncremental") {
      const generated = await runProviderFirstIncrementalScipIo(
        {
          ...request,
          repoConfig,
          appConfig,
          changedFiles: files,
        },
        dependencies.runScipIo,
      );
      tempPaths = generated.tempPaths;
      diagnostics = generated.diagnostics;
      if (diagnostics.failures.length > 0)
        throw new IndexError(
          "Configured SCIP provider failed during reconciliation",
        );
    }
    const result = await executeProviderFirstIncremental(
      plan.executor,
      {
        repoId: request.repoId,
        repoRoot: request.repoRoot,
        config: appConfig,
        scannedFiles: files,
        scannedPaths: files.map((file) => file.path),
        generatedIndexes: diagnostics?.generatedIndexes,
        generatorFailures: diagnostics?.failures,
        generatorCacheKey: diagnostics?.cache?.key,
        signal: request.signal,
      },
      dependencies.clientFactory,
    );
    await assertInputsCurrent();
    if (result.facts.providerRuns.some((run) => run.status === "failed")) {
      throw new IndexError("Configured provider failed during reconciliation");
    }
    // LSP batches can succeed overall while individual documents failed or
    // could not collect symbols. A successful [] has no skipped-symbol reason.
    if (
      result.facts.coverage.some(
        (coverage) =>
          coverage.providerType === "lsp" &&
          coverage.skippedSymbolReasons?.some(
            (reason) => reason.reason === "documentSymbol request failed",
          ),
      )
    ) {
      throw new IndexError(
        "Configured LSP symbol collection failed during reconciliation",
      );
    }
    const selectedPaths = new Set(files.map((file) => file.path));
    if (
      result.facts.files.some(
        (file) => !selectedPaths.has(normalizePath(file.relPath)),
      )
    ) {
      throw new IndexError(
        "Configured provider returned files outside the reconciliation scope",
      );
    }
    // Coverage gaps remain explicit facts for the future publisher/planner;
    // preparation neither relabels provider failures nor invents parser state.
    const coveredPaths = new Set(
      result.facts.files.map((file) => normalizePath(file.relPath)),
    );
    const uncoveredPaths = files
      .filter((file) => !coveredPaths.has(file.path))
      .map((file) => file.path);
    return {
      kind: "provider" as const,
      files,
      dependencyInputs,
      configurationHash,
      result,
      uncoveredPaths,
    };
  } finally {
    // Await provider settlement before deleting its inputs/output (no timeout race).
    await cleanupProviderFirstIncrementalTempPaths(tempPaths);
  }
}
