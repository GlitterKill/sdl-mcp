import { existsSync } from "node:fs";

import type { SemanticConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getDerivedStateFromConnection } from "../db/ladybug-derived-state.js";
import {
  getFileSummaryRetrievalCoverage,
  getSymbolRetrievalCoverage,
} from "../db/ladybug-retrieval-health.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  LADYBUG_SCHEMA_VERSION,
  getSchemaVersion,
} from "../db/ladybug-schema.js";
import {
  closeLadybugDb,
  getLadybugConn,
  getLadybugDbPath,
  initValidatedLadybugClone,
} from "../db/ladybug.js";
import type { VerifiedLadybugFamilyCopy } from "../db/ladybug-family-files.js";
import {
  hasExactHealthyIndex,
  resolveRequiredRetrievalIndexes,
  type RequiredRetrievalIndex,
} from "../retrieval/health.js";
import { showIndexesStrict } from "../retrieval/index-lifecycle.js";
import { SYMBOL_VECTOR_EMBEDDING_TABLE } from "../retrieval/model-mapping.js";
import { normalizePath } from "../util/paths.js";

export interface ContextQualityCacheExpectation {
  repoId: string;
  repoRoot: string;
  repoSha: string;
  configDigest: string;
  ladybugSchemaVersion: number;
  symbolEmbeddingModels: string[];
  fileSummaryEmbeddingModels: string[];
}

export interface ContextQualityCacheIndexIdentity {
  model?: string;
  tableName: "Symbol" | typeof SYMBOL_VECTOR_EMBEDDING_TABLE | "FileSummary";
  name: string;
  type: "fts" | "vector";
  property: string;
  healthy: boolean;
  eligible?: number;
  covered?: number;
}

export interface ContextQualityCacheSnapshot {
  repos: Array<{ repoId: string; rootPath: string }>;
  ladybugSchemaVersion: number | null;
  activeEmbeddingModels: {
    symbol: string[];
    fileSummary: string[];
  };
  graphVersionId: string;
  derivedState: {
    clustersDirty: boolean;
    processesDirty: boolean;
    algorithmsDirty: boolean;
    summariesDirty: boolean;
    embeddingsDirty: boolean;
    targetVersionId: string | null;
    computedVersionId: string | null;
    graphIntegrityState: string | null;
    graphIntegrityVersionId: string | null;
    graphIntegrityDigest: string | null;
    graphIntegrityRevision: number | null;
    graphIntegrityVerifiedRevision: number | null;
  };
  indexes: {
    symbolFts: ContextQualityCacheIndexIdentity;
    fileSummaryFts: ContextQualityCacheIndexIdentity;
    symbolVectors: ContextQualityCacheIndexIdentity[];
    fileSummaryVectors: ContextQualityCacheIndexIdentity[];
  };
}

export interface ContextQualityCacheValidation {
  repoId: string;
  repoRoot: string;
  repoSha: string;
  configDigest: string;
  ladybugSchemaVersion: number;
  activeEmbeddingModels: {
    symbol: string[];
    fileSummary: string[];
  };
  graphVersionId: string;
  graphIntegrityState: "verified";
  graphIntegrityVersionId: string;
  graphIntegrityDigest: string;
  indexes: ContextQualityCacheSnapshot["indexes"];
}

function assertExactArray(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + " mismatch");
  }
}

function assertHealthyIndex(
  index: ContextQualityCacheIndexIdentity,
  tableName: "Symbol" | typeof SYMBOL_VECTOR_EMBEDDING_TABLE | "FileSummary",
  type: "fts" | "vector",
): void {
  if (
    index.tableName !== tableName ||
    index.type !== type ||
    index.name.length === 0 ||
    index.property.length === 0 ||
    index.healthy !== true
  ) {
    throw new Error(`Required ${tableName} ${type} index is not healthy`);
  }
}

function assertCompleteVectorCoverage(
  indexes: readonly ContextQualityCacheIndexIdentity[],
  models: readonly string[],
  tableName: "Symbol" | typeof SYMBOL_VECTOR_EMBEDDING_TABLE | "FileSummary",
): void {
  assertExactArray(
    indexes.map((index) => index.model ?? ""),
    models,
    `${tableName} vector model identity`,
  );
  for (const index of indexes) {
    assertHealthyIndex(index, tableName, "vector");
    if (
      !Number.isSafeInteger(index.eligible) ||
      !Number.isSafeInteger(index.covered) ||
      (index.eligible ?? 0) <= 0 ||
      index.covered !== index.eligible
    ) {
      throw new Error(
        `${tableName} vector coverage is not complete for ${index.model ?? "unknown model"}`,
      );
    }
  }
}

