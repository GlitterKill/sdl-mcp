import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Migration {
  version: number;
  description: string;
  up(conn: import("kuzu").Connection): Promise<void>;
}

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let getSchemaVersion: (
  conn: import("kuzu").Connection,
) => Promise<number | null>;
let exec: typeof import("../../dist/db/ladybug-core.js").exec;
let queryAll: typeof import("../../dist/db/ladybug-core.js").queryAll;
let migrations: Migration[];
let LADYBUG_SCHEMA_VERSION: number;
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const coreMod = await import("../../dist/db/ladybug-core.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migrationMod = await import("../../dist/db/migrations/index.js");
  initLadybugDb = ladybugMod.initLadybugDb;
  closeLadybugDb = ladybugMod.closeLadybugDb;
  getLadybugConn = ladybugMod.getLadybugConn;
  getSchemaVersion = schemaMod.getSchemaVersion;
  exec = coreMod.exec;
  queryAll = coreMod.queryAll;
  migrations = migrationMod.migrations;
  LADYBUG_SCHEMA_VERSION = migrationMod.LADYBUG_SCHEMA_VERSION;
  ladybugAvailable = true;
} catch {
  // Module not built or LadybugDB unavailable.
}

describe("migration: fresh database", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-fresh-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("creates schema version 26 with symbol vector embeddings directly and idempotently", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "fresh.lbug");
    const original = migrations[0];
    migrations[0] = {
      ...original,
      async up() {
        throw new Error("numbered migration must not run for a fresh database");
      },
    };

    try {
      await initLadybugDb(dbPath);
      const conn = await getLadybugConn();

      assert.equal(LADYBUG_SCHEMA_VERSION, 26);
      assert.equal(await getSchemaVersion(conn), 26);

      await exec(
        conn,
        `CREATE (e:SymbolVectorEmbedding {
          embeddingId: $embeddingId,
          repoId: $repoId,
          symbolId: $symbolId,
          model: $model,
          embeddingVector: $embeddingVector,
          cardHash: $cardHash,
          updatedAt: $updatedAt,
          embeddingJinaCodeVec: $embeddingJinaCodeVec,
          embeddingNomicVec: $embeddingNomicVec
        })`,
        {
          embeddingId: "jina-embeddings-v2-base-code:fresh-symbol",
          repoId: "fresh-repo",
          symbolId: "fresh-symbol",
          model: "jina-embeddings-v2-base-code",
          embeddingVector: "[0.25]",
          cardHash: "fresh-hash",
          updatedAt: "2026-08-26T00:00:00.000Z",
          embeddingJinaCodeVec: Array(768).fill(0.25),
          embeddingNomicVec: null,
        },
      );
      const vectorRows = await queryAll<{
        embeddingId: string;
        repoId: string;
        symbolId: string;
        model: string;
        embeddingVector: string;
        cardHash: string;
        updatedAt: string;
        jinaSize: number;
        embeddingNomicVec: number[] | null;
      }>(
        conn,
        `MATCH (e:SymbolVectorEmbedding {embeddingId: $embeddingId})
         RETURN e.embeddingId AS embeddingId,
                e.repoId AS repoId,
                e.symbolId AS symbolId,
                e.model AS model,
                e.embeddingVector AS embeddingVector,
                e.cardHash AS cardHash,
                e.updatedAt AS updatedAt,
                size(e.embeddingJinaCodeVec) AS jinaSize,
                e.embeddingNomicVec AS embeddingNomicVec`,
        { embeddingId: "jina-embeddings-v2-base-code:fresh-symbol" },
      );
      assert.deepEqual(vectorRows, [
        {
          embeddingId: "jina-embeddings-v2-base-code:fresh-symbol",
          repoId: "fresh-repo",
          symbolId: "fresh-symbol",
          model: "jina-embeddings-v2-base-code",
          embeddingVector: "[0.25]",
          cardHash: "fresh-hash",
          updatedAt: "2026-08-26T00:00:00.000Z",
          jinaSize: 768,
          embeddingNomicVec: null,
        },
      ]);

      const m025 = await import(
        "../../dist/db/migrations/m025-add-parser-provenance.js"
      );
      await m025.up(conn);
      await m025.up(conn);
      await exec(
        conn,
        `CREATE (r:Repo {
           repoId: 'parser-repo',
           rootPath: '',
           configJson: '{}',
           createdAt: '2026-08-07T00:00:00.000Z'
         })
         CREATE (f:FileParserState {
           stateId: '["parser-repo","file-1"]',
           repoId: 'parser-repo',
           fileId: 'file-1',
           engine: 'typescript',
           engineContract: 'typescript:1',
           adapterKey: 'builtin:typescript:typescript:1',
           language: 'typescript'
         })
         CREATE (s:RepoParserState {
           repoId: 'parser-repo',
           coverageState: 'complete',
           graphVersionId: 'version-1',
           graphRevision: 1,
           coverageDigest: 'digest'
         })
         CREATE (f)-[:FILE_PARSER_STATE_IN_REPO]->(r)
         CREATE (s)-[:REPO_PARSER_STATE_IN_REPO]->(r)`,
      );
      const parserObjects = await queryAll<{
        fileStates: unknown;
        repoStates: unknown;
        fileLinks: unknown;
        repoLinks: unknown;
      }>(
        conn,
        `MATCH (f:FileParserState)-[fr:FILE_PARSER_STATE_IN_REPO]->(:Repo {repoId: 'parser-repo'})
         MATCH (s:RepoParserState)-[sr:REPO_PARSER_STATE_IN_REPO]->(:Repo {repoId: 'parser-repo'})
         RETURN count(DISTINCT f) AS fileStates,
                count(DISTINCT s) AS repoStates,
                count(DISTINCT fr) AS fileLinks,
                count(DISTINCT sr) AS repoLinks`,
      );
      assert.deepEqual(
        parserObjects.map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, Number(value)]),
        )),
        [{ fileStates: 1, repoStates: 1, fileLinks: 1, repoLinks: 1 }],
      );

      await exec(
        conn,
        "CREATE (d:DerivedState {repoId: $repoId})",
        { repoId: "fresh-repo" },
      );
      const integrityRows = await queryAll<{
        graphIntegrityState: string;
        graphIntegrityVersionId: string | null;
        graphIntegrityDigest: string | null;
        graphIntegrityError: string | null;
        graphIntegrityRevision: bigint | null;
        graphIntegrityVerifiedRevision: bigint | null;
        graphIntegrityFilelessPruningSupported: boolean | null;
        graphIntegrityManifestEstablished: boolean;
      }>(
        conn,
        `MATCH (d:DerivedState {repoId: $repoId})
         RETURN d.graphIntegrityState AS graphIntegrityState,
                d.graphIntegrityVersionId AS graphIntegrityVersionId,
                d.graphIntegrityDigest AS graphIntegrityDigest,
                d.graphIntegrityError AS graphIntegrityError,
                 d.graphIntegrityRevision AS graphIntegrityRevision,
                 d.graphIntegrityVerifiedRevision AS graphIntegrityVerifiedRevision,
                 d.graphIntegrityFilelessPruningSupported AS graphIntegrityFilelessPruningSupported,
                 d.graphIntegrityManifestEstablished AS graphIntegrityManifestEstablished`,
        { repoId: "fresh-repo" },
      );
      assert.deepEqual(integrityRows, [
        {
          graphIntegrityState: "unknown",
          graphIntegrityVersionId: null,
          graphIntegrityDigest: null,
          graphIntegrityError: null,
          graphIntegrityRevision: null,
          graphIntegrityVerifiedRevision: null,
          graphIntegrityFilelessPruningSupported: null,
          graphIntegrityManifestEstablished: false,
        },
      ]);

      await exec(
        conn,
        `CREATE (s:Symbol {
          symbolId: $symbolId,
          embeddingMiniLM: $embeddingMiniLM,
          embeddingMiniLMCardHash: $embeddingMiniLMCardHash,
          embeddingMiniLMUpdatedAt: $embeddingMiniLMUpdatedAt,
          embeddingNomic: $embeddingNomic,
          embeddingNomicCardHash: $embeddingNomicCardHash,
          embeddingNomicUpdatedAt: $embeddingNomicUpdatedAt
        })`,
        {
          symbolId: "fresh-symbol",
          embeddingMiniLM: "[0]",
          embeddingMiniLMCardHash: "mini-hash",
          embeddingMiniLMUpdatedAt: "mini-updated",
          embeddingNomic: "[1]",
          embeddingNomicCardHash: "nomic-hash",
          embeddingNomicUpdatedAt: "nomic-updated",
        },
      );

      const symbols = await queryAll<{
        symbolId: string;
        embeddingMiniLM: string;
        embeddingMiniLMCardHash: string;
        embeddingMiniLMUpdatedAt: string;
        embeddingNomic: string;
        embeddingNomicCardHash: string;
        embeddingNomicUpdatedAt: string;
      }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         RETURN s.symbolId AS symbolId,
                s.embeddingMiniLM AS embeddingMiniLM,
                s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
                s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
                s.embeddingNomic AS embeddingNomic,
                s.embeddingNomicCardHash AS embeddingNomicCardHash,
                s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt`,
        { symbolId: "fresh-symbol" },
      );
      assert.deepEqual(symbols, [
        {
          symbolId: "fresh-symbol",
          embeddingMiniLM: "[0]",
          embeddingMiniLMCardHash: "mini-hash",
          embeddingMiniLMUpdatedAt: "mini-updated",
          embeddingNomic: "[1]",
          embeddingNomicCardHash: "nomic-hash",
          embeddingNomicUpdatedAt: "nomic-updated",
        },
      ]);

      assert.deepEqual(
        await queryAll(
          conn,
          "MATCH (se:SymbolEmbedding) RETURN se.symbolId AS symbolId",
        ),
        [],
      );
    } finally {
      migrations[0] = original;
    }
  });
});
