import type { Connection } from "kuzu";

import type { SemanticConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getExtensionCapabilities } from "../db/extension-caps.js";
import { queryStoredProcAll, toNumber } from "../db/ladybug-core.js";
import {
  countCompleteRepoSymbolVectors,
  getEligibleRepoSymbolIds,
  getFileSummaryRetrievalCoverage,
  getRepoSymbolVectorHealthRows,
  type RepoSymbolVectorHealthRow,
  validateRepoSymbolVectorOwnership,
} from "../db/ladybug-retrieval-health.js";
import {
  getDerivedStateFromConnection,
  type EmbeddingLifecycleState,
} from "../db/ladybug-derived-state.js";
import { resolveSymbolVectorPhysicalIdentity } from "../db/ladybug-symbol-embeddings.js";
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
} from "./model-mapping.js";
import type {
  DegradationReason,
  RetrievalCapabilities,
} from "./types.js";

export type RepositorySymbolVectorTableName =
  `SymbolVectorEmbedding_r_${string}`;

export interface RequiredRetrievalIndex<
  TTableName extends string =
    | "Symbol"
    | RepositorySymbolVectorTableName
    | "FileSummary",
> {
  model?: string;
  tableName: TTableName;
  name: string | null;
  type: IndexInfo["type"];
  property: string | null;
}

export interface RequiredRetrievalIndexes<
  TSymbolTableName extends string = RepositorySymbolVectorTableName,
> {
  symbolFts: RequiredRetrievalIndex<"Symbol">;
  fileSummaryFts: RequiredRetrievalIndex<"FileSummary">;
  symbolVectors: RequiredRetrievalIndex<TSymbolTableName>[];
  fileSummaryVectors: RequiredRetrievalIndex<"FileSummary">[];
}

export interface CoverageCount {
  eligible: unknown;
  covered: unknown;
  indexHealthy: boolean;
}

interface ModelCoverageCount extends CoverageCount {
  model: string;
}

export const SYMBOL_HNSW_MIN_ROWS = 2_000;

export interface SymbolVectorHealthSnapshot {
  repoId: string;
  versionId: string | null;
  generation: number;
  model: string;
  eligibleSymbolCount: number;
  completeVectorCount: number;
  lifecycleState: EmbeddingLifecycleState;
  expectedIndexIdentity: RequiredRetrievalIndex<RepositorySymbolVectorTableName>;
  observedIndexIdentity: IndexInfo | null;
  mode: "none" | "exact" | "hnsw" | "degraded";
  exactFallbackAllowed: boolean;
  reason?: string;
}

export const REPOSITORY_SYMBOL_VECTOR_TABLE_PREFIX =
  "SymbolVectorEmbedding_r_";

export type RepositorySymbolVectorDiagnosticCode =
  | "deletion-pending"
  | "orphan-table";

export interface RepositorySymbolVectorDiagnostic {
  code: RepositorySymbolVectorDiagnosticCode;
  tableName: RepositorySymbolVectorTableName;
  repoId?: string;
  message: string;
}

interface RepositoryVectorCatalogTableRow {
  name?: unknown;
}

let repositorySymbolVectorDiagnostics = new Map<
  string,
  RepositorySymbolVectorDiagnostic
>();