/**
 * Converts one reopened Ladybug family snapshot into the immutable cache
 * identity. Every field here must match again after a cache restore.
 */
export function validateContextQualityCacheSnapshot(
  snapshot: ContextQualityCacheSnapshot,
  expectation: ContextQualityCacheExpectation,
): ContextQualityCacheValidation {
  if (!/^[0-9a-f]{40}$/u.test(expectation.repoSha)) {
    throw new Error("Pinned repository SHA must be a lowercase SHA-1");
  }
  if (!/^[0-9a-f]{64}$/u.test(expectation.configDigest)) {
    throw new Error("Benchmark config digest must be a lowercase SHA-256");
  }
  if (
    snapshot.repos.length !== 1 ||
    snapshot.repos[0]?.repoId !== expectation.repoId
  ) {
    throw new Error("Benchmark database must be owned by exactly one repo");
  }

  const expectedRoot = normalizePath(expectation.repoRoot);
  if (normalizePath(snapshot.repos[0].rootPath) !== expectedRoot) {
    throw new Error("Benchmark repository root mismatch");
  }
  if (snapshot.ladybugSchemaVersion !== expectation.ladybugSchemaVersion) {
    throw new Error("Ladybug schema version mismatch");
  }
  if (expectation.ladybugSchemaVersion !== LADYBUG_SCHEMA_VERSION) {
    throw new Error("Cache expectation does not use the current schema version");
  }

  assertExactArray(
    snapshot.activeEmbeddingModels.symbol,
    expectation.symbolEmbeddingModels,
    "Symbol embedding model plan",
  );
  assertExactArray(
    snapshot.activeEmbeddingModels.fileSummary,
    expectation.fileSummaryEmbeddingModels,
    "File-summary embedding model plan",
  );

  const derived = snapshot.derivedState;
  const graphIntegrityDigest = derived.graphIntegrityDigest;
  if (
    derived.clustersDirty ||
    derived.processesDirty ||
    derived.algorithmsDirty ||
    derived.summariesDirty ||
    derived.embeddingsDirty ||
    derived.targetVersionId !== snapshot.graphVersionId ||
    derived.computedVersionId !== snapshot.graphVersionId
  ) {
    throw new Error("Benchmark derived state is stale");
  }
  if (
    derived.graphIntegrityState !== "verified" ||
    derived.graphIntegrityVersionId !== snapshot.graphVersionId ||
    graphIntegrityDigest === null ||
    !/^[0-9a-f]{64}$/u.test(graphIntegrityDigest) ||
    derived.graphIntegrityRevision === null ||
    derived.graphIntegrityVerifiedRevision === null ||
    derived.graphIntegrityRevision !== derived.graphIntegrityVerifiedRevision
  ) {
    throw new Error("Benchmark graph integrity identity is not verified");
  }

  assertHealthyIndex(snapshot.indexes.symbolFts, "Symbol", "fts");
  assertHealthyIndex(snapshot.indexes.fileSummaryFts, "FileSummary", "fts");
  assertCompleteVectorCoverage(
    snapshot.indexes.symbolVectors,
    expectation.symbolEmbeddingModels,
    SYMBOL_VECTOR_EMBEDDING_TABLE,
  );
  assertCompleteVectorCoverage(
    snapshot.indexes.fileSummaryVectors,
    expectation.fileSummaryEmbeddingModels,
    "FileSummary",
  );

  return {
    repoId: expectation.repoId,
    repoRoot: expectedRoot,
    repoSha: expectation.repoSha,
    configDigest: expectation.configDigest,
    ladybugSchemaVersion: expectation.ladybugSchemaVersion,
    activeEmbeddingModels: {
      symbol: [...expectation.symbolEmbeddingModels],
      fileSummary: [...expectation.fileSummaryEmbeddingModels],
    },
    graphVersionId: snapshot.graphVersionId,
    graphIntegrityState: "verified",
    graphIntegrityVersionId: derived.graphIntegrityVersionId,
    graphIntegrityDigest,
    indexes: snapshot.indexes,
  };
}

function exactIndexIdentity(
  indexes: Awaited<ReturnType<typeof showIndexesStrict>>,
  required: RequiredRetrievalIndex,
): ContextQualityCacheIndexIdentity {
  if (
    !required.name ||
    !required.property ||
    !hasExactHealthyIndex(indexes, required)
  ) {
    throw new Error(
      `Required ${required.tableName} ${required.type} index is unavailable`,
    );
  }
  return {
    ...(required.model ? { model: required.model } : {}),
    tableName: required.tableName,
    name: required.name,
    type: required.type,
    property: required.property,
    healthy: true,
  };
}

