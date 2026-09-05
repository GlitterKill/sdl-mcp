import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "kuzu";

import {
  closeLadybugDb,
  configurePool,
  getLadybugDb,
  getReadPool,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  _configureVectorQueryGuardForTesting,
  exec,
  execCheckpoint,
  execDdl,
  queryAll,
  queryStoredProcAll,
  resetPreparedStatementCaches,
} from "../../dist/db/ladybug-core.js";
import {
  hasCurrentExclusiveLadybugOperation,
  withExclusiveLadybugOperation,
  withSharedLadybugOperation,
} from "../../dist/db/ladybug-operation-gate.js";
import { createSchema } from "../../dist/db/ladybug-schema.js";
import { withWindowsFtsRuntime } from "../../dist/db/ladybug-windows-fts-runtime.js";
import {
  deleteRepoSymbolVectorEmbeddingsBySymbolIds,
  ensureRepoSymbolVectorTable,
  getRepoSymbolVectorEmbedding,
  getRepoSymbolVectorEmbeddings,
  getRepoSymbolVectorProbe,
  inspectRepoSymbolVectorTable,
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbedding,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { rankRepoSymbolVectorsExact } from "../../dist/db/ladybug-retrieval.js";
import {
  _teardownRepositoryDatabaseForTesting,
  handleRepoRegister,
  handleRepoUnregister,
} from "../../dist/mcp/tools/repo.js";
import {
  countCompleteRepoSymbolVectors,
  validateRepoSymbolVectorOwnership,
} from "../../dist/db/ladybug-retrieval-health.js";
import {
  assessRepositorySymbolVectorHealth,
  clearRepositorySymbolVectorDiagnostics,
  clearRepositorySymbolVectorHealth,
  commitPreparedRepositorySymbolVectorHealthBatch,
  getRepositorySymbolVectorHealthSnapshot,
  invalidateRepositorySymbolVectorHealth,
  listRepositorySymbolVectorDiagnostics,
  publishRepositorySymbolVectorDiagnostic,
  publishRepositorySymbolVectorHealthBatch,
} from "../../dist/retrieval/health.js";
import {
  dropVectorIndex,
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../dist/retrieval/index-lifecycle.js";
import {
  planRepositorySymbolVectorReconciliation,
  refreshSymbolEmbeddings,
  resolveRepositorySymbolVectorIndexMode,
  type EmbeddingProvider,
} from "../../dist/indexer/embeddings.js";
import {
  getDerivedStateFromConnection,
  markEmbeddingLifecycleDeleting,
  markEmbeddingLifecycleRefreshingForTarget,
  markEmbeddingLifecycleSteadyIfCurrent,
} from "../../dist/db/ladybug-derived-state.js";
import { createRepositorySemanticLifecycle } from "../../dist/indexer/provider-first/semantic-readiness.js";
import { queryRepoSymbolVectorIndex } from "../../dist/retrieval/orchestrator.js";
import type { SemanticConfig } from "../../dist/config/types.js";

const JINA_MODEL = "jina-embeddings-v2-base-code";
const NOMIC_MODEL = "nomic-embed-text-v1.5";
const dbPath = join(
  tmpdir(),
  `.test-repository-vector-table-lifecycle-${process.pid}.lbug`,
);

function vector(fill: number): number[] {
  return new Array<number>(768).fill(fill);
}

async function exclusiveWrite<T>(
  task: (conn: Connection) => Promise<T>,
): Promise<T> {
  return withExclusiveLadybugOperation(() => withWriteConn(task));
}

async function tableRows(
  conn: Connection,
  repoId: string,
): Promise<Array<Record<string, unknown>>> {
  const { tableName } = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);
  return queryAll<Record<string, unknown>>(
    conn,
    `MATCH (e:${tableName}) RETURN e.embeddingId AS embeddingId, e.repoId AS repoId, e.symbolId AS symbolId, e.model AS model ORDER BY e.embeddingId`,
  );
}

function reconciliationSymbol(
  repoId: string,
  index: number,
  revision = "base",
): ladybugDb.SymbolRow {
  return {
    symbolId: `${repoId}:symbol:${index.toString().padStart(4, "0")}`,
    repoId,
    fileId: `${repoId}:file`,
    kind: "function",
    name: `symbol${index}`,
    exported: true,
    visibility: "public",
    language: "ts",
    rangeStartLine: index + 1,
    rangeStartCol: 0,
    rangeEndLine: index + 1,
    rangeEndCol: 10,
    astFingerprint: `fingerprint-${index}-${revision}`,
    signatureJson: JSON.stringify(`(value: string) => ${revision}`),
    summary: `repository vector fixture ${index} ${revision}`,
    searchText: `symbol ${index} repository vector fixture ${revision}`,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function reconciliationVector(text: string): number[] {
  let state = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    state = Math.imul(state ^ text.charCodeAt(index), 16_777_619) >>> 0;
  }

  const values = new Array<number>(768);
  let squaredNorm = 0;
  for (let index = 0; index < values.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = (state >>> 0) / 0xffff_ffff - 0.5;
    values[index] = value;
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  return values.map((value) => value / norm);
}


function reconciliationProvider(): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => reconciliationVector(text));
    },
    getDimension: () => 768,
    isMockFallback: () => false,
    getCacheCompatibilityKey: () => "repository-vector-fixture-v1",
  };
}

const RECONCILIATION_MUTATION_OPERATIONS = new Set([
  "after-vector-delete",
  "after-vector-merge",
  "after-vector-create",
  "after-index-drop",
  "after-index-create",
]);

function reconciliationMutationOperations(steps: readonly string[]): string[] {
  return steps.filter((step) => RECONCILIATION_MUTATION_OPERATIONS.has(step));
}


async function seedReconciliationRepo(
  repoId: string,
  count: number,
): Promise<ladybugDb.SymbolRow[]> {
  const symbols = Array.from({ length: count }, (_, index) =>
    reconciliationSymbol(repoId, index),
  );
  await exclusiveWrite(async (conn) => {
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: `/fixture/${repoId}`,
      configJson: "{}",
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    await ladybugDb.upsertFile(conn, {
      fileId: `${repoId}:file`,
      repoId,
      relPath: "src/fixture.ts",
      contentHash: "fixture-hash",
      language: "ts",
      byteSize: count,
      lastIndexedAt: "2026-09-03T00:00:00.000Z",
    });
    for (let start = 0; start < symbols.length; start += 250) {
      await ladybugDb.upsertSymbolBatch(conn, symbols.slice(start, start + 250));
    }
  });
  return symbols;
}

async function refreshReconciliationRepo(params: {
  repoId: string;
  symbols?: ladybugDb.SymbolRow[];
  operations?: string[];
}) {
  return refreshSymbolEmbeddings({
    repoId: params.repoId,
    provider: "local",
    model: JINA_MODEL,
    symbols: params.symbols,
    embeddingProvider: reconciliationProvider(),
    batchSize: 32,
    concurrency: 2,
    onReconciliationStep: (step) => {
      if (process.env.SDL_RECONCILIATION_CHILD_MUTATIONS) {
        console.error(`reconciliation-step:${step}`);
      }
      params.operations?.push(step);
    },
  });
}

async function assertReconciledCountAndCatalog(
  repoId: string,
  expectedCount: number,
): Promise<void> {
  await withWriteConn(async (conn) => {
    assert.strictEqual(
      await countCompleteRepoSymbolVectors(conn, repoId, JINA_MODEL),
      expectedCount,
    );
    const identity = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);
    await validateRepoSymbolVectorOwnership(conn, repoId, JINA_MODEL);
    const relevant = (await showIndexesStrict(conn)).filter(
      (index) =>
        index.name === identity.indexName ||
        (index.tableName === identity.tableName &&
          index.property === identity.propertyName),
    );
    if (expectedCount >= 2_000) {
      assert.strictEqual(relevant.length, 1);
      assert.strictEqual(relevant[0]?.name, identity.indexName);
      assert.strictEqual(relevant[0]?.status, "healthy");
      assert.strictEqual(relevant[0]?.extensionLoaded, true);
      const probe = await getRepoSymbolVectorProbe(
        conn,
        identity,
        repoId,
        JINA_MODEL,
      );
      assert.ok(probe, "expected a complete repository ANN probe row");
      assert.strictEqual(
        await queryVectorIndexProbe(
          conn,
          identity,
          repoId,
          JINA_MODEL,
          probe.vectorArray,
        ),
        10,
      );
    } else {
      assert.deepStrictEqual(relevant, []);
    }
  });
}



type RefreshRecoverySeam =
  | "marker-commit"
  | "table-create"
  | "index-drop"
  | "vector-delete"
  | "vector-merge"
  | "index-create"
  | "probe"
  | "checkpoint";
type DeletionRecoverySeam = "deletion-table-drop" | "graph-deletion";
type DurableRecoverySeam = RefreshRecoverySeam | DeletionRecoverySeam;
type RecoveryCatalogExpectation = "none" | "healthy";

const RECOVERY_SEMANTIC_CONFIG = {
  enabled: true,
  provider: "local",
  symbolEmbeddingModels: [JINA_MODEL],
  fileSummaryEmbeddingModels: [],
} satisfies SemanticConfig;

interface RecoveryStateExpectation {
  repoPresent: boolean;
  tableState: "absent" | "present";
  completeVectorCount: number;
  catalog: RecoveryCatalogExpectation;
  lifecycleState: "refreshing" | "deleting" | "steady" | null;
  mode: "degraded" | "exact" | "hnsw" | null;
  exactFallbackAllowed: boolean | null;
}

interface DurableRecoveryFixture {
  seam: DurableRecoverySeam;
  repoId: string;
  versionId: string;
  expectedFinalCount: number;
  controlRows: Array<Record<string, unknown>>;
  events: string[];
  failureState: RecoveryStateExpectation;
  runRefresh(injectFailure: boolean): Promise<void>;
  runDeletion(injectFailure: boolean): Promise<void>;
}

const REFRESH_FAILURE_STEP: Record<
  RefreshRecoverySeam,
  string | null
