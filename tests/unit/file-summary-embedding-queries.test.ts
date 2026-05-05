import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEST_DB_PATH = join(
  tmpdir(),
  `.lbug-file-summary-emb-${process.pid}.lbug`,
);

async function resetDb(): Promise<void> {
  const { closeLadybugDb, initLadybugDb } =
    await import("../../dist/db/ladybug.js");
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

describe("FileSummary embedding persistence", () => {
  beforeEach(resetDb);

  afterEach(async () => {
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("batch-writes text metadata and numeric vector arrays", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const conn = await getLadybugConn();

    await queries.upsertRepo(conn, {
      repoId: "fs-emb-repo",
      rootPath: "C:/tmp/fs-emb-repo",
      configJson: "{}",
      createdAt: "2026-05-05T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId: "file-1",
      repoId: "fs-emb-repo",
      relPath: "src/example.ts",
      contentHash: "hash",
      language: "typescript",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertFileSummaryBatch(conn, [
      {
        fileId: "file-1",
        repoId: "fs-emb-repo",
        summary: "File: src/example.ts",
        searchText: "file: src/example.ts",
        updatedAt: "2026-05-05T00:00:00Z",
      },
    ]);

    await queries.setFileSummaryEmbeddingBatch(
      conn,
      "jina-embeddings-v2-base-code",
      [
        {
          fileId: "file-1",
          vector: "encoded-vector",
          cardHash: "hash-1",
          vectorArray: new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
        },
      ],
    );

    const result = await conn.query(
      `MATCH (fs:FileSummary {fileId: 'file-1'})
       RETURN fs.embeddingJinaCode AS vector,
              fs.embeddingJinaCodeCardHash AS cardHash,
              fs.embeddingJinaCodeUpdatedAt AS updatedAt,
              fs.embeddingJinaCodeVec AS vectorArray`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      vector: unknown;
      cardHash: unknown;
      updatedAt: unknown;
      vectorArray: unknown;
    }>;
    qr.close();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].vector, "encoded-vector");
    assert.equal(rows[0].cardHash, "hash-1");
    assert.equal(typeof rows[0].updatedAt, "string");
    assert.ok(Array.isArray(rows[0].vectorArray));
    assert.equal((rows[0].vectorArray as number[]).length, 768);
  });
});
