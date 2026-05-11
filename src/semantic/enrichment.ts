import { randomUUID } from "node:crypto";

import {
  ScipConfigSchema,
  SemanticEnrichmentConfigSchema,
  type AppConfig,
  type ScipConfig,
  type ScipIndexEntry,
  type SemanticEnrichmentConfig,
  type SemanticEnrichmentLspServerConfig,
} from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import {
  getLatestSemanticProviderRuns,
  mergeSemanticProviderRun,
} from "../db/ladybug-semantic.js";
import { getRepo } from "../db/ladybug-repos.js";
import { getLatestVersion } from "../db/ladybug-versions.js";
import { markDerivedStateDirty } from "../db/ladybug-derived-state.js";
import { ScipIngestionError } from "../domain/errors.js";
import { clearOverviewCache } from "../graph/overview.js";
import { clearSliceCache } from "../graph/sliceCache.js";
import { symbolCardCache } from "../graph/cache.js";
import { invalidateGraphSnapshot } from "../graph/graphSnapshotCache.js";
import { ingestScipIndex } from "../scip/ingestion.js";
import type { ScipIngestResponse } from "../scip/types.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import {
  deriveSemanticLanguagePacks,
  extendLanguagePacksForLsp,
} from "./language-packs.js";
import {
  selectSemanticSources,
  type DetectedSemanticTools,
  type SemanticSourceSelection,
} from "./source-selection.js";
import type {
  PersistedSemanticProviderRun,
  SemanticProviderRun,
} from "./types.js";
import { runLspCallDefinitionEnrichment } from "./providers/lsp/runner.js";
import { writeSemanticIndex } from "./writer.js";

export interface SemanticEnrichmentRefreshRequest {
  repoId: string;
  dryRun?: boolean;
  force?: boolean;
  install?: boolean;
  languages?: string[];
  skipProviders?: Array<"scip" | "lsp">;
}

export interface SemanticEnrichmentStatusRequest {
  repoId: string;
  languages?: string[];
}

export interface SemanticEnrichmentRefreshResult {
  ok: boolean;
  repoId: string;
  enabled: boolean;
  dryRun: boolean;
  installPolicy: SemanticEnrichmentConfig["installPolicy"];
  selections: SemanticSourceSelection[];
  runs: SemanticProviderRun[];
  scipResults: ScipIngestResponse[];
  skipped: Array<{ providerType: string; languageId?: string; reason: string }>;
}

export interface SemanticEnrichmentStatusResult {
  ok: boolean;
  repoId: string;
  enabled: boolean;
  autoRunOnIndexRefresh: boolean;
  installPolicy: SemanticEnrichmentConfig["installPolicy"];
  selections: SemanticSourceSelection[];
  lastRuns: PersistedSemanticProviderRun[];
}

