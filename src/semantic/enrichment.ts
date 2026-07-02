import { randomUUID } from "node:crypto";

import {
  SemanticEnrichmentConfigSchema,
  type AppConfig,
  type ScipIndexEntry,
  type SemanticEnrichmentConfig,
} from "../config/types.js";
import { getLadybugConn } from "../db/ladybug.js";
import {
  getLatestSemanticProviderRuns,
} from "../db/ladybug-semantic.js";
import { getRepo } from "../db/ladybug-repos.js";
import { ScipIngestionError } from "../domain/errors.js";
import type { ScipIngestResponse } from "../scip/types.js";
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
  detail?: "compact" | "full";
  limit?: number;
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

  const providerFirstOnlyReason =
    "SCIP and LSP provider facts are indexed only by provider-first indexing; run sdl.index.refresh with provider inputs enabled";
  for (const providerType of selectedProviderTypes) {
    const languages = selectedLanguages(selections, providerType);
    if (languages.length === 0) {
      skipped.push({
        providerType,
        reason: providerFirstOnlyReason,
      });
      continue;
    }
    for (const languageId of languages) {
      skipped.push({
        providerType,
        languageId,
        reason: providerFirstOnlyReason,
      });
    }
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
