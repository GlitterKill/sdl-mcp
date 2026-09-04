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
  exec,
  execCheckpoint,
  execDdl,
  queryAll,
  queryStoredProcAll,
} from "../../dist/db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";
import { createSchema } from "../../dist/db/ladybug-schema.js";
import { withWindowsFtsRuntime } from "../../dist/db/ladybug-windows-fts-runtime.js";
import {
  deleteRepoSymbolVectorEmbeddingsBySymbolIds,
  ensureRepoSymbolVectorTable,
  getRepoSymbolVectorEmbedding,
  getRepoSymbolVectorEmbeddings,
  getRepoSymbolVectorProbe,
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbedding,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { rankRepoSymbolVectorsExact } from "../../dist/db/ladybug-retrieval.js";
import {
  handleRepoRegister,
  handleRepoUnregister,
} from "../../dist/mcp/tools/repo.js";
import {
  countCompleteRepoSymbolVectors,
  validateRepoSymbolVectorOwnership,
} from "../../dist/db/ladybug-retrieval-health.js";
import {
  clearRepositorySymbolVectorDiagnostics,
  listRepositorySymbolVectorDiagnostics,
} from "../../dist/retrieval/health.js";
import {
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../dist/retrieval/index-lifecycle.js";
import {
  planRepositorySymbolVectorReconciliation,
  refreshSymbolEmbeddings,
  resolveRepositorySymbolVectorIndexMode,
  type EmbeddingProvider,
} from "../../dist/indexer/embeddings.js";

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




  },
);
