import type { Connection } from "kuzu";

import type { SemanticConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getExtensionCapabilities } from "../db/extension-caps.js";
import { toNumber } from "../db/ladybug-core.js";
import {
  getFileSummaryRetrievalCoverage,
  getSymbolRetrievalCoverage,
} from "../db/ladybug-retrieval-health.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import {
  ENTITY_FTS_INDEX_NAMES,
  FILESUMMARY_EMBEDDING_PROPERTIES,
  FILESUMMARY_VECTOR_INDEX_NAMES,
  SYMBOL_FTS_INDEX_NAME,
  showIndexesStrict,
  type IndexInfo,
} from "./index-lifecycle.js";
import {
  getVecPropertyName,
  getVectorIndexName,
  SYMBOL_VECTOR_EMBEDDING_TABLE,
} from "./model-mapping.js";
import type {
  DegradationReason,
  RetrievalCapabilities,
} from "./types.js";

export interface RequiredRetrievalIndex {
  model?: string;
  tableName: "Symbol" | "SymbolVectorEmbedding" | "FileSummary";
  name: string | null;
  type: IndexInfo["type"];
  property: string | null;
}

export interface RequiredRetrievalIndexes {
  symbolFts: RequiredRetrievalIndex;
  fileSummaryFts: RequiredRetrievalIndex;
  symbolVectors: RequiredRetrievalIndex[];
  fileSummaryVectors: RequiredRetrievalIndex[];
}

export interface CoverageCount {
  eligible: unknown;
  covered: unknown;
  indexHealthy: boolean;
}

interface ModelCoverageCount extends CoverageCount {
  model: string;
}

/** Resolve the exact indexes required by the active semantic model plan. */
export function resolveRequiredRetrievalIndexes(
  semanticConfig: SemanticConfig | undefined,
): RequiredRetrievalIndexes {
  const plan = resolveSemanticEmbeddingModelPlan(semanticConfig);
  const configuredVectorIndexes = semanticConfig?.retrieval?.vector?.indexes;
  const symbolModels = [
    ...plan.symbolEmbeddingModels,
    ...plan.unsupportedSymbolEmbeddingModels,
  ];
  const fileSummaryModels = [
    ...plan.fileSummaryEmbeddingModels,
    ...plan.unsupportedFileSummaryEmbeddingModels,
  ];

  return {
    symbolFts: {
      tableName: "Symbol",
      name:
        semanticConfig?.retrieval?.fts?.indexName ?? SYMBOL_FTS_INDEX_NAME,
      type: "fts",
      property: "searchText",
    },
    fileSummaryFts: {
      tableName: "FileSummary",
      name: ENTITY_FTS_INDEX_NAMES.fileSummary,
      type: "fts",
      property: "searchText",
    },
    symbolVectors: symbolModels.map((model) => {
      const property = getVecPropertyName(model);
      const name =
        configuredVectorIndexes?.[model]?.indexName ??
        getVectorIndexName(model);
      return {
        model,
        tableName: SYMBOL_VECTOR_EMBEDDING_TABLE,
        name: property ? (name ?? null) : null,
        type: "vector" as const,
        property: property ?? null,
      };
    }),
    fileSummaryVectors: fileSummaryModels.map((model) => {
      const property = getVecPropertyName(model);
      return {
        model,
        tableName: "FileSummary" as const,
        name: property ? getFileSummaryVectorIndexName(property) : null,
        type: "vector" as const,
        property: property ?? null,
      };
    }),
  };
}

/** Match every index identity field and reject unhealthy or unloaded rows. */
export function hasExactHealthyIndex(
  indexes: readonly IndexInfo[],
  required: RequiredRetrievalIndex,
): boolean {
  if (!required.name || !required.property) return false;

  return indexes.some(
    (index) =>
      index.tableName === required.tableName &&
      index.name === required.name &&
      index.type === required.type &&
      index.property === required.property &&
      index.status === "healthy" &&
      index.extensionLoaded === true,
  );
}