export async function refreshSemanticEnrichment(
  request: SemanticEnrichmentRefreshRequest,
  appConfig: AppConfig,
): Promise<SemanticEnrichmentRefreshResult> {
  const config = resolveSemanticEnrichmentConfig(appConfig, request.languages);
  const dryRun = request.dryRun === true;
  if (!config.enabled) {
    return {
      ok: true,
      repoId: request.repoId,
      enabled: false,
      dryRun,
      installPolicy: config.installPolicy,
      selections: [],
      runs: [],
      scipResults: [],
      skipped: [
        {
          providerType: "semanticEnrichment",
          reason: "semanticEnrichment.enabled is false",
        },
      ],
    };
  }

  const conn = await getLadybugConn();
  const repo = await getRepo(conn, request.repoId);
  if (!repo) {
    throw new ScipIngestionError(
      `Repository "${request.repoId}" not found. Register it first.`,
    );
  }

  const packs = extendLanguagePacksForLsp(deriveSemanticLanguagePacks(), config);
  const detectedTools = detectSemanticTools(
    appConfig,
    config,
    packs.map((p) => p.languageId),
  );
  const selections = selectSemanticSources(config, packs, detectedTools);
  const skipped: SemanticEnrichmentRefreshResult["skipped"] = [];
  const runs: SemanticProviderRun[] = [];
  const scipResults: ScipIngestResponse[] = [];

  if (request.install === true && config.installPolicy === "never") {
    skipped.push({
      providerType: "install",
      reason:
        "install requested but semanticEnrichment.installPolicy is 'never'",
    });
  }

  const selectedProviderTypes = new Set(
    selections
      .map((selection) => selection.selected?.providerType)
      .filter((providerType): providerType is "scip" | "lsp" =>
        Boolean(providerType),
      ),
  );
  for (const providerType of request.skipProviders ?? []) {
    selectedProviderTypes.delete(providerType);
  }
  const shouldFilterProviderLanguages = config.languages.length > 0;

  if (selectedProviderTypes.has("scip")) {
    const scipConfig = resolveScipConfig(appConfig);
    const indexes = resolveScipIndexes(appConfig, config);
    const scipLanguages = selectedLanguages(selections, "scip");
    for (const index of indexes) {
      const result = await ingestScipIndex(
        {
          repoId: request.repoId,
          indexPath: index.path,
          dryRun,
          force: request.force === true,
          languages: shouldFilterProviderLanguages ? scipLanguages : undefined,
        },
        scipConfig,
      );
      scipResults.push(result);
      const run = scipResultToProviderRun({
        repoId: request.repoId,
        indexPath: index.path,
        result,
        languages: scipLanguages,
        dryRun,
      });
      runs.push(run);
      if (!dryRun) {
        await withWriteConn((writeConn) =>
          mergeSemanticProviderRun(writeConn, run),
        );
      }
    }
  }

  if (selectedProviderTypes.has("lsp")) {
    for (const languageId of selectedLanguages(selections, "lsp")) {
      const serverEntry = resolveLspServer(config, languageId);
      if (!serverEntry) {
        skipped.push({
          providerType: "lsp",
          languageId,
          reason: "no enabled LSP server configured for language",
        });
        continue;
      }

      const result = await runLspCallDefinitionEnrichment({
        conn,
        repoId: request.repoId,
        repoRoot: repo.rootPath,
        languageId,
        serverKey: serverEntry.serverKey,
        server: serverEntry.server,
        providerVersion: config.providers.lsp?.providerVersion,
        confidence: config.providers.lsp?.confidence ?? 0.8,
        timeoutMs: config.timeoutMs,
        candidateLimit: config.providers.lsp?.candidateLimit ?? 200,
      });
      for (const skip of result.skipped) {
        skipped.push({
          providerType: "lsp",
          languageId: skip.languageId,
          reason: skip.reason,
        });
      }

      if (result.failedRun) {
        runs.push(result.failedRun);
        if (!dryRun) {
          await withWriteConn((writeConn) =>
            mergeSemanticProviderRun(writeConn, result.failedRun!),
          );
        }
        continue;
      }

      if (result.skippedRun) {
        runs.push(result.skippedRun);
        if (!dryRun) {
          await withWriteConn((writeConn) =>
            mergeSemanticProviderRun(writeConn, result.skippedRun!),
          );
        }
        continue;
      }

      if (result.index) {
        const index = result.index;
        const writeResult = dryRun
          ? await writeSemanticIndex(conn, index, {
              dryRun: true,
              extraEdgesSkipped: result.skipped.length,
            })
          : await withWriteConn((writeConn) =>
              writeSemanticIndex(writeConn, index, {
                extraEdgesSkipped: result.skipped.length,
              }),
            );
        runs.push(writeResult.run);
      }
    }
  }

  if (!dryRun && semanticRefreshTouchedEdges(runs, scipResults)) {
    await invalidateSemanticEnrichmentState(request.repoId);
  }

  return {
    ok: true,
    repoId: request.repoId,
    enabled: config.enabled,
    dryRun,
    installPolicy: config.installPolicy,
    selections,
    runs,
    scipResults,
    skipped,
  };
}

export async function getSemanticEnrichmentStatus(
  request: SemanticEnrichmentStatusRequest,
  appConfig: AppConfig,
): Promise<SemanticEnrichmentStatusResult> {
  const config = resolveSemanticEnrichmentConfig(appConfig, request.languages);
  const packs = extendLanguagePacksForLsp(deriveSemanticLanguagePacks(), config);
  const detectedTools = detectSemanticTools(
    appConfig,
    config,
    packs.map((p) => p.languageId),
  );
  const selections = selectSemanticSources(config, packs, detectedTools);
  const conn = await getLadybugConn();
  const lastRuns = filterProviderRunsByLanguages(
    await getLatestSemanticProviderRuns(conn, request.repoId),
    config.languages,
  );

  return {
    ok: true,
    repoId: request.repoId,
    enabled: config.enabled,
    autoRunOnIndexRefresh: config.autoRunOnIndexRefresh,
    installPolicy: config.installPolicy,
    selections,
    lastRuns,
  };
}

function semanticRefreshTouchedEdges(
  runs: readonly SemanticProviderRun[],
  scipResults: readonly ScipIngestResponse[],
): boolean {
  return (
    runs.some(
      (run) =>
        run.status === "completed" &&
        run.edgesCreated + run.edgesUpgraded + run.edgesReplaced > 0,
    ) ||
    scipResults.some(
      (result) =>
        result.edgesCreated + result.edgesUpgraded + result.edgesReplaced > 0,
    )
  );
}

async function invalidateSemanticEnrichmentState(repoId: string): Promise<void> {
  clearSliceCache();
  clearOverviewCache();
  symbolCardCache.clear();
  invalidateGraphSnapshot(repoId);

  const conn = await getLadybugConn();
  const latestVersion = await getLatestVersion(conn, repoId);
  if (!latestVersion) {
    logger.debug("Semantic enrichment cache invalidation skipped derived state", {
      repoId,
      reason: "no latest version",
    });
    return;
  }

  await markDerivedStateDirty(repoId, latestVersion.versionId, {
    clusters: true,
    processes: true,
    algorithms: true,
    embeddings: true,
  });
}