> = {
  "marker-commit": null,
  "table-create": null,
  "index-drop": "after-index-drop",
  "vector-delete": "after-vector-delete",
  "vector-merge": "after-vector-merge",
  "index-create": "after-index-create",
  probe: null,
  checkpoint: null,
};

function recoveryStepEvent(step: string): string {
  if (step === "catalog-classified") return "gate:catalog-classified";
  if (step === "after-index-drop") return "ddl:index-drop";
  if (step === "after-index-create") return "ddl:index-create";
  if (step === "after-vector-delete") return "dml:vector-delete";
  if (step === "after-vector-merge") return "dml:vector-merge";
  if (step === "after-vector-create") return "dml:vector-create";
  return `gate:${step}`;
}

const REFRESH_FAILURE_EVENT_ORDER: Readonly<
  Record<RefreshRecoverySeam, readonly string[]>
> = {
  "marker-commit": [
    "marker:refreshing",
    "checkpoint:1",
    "ddl:table-create",
    "dml:vector-delete",
    "dml:vector-merge",
    "checkpoint:2",
    "gate:start",
    "marker:commit",
    "publication:degraded",
    "gate:release",
  ],
  "table-create": [
    "marker:refreshing",
    "checkpoint:1",
    "gate:catalog-classified",
    "gate:before-vector-mutation",
    "ddl:table-create",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  "index-drop": [
    "marker:refreshing",
    "checkpoint:1",
    "gate:catalog-classified",
    "gate:before-vector-mutation",
    "ddl:index-drop",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  "vector-delete": [
    "marker:refreshing",
    "checkpoint:1",
    "gate:catalog-classified",
    "gate:before-vector-mutation",
    "dml:vector-delete",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  "vector-merge": [
    "marker:refreshing",
    "checkpoint:1",
    "ddl:table-create",
    "dml:vector-delete",
    "dml:vector-merge",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  "index-create": [
    "marker:refreshing",
    "checkpoint:1",
    "gate:catalog-classified",
    "dml:vector-delete",
    "dml:vector-merge",
    "ddl:index-create",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  probe: [
    "marker:refreshing",
    "checkpoint:1",
    "gate:catalog-classified",
    "dml:vector-delete",
    "checkpoint:2",
    "dml:vector-create",
    "gate:after-index-reconcile",
    "probe:ann-query",
    "checkpoint:3",
    "gate:failure-finalize",
    "publication:degraded",
  ],
  checkpoint: [
    "marker:refreshing",
    "checkpoint:1",
    "ddl:table-create",
    "dml:vector-delete",
    "dml:vector-merge",
    "checkpoint:2",
    "gate:failure-finalize",
    "publication:degraded",
  ],
};

const REFRESH_SUCCESS_EVENT_ORDER = [
  "marker:refreshing",
  "checkpoint:1",
  "checkpoint:2",
  "gate:start",
  "marker:commit",
  "marker:steady",
  "publication:steady",
  "gate:release",
] as const;

const DELETION_RECOVERY_EVENT_ORDER: Readonly<
  Record<DeletionRecoverySeam, readonly string[]>
> = {
  "deletion-table-drop": [
    "gate:start",
    "marker:deleting",
    "gate:catalog-table",
    "gate:catalog-indexes",
    "gate:ownership",
    "ddl:table-drop",
    "publication:diagnostic",
    "publication:deletion-pending",
    "gate:release",
    "gate:start",
    "marker:deleting",
    "ddl:table-drop",
    "ddl:prepared-cache-reset",
    "dml:graph-delete",
    "publication:clear",
    "gate:release",
    "gate:start",
    "publication:clear",
    "gate:release",
  ],
  "graph-deletion": [
    "gate:start",
    "marker:deleting",
    "gate:catalog-table",
    "gate:catalog-indexes",
    "gate:ownership",
    "ddl:table-drop",
    "ddl:prepared-cache-reset",
    "dml:graph-delete",
    "publication:diagnostic",
    "publication:deletion-pending",
    "gate:release",
    "gate:start",
    "marker:deleting",
    "dml:graph-delete",
    "publication:clear",
    "gate:release",
    "gate:start",
    "publication:clear",
    "gate:release",
  ],
};

function assertRecoveryEventOrder(fixture: DurableRecoveryFixture): void {
  const expected =
    fixture.seam === "deletion-table-drop" || fixture.seam === "graph-deletion"
      ? DELETION_RECOVERY_EVENT_ORDER[fixture.seam]
      : [
          ...REFRESH_FAILURE_EVENT_ORDER[fixture.seam],
          ...REFRESH_SUCCESS_EVENT_ORDER,
        ];
  let cursor = 0;
  for (const event of expected) {
    const index = fixture.events.indexOf(event, cursor);
    assert.notStrictEqual(
      index,
      -1,
      `${fixture.seam} missing ordered event ${event} after offset ${cursor}; observed ${JSON.stringify(fixture.events)}`,
    );
    cursor = index + 1;
  }
}

async function reopenRecoveryDatabase(
  resetVectorQueryGuard = false,
): Promise<void> {
  await closeLadybugDb({ strict: true });
  if (resetVectorQueryGuard) {
    // A fresh process has no in-memory circuit state. Reset only after closing
    // the failed probe's connection so this reopen models that boundary.
    _configureVectorQueryGuardForTesting();
  }
  await getLadybugDb(dbPath);
  await exclusiveWrite((conn) =>
    withWindowsFtsRuntime(() => execDdl(conn, "LOAD EXTENSION vector")),
  );
}

async function seedRecoveryRepository(
  repoId: string,
  count: number,
): Promise<{ symbols: ladybugDb.SymbolRow[]; versionId: string }> {
  const symbols = await seedReconciliationRepo(repoId, count);
  const versionId = `${repoId}:version`;
  await exclusiveWrite(async (conn) => {
    await ladybugDb.createVersion(conn, {
      versionId,
      repoId,
      createdAt: "2026-09-03T00:00:00.000Z",
      reason: "durable recovery fixture",
      prevVersionHash: null,
      versionHash: null,
    });
    assert.strictEqual(
      await markEmbeddingLifecycleRefreshingForTarget(
        conn,
        repoId,
        null,
        versionId,
      ),
      true,
    );
    assert.strictEqual(
      await markEmbeddingLifecycleSteadyIfCurrent(conn, repoId, versionId),
      true,
    );
  });
  return { symbols, versionId };
}

async function seedRecoveryControlOverlap(
  symbolId: string,
): Promise<Array<Record<string, unknown>>> {
  const repoId = "vector-recovery-control";
  await exclusiveWrite(async (conn) => {
    if (!(await ladybugDb.getRepo(conn, repoId))) {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: `/fixture/${repoId}`,
        configJson: "{}",
        createdAt: "2026-09-03T00:00:00.000Z",
      });
    }
    await setRepoSymbolVectorEmbedding(
      conn,
      repoId,
      symbolId,
      JINA_MODEL,
      `control-vector:${symbolId}`,
      `control-hash:${symbolId}`,
      vector(0.875),
    );
  });
  return withWriteConn((conn) => tableRows(conn, repoId));
}

async function prepareRecoveryAttempt(
  fixture: DurableRecoveryFixture,
  injectFailure: boolean,
) {
  await exclusiveWrite(async (conn) => {
    const state = await getDerivedStateFromConnection(conn, fixture.repoId);
    assert.strictEqual(
      await markEmbeddingLifecycleRefreshingForTarget(
        conn,
        fixture.repoId,
        state?.targetVersionId ?? null,
        fixture.versionId,
      ),
      true,
    );
  });
  fixture.events.push("marker:refreshing");
  invalidateRepositorySymbolVectorHealth(
    fixture.repoId,
    fixture.versionId,
    RECOVERY_SEMANTIC_CONFIG,
    "refreshing",
  );

  return createRepositorySemanticLifecycle({
    repoId: fixture.repoId,
    versionId: fixture.versionId,
    appConfig: { semantic: RECOVERY_SEMANTIC_CONFIG },
    beforeSteadyCommit: async () => {
      fixture.events.push("marker:commit");
      if (injectFailure && fixture.seam === "marker-commit") {
        throw new Error("injected marker-commit failure");
      }
    },
    deps: {
      withExclusiveOperation: async (task, timeoutMs) => {
        fixture.events.push("gate:start");
        try {
          return await withExclusiveLadybugOperation(task, timeoutMs);
        } finally {
          fixture.events.push("gate:release");
        }
      },
      markSteadyIfCurrent: async (conn, repoId, versionId) => {
        fixture.events.push("marker:steady");
        return markEmbeddingLifecycleSteadyIfCurrent(conn, repoId, versionId);
      },
      publish: (input) => {
        fixture.events.push("publication:degraded");
        return publishRepositorySymbolVectorHealthBatch(input);
      },
      commitPreparedSuccessBatch: (prepared) => {
        fixture.events.push("publication:steady");
        commitPreparedRepositorySymbolVectorHealthBatch(prepared);
      },
    },
  });
}

async function installRecoveryQueryObserver(
  fixture: DurableRecoveryFixture,
  injectFailure: boolean,
): Promise<() => void> {
  let writeConn!: Connection;
  await withWriteConn(async (conn) => {
    writeConn = conn;
  });
  const originalQuery = writeConn.query.bind(writeConn);
  const identity = resolveSymbolVectorPhysicalIdentity(
    fixture.repoId,
    JINA_MODEL,
  );
  let checkpointCount = 0;

  writeConn.query = async function (statement, progressCallback) {
    const normalized = statement.trim();
    if (/^CHECKPOINT\s*;?$/iu.test(normalized)) {
      checkpointCount += 1;
      fixture.events.push(`checkpoint:${checkpointCount}`);
      if (
        injectFailure &&
        fixture.seam === "checkpoint" &&
        checkpointCount === 2
      ) {
        throw new Error("injected checkpoint failure");
      }
    }
    if (normalized.startsWith(`CREATE NODE TABLE ${identity.tableName}`)) {
      fixture.events.push("ddl:table-create");
      if (injectFailure && fixture.seam === "table-create") {
        throw new Error("injected table-create failure");
      }
    }
    if (
      normalized.startsWith(
        `CALL QUERY_VECTOR_INDEX('${identity.tableName}', '${identity.indexName}',`,
      )
    ) {
      fixture.events.push("probe:ann-query");
      if (injectFailure && fixture.seam === "probe") {
        throw new Error("injected probe failure");
      }
    }
    return originalQuery(statement, progressCallback);
  };

  return () => {
    writeConn.query = originalQuery;
  };
}

async function createDurableRecoveryFixture(
  seam: DurableRecoverySeam,
  ordinal: number,
): Promise<DurableRecoveryFixture> {
  const repoId = `vector-recovery-${ordinal}-${seam}`;
  const initialCount =
    seam === "index-create"
      ? 1_999
      : seam === "index-drop" || seam === "probe"
        ? 2_000
        : 1;
  const seeded = await seedRecoveryRepository(repoId, initialCount);
  let attemptSymbols = seeded.symbols;
  const needsBaseline =
    seam === "index-create" ||
    seam === "index-drop" ||
    seam === "probe" ||
    seam === "vector-delete" ||
    seam === "deletion-table-drop" ||
    seam === "graph-deletion";

  if (needsBaseline) {
    await refreshReconciliationRepo({
      repoId,
      symbols: seeded.symbols,
    });
  }

  if (seam === "index-create") {
    const thresholdSymbol = reconciliationSymbol(repoId, 1_999);
    await exclusiveWrite((conn) =>
      ladybugDb.upsertSymbol(conn, thresholdSymbol),
    );
    attemptSymbols = [thresholdSymbol];
  } else if (seam === "index-drop") {
    attemptSymbols = seeded.symbols
      .slice(0, 51)
      .map((_, index) =>
        reconciliationSymbol(repoId, index, "recovery-index-drop"),
      );
    await exclusiveWrite((conn) =>
      ladybugDb.upsertSymbolBatch(conn, attemptSymbols),
    );
  } else if (seam === "probe" || seam === "vector-delete") {
    const changed = reconciliationSymbol(repoId, 0, `recovery-${seam}`);
    await exclusiveWrite((conn) => ladybugDb.upsertSymbol(conn, changed));
    attemptSymbols = [changed];
  }

  const expectedFinalCount =
    seam === "index-create" ? 2_000 : initialCount;
  const overlapSymbolId =
    attemptSymbols[0]?.symbolId ?? seeded.symbols[0]!.symbolId;
  const controlRows = await seedRecoveryControlOverlap(overlapSymbolId);
  const events: string[] = [];

  const fixture: DurableRecoveryFixture = {
    seam,
    repoId,
    versionId: seeded.versionId,
    expectedFinalCount,
    controlRows,
    events,
    failureState: (() => {
      if (seam === "table-create") {
        return {
          repoPresent: true,
          tableState: "absent",
          completeVectorCount: 0,
          catalog: "none",
          lifecycleState: "refreshing",
          mode: "degraded",
          exactFallbackAllowed: false,
        };
      }
      if (seam === "vector-delete") {
        return {
          repoPresent: true,
          tableState: "present",
          completeVectorCount: 0,
          catalog: "none",
          lifecycleState: "refreshing",
          mode: "degraded",
          exactFallbackAllowed: false,
        };
      }
      if (seam === "index-drop") {
        return {
          repoPresent: true,
          tableState: "present",
          completeVectorCount: 2_000,
          catalog: "none",
          lifecycleState: "refreshing",
          mode: "degraded",
          exactFallbackAllowed: false,
        };
      }
      if (seam === "deletion-table-drop") {
        return {
          repoPresent: true,
          tableState: "present",
          completeVectorCount: 1,
          catalog: "none",
          lifecycleState: "deleting",
          mode: "degraded",
          exactFallbackAllowed: false,
        };
      }
      if (seam === "graph-deletion") {
        return {
          repoPresent: true,
          tableState: "absent",
          completeVectorCount: 0,
          catalog: "none",
          lifecycleState: "deleting",
          mode: "degraded",
          exactFallbackAllowed: false,
        };
      }
      return {
        repoPresent: true,
        tableState: "present",
        completeVectorCount: expectedFinalCount,
        catalog: expectedFinalCount >= 2_000 ? "healthy" : "none",
        lifecycleState: "refreshing",
        mode: "degraded",
        exactFallbackAllowed: false,
      };
    })(),
    async runRefresh(shouldInject) {
      if (seam === "deletion-table-drop" || seam === "graph-deletion") {
        throw new Error(`refresh is unavailable for ${seam}`);
      }
      const lifecycle = await prepareRecoveryAttempt(fixture, shouldInject);
      const restoreQuery = await installRecoveryQueryObserver(
        fixture,
        shouldInject,
      );
      try {
        await refreshSymbolEmbeddings({
          repoId,
          provider: "local",
          model: JINA_MODEL,
          symbols: attemptSymbols,
          embeddingProvider: reconciliationProvider(),
          batchSize: 32,
          concurrency: 2,
          onReconciliationStep: async (step) => {
            fixture.events.push(recoveryStepEvent(step));
            if (
              shouldInject &&
              REFRESH_FAILURE_STEP[seam] === step
            ) {
              throw new Error(`injected ${seam} failure`);
            }
          },
          onFailureInsideGate: async (error) => {
            fixture.events.push("gate:failure-finalize");
            await lifecycle.onFailureInsideGate(error);
          },
        });
        await lifecycle.commitSuccess();
      } catch (error) {
        if (!lifecycle.failureFinalizationStartedInsideGate()) {
          await lifecycle.onFailureOutsideGate(error);
        }
        throw error;
      } finally {
        restoreQuery();
      }
    },
    async runDeletion(shouldInject) {
      if (seam !== "deletion-table-drop" && seam !== "graph-deletion") {
        throw new Error(`deletion is unavailable for ${seam}`);
      }
      await _teardownRepositoryDatabaseForTesting(
        repoId,
        RECOVERY_SEMANTIC_CONFIG,
        {
          withExclusiveOperation: async (task) => {
            fixture.events.push("gate:start");
            try {
              return await withExclusiveLadybugOperation(task);
            } finally {
              fixture.events.push("gate:release");
            }
          },
          withWriteConnection: withWriteConn,
          getRepo: ladybugDb.getRepo,
          getLatestVersion: ladybugDb.getLatestVersion,
          markDeleting: async (conn, targetRepoId) => {
            fixture.events.push("marker:deleting");
            await markEmbeddingLifecycleDeleting(conn, targetRepoId);
          },
          invalidateHealth: (
            targetRepoId,
            versionId,
            semanticConfig,
            lifecycleState,
          ) =>
            invalidateRepositorySymbolVectorHealth(
              targetRepoId,
              versionId,
              semanticConfig,
              lifecycleState,
            ),
          inspectTable: async (conn, targetRepoId) => {
            fixture.events.push("gate:catalog-table");
            return inspectRepoSymbolVectorTable(conn, targetRepoId);
          },
          validateOwnership: async (conn, targetRepoId, model) => {
            fixture.events.push("gate:ownership");
            await validateRepoSymbolVectorOwnership(
              conn,
              targetRepoId,
              model,
            );
          },
          showIndexes: async (conn) => {
            fixture.events.push("gate:catalog-indexes");
            return showIndexesStrict(conn);
          },
          dropIndex: async (conn, tableName, indexName) => {
            fixture.events.push("ddl:index-drop");
            return dropVectorIndex(conn, tableName, indexName);
          },
          dropTable: async (conn, tableName) => {
            fixture.events.push("ddl:table-drop");
            if (shouldInject && seam === "deletion-table-drop") {
              throw new Error("injected deletion-table-drop failure");
            }
            await execDdl(conn, `DROP TABLE ${tableName}`);
          },
          resetPreparedCaches: () => {
            fixture.events.push("ddl:prepared-cache-reset");
            resetPreparedStatementCaches();
          },
          deleteGraph: async (conn, targetRepoId) => {
            fixture.events.push("dml:graph-delete");
            if (shouldInject && seam === "graph-deletion") {
              throw new Error("injected graph-deletion failure");
            }
            await ladybugDb.deleteRepo(conn, targetRepoId);
          },
          clearHealth: (targetRepoId) => {
            fixture.events.push("publication:clear");
            clearRepositorySymbolVectorHealth(targetRepoId);
            clearRepositorySymbolVectorDiagnostics(targetRepoId);
          },
          getDerivedState: getDerivedStateFromConnection,
          assessHealth: assessRepositorySymbolVectorHealth,
          publishHealth: (input) => {
            fixture.events.push("publication:deletion-pending");
            return publishRepositorySymbolVectorHealthBatch(input);
          },
          publishDiagnostic: (diagnostic) => {
            fixture.events.push("publication:diagnostic");
            publishRepositorySymbolVectorDiagnostic(diagnostic);
          },
        },
      );
    },
  };
  return fixture;
}

async function assertRecoveryState(
  fixture: DurableRecoveryFixture,
  expected: RecoveryStateExpectation,
  resetVectorQueryGuard = false,
): Promise<void> {
  await reopenRecoveryDatabase(resetVectorQueryGuard);
  const identity = resolveSymbolVectorPhysicalIdentity(
    fixture.repoId,
    JINA_MODEL,
  );
  const controlIdentity = resolveSymbolVectorPhysicalIdentity(
    "vector-recovery-control",
    JINA_MODEL,
  );

  await withWriteConn(async (conn) => {
    assert.strictEqual(
      Boolean(await ladybugDb.getRepo(conn, fixture.repoId)),
      expected.repoPresent,
    );
    const inspection = await inspectRepoSymbolVectorTable(
      conn,
      fixture.repoId,
    );
    assert.strictEqual(inspection.tableName, identity.tableName);
    assert.strictEqual(inspection.state, expected.tableState);
    assert.strictEqual(
      await countCompleteRepoSymbolVectors(
        conn,
        fixture.repoId,
        JINA_MODEL,
      ),
      expected.completeVectorCount,
    );
    await validateRepoSymbolVectorOwnership(
      conn,
      fixture.repoId,
      JINA_MODEL,
    );

    const indexes = await showIndexesStrict(conn);
    const relevant = indexes.filter(
      (index) =>
        index.name === identity.indexName ||
        (index.tableName === identity.tableName &&
          index.property === identity.propertyName),
    );
    if (expected.catalog === "healthy") {
      assert.strictEqual(relevant.length, 1);
      assert.deepStrictEqual(
        {
          name: relevant[0]?.name,
          tableName: relevant[0]?.tableName,
          type: relevant[0]?.type,
          property: relevant[0]?.property,
          status: relevant[0]?.status,
          extensionLoaded: relevant[0]?.extensionLoaded,
        },
        {
          name: identity.indexName,
          tableName: identity.tableName,
          type: "vector",
          property: identity.propertyName,
          status: "healthy",
          extensionLoaded: true,
        },
      );
    } else {
      assert.deepStrictEqual(relevant, []);
    }

    const state = await getDerivedStateFromConnection(conn, fixture.repoId);
    assert.strictEqual(
      state?.embeddingLifecycleState ?? null,
      expected.lifecycleState,
    );
    assert.deepStrictEqual(
      await tableRows(conn, "vector-recovery-control"),
      fixture.controlRows,
    );
    const controlIndexes = indexes.filter(
      (index) =>
        index.name === controlIdentity.indexName ||
        (index.tableName === controlIdentity.tableName &&
          index.property === controlIdentity.propertyName),
    );
    assert.deepStrictEqual(controlIndexes, []);
  });

  const snapshot = getRepositorySymbolVectorHealthSnapshot(
    fixture.repoId,
    JINA_MODEL,
  );
  assert.strictEqual(snapshot?.mode ?? null, expected.mode);
  assert.strictEqual(
    snapshot?.exactFallbackAllowed ?? null,
    expected.exactFallbackAllowed,
  );
  if (snapshot) {
    assert.strictEqual(
      snapshot.lifecycleState,
      expected.lifecycleState,
    );
  }
}

async function retrieveRecoveryBytes(
  fixture: DurableRecoveryFixture,
): Promise<string> {
  const query = reconciliationVector(`query:${fixture.repoId}`);
  return withWriteConn(async (conn) => {
    const retrieve = () =>
      fixture.expectedFinalCount >= 2_000
        ? queryRepoSymbolVectorIndex(
            conn,
            fixture.repoId,
            JINA_MODEL,
            query,
            10,
            200,
          )
        : rankRepoSymbolVectorsExact(
            conn,
            fixture.repoId,
            JINA_MODEL,
            query,
            10,
          );
    const first = JSON.stringify(await retrieve());
    const second = JSON.stringify(await retrieve());
    assert.strictEqual(second, first);
    assert.notStrictEqual(first, "[]");
    return first;
  });
}

async function assertRefreshRecovery(
  fixture: DurableRecoveryFixture,
): Promise<void> {
  await assert.rejects(
    fixture.runRefresh(true),
    fixture.seam === "checkpoint"
      ? /post-checkpoint failed/iu
      : new RegExp(`injected ${fixture.seam} failure`, "iu"),
  );
  await assertRecoveryState(
    fixture,
    fixture.failureState,
    fixture.seam === "probe",
  );
  assert.ok(fixture.events.includes("publication:degraded"));

  await fixture.runRefresh(false);
  const steadyState: RecoveryStateExpectation = {
    repoPresent: true,
    tableState: "present",
    completeVectorCount: fixture.expectedFinalCount,
    catalog: fixture.expectedFinalCount >= 2_000 ? "healthy" : "none",
    lifecycleState: "steady",
    mode: fixture.expectedFinalCount >= 2_000 ? "hnsw" : "exact",
    exactFallbackAllowed: true,
  };
  await assertRecoveryState(fixture, steadyState);
  const firstRetryBytes = await retrieveRecoveryBytes(fixture);

  const secondRetryStart = fixture.events.length;
  await fixture.runRefresh(false);
  const secondRetryEvents = fixture.events.slice(secondRetryStart);
  assert.strictEqual(
    secondRetryEvents.some(
      (event) => event.startsWith("dml:") || event.startsWith("ddl:"),
    ),
    false,
    `${fixture.seam} second retry emitted vector DML or DDL`,
  );
  await assertRecoveryState(fixture, steadyState);
  assert.strictEqual(
    await retrieveRecoveryBytes(fixture),
    firstRetryBytes,
  );
}

async function assertDeletionRecovery(
  fixture: DurableRecoveryFixture,
): Promise<void> {
  await assert.rejects(
    fixture.runDeletion(true),
    new RegExp(`injected ${fixture.seam} failure`, "iu"),
  );
  await assertRecoveryState(fixture, fixture.failureState);

  await fixture.runDeletion(false);
  const terminalState: RecoveryStateExpectation = {
    repoPresent: false,
    tableState: "absent",
    completeVectorCount: 0,
    catalog: "none",
    lifecycleState: null,
    mode: null,
    exactFallbackAllowed: null,
  };
  await assertRecoveryState(fixture, terminalState);
  const secondRetryStart = fixture.events.length;
  await fixture.runDeletion(false);
  await assertRecoveryState(fixture, terminalState);
  assert.strictEqual(
    fixture.events
      .slice(secondRetryStart)
      .some(
        (event) =>
          event.startsWith("dml:") ||
          event.startsWith("ddl:table") ||
          event.startsWith("ddl:index"),
      ),
    false,
    `${fixture.seam} terminal retry mutated durable storage`,
  );
}


describe(
  "repository vector table lifecycle",
  { concurrency: 1 },
  () => {
    before(async () => {
      rmSync(dbPath, { recursive: true, force: true });
      rmSync(`${dbPath}.sdl-lineage.json`, { force: true });
      configurePool({ readPoolSize: 2 });
      await getLadybugDb(dbPath);
      await withWriteConn(createSchema);
      await exclusiveWrite(async (conn) => {
        await execCheckpoint(conn);
        await withWindowsFtsRuntime(() =>
          execDdl(conn, "LOAD EXTENSION vector"),
        );
      });
    });



    after(async () => {
      await closeLadybugDb();
      rmSync(dbPath, { recursive: true, force: true });
      rmSync(`${dbPath}.sdl-lineage.json`, { force: true });
    });

    it("keeps the same symbol ID isolated in repository A and B", async () => {
      const repoA = "vector-isolation-a";
      const repoB = "vector-isolation-b";
      await exclusiveWrite(async (conn) => {
        await ensureRepoSymbolVectorTable(conn, repoA);
        await ensureRepoSymbolVectorTable(conn, repoB);
        await setRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "shared-symbol",
          JINA_MODEL,
          "repo-a-vector",
          "repo-a-hash",
          vector(0.1),
        );
        await setRepoSymbolVectorEmbedding(
          conn,
          repoB,
          "shared-symbol",
          JINA_MODEL,
          "repo-b-vector",
          "repo-b-hash",
          vector(0.2),
        );
      });

      await withWriteConn(async (conn) => {
        assert.deepStrictEqual(
          await tableRows(conn, repoA),
          [{
            embeddingId: `${JINA_MODEL}:shared-symbol`,
            repoId: repoA,
            symbolId: "shared-symbol",
            model: JINA_MODEL,
          }],
        );
        assert.deepStrictEqual(
          await tableRows(conn, repoB),
          [{
            embeddingId: `${JINA_MODEL}:shared-symbol`,
            repoId: repoB,
            symbolId: "shared-symbol",
            model: JINA_MODEL,
          }],
        );

        const repoAEmbedding = await getRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "shared-symbol",
          JINA_MODEL,
        );
        assert.strictEqual(repoAEmbedding?.vector, "repo-a-vector");
        assert.strictEqual(repoAEmbedding?.cardHash, "repo-a-hash");
        assert.ok(repoAEmbedding?.updatedAt);

        const repoBRows = await getRepoSymbolVectorEmbeddings(
          conn,
          repoB,
          ["shared-symbol", "missing-symbol"],
          JINA_MODEL,
        );
        assert.strictEqual(repoBRows.size, 1);
        assert.strictEqual(repoBRows.get("shared-symbol")?.vector, "repo-b-vector");
      });
    });

    it("counts complete rows and validates ownership per repository and model", async () => {
      const repoA = "vector-count-a";
      const repoB = "vector-count-b";
      await exclusiveWrite(async (conn) => {
        await setRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "jina-a",
          JINA_MODEL,
          "jina-a-vector",
          "jina-a-hash",
          vector(0.3),
        );
        await setRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "nomic-a",
          NOMIC_MODEL,
          "nomic-a-vector",
          "nomic-a-hash",
          vector(0.4),
        );
        await setRepoSymbolVectorEmbedding(
          conn,
          repoB,
          "jina-b",
          JINA_MODEL,
          "jina-b-vector",
          "jina-b-hash",
          vector(0.5),
        );
      });

      await withWriteConn(async (conn) => {
        assert.strictEqual(
          await countCompleteRepoSymbolVectors(conn, repoA, JINA_MODEL),
          1,
        );
        assert.strictEqual(
          await countCompleteRepoSymbolVectors(conn, repoA, NOMIC_MODEL),
          1,
        );
        assert.strictEqual(
          await countCompleteRepoSymbolVectors(conn, repoB, JINA_MODEL),
          1,
        );
        assert.strictEqual(
          await countCompleteRepoSymbolVectors(conn, repoB, NOMIC_MODEL),
          0,
        );
        await validateRepoSymbolVectorOwnership(conn, repoA, JINA_MODEL);
        await validateRepoSymbolVectorOwnership(conn, repoA, NOMIC_MODEL);
        await validateRepoSymbolVectorOwnership(conn, repoB, JINA_MODEL);
      });
    });

    it("fails closed for foreign metadata, cross-model vectors, and bad embedding IDs", async () => {
      const foreignRepo = "vector-corrupt-foreign";
      const crossModelRepo = "vector-corrupt-model";
      const badIdRepo = "vector-corrupt-id";
      await exclusiveWrite(async (conn) => {
        for (const repoId of [foreignRepo, crossModelRepo, badIdRepo]) {
          await ensureRepoSymbolVectorTable(conn, repoId);
        }

        const foreignTable = resolveSymbolVectorPhysicalIdentity(
          foreignRepo,
          JINA_MODEL,
        ).tableName;
        await exec(
          conn,
          `CREATE (e:${foreignTable} {embeddingId: $embeddingId, repoId: $repoId, symbolId: $symbolId, model: $model})`,
          {
            embeddingId: "metadata-only",
            repoId: "foreign-owner",
            symbolId: "metadata-only",
            model: JINA_MODEL,
          },
        );

        const crossModelTable = resolveSymbolVectorPhysicalIdentity(
          crossModelRepo,
          JINA_MODEL,
        ).tableName;
        await exec(
          conn,
          `CREATE (e:${crossModelTable} {embeddingId: $embeddingId, repoId: $repoId, symbolId: $symbolId, model: $model, embeddingJinaCodeVec: $vector})`,
          {
            embeddingId: `${NOMIC_MODEL}:cross-model`,
            repoId: crossModelRepo,
            symbolId: "cross-model",
            model: NOMIC_MODEL,
            vector: vector(0.6),
          },
        );

        const badIdTable = resolveSymbolVectorPhysicalIdentity(
          badIdRepo,
          JINA_MODEL,
        ).tableName;
        await exec(
          conn,
          `CREATE (e:${badIdTable} {embeddingId: $embeddingId, repoId: $repoId, symbolId: $symbolId, model: $model, embeddingJinaCodeVec: $vector})`,
          {
            embeddingId: "not-model-colon-symbol",
            repoId: badIdRepo,
            symbolId: "bad-id",
            model: JINA_MODEL,
            vector: vector(0.7),
          },
        );
      });

      await withWriteConn(async (conn) => {
        await assert.rejects(
          validateRepoSymbolVectorOwnership(conn, foreignRepo, JINA_MODEL),
          /ownership/i,
        );
        await assert.rejects(
          validateRepoSymbolVectorOwnership(conn, crossModelRepo, JINA_MODEL),
          /ownership/i,
        );
        await assert.rejects(
          validateRepoSymbolVectorOwnership(conn, badIdRepo, JINA_MODEL),
          /ownership/i,
        );
      });
    });

    it("deletes repository A without touching an overlapping ID in repository B", async () => {
      const repoA = "vector-delete-a";
      const repoB = "vector-delete-b";
      await exclusiveWrite(async (conn) => {
        await setRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "overlap",
          JINA_MODEL,
          "a",
          "a-hash",
          vector(0.1),
        );
        await setRepoSymbolVectorEmbedding(
          conn,
          repoB,
          "overlap",
          JINA_MODEL,
          "b",
          "b-hash",
          vector(0.2),
        );
        await deleteRepoSymbolVectorEmbeddingsBySymbolIds(
          conn,
          repoA,
          JINA_MODEL,
          ["overlap"],
        );
      });

      await withWriteConn(async (conn) => {
        assert.strictEqual(
          await getRepoSymbolVectorEmbedding(
            conn,
            repoA,
            "overlap",
            JINA_MODEL,
          ),
          null,
        );
        assert.strictEqual(
          (
            await getRepoSymbolVectorEmbedding(
              conn,
              repoB,
              "overlap",
              JINA_MODEL,
            )
          )?.vector,
          "b",
        );
      });
    });

    it("treats absence only after a successful catalog read and does not mutate inventory", async () => {
      const repoId = "vector-never-created";
      await withWriteConn(async (conn) => {
        const beforeTables = await queryStoredProcAll<Record<string, unknown>>(
          conn,
          "CALL SHOW_TABLES() RETURN name, type",
        );
        assert.strictEqual(
          await getRepoSymbolVectorEmbedding(
            conn,
            repoId,
            "missing",
            JINA_MODEL,
          ),
          null,
        );
        assert.strictEqual(
          (
            await getRepoSymbolVectorEmbeddings(
              conn,
              repoId,
              ["missing"],
              JINA_MODEL,
            )
          ).size,
          0,
        );
        assert.strictEqual(
          await countCompleteRepoSymbolVectors(conn, repoId, JINA_MODEL),
          0,
        );
        const afterTables = await queryStoredProcAll<Record<string, unknown>>(
          conn,
          "CALL SHOW_TABLES() RETURN name, type",
        );
        assert.deepStrictEqual(afterTables, beforeTables);
      });
    });

    it("rejects wrong-schema and foreign-owner tables before write mutation", async () => {
      const wrongSchemaRepo = "vector-wrong-schema";
      const wrongTable = resolveSymbolVectorPhysicalIdentity(
        wrongSchemaRepo,
        JINA_MODEL,
      ).tableName;
      await exclusiveWrite(async (conn) => {
        await execDdl(
          conn,
          `CREATE NODE TABLE ${wrongTable} (embeddingId STRING PRIMARY KEY, repoId STRING)`,
        );
        await assert.rejects(
          ensureRepoSymbolVectorTable(conn, wrongSchemaRepo),
          /schema/i,
        );
        await assert.rejects(
          setRepoSymbolVectorEmbedding(
            conn,
            wrongSchemaRepo,
            "must-not-write",
            JINA_MODEL,
            "vector",
            "hash",
            vector(0.1),
          ),
          /schema/i,
        );
        assert.deepStrictEqual(
          await queryAll(
            conn,
            `MATCH (e:${wrongTable}) RETURN e.embeddingId AS embeddingId`,
          ),
          [],
        );

      });

      const foreignRepo = "vector-foreign-owner-table";
      await exclusiveWrite(async (conn) => {
        await ensureRepoSymbolVectorTable(conn, foreignRepo);
        const tableName = resolveSymbolVectorPhysicalIdentity(
          foreignRepo,
          JINA_MODEL,
        ).tableName;
        await exec(
          conn,
          `CREATE (e:${tableName} {embeddingId: $embeddingId, repoId: $repoId, symbolId: $symbolId, model: $model})`,
          {
            embeddingId: "foreign-sentinel",
            repoId: "not-the-owner",
            symbolId: "foreign-sentinel",
            model: JINA_MODEL,
          },
        );
        await assert.rejects(
          setRepoSymbolVectorEmbedding(
            conn,
            foreignRepo,
            "must-not-write",
            JINA_MODEL,
            "vector",
            "hash",
            vector(0.2),
          ),
          /ownership/i,
        );
        const rows = await tableRows(conn, foreignRepo);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]?.embeddingId, "foreign-sentinel");
      });
    });

    it("executes DDL for both repository tables and generated model index names", async () => {
      const repoA = "vector-ddl-a";
      const repoB = "vector-ddl-b";
      const identityA = resolveSymbolVectorPhysicalIdentity(repoA, JINA_MODEL);
      const identityB = resolveSymbolVectorPhysicalIdentity(repoB, NOMIC_MODEL);

      await exclusiveWrite(async (conn) => {
        await ensureRepoSymbolVectorTable(conn, repoA);
        await ensureRepoSymbolVectorTable(conn, repoB);
        await setRepoSymbolVectorEmbedding(
          conn,
          repoA,
          "ddl-jina",
          JINA_MODEL,
          "ddl-jina-vector",
          "ddl-jina-hash",
          vector(0.1),
        );
        await setRepoSymbolVectorEmbedding(
          conn,
          repoB,
          "ddl-nomic",
          NOMIC_MODEL,
          "ddl-nomic-vector",
          "ddl-nomic-hash",
          vector(0.2),
        );
        await queryStoredProcAll(
          conn,
          `CALL CREATE_VECTOR_INDEX('${identityA.tableName}', '${identityA.indexName}', '${identityA.propertyName}', metric := 'cosine', efc := 200)`,
        );
        await queryStoredProcAll(
          conn,
          `CALL CREATE_VECTOR_INDEX('${identityB.tableName}', '${identityB.indexName}', '${identityB.propertyName}', metric := 'cosine', efc := 200)`,
        );


        const indexes = await showIndexesStrict(conn);
        assert.ok(
          indexes.some(
            (index) =>
              index.name === identityA.indexName &&
              index.tableName === identityA.tableName &&
              index.property === identityA.propertyName,
          ),
        );
        assert.ok(
          indexes.some(
            (index) =>
              index.name === identityB.indexName &&
              index.tableName === identityB.tableName &&
              index.property === identityB.propertyName,
          ),
        );
      });
    });

    it("evicts write and pooled-read prepared plans immediately after table creation", async () => {
      const repoId = "vector-prepared-cache-reset";
      const oldQuery = "MATCH (r:Repo) RETURN count(r) AS count";
      await withWriteConn(async (conn) => {
        await queryAll(conn, oldQuery);
        await queryAll(conn, oldQuery);
      });
      const readPool = getReadPool();
      assert.strictEqual(readPool.length, 2);
      for (const conn of readPool) {
        await queryAll(conn, oldQuery);
        await queryAll(conn, oldQuery);
      }

      await exclusiveWrite((conn) => ensureRepoSymbolVectorTable(conn, repoId));

      await withWriteConn(async (conn) => {
        await queryAll(conn, oldQuery);
        assert.strictEqual(
          await getRepoSymbolVectorEmbedding(
            conn,
            repoId,
            "missing",
            JINA_MODEL,
          ),
          null,
        );
      });
      const { tableName } = resolveSymbolVectorPhysicalIdentity(
        repoId,
        JINA_MODEL,
      );
      for (const conn of readPool) {
        await queryAll(conn, oldQuery);
        assert.deepStrictEqual(
          await queryAll(
            conn,
            `MATCH (e:${tableName}) WHERE e.repoId = $repoId RETURN e.symbolId AS symbolId`,
            { repoId },
          ),
          [],
        );
      }
    });

    it("probes the repository table and rejects foreign, wrong-model, or bad-ID rows", async () => {
      await exclusiveWrite(async (conn) => {
        const seed = async (params: {
          repoId: string;
          storedRepoId: string;
          model: string;
          embeddingId: string;
        }) => {
          const identity = resolveSymbolVectorPhysicalIdentity(
            params.repoId,
            JINA_MODEL,
          );
          await ensureRepoSymbolVectorTable(conn, params.repoId);
          await exec(
            conn,
            `MERGE (e:${identity.tableName} {embeddingId: $embeddingId})
             SET e.repoId = $storedRepoId,
                 e.symbolId = $symbolId,
                 e.model = $model,
                 e.embeddingVector = $vectorText,
                 e.cardHash = $cardHash,
                 e.updatedAt = $updatedAt,
                 e.embeddingJinaCodeVec = $vector`,
            {
              embeddingId: params.embeddingId,
              storedRepoId: params.storedRepoId,
              symbolId: "probe-symbol",
              model: params.model,
              vectorText: "probe-vector",
              cardHash: "probe-hash",
              updatedAt: new Date(0).toISOString(),
              vector: vector(0.25),
            },
          );
          await queryStoredProcAll(
            conn,
            `CALL CREATE_VECTOR_INDEX('${identity.tableName}', '${identity.indexName}', '${identity.propertyName}', metric := 'cosine', efc := 200)`,
          );
          return identity;
        };

        const goodRepo = "vector-probe-good";
        const goodIdentity = await seed({
          repoId: goodRepo,
          storedRepoId: goodRepo,
          model: JINA_MODEL,
          embeddingId: `${JINA_MODEL}:probe-symbol`,
        });
        assert.strictEqual(
          await queryVectorIndexProbe(
            conn,
            goodIdentity,
            goodRepo,
            JINA_MODEL,
            vector(0.25),
          ),
          1,
        );

        for (const testCase of [
          {
            label: "foreign owner",
            repoId: "vector-probe-foreign",
            storedRepoId: "another-repository",
            model: JINA_MODEL,
            embeddingId: `${JINA_MODEL}:probe-symbol`,
          },
          {
            label: "wrong model",
            repoId: "vector-probe-model",
            storedRepoId: "vector-probe-model",
            model: NOMIC_MODEL,
            embeddingId: `${NOMIC_MODEL}:probe-symbol`,
          },
          {
            label: "bad embedding ID",
            repoId: "vector-probe-id",
            storedRepoId: "vector-probe-id",
            model: JINA_MODEL,
            embeddingId: "bad-id",
          },
        ]) {
          const identity = await seed(testCase);
          await assert.rejects(
            queryVectorIndexProbe(
              conn,
              identity,
              testCase.repoId,
              JINA_MODEL,
              vector(0.25),
            ),
            new RegExp(testCase.label.replace(" ", ".*"), "i"),
          );
        }
      });
    });

    it("derives exact and HNSW modes from actual durable counts", () => {
      for (const [count, expected] of [
        [0, "exact"],
        [1, "exact"],
        [1_999, "exact"],
        [2_000, "hnsw"],
        [2_001, "hnsw"],
      ] as const) {
        assert.strictEqual(resolveRepositorySymbolVectorIndexMode(count), expected);
      }
    });

    it("plans upward, downward, retained, and provider-disagreement reconciliation from actual counts", () => {
      assert.deepStrictEqual(
        planRepositorySymbolVectorReconciliation({
          actualPreCount: 1_999,
          actualPostCount: 2_000,
          mutationCount: 1,
          expectedIndexHealthy: false,
          providerTargetCount: 1,
        }),
        {
          retainExpectedIndex: false,
          dropExpectedBeforeMutation: false,
          requireExpectedIndexAfterMutation: true,
        },
      );
      assert.deepStrictEqual(
        planRepositorySymbolVectorReconciliation({
          actualPreCount: 2_000,
          actualPostCount: 1_999,
          mutationCount: 1,
          expectedIndexHealthy: true,
          providerTargetCount: 9_999,
        }),
        {
          retainExpectedIndex: true,
          dropExpectedBeforeMutation: false,
          requireExpectedIndexAfterMutation: false,
        },
      );
      assert.deepStrictEqual(
        planRepositorySymbolVectorReconciliation({
          actualPreCount: 2_001,
          actualPostCount: 2_001,
          mutationCount: 0,
          expectedIndexHealthy: true,
          providerTargetCount: 0,
        }),
        {
          retainExpectedIndex: true,
          dropExpectedBeforeMutation: false,
          requireExpectedIndexAfterMutation: true,
        },
      );
      assert.deepStrictEqual(
        planRepositorySymbolVectorReconciliation({
          actualPreCount: 2_001,
          actualPostCount: 2_001,
          mutationCount: 51,
          expectedIndexHealthy: true,
          providerTargetCount: 2_001,
        }),
        {
          retainExpectedIndex: false,
          dropExpectedBeforeMutation: true,
          requireExpectedIndexAfterMutation: true,
        },
      );
    });


    it(
      "compares fresh retained-HNSW mutation counts 1, 50, and 51 in disposable subprocesses",
      { timeout: 600_000 },
      async () => {
        const childMutationCount = Number.parseInt(
          process.env.SDL_RECONCILIATION_CHILD_MUTATIONS ?? "0",
          10,
        );
        if (childMutationCount === 0) {
          const testFile = process.argv[1];
          assert.ok(testFile, "expected the current integration test path");
          for (const mutationCount of [1, 6, 7, 50, 51]) {
            const result = spawnSync(
              process.execPath,
              [
                "--experimental-strip-types",
                "--test",
                "--test-concurrency=1",
                "--test-name-pattern=fresh retained-HNSW mutation counts",
                testFile,
              ],
              {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                  ...process.env,
                  SDL_RECONCILIATION_CHILD_MUTATIONS: String(mutationCount),
                },
                timeout: 180_000,
              },
            );
            assert.strictEqual(
              result.status,
              0,
              [
                `fresh HNSW mutation subprocess ${mutationCount} failed`,
                result.error?.stack ?? "",
                result.stdout,
                result.stderr,
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }
          return;
        }

        assert.ok(
          childMutationCount >= 1 && childMutationCount <= 51,
          `unsupported child mutation count ${childMutationCount}`,
        );
        const repoId = "vector-fresh-retained";
        const allSymbols = await seedReconciliationRepo(repoId, 2_000);
        let operations: string[] = [];
        await refreshReconciliationRepo({
          repoId,
          symbols: allSymbols,
          operations,
        });
        assert.deepStrictEqual(reconciliationMutationOperations(operations), [
          "after-vector-delete",
          "after-vector-merge",
          "after-index-create",
        ]);
        await assertReconciledCountAndCatalog(repoId, 2_000);

        const changed = allSymbols
          .slice(0, childMutationCount)
          .map((_, index) =>
            reconciliationSymbol(repoId, index, "changed"),
          );
        await exclusiveWrite(async (conn) => {
          for (let start = 0; start < changed.length; start += 250) {
            await ladybugDb.upsertSymbolBatch(
              conn,
              changed.slice(start, start + 250),
            );
          }
        });
        operations = [];
        await refreshReconciliationRepo({
          repoId,
          symbols: changed,
          operations,
        });
        assert.deepStrictEqual(
          reconciliationMutationOperations(operations),
          childMutationCount <= 50
            ? ["after-vector-delete", "after-vector-create"]
            : [
                "after-index-drop",
                "after-vector-delete",
                "after-vector-merge",
                "after-index-create",
              ],
        );
        await assertReconciledCountAndCatalog(repoId, 2_000);

        if (childMutationCount === 7 || childMutationCount === 50) {
          await exclusiveWrite((conn) => execCheckpoint(conn));
          await closeLadybugDb({ strict: true });
          await getLadybugDb(dbPath);
          await exclusiveWrite((conn) =>
            withWindowsFtsRuntime(() =>
              execDdl(conn, "LOAD EXTENSION vector"),
            ),
          );
          await assertReconciledCountAndCatalog(repoId, 2_000);
        }
      },
    );


    it("finalizes a fresh streamed write failure before shared admission reopens", { timeout: 30_000 }, async () => {
      const repoId = "vector-stream-write-failure";
      const { symbols, versionId } = await seedRecoveryRepository(repoId, 2);
      const semanticConfig = {
        ...RECOVERY_SEMANTIC_CONFIG,
        symbolEmbeddingModels: [JINA_MODEL, NOMIC_MODEL],
      };
      await exclusiveWrite(async (conn) => {
        assert.strictEqual(await markEmbeddingLifecycleRefreshingForTarget(
          conn, repoId, versionId, versionId,
        ), true);
      });
      invalidateRepositorySymbolVectorHealth(repoId, versionId, semanticConfig, "refreshing");
      const lifecycle = createRepositorySemanticLifecycle({
        repoId, versionId, appConfig: { semantic: semanticConfig },
      });
      const writeStarted = Promise.withResolvers<void>();
      const releaseFailure = Promise.withResolvers<void>();
      let finalized = false;
      let readerEntered = false;
      const completion = assert.rejects(refreshSymbolEmbeddings({
        repoId, provider: "local", model: JINA_MODEL, symbols,
        embeddingProvider: reconciliationProvider(), batchSize: 1, concurrency: 2,
        onReconciliationStep: async (step) => {
          if (step !== "after-vector-delete") return;
          writeStarted.resolve();
          await releaseFailure.promise;
          throw new Error("injected streamed write failure");
        },
        onFailureInsideGate: async (error) => {
          await lifecycle.onFailureInsideGate(error);
          finalized = true;
        },
      }), /injected streamed write failure/);
      await writeStarted.promise;
      const reader = withSharedLadybugOperation(async () => {
        readerEntered = true;
        assert.strictEqual(finalized, true);
        const conn = getReadPool()[0];
        assert.strictEqual(await countCompleteRepoSymbolVectors(conn, repoId, JINA_MODEL), 0);
        const state = await getDerivedStateFromConnection(conn, repoId);
        assert.strictEqual(state?.embeddingLifecycleState, "refreshing");
        assert.strictEqual(state?.embeddingsDirty, true);
        for (const model of semanticConfig.symbolEmbeddingModels) {
          const snapshot = getRepositorySymbolVectorHealthSnapshot(repoId, model);
          assert.strictEqual(snapshot?.mode, "degraded");
          assert.strictEqual(snapshot?.exactFallbackAllowed, false);
        }
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(readerEntered, false);
      } finally {
        releaseFailure.resolve();
        await Promise.all([completion, reader]);
      }
    });

    for (const failInference of [false, true]) {
      it(
        `streams fresh vectors while sibling inference is pending${failInference ? " and drains provider failure" : ""}`,
        { timeout: 30_000 },
        async () => {
          const repoId = `vector-stream-${failInference ? "failure" : "success"}`;
          const { symbols, versionId } = await seedRecoveryRepository(
            repoId,
            failInference ? 3 : 2,
          );
          const semanticConfig = {
            ...RECOVERY_SEMANTIC_CONFIG,
            symbolEmbeddingModels: failInference
              ? [JINA_MODEL, NOMIC_MODEL]
              : [JINA_MODEL],
          };
          await exclusiveWrite(async (conn) => {
            assert.strictEqual(
              await markEmbeddingLifecycleRefreshingForTarget(
                conn,
                repoId,
                versionId,
                versionId,
              ),
              true,
            );
          });
          invalidateRepositorySymbolVectorHealth(
            repoId,
            versionId,
            semanticConfig,
            "refreshing",
          );
          const lifecycle = createRepositorySemanticLifecycle({
            repoId,
            versionId,
            appConfig: { semantic: semanticConfig },
          });
          const firstWrite = Promise.withResolvers<void>();
          const releaseSecond = Promise.withResolvers<void>();
          const releaseThird = Promise.withResolvers<void>();
          const providerFailed = Promise.withResolvers<void>();
          const operations: string[] = [];
          let calls = 0;
          let settled = false;
          const refresh = refreshSymbolEmbeddings({
            repoId,
            provider: "local",
            model: JINA_MODEL,
            symbols,
            batchSize: 1,
            concurrency: symbols.length,
            embeddingProvider: {
              ...reconciliationProvider(),
              async embed(texts) {
                assert.strictEqual(hasCurrentExclusiveLadybugOperation(), false);
                const call = ++calls;
                if (call === 2) {
                  await releaseSecond.promise;
                  if (failInference) throw new Error("later sibling failure");
                }
                if (call === 3) {
                  await releaseThird.promise;
                  providerFailed.resolve();
                  throw new Error("injected streaming provider failure");
                }
                return texts.map(reconciliationVector);
              },
            },
            onReconciliationStep: (step) => {
              operations.push(step);
              if (step === "after-vector-delete") firstWrite.resolve();
            },
            onFailureInsideGate: lifecycle.onFailureInsideGate,
          })
            .catch(async (error) => {
              await lifecycle.onFailureOutsideGate(error);
              throw error;
            })
            .finally(() => {
              settled = true;
            });
          // Attach the rejection assertion immediately; delayed inference must never
          // turn a native write or provider failure into an unhandled rejection.
          const completion = failInference
            ? assert.rejects(refresh, {
                message: "Symbol embedding provider failed: injected streaming provider failure",
              })
            : refresh;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const overlapped = await Promise.race([
              firstWrite.promise.then(() => true),
              new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), 5_000);
              }),
            ]);
            assert.strictEqual(
              overlapped,
              true,
              "first vector write must precede final inference settlement",
            );
            // This is a separately admitted reader, started outside the write's
            // async context. It can enter while the second inference is held.
            await withSharedLadybugOperation(async () => {
              const conn = getReadPool()[0];
              assert.strictEqual(
                await countCompleteRepoSymbolVectors(conn, repoId, JINA_MODEL),
                1,
              );
              const state = await getDerivedStateFromConnection(conn, repoId);
              assert.strictEqual(state?.embeddingLifecycleState, "refreshing");
              assert.strictEqual(state?.embeddingsDirty, true);
              for (const model of semanticConfig.symbolEmbeddingModels) {
                const snapshot = getRepositorySymbolVectorHealthSnapshot(
                  repoId,
                  model,
                );
                assert.strictEqual(snapshot?.mode, "degraded");
                assert.strictEqual(snapshot?.exactFallbackAllowed, false);
              }
            });
            assert.strictEqual(settled, false);
            if (failInference) {
              // The later input fails first. The earlier held input then fails
              // during drain, and must not replace the initiating error.
              releaseThird.resolve();
              await providerFailed.promise;
              await new Promise<void>((resolve) => setImmediate(resolve));
              assert.strictEqual(
                settled,
                false,
                "refresh must drain the remaining inference before rejecting",
              );
            } else {
              releaseSecond.resolve();
            }
          } finally {
            clearTimeout(timeout);
            releaseSecond.resolve();
            releaseThird.resolve();
            await completion;
          }
          await withSharedLadybugOperation(async () => {
            const conn = getReadPool()[0];
            assert.strictEqual(
              await countCompleteRepoSymbolVectors(conn, repoId, JINA_MODEL),
              failInference ? 1 : 2,
            );
            assert.strictEqual(
              (await getDerivedStateFromConnection(conn, repoId))
                ?.embeddingLifecycleState,
              "refreshing",
            );
          });
          assert.deepStrictEqual(
            reconciliationMutationOperations(operations),
            failInference
              ? ["after-vector-delete"]
              : ["after-vector-delete", "after-vector-merge"],
          );
          if (failInference) {
            for (const model of semanticConfig.symbolEmbeddingModels) {
              const snapshot = getRepositorySymbolVectorHealthSnapshot(
                repoId,
                model,
              );
              assert.strictEqual(snapshot?.mode, "degraded");
              assert.strictEqual(snapshot?.exactFallbackAllowed, false);
            }
          } else {
            await lifecycle.commitSuccess();
            assert.strictEqual(
              getRepositorySymbolVectorHealthSnapshot(repoId, JINA_MODEL)?.mode,
              "exact",
            );
          }
        },
      );
    }

    it("executes durable count thresholds, zero-change, and up/down reconciliation", async () => {
      const repoId = "vector-execution-reconciliation";
      const operationSteps = (steps: readonly string[]) =>
        reconciliationMutationOperations(steps);
      const upsertSymbols = (symbols: ladybugDb.SymbolRow[]) =>
        exclusiveWrite(async (conn) => {
          for (let start = 0; start < symbols.length; start += 250) {
            await ladybugDb.upsertSymbolBatch(
              conn,
              symbols.slice(start, start + 250),
            );
          }
        });

      let allSymbols = await seedReconciliationRepo(repoId, 0);
      let operations: string[] = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: allSymbols,
          operations,
        }),
        { embedded: 0, skipped: 0 },
      );
      assert.deepStrictEqual(operationSteps(operations), []);
      await assertReconciledCountAndCatalog(repoId, 0);

      const first = reconciliationSymbol(repoId, 0);
      await upsertSymbols([first]);
      allSymbols = [first];
      operations = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: [first],
          operations,
        }),
        { embedded: 1, skipped: 0 },
      );
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",
        "after-vector-merge",
      ]);
      await assertReconciledCountAndCatalog(repoId, 1);

      const toExactBoundary = Array.from({ length: 1_998 }, (_, offset) =>
        reconciliationSymbol(repoId, offset + 1),
      );
      await upsertSymbols(toExactBoundary);
      allSymbols.push(...toExactBoundary);
      operations = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: toExactBoundary,
          operations,
        }),
        { embedded: 1_998, skipped: 0 },
      );
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",
        "after-vector-merge",
      ]);
      await assertReconciledCountAndCatalog(repoId, 1_999);

      const thresholdSymbol = reconciliationSymbol(repoId, 1_999);
      await upsertSymbols([thresholdSymbol]);
      allSymbols.push(thresholdSymbol);
      operations = [];
      await refreshReconciliationRepo({
        repoId,
        // This one-row provider target must not override the durable count.
        symbols: [thresholdSymbol],
        operations,
      });
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",

        "after-vector-merge",
        "after-index-create",
      ]);
      await assertReconciledCountAndCatalog(repoId, 2_000);

      const retainedOne = reconciliationSymbol(repoId, 2_000);
      await upsertSymbols([retainedOne]);
      allSymbols.push(retainedOne);
      operations = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: [retainedOne],
          operations,
        }),
        { embedded: 1, skipped: 0 },
      );
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",
        "after-vector-create",
      ]);
      await assertReconciledCountAndCatalog(repoId, 2_001);

      operations = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: allSymbols,
          operations,
        }),
        { embedded: 0, skipped: 2_001 },
      );
      assert.deepStrictEqual(
        operationSteps(operations),
        [],
        "healthy zero-change HNSW reconciliation must issue no vector DML or DDL",
      );

      const changedFiftyOne = allSymbols
        .slice(100, 151)
        .map((_, index) =>
          reconciliationSymbol(repoId, index + 100, `bulk-${index}`),
        );
      await upsertSymbols(changedFiftyOne);
      operations = [];
      assert.deepStrictEqual(
        await refreshReconciliationRepo({
          repoId,
          symbols: changedFiftyOne,
          operations,
        }),
        { embedded: 51, skipped: 0 },
      );
      assert.deepStrictEqual(operationSteps(operations), [
        "after-index-drop",
        "after-vector-delete",

        "after-vector-merge",
        "after-index-create",
      ]);
      await assertReconciledCountAndCatalog(repoId, 2_001);

      await exclusiveWrite((conn) =>
        ladybugDb.deleteSymbolsByIds(conn, [
          thresholdSymbol.symbolId,
          retainedOne.symbolId,
        ]),
      );
      await withWriteConn(async (conn) => {
        assert.ok(
          await getRepoSymbolVectorEmbedding(
            conn,
            repoId,
            retainedOne.symbolId,
            JINA_MODEL,
          ),
          "structural deletion must leave stale repository vectors intact",
        );
      });
      allSymbols = allSymbols.slice(0, 1_999);
      operations = [];
      await refreshReconciliationRepo({
        repoId,
        symbols: [],
        operations,
      });
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",
        "after-index-drop",
      ]);
      await assertReconciledCountAndCatalog(repoId, 1_999);
      await withWriteConn(async (conn) => {
        assert.strictEqual(
          await getRepoSymbolVectorEmbedding(
            conn,
            repoId,
            retainedOne.symbolId,
            JINA_MODEL,
          ),
          null,
        );
      });

      const restored = [
        reconciliationSymbol(repoId, 1_999, "restored"),
        reconciliationSymbol(repoId, 2_000, "restored"),
      ];
      await upsertSymbols(restored);
      allSymbols.push(...restored);
      operations = [];
      await refreshReconciliationRepo({
        repoId,
        symbols: restored,
        operations,
      });
      assert.deepStrictEqual(operationSteps(operations), [
        "after-vector-delete",

        "after-vector-merge",
        "after-index-create",
      ]);
      await assertReconciledCountAndCatalog(repoId, 2_001);


    });

    it("rejects wrong and ambiguous relevant catalog identities before vector mutation", async () => {
      for (const ambiguous of [false, true]) {
        const repoId = ambiguous
          ? "vector-execution-ambiguous-catalog"
          : "vector-execution-wrong-catalog";
        const [symbol] = await seedReconciliationRepo(repoId, 1);
        await refreshReconciliationRepo({ repoId, symbols: [symbol] });
        const identity = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);
        let originalCardHash = "";
        await exclusiveWrite(async (conn) => {
          originalCardHash =
            (
              await getRepoSymbolVectorEmbedding(
                conn,
                repoId,
                symbol.symbolId,
                JINA_MODEL,
              )
            )?.cardHash ?? "";
          await setRepoSymbolVectorEmbedding(
            conn,
            repoId,
            "nomic-catalog-sentinel",
            NOMIC_MODEL,
            "nomic-vector",
            "nomic-hash",
            vector(0.25),
          );
          await queryStoredProcAll(
            conn,
            `CALL CREATE_VECTOR_INDEX('${identity.tableName}', '${identity.indexName}', 'embeddingNomicVec', metric := 'cosine', efc := 200)`,
          );
          if (ambiguous) {
            await queryStoredProcAll(
              conn,
              `CALL CREATE_VECTOR_INDEX('${identity.tableName}', '${identity.indexName}_duplicate', '${identity.propertyName}', metric := 'cosine', efc := 200)`,
            );
          }
        });

        const changed = reconciliationSymbol(repoId, 0, "catalog-change");
        await exclusiveWrite((conn) => ladybugDb.upsertSymbol(conn, changed));
        const operations: string[] = [];
        await assert.rejects(
          refreshReconciliationRepo({
            repoId,
            symbols: [changed],
            operations,
          }),
          ambiguous ? /ambiguous/i : /incompatible/i,
        );
        assert.deepStrictEqual(operations, []);
        await withWriteConn(async (conn) => {
          assert.strictEqual(
            (
              await getRepoSymbolVectorEmbedding(
                conn,
                repoId,
                symbol.symbolId,
                JINA_MODEL,
              )
            )?.cardHash,
            originalCardHash,
          );
        });
      }
    });


    it("diagnoses a leftover repository vector table instead of adopting it", async () => {
      const repoId = "vector-leftover-registration";
      const rootPath = process.cwd();
      const identity = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);

      await exclusiveWrite((conn) => ensureRepoSymbolVectorTable(conn, repoId));
      try {
        await assert.rejects(
          handleRepoRegister({ repoId, rootPath }),
          /leftover vector table.*explicit repair or deletion/i,
        );

        await withWriteConn(async (conn) => {
          assert.ok(!(await ladybugDb.getRepo(conn, repoId)));
          const tables = await queryStoredProcAll<{ name: string }>(
            conn,
            "CALL SHOW_TABLES() RETURN name, type",
          );
          assert.ok(tables.some((table) => table.name === identity.tableName));
        });
        assert.deepStrictEqual(
          listRepositorySymbolVectorDiagnostics()
            .filter((diagnostic) => diagnostic.repoId === repoId)
            .map(({ code, tableName, repoId: owner }) => ({
              code,
              tableName,
              repoId: owner,
            })),
          [{
            code: "orphan-table",
            tableName: identity.tableName,
            repoId,
          }],
        );
      } finally {
        clearRepositorySymbolVectorDiagnostics(repoId);
      }
    });

    it("drops, re-registers, and recreates a repository table across every prepared cache", async () => {
      const repoId = "vector-unregister-recreate";
      const otherRepoId = "vector-unregister-keeper";
      const rootPath = mkdtempSync(
        join(tmpdir(), ".test-vector-unregister-recreate-"),
      );
      let clearedRepoId: string | null = null;
      const coordinator = {
        async getLiveStatus() {
          return { dirtyBuffers: 0 };
        },
        async clearRepo(cleared: string) {
          clearedRepoId = cleared;
        },
      } as unknown as NonNullable<Parameters<typeof handleRepoUnregister>[2]>;
      const oldQuery = "MATCH (r:Repo) RETURN count(r) AS count";

      try {
        await handleRepoRegister({ repoId, rootPath });
        await handleRepoRegister({ repoId: otherRepoId, rootPath });
        await exclusiveWrite(async (conn) => {
          await setRepoSymbolVectorEmbedding(
            conn,
            repoId,
            "overlap",
            JINA_MODEL,
            "old-vector",
            "old-hash",
            vector(0.2),
          );
          await setRepoSymbolVectorEmbedding(
            conn,
            otherRepoId,
            "overlap",
            JINA_MODEL,
            "keeper-vector",
            "keeper-hash",
            vector(0.3),
          );
        });

        await withWriteConn(async (conn) => {
          await queryAll(conn, oldQuery);
          await queryAll(conn, oldQuery);
          await rankRepoSymbolVectorsExact(
            conn,
            repoId,
            JINA_MODEL,
            vector(0.2),
            10,
          );
          await rankRepoSymbolVectorsExact(
            conn,
            repoId,
            JINA_MODEL,
            vector(0.2),
            10,
          );
        });
        const readPool = getReadPool();
        assert.strictEqual(readPool.length, 2);
        for (const conn of readPool) {
          await queryAll(conn, oldQuery);
          await queryAll(conn, oldQuery);
          await rankRepoSymbolVectorsExact(
            conn,
            repoId,
            JINA_MODEL,
            vector(0.2),
            10,
          );
          await rankRepoSymbolVectorsExact(
            conn,
            repoId,
            JINA_MODEL,
            vector(0.2),
            10,
          );
        }

        const removed = await handleRepoUnregister(
          { repoId, confirmRepoId: repoId, discardDrafts: true },
          undefined,
          coordinator,
        );
        assert.strictEqual(removed.ok, true);
        assert.strictEqual(clearedRepoId, repoId);

        const removedIdentity = resolveSymbolVectorPhysicalIdentity(
          repoId,
          JINA_MODEL,
        );
        await withWriteConn(async (conn) => {
          assert.ok(!(await ladybugDb.getRepo(conn, repoId)));
          const tables = await queryStoredProcAll<{ name: string }>(
            conn,
            "CALL SHOW_TABLES() RETURN name, type",
          );
          assert.ok(
            !tables.some((table) => table.name === removedIdentity.tableName),
          );
          assert.strictEqual(
            (
              await getRepoSymbolVectorEmbedding(
                conn,
                otherRepoId,
                "overlap",
                JINA_MODEL,
              )
            )?.vector,
            "keeper-vector",
          );
        });

        await handleRepoRegister({ repoId, rootPath });
        await exclusiveWrite((conn) =>
          setRepoSymbolVectorEmbedding(
            conn,
            repoId,
            "replacement",
            JINA_MODEL,
            "replacement-vector",
            "replacement-hash",
            vector(0.7),
          ),
        );

        const assertReplacement = async (conn: Connection): Promise<void> => {
          await queryAll(conn, oldQuery);
          assert.deepStrictEqual(
            (
              await rankRepoSymbolVectorsExact(
                conn,
                repoId,
                JINA_MODEL,
                vector(0.7),
                10,
              )
            ).map((candidate) => candidate.symbolId),
            ["replacement"],
          );
        };
        await withWriteConn(assertReplacement);
        for (const conn of readPool) {
          await assertReplacement(conn);
        }
      } finally {
        rmSync(rootPath, { recursive: true, force: true });
      }
    });


    it(
      "recovers every durable repository-vector failure seam",
      { timeout: 600_000 },
      async () => {
        const allEvents: string[] = [];
        const refreshSeams: readonly RefreshRecoverySeam[] = [
          "marker-commit",
          "table-create",
          "index-drop",
          "vector-delete",
          "vector-merge",
          "index-create",
          "probe",
          "checkpoint",
        ];
        for (const [index, seam] of refreshSeams.entries()) {
          const fixture = await createDurableRecoveryFixture(seam, index);
          await assertRefreshRecovery(fixture);
          assertRecoveryEventOrder(fixture);
          allEvents.push(...fixture.events);
        }

        const deletionSeams: readonly DeletionRecoverySeam[] = [
          "deletion-table-drop",
          "graph-deletion",
        ];
        for (const [index, seam] of deletionSeams.entries()) {
          const fixture = await createDurableRecoveryFixture(
            seam,
            refreshSeams.length + index,
          );
          await assertDeletionRecovery(fixture);
          assertRecoveryEventOrder(fixture);
          allEvents.push(...fixture.events);
        }

        for (const category of [
          "marker:",
          "ddl:",
          "dml:",
          "probe:",
          "checkpoint:",
          "gate:",
          "publication:",
        ]) {
          assert.ok(
            allEvents.some((event) => event.startsWith(category)),
            `recovery matrix did not record ${category}`,
          );
        }
      },
    );




  },
);