/** Aggregate model rows into one logical source before one permille rounding. */
export function aggregateCoveragePermille(
  rows: readonly CoverageCount[],
): number {
  let eligible = 0;
  let covered = 0;

  for (const row of rows) {
    const rowEligible = Math.max(0, toNumber(row.eligible));
    const rowCovered = Math.max(0, toNumber(row.covered));
    eligible += rowEligible;
    covered += row.indexHealthy ? Math.min(rowEligible, rowCovered) : 0;
  }

  if (eligible === 0) {
    return rows.length === 0 || rows.every((row) => row.indexHealthy) ? 1000 : 0;
  }
  return Math.round((covered * 1000) / eligible);
}

/** Version-scoped Symbol coverage shared across retrieval requests. */
type SymbolRetrievalCoverage = Awaited<
  ReturnType<typeof getSymbolRetrievalCoverage>
>;

interface SymbolRetrievalCoverageCacheEntry {
  versionId: string;
  promise: Promise<SymbolRetrievalCoverage>;
}

const symbolRetrievalCoverageCache = new Map<
  string,
  Map<string, SymbolRetrievalCoverageCacheEntry>
>();

function getCachedSymbolRetrievalCoverage(
  conn: Connection,
  repoId: string,
  versionId: string,
  property: string,
): Promise<SymbolRetrievalCoverage> {
  let repoCache = symbolRetrievalCoverageCache.get(repoId);
  if (!repoCache) {
    repoCache = new Map();
    symbolRetrievalCoverageCache.set(repoId, repoCache);
  }

  const existing = repoCache.get(property);
  if (existing?.versionId === versionId) {
    return existing.promise;
  }

  // Cache the promise before the database work starts so concurrent queries
  // share one repository-wide coverage scan.
  const promise = Promise.resolve().then(() =>
    getSymbolRetrievalCoverage(conn, repoId, property),
  );
  const entry = { versionId, promise };
  repoCache.set(property, entry);

  void promise.catch(() => {
    const currentRepoCache = symbolRetrievalCoverageCache.get(repoId);
    // A failed old-version scan must not evict a newer replacement.
    if (currentRepoCache?.get(property) === entry) {
      currentRepoCache.delete(property);
      if (currentRepoCache.size === 0) {
        symbolRetrievalCoverageCache.delete(repoId);
      }
    }
  });

  return promise;
}

export function invalidateSymbolRetrievalCoverageCache(repoId: string): void {
  symbolRetrievalCoverageCache.delete(repoId);
}

/**
 * Inspect retrieval indexes and repo-scoped embedding coverage.
 *
 * The caller owns connection admission. Any inspection failure stays unavailable;
 * extension availability alone never promotes a retrieval capability.
 */