function filterProviderRunsByLanguages(
  runs: readonly PersistedSemanticProviderRun[],
  languages: readonly string[],
): PersistedSemanticProviderRun[] {
  if (languages.length === 0) return [...runs];
  const allowed = new Set(languages);
  return runs.filter((run) =>
    run.languages.some((languageId) => allowed.has(languageId)),
  );
}

function resolveSemanticEnrichmentConfig(
  appConfig: AppConfig,
  languages?: string[],
): SemanticEnrichmentConfig {
  const parsed = SemanticEnrichmentConfigSchema.parse(
    appConfig.semanticEnrichment ?? {},
  );
  return languages && languages.length > 0 ? { ...parsed, languages } : parsed;
}

function detectSemanticTools(
  appConfig: AppConfig,
  config: SemanticEnrichmentConfig,
  languageIds: readonly string[],
): DetectedSemanticTools {
  const detected: DetectedSemanticTools = {};
  const scipIndexes = resolveScipIndexes(appConfig, config);
  if (appConfig.scip?.enabled && scipIndexes.length > 0) {
    detected.scip = Object.fromEntries(
      languageIds.map((languageId) => [
        languageId,
        {
          available: true,
          providerId: config.providers.scip?.providerId ?? "scip",
          providerVersion: config.providers.scip?.providerVersion,
          canAffectPass2: true,
        },
      ]),
    );
  }

  const lspServers = config.providers.lsp?.servers ?? {};
  if (Object.keys(lspServers).length > 0) {
    detected.lsp = {};
    for (const [serverId, server] of Object.entries(lspServers)) {
      if (server.enabled === false) continue;
      for (const languageId of server.languages) {
        detected.lsp[languageId] = {
          available: true,
          providerId: server.serverId || serverId,
          providerVersion: config.providers.lsp?.providerVersion,
          canAffectPass2: false,
        };
      }
    }
  }

  return detected;
}

function resolveScipConfig(appConfig: AppConfig): ScipConfig {
  return ScipConfigSchema.parse(appConfig.scip ?? {});
}

function resolveScipIndexes(
  appConfig: AppConfig,
  config: SemanticEnrichmentConfig,
): ScipIndexEntry[] {
  const bridgeIndexes = config.providers.scip?.indexes ?? [];
  return bridgeIndexes.length > 0
    ? bridgeIndexes
    : (appConfig.scip?.indexes ?? []);
}

function selectedLanguages(
  selections: readonly SemanticSourceSelection[],
  providerType: "scip" | "lsp",
): string[] {
  return selections
    .filter((selection) => selection.selected?.providerType === providerType)
    .map((selection) => selection.languageId);
}

function resolveLspServer(
  config: SemanticEnrichmentConfig,
  languageId: string,
): { serverKey: string; server: SemanticEnrichmentLspServerConfig } | null {
  for (const [serverKey, server] of Object.entries(
    config.providers.lsp?.servers ?? {},
  )) {
    if (server.enabled === false) continue;
    if (server.languages.includes(languageId)) {
      return { serverKey, server };
    }
  }
  return null;
}

export function scipResultToProviderRun(params: {
  repoId: string;
  indexPath: string;
  result: ScipIngestResponse;
  languages: string[];
  dryRun: boolean;
}): SemanticProviderRun {
  const now = new Date().toISOString();
  const cacheHit = params.result.status === "alreadyIngested";
  const edgesTouched =
    params.result.edgesCreated +
    params.result.edgesUpgraded +
    params.result.edgesReplaced;
  const coverage = params.result.perFileCoverage;
  const fullyCovered = coverage.filter(
    (row) => row.total > 0 && row.matched === row.total && row.unresolved === 0,
  ).length;
  const precisionScore =
    coverage.length === 0
      ? 0
      : Math.round((fullyCovered / coverage.length) * 1000) / 1000;

  return {
    runId: randomUUID(),
    repoId: params.repoId,
    providerType: "scip",
    providerId: "scip",
    languages: params.languages,
    sourceIndexPath: normalizePath(params.indexPath),
    status: params.dryRun ? "planned" : cacheHit ? "skipped" : "completed",
    startedAt: now,
    finishedAt: now,
    documentsProcessed: params.result.documentsProcessed,
    symbolsMatched: params.result.symbolsMatched,
    edgesCreated: params.result.edgesCreated,
    edgesUpgraded: params.result.edgesUpgraded,
    edgesReplaced: params.result.edgesReplaced,
    edgesSkipped: params.result.skippedSymbols,
    diagnosticsCount: 0,
    precisionScore: edgesTouched > 0 ? precisionScore : 0,
    cacheHit,
    canAffectPass2: true,
    selected: true,
  };
}