function diagnosticKey(diagnostic: RepositorySymbolVectorDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.repoId ?? ""}\u0000${diagnostic.tableName}`;
}

/** Create stable, actionable process-local diagnostics without operational data. */
export function createRepositorySymbolVectorDiagnostic(
  code: RepositorySymbolVectorDiagnosticCode,
  tableName: string,
  repoId?: string,
): RepositorySymbolVectorDiagnostic {
  const typedTableName = tableName as RepositorySymbolVectorTableName;
  if (code === "deletion-pending") {
    if (!repoId) {
      throw new Error("A repository ID is required for deletion-pending diagnostics");
    }
    return {
      code,
      repoId,
      tableName: typedTableName,
      message:
        `Repository "${repoId}" vector deletion is pending; retry repo.unregister to resume teardown.`,
    };
  }
  return {
    code,
    tableName: typedTableName,
    ...(repoId ? { repoId } : {}),
    message:
      `Repository Symbol vector table "${tableName}" has no registered owner; use an explicit repair or deletion action before reuse.`,
  };
}

/** Replace the complete deterministic diagnostic inventory atomically. */
export function publishRepositorySymbolVectorDiagnostics(
  diagnostics: readonly RepositorySymbolVectorDiagnostic[],
): void {
  const replacement = new Map<string, RepositorySymbolVectorDiagnostic>();
  for (const diagnostic of [...diagnostics].sort((left, right) =>
    diagnosticKey(left).localeCompare(diagnosticKey(right)),
  )) {
    replacement.set(diagnosticKey(diagnostic), diagnostic);
  }
  repositorySymbolVectorDiagnostics = replacement;
}

/** Add one registration/deletion diagnostic without disturbing other repositories. */
export function publishRepositorySymbolVectorDiagnostic(
  diagnostic: RepositorySymbolVectorDiagnostic,
): void {
  repositorySymbolVectorDiagnostics.set(diagnosticKey(diagnostic), diagnostic);
}

/** Return diagnostics in stable identity order. */
export function listRepositorySymbolVectorDiagnostics():
  readonly RepositorySymbolVectorDiagnostic[] {
  return [...repositorySymbolVectorDiagnostics.values()].sort((left, right) =>
    diagnosticKey(left).localeCompare(diagnosticKey(right)),
  );
}

/** Clear diagnostics owned by one repository after successful teardown. */
export function clearRepositorySymbolVectorDiagnostics(repoId: string): void {
  for (const [key, diagnostic] of repositorySymbolVectorDiagnostics) {
    if (diagnostic.repoId === repoId) {
      repositorySymbolVectorDiagnostics.delete(key);
    }
  }
}

/** Strictly inventory only repository-vector table names from a successful catalog read. */
export async function listRepositorySymbolVectorTableNames(
  conn: Connection,
): Promise<RepositorySymbolVectorTableName[]> {
  const rows = await queryStoredProcAll<RepositoryVectorCatalogTableRow>(
    conn,
    "CALL SHOW_TABLES() RETURN name, type",
  );
  return rows
    .flatMap((row) =>
      typeof row.name === "string" &&
      row.name.startsWith(REPOSITORY_SYMBOL_VECTOR_TABLE_PREFIX)
        ? [row.name as RepositorySymbolVectorTableName]
        : [],
    )
    .sort((left, right) => left.localeCompare(right));
}

export interface EvaluateRepositorySymbolVectorHealthInput {
  repoId: string;
  versionId: string | null;
  generation: number;
  lifecycleState: EmbeddingLifecycleState;
  semanticConfig: SemanticConfig | undefined;
  tableState: "absent" | "present";
  eligibleSymbolIds: readonly string[];
  vectorRows: readonly RepoSymbolVectorHealthRow[];
  indexes: readonly IndexInfo[];
}

interface RepositorySymbolVectorHealthEntry {
  versionId: string | null;
  generation: number;
  snapshots: ReadonlyMap<string, SymbolVectorHealthSnapshot>;
}


/** Resolve the exact indexes required by the active semantic model plan. */
export function resolveRequiredRetrievalIndexes(
  semanticConfig: SemanticConfig | undefined,
  repoId: string,
): RequiredRetrievalIndexes<RepositorySymbolVectorTableName> {
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
  const repoSymbolTableName = resolveSymbolVectorPhysicalIdentity(
    repoId,
    "jina-embeddings-v2-base-code",
  ).tableName as RepositorySymbolVectorTableName;

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
      const logicalName =
        configuredVectorIndexes?.[model]?.indexName ??
        getVectorIndexName(model);
      const physical =
        property && logicalName
          ? resolveSymbolVectorPhysicalIdentity(repoId, model, semanticConfig)
          : null;
      return {
        model,
        tableName: physical
          ? (physical.tableName as RepositorySymbolVectorTableName)
          : repoSymbolTableName,
        name: property ? (physical?.indexName ?? null) : null,
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
export function hasExactHealthyIndex<TTableName extends string>(
  indexes: readonly IndexInfo[],
  required: RequiredRetrievalIndex<TTableName>,
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

function mappedVectorPresent(
  row: RepoSymbolVectorHealthRow,
  property: string,
): boolean {
  if (property === "embeddingJinaCodeVec") {
    return row.embeddingJinaCodeVecPresent;
  }
  if (property === "embeddingNomicVec") {
    return row.embeddingNomicVecPresent;
  }
  return false;
}

function inspectModelRows(
  input: EvaluateRepositorySymbolVectorHealthInput,
  model: string,
  property: string,
): { completeVectorCount: number; safe: boolean; reason?: string } {
  if (input.vectorRows.some((row) => row.repoId !== input.repoId)) {
    return {
      completeVectorCount: 0,
      safe: false,
      reason: "repository vector ownership mismatch",
    };
  }

  const completeSymbolIds: string[] = [];
  for (const row of input.vectorRows) {
    const mappedPresent = mappedVectorPresent(row, property);
    if (row.model !== model && !mappedPresent) continue;
    if (
      row.model !== model ||
      !mappedPresent ||
      !row.embeddingVectorPresent ||
      !row.cardHashPresent ||
      !row.symbolId ||
      row.embeddingId !== `${model}:${row.symbolId}`
    ) {
      return {
        completeVectorCount: completeSymbolIds.length,
        safe: false,
        reason: "repository vector row identity is incomplete or invalid",
      };
    }
    completeSymbolIds.push(row.symbolId);
  }

  const eligibleCounts = new Map<string, number>();
  for (const symbolId of input.eligibleSymbolIds) {
    eligibleCounts.set(symbolId, (eligibleCounts.get(symbolId) ?? 0) + 1);
  }
  const completeCounts = new Map<string, number>();
  for (const symbolId of completeSymbolIds) {
    completeCounts.set(symbolId, (completeCounts.get(symbolId) ?? 0) + 1);
  }
  const coverageSafe =
    eligibleCounts.size === input.eligibleSymbolIds.length &&
    completeCounts.size === completeSymbolIds.length &&
    eligibleCounts.size === completeCounts.size &&
    [...eligibleCounts].every(
      ([symbolId, count]) =>
        count === 1 && completeCounts.get(symbolId) === 1,
    );

  return {
    completeVectorCount: completeSymbolIds.length,
    safe: coverageSafe,
    ...(coverageSafe
      ? {}
      : { reason: "repository vector coverage is not bidirectional" }),
  };
}

function relevantCatalogRows(
  indexes: readonly IndexInfo[],
  expected: RequiredRetrievalIndex<RepositorySymbolVectorTableName>,
): IndexInfo[] {
  return indexes.filter(
    (index) =>
      index.name === expected.name ||
      (index.tableName === expected.tableName &&
        index.property === expected.property),
  );
}

function isExactHealthyTuple(
  index: IndexInfo,
  expected: RequiredRetrievalIndex<RepositorySymbolVectorTableName>,
): boolean {
  return (
    index.name === expected.name &&
    index.tableName === expected.tableName &&
    index.type === expected.type &&
    index.property === expected.property &&
    index.status === "healthy" &&
    index.extensionLoaded === true
  );
}

/** Pure durable-fact evaluator shared by startup, refresh, and focused tests. */
export function evaluateRepositorySymbolVectorHealth(
  input: EvaluateRepositorySymbolVectorHealthInput,
): SymbolVectorHealthSnapshot[] {
  if (input.semanticConfig?.enabled === false) return [];

  const plan = resolveSemanticEmbeddingModelPlan(input.semanticConfig);
  const required = resolveRequiredRetrievalIndexes(
    input.semanticConfig,
    input.repoId,
  );
  return plan.symbolEmbeddingModels.map((model) => {
    const expected = required.symbolVectors.find(
      (index) => index.model === model,
    );
    if (!expected?.property || !expected.name) {
      throw new Error(`Missing repository Symbol vector identity for ${model}`);
    }

    const rowState = inspectModelRows(input, model, expected.property);
    const relevant = relevantCatalogRows(input.indexes, expected);
    const observed = relevant.length === 1 ? relevant[0] : null;
    const eligibleSymbolCount = input.eligibleSymbolIds.length;
    const completeVectorCount = rowState.completeVectorCount;
    const coverageSafe =
      rowState.safe &&
      (eligibleSymbolCount === 0 || input.tableState === "present");
    const needsHnsw = completeVectorCount >= SYMBOL_HNSW_MIN_ROWS;
    const catalogSafe = needsHnsw
      ? relevant.length === 1 &&
        isExactHealthyTuple(relevant[0], expected)
      : relevant.length === 0;

    let mode: SymbolVectorHealthSnapshot["mode"] = "degraded";
    let exactFallbackAllowed = false;
    let reason: string | undefined;

    if (input.lifecycleState === "deleting") {
      reason = "repository vector deletion is pending";
    } else if (
      eligibleSymbolCount === 0 &&
      completeVectorCount === 0 &&
      rowState.safe &&
      relevant.length === 0 &&
      input.lifecycleState === "steady"
    ) {
      mode = "none";
    } else if (input.versionId === null) {
      reason = "repository has eligible symbols but no indexed version";
    } else if (!coverageSafe) {
      reason =
        input.tableState === "absent"
          ? "repository vector table is absent"
          : rowState.reason;
    } else if (input.lifecycleState !== "steady") {
      exactFallbackAllowed = true;
      reason = "repository vector refresh is incomplete";
    } else if (!catalogSafe) {
      exactFallbackAllowed = true;
      reason = "repository vector index identity is missing or ambiguous";
    } else {
      mode = needsHnsw ? "hnsw" : "exact";
      exactFallbackAllowed = true;
    }

    return {
      repoId: input.repoId,
      versionId: input.versionId,
      generation: input.generation,
      model,
      eligibleSymbolCount,
      completeVectorCount,
      lifecycleState: input.lifecycleState,
      expectedIndexIdentity: expected,
      observedIndexIdentity: observed,
      mode,
      exactFallbackAllowed,
      ...(reason ? { reason } : {}),
    };
  });
}

const repositorySymbolVectorHealth = new Map<
  string,
  RepositorySymbolVectorHealthEntry
>();
let repositorySymbolVectorHealthGeneration = 0;

export function getRepositorySymbolVectorHealthGeneration(
  repoId: string,
): number {
  return repositorySymbolVectorHealth.get(repoId)?.generation ?? 0;
}

export function getRepositorySymbolVectorHealthSnapshots(
  repoId: string,
): ReadonlyMap<string, SymbolVectorHealthSnapshot> | null {
  return repositorySymbolVectorHealth.get(repoId)?.snapshots ?? null;
}

export function getRepositorySymbolVectorHealthSnapshot(
  repoId: string,
  model: string,
): SymbolVectorHealthSnapshot | null {
  return repositorySymbolVectorHealth.get(repoId)?.snapshots.get(model) ?? null;
}

export function hasRepositorySymbolVectorHealth(repoId: string): boolean {
  return repositorySymbolVectorHealth.has(repoId);
}

export function listRepositorySymbolVectorHealthRepoIds(): readonly string[] {
  return [...repositorySymbolVectorHealth.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function clearRepositorySymbolVectorHealth(repoId: string): void {
  repositorySymbolVectorHealthGeneration += 1;
  repositorySymbolVectorHealth.delete(repoId);
}

/**
 * Direct lifecycle invalidation is deliberately non-queryable. A later
 * durable assessment may explicitly permit guarded exact fallback.
 */
export function invalidateRepositorySymbolVectorHealth(
  repoId: string,
  versionId: string | null,
  semanticConfig: SemanticConfig | undefined,
  lifecycleState: "refreshing" | "deleting",
): number {
  const generation = ++repositorySymbolVectorHealthGeneration;
  try {
    const models =
      semanticConfig?.enabled === false
        ? []
        : resolveSemanticEmbeddingModelPlan(semanticConfig)
            .symbolEmbeddingModels;
    const required = resolveRequiredRetrievalIndexes(semanticConfig, repoId);
    const snapshots = new Map<string, SymbolVectorHealthSnapshot>();

    for (const model of models) {
      const expected = required.symbolVectors.find(
        (index) => index.model === model,
      );
      if (!expected?.property || !expected.name) continue;
      snapshots.set(model, {
        repoId,
        versionId,
        generation,
        model,
        eligibleSymbolCount: 0,
        completeVectorCount: 0,
        lifecycleState,
        expectedIndexIdentity: expected,
        observedIndexIdentity: null,
        mode: "degraded",
        exactFallbackAllowed: false,
        reason:
          lifecycleState === "deleting"
            ? "repository vector deletion is pending"
            : "repository vector refresh is active",
      });
    }

    repositorySymbolVectorHealth.set(repoId, {
      versionId,
      generation,
      snapshots,
    });
    return generation;
  } catch (error) {
    repositorySymbolVectorHealth.delete(repoId);
    throw error;
  }
}

export interface PublishRepositorySymbolVectorHealthBatchInput {
  repoId: string;
  versionId: string | null;
  capturedGeneration: number;
  enabledModels: readonly string[];
  snapshots: readonly SymbolVectorHealthSnapshot[];
}

export interface PreparedRepositorySymbolVectorHealthBatch {
  readonly repoId: string;
  readonly entry: RepositorySymbolVectorHealthEntry;
}

/**
 * Validate the complete model batch and allocate its replacement Map before a
 * caller commits durable semantic readiness.
 */
export function prepareRepositorySymbolVectorHealthBatch(
  input: PublishRepositorySymbolVectorHealthBatchInput,
): PreparedRepositorySymbolVectorHealthBatch | null {
  const current = repositorySymbolVectorHealth.get(input.repoId);
  if (
    !current ||
    current.versionId !== input.versionId ||
    current.generation !== input.capturedGeneration
  ) {
    return null;
  }

  const currentModels = [...current.snapshots.keys()];
  if (
    input.enabledModels.length !== currentModels.length ||
    !input.enabledModels.every((model, index) => model === currentModels[index]) ||
    input.enabledModels.length !== input.snapshots.length
  ) {
    return null;
  }

  const replacement = new Map<string, SymbolVectorHealthSnapshot>();
  for (let index = 0; index < input.enabledModels.length; index += 1) {
    const model = input.enabledModels[index];
    const snapshot = input.snapshots[index];
    if (
      snapshot.repoId !== input.repoId ||
      snapshot.versionId !== input.versionId ||
      snapshot.generation !== input.capturedGeneration ||
      snapshot.model !== model ||
      replacement.has(model)
    ) {
      return null;
    }
    replacement.set(model, snapshot);
  }

  return {
    repoId: input.repoId,
    entry: {
      versionId: input.versionId,
      generation: input.capturedGeneration,
      snapshots: replacement,
    },
  };
}

/** Complete the already-validated synchronous cache replacement. */
export function commitPreparedRepositorySymbolVectorHealthBatch(
  prepared: PreparedRepositorySymbolVectorHealthBatch,
): void {
  repositorySymbolVectorHealth.set(prepared.repoId, prepared.entry);
}

/** Publish a complete model batch with one version/generation CAS and Map.set. */
export function publishRepositorySymbolVectorHealthBatch(
  input: PublishRepositorySymbolVectorHealthBatchInput,
): boolean {
  const prepared = prepareRepositorySymbolVectorHealthBatch(input);
  if (!prepared) return false;
  commitPreparedRepositorySymbolVectorHealthBatch(prepared);
  return true;
}

export interface AssessRepositorySymbolVectorHealthInput {
  repoId: string;
  versionId: string | null;
  generation: number;
  lifecycleState: EmbeddingLifecycleState;
  semanticConfig: SemanticConfig | undefined;
  indexes?: readonly IndexInfo[];
}

/** Read durable facts without mutation, then evaluate the complete model batch. */
export async function assessRepositorySymbolVectorHealth(
  conn: Connection,
  input: AssessRepositorySymbolVectorHealthInput,
): Promise<SymbolVectorHealthSnapshot[]> {
  if (input.semanticConfig?.enabled === false) return [];

  const enabledModels = resolveSemanticEmbeddingModelPlan(
    input.semanticConfig,
  ).symbolEmbeddingModels;
  const completeCounts = new Map<string, number>();
  for (const model of enabledModels) {
    await validateRepoSymbolVectorOwnership(conn, input.repoId, model);
    completeCounts.set(
      model,
      await countCompleteRepoSymbolVectors(conn, input.repoId, model),
    );
  }

  const eligibleSymbolIds = await getEligibleRepoSymbolIds(conn, input.repoId);
  const table = await getRepoSymbolVectorHealthRows(conn, input.repoId);
  const indexes = input.indexes ?? (await showIndexesStrict(conn));
  return evaluateRepositorySymbolVectorHealth({
    ...input,
    tableState: table.tableState,
    eligibleSymbolIds,
    vectorRows: table.rows,
    indexes,
  }).map((snapshot) =>
    completeCounts.get(snapshot.model) === snapshot.completeVectorCount
      ? snapshot
      : {
          ...snapshot,
          mode: "degraded",
          exactFallbackAllowed: false,
          reason: "repository vector count changed during assessment",
        },
  );
}

/** @deprecated Use repository health invalidation with a complete model plan. */
export function invalidateSymbolRetrievalCoverageCache(repoId: string): void {
  clearRepositorySymbolVectorHealth(repoId);
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
    const required = resolveRequiredRetrievalIndexes(semanticConfig, repoId);
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    const derivedState = await getDerivedStateFromConnection(conn, repoId);
    const enabledModels =
      semanticConfig?.enabled === false
        ? []
        : resolveSemanticEmbeddingModelPlan(semanticConfig)
            .symbolEmbeddingModels;
    const versionId = latestVersion?.versionId ?? null;
    const current = repositorySymbolVectorHealth.get(repoId);
    const currentModels = current ? [...current.snapshots.keys()] : [];
    let symbolSnapshots: SymbolVectorHealthSnapshot[];

    if (
      current?.versionId === versionId &&
      currentModels.length === enabledModels.length &&
      currentModels.every((model, index) => model === enabledModels[index])
    ) {
      symbolSnapshots = [...current.snapshots.values()];
    } else {
      const generation = invalidateRepositorySymbolVectorHealth(
        repoId,
        versionId,
        semanticConfig,
        derivedState?.embeddingLifecycleState === "deleting"
          ? "deleting"
          : "refreshing",
      );
      const assessed = await assessRepositorySymbolVectorHealth(conn, {
        repoId,
        versionId,
        generation,
        lifecycleState:
          derivedState?.embeddingLifecycleState ?? "steady",
        semanticConfig,
        indexes,
      });
      const published = publishRepositorySymbolVectorHealthBatch({
        repoId,
        versionId,
        capturedGeneration: generation,
        enabledModels,
        snapshots: assessed,
      });
      symbolSnapshots = published
        ? assessed
        : [
            ...(getRepositorySymbolVectorHealthSnapshots(repoId)?.values() ??
              []),
          ];
    }

    const symbolFts =
      extensions.fts && hasExactHealthyIndex(indexes, required.symbolFts);
    const fileSummaryFts =
      extensions.fts &&
      hasExactHealthyIndex(indexes, required.fileSummaryFts);
    const symbolRows: ModelCoverageCount[] = symbolSnapshots.map(
      (snapshot) => ({
        model: snapshot.model,
        eligible: snapshot.eligibleSymbolCount,
        covered: snapshot.completeVectorCount,
        indexHealthy:
          extensions.vector &&
          (snapshot.mode === "exact" ||
            snapshot.mode === "hnsw" ||
            snapshot.exactFallbackAllowed),
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
      symbolSnapshots,
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
  required: RequiredRetrievalIndexes<RepositorySymbolVectorTableName>,
  indexes: readonly IndexInfo[],
  symbolSnapshots: readonly SymbolVectorHealthSnapshot[],
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
  for (const snapshot of symbolSnapshots) {
    if (snapshot.mode === "degraded") {
      reasons.push({
        code: "vector-index-missing",
        message:
          snapshot.reason ??
          `Repository Symbol vector health is degraded: ${snapshot.model}`,
        affects: "vector",
      });
    }
  }
  for (const index of required.fileSummaryVectors) {
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
