import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { rmSync } from "node:fs";
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
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbedding,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import {
  countCompleteRepoSymbolVectors,
  validateRepoSymbolVectorOwnership,
} from "../../dist/db/ladybug-retrieval-health.js";
import { showIndexesStrict } from "../../dist/retrieval/index-lifecycle.js";

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
  },
);