async function vectorIndexIdentity(
  connection: Awaited<ReturnType<typeof getLadybugConn>>,
  indexes: Awaited<ReturnType<typeof showIndexesStrict>>,
  repoId: string,
  required: RequiredRetrievalIndex,
): Promise<ContextQualityCacheIndexIdentity> {
  const identity = exactIndexIdentity(indexes, required);
  const coverage =
    required.tableName === SYMBOL_VECTOR_EMBEDDING_TABLE
      ? await getSymbolRetrievalCoverage(
          connection,
          repoId,
          identity.property,
        )
      : await getFileSummaryRetrievalCoverage(
          connection,
          repoId,
          identity.property,
        );
  return {
    ...identity,
    eligible: ladybugDb.toNumber(coverage.eligible),
    covered: ladybugDb.toNumber(coverage.covered),
  };
}

export interface ValidateContextQualityCacheFamilyOptions {
  expectation: ContextQualityCacheExpectation;
  semanticConfig: SemanticConfig | undefined;
  verifiedCopyFingerprint: VerifiedLadybugFamilyCopy;
  bufferPoolBytes?: number;
}

/**
 * Reopens only the supplied copied family, validates it, and closes it before
 * returning. A pre-existing process-global Ladybug owner is rejected.
 */
export async function validateContextQualityCacheFamily(
  copiedPrimaryPath: string,
  options: ValidateContextQualityCacheFamilyOptions,
): Promise<ContextQualityCacheValidation> {
  if (!existsSync(copiedPrimaryPath)) {
    throw new Error("Copied benchmark database is missing: " + copiedPrimaryPath);
  }
  if (getLadybugDbPath() !== null) {
    throw new Error("LadybugDB is already owned by another operation");
  }

  try {
    await initValidatedLadybugClone(
      copiedPrimaryPath,
      options.verifiedCopyFingerprint,
      {
        bufferPoolBytes: options.bufferPoolBytes,
      },
    );
    const connection = await getLadybugConn();
    const plan = resolveSemanticEmbeddingModelPlan(options.semanticConfig);
    if (plan.unsupportedModels.length > 0) {
      throw new Error(
        "Unsupported benchmark embedding model(s): " +
          plan.unsupportedModels.join(", "),
      );
    }
    const required = resolveRequiredRetrievalIndexes(options.semanticConfig);
    const [
      repos,
      latestVersion,
      derivedState,
      ladybugSchemaVersion,
      indexes,
    ] = await Promise.all([
      ladybugDb.listRepos(connection, 2),
      ladybugDb.getLatestVersion(connection, options.expectation.repoId),
      getDerivedStateFromConnection(connection, options.expectation.repoId),
      getSchemaVersion(connection),
      showIndexesStrict(connection),
    ]);
    if (!latestVersion || !derivedState) {
      throw new Error("Benchmark database is missing versioned derived state");
    }

    const [
      symbolVectors,
      fileSummaryVectors,
    ] = await Promise.all([
      Promise.all(
        required.symbolVectors.map((index) =>
          vectorIndexIdentity(
            connection,
            indexes,
            options.expectation.repoId,
            index,
          ),
        ),
      ),
      Promise.all(
        required.fileSummaryVectors.map((index) =>
          vectorIndexIdentity(
            connection,
            indexes,
            options.expectation.repoId,
            index,
          ),
        ),
      ),
    ]);

    return validateContextQualityCacheSnapshot(
      {
        repos: repos.map(({ repoId, rootPath }) => ({ repoId, rootPath })),
        ladybugSchemaVersion,
        activeEmbeddingModels: {
          symbol: plan.symbolEmbeddingModels,
          fileSummary: plan.fileSummaryEmbeddingModels,
        },
        graphVersionId: latestVersion.versionId,
        derivedState,
        indexes: {
          symbolFts: exactIndexIdentity(indexes, required.symbolFts),
          fileSummaryFts: exactIndexIdentity(
            indexes,
            required.fileSummaryFts,
          ),
          symbolVectors,
          fileSummaryVectors,
        },
      },
      options.expectation,
    );
  } finally {
    if (getLadybugDbPath() !== null) {
      await closeLadybugDb({
        preserveCloseHooks: true,
        strict: true,
      });
    }
    if (getLadybugDbPath() !== null) {
      throw new Error("LadybugDB remained open after cache validation");
    }
  }
}