export async function checkRetrievalHealth(
  conn: Connection,
  repoId: string,
  semanticConfig: SemanticConfig | undefined,
): Promise<RetrievalCapabilities> {
  try {
    const indexes = await showIndexesStrict(conn);
    const extensions = getExtensionCapabilities();
    const required = resolveRequiredRetrievalIndexes(semanticConfig);
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    const symbolCoverageFallback =
      getVecPropertyName("jina-embeddings-v2-base-code") ??
      FILESUMMARY_EMBEDDING_PROPERTIES.jinaCode.property;

    const symbolFts =
      extensions.fts && hasExactHealthyIndex(indexes, required.symbolFts);
    const fileSummaryFts =
      extensions.fts && hasExactHealthyIndex(indexes, required.fileSummaryFts);

    const symbolRows: ModelCoverageCount[] = await Promise.all(
      required.symbolVectors.map(async (index) => {
        const property = index.property ?? symbolCoverageFallback;
        return {
          model: index.model ?? "unknown",
          ...(latestVersion
            ? await getCachedSymbolRetrievalCoverage(
                conn,
                repoId,
                latestVersion.versionId,
                property,
              )
            : await getSymbolRetrievalCoverage(conn, repoId, property)),
          indexHealthy:
            extensions.vector && hasExactHealthyIndex(indexes, index),
        };
      }),
    );
    const fileSummaryRows: ModelCoverageCount[] = await Promise.all(
      required.fileSummaryVectors.map(async (index) => {
        const property =
          index.property ?? FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property;
        return {
          model: index.model ?? "unknown",
          ...(await getFileSummaryRetrievalCoverage(conn, repoId, property)),
          indexHealthy:
            extensions.vector && hasExactHealthyIndex(indexes, index),
        };
      }),
    );

    const vectorByEntityModel = {
      symbol: Object.fromEntries(
        symbolRows.map((row) => [row.model, row.indexHealthy]),
      ),
      fileSummary: Object.fromEntries(
        fileSummaryRows.map((row) => [row.model, row.indexHealthy]),
      ),
    };
    const modelCoveragePermille = {
      symbol: Object.fromEntries(
        symbolRows.map((row) => [
          row.model,
          aggregateCoveragePermille([row]),
        ]),
      ),
      fileSummary: Object.fromEntries(
        fileSummaryRows.map((row) => [
          row.model,
          aggregateCoveragePermille([row]),
        ]),
      ),
    };
    const coveragePermille = {
      symbolVector: aggregateCoveragePermille(symbolRows),
      fileSummaryVector: aggregateCoveragePermille(fileSummaryRows),
    };
    const degradationReasons = buildDegradationReasons(
      extensions,
      required,
      indexes,
    );

    logger.debug("[retrieval] strict health coverage", {
      repoId,
      coveragePermille,
      modelCoveragePermille,
    });

    return {
      fts: symbolFts,
      fileSummaryFts,
      vectorNomic:
        vectorByEntityModel.symbol["nomic-embed-text-v1.5"] === true,
      vectorJinaCode:
        vectorByEntityModel.symbol["jina-embeddings-v2-base-code"] === true,
      vectorByEntityModel,
      modelCoveragePermille,
      coveragePermille,
      degradationReasons,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[retrieval] strict health check failed: ${message}`);
    return unavailableCapabilities({
      code: "health-check-error",
      message,
      affects: "all",
    });
  }
}

function getFileSummaryVectorIndexName(property: string | null): string | null {
  if (property === FILESUMMARY_EMBEDDING_PROPERTIES.jinaCode.property) {
    return FILESUMMARY_VECTOR_INDEX_NAMES.jinaCode;
  }
  if (property === FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property) {
    return FILESUMMARY_VECTOR_INDEX_NAMES.nomic;
  }
  return null;
}

function buildDegradationReasons(
  extensions: { fts: boolean; vector: boolean },
  required: RequiredRetrievalIndexes,
  indexes: readonly IndexInfo[],
): DegradationReason[] {
  const reasons: DegradationReason[] = [];
  if (!extensions.fts) {
    reasons.push({
      code: "fts-extension-unavailable",
      message: "FTS extension not loaded",
      affects: "fts",
    });
  } else if (
    !hasExactHealthyIndex(indexes, required.symbolFts) ||
    !hasExactHealthyIndex(indexes, required.fileSummaryFts)
  ) {
    reasons.push({
      code: "fts-index-missing",
      message: "Required retrieval FTS index is missing or unhealthy",
      affects: "fts",
    });
  }

  if (!extensions.vector) {
    reasons.push({
      code: "vector-extension-unavailable",
      message: "Vector extension not loaded",
      affects: "vector",
    });
  }
  for (const index of [
    ...required.symbolVectors,
    ...required.fileSummaryVectors,
  ]) {
    if (!hasExactHealthyIndex(indexes, index)) {
      reasons.push({
        code: "vector-index-missing",
        message: `Required vector index is missing or unhealthy: ${
          index.name ?? `${index.tableName}:${index.model ?? "unknown"}`
        }`,
        affects: "vector",
      });
    }
  }
  return reasons;
}

function unavailableCapabilities(
  reason: DegradationReason,
): RetrievalCapabilities {
  return {
    fts: false,
    fileSummaryFts: false,
    vectorNomic: false,
    vectorJinaCode: false,
    vectorByEntityModel: {
      symbol: {},
      fileSummary: {},
    },
    modelCoveragePermille: {
      symbol: {},
      fileSummary: {},
    },
    coveragePermille: {
      symbolVector: 0,
      fileSummaryVector: 0,
    },
    degradationReasons: [reason],
  };
}
