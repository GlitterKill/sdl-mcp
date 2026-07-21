import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Connection } from "kuzu";

import { exec, querySingle, withTransaction } from "../../dist/db/ladybug-core.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  deleteGraphIntegrityFileStateInTransaction,
  deleteGraphIntegrityFilelessStateInTransaction,
  deleteGraphIntegrityManifestInTransaction,
  getGraphIntegrityFileState,
  listGraphIntegrityFileStates,
  listGraphIntegrityFilelessStates,
  replaceGraphIntegrityManifestInTransaction,
  upsertGraphIntegrityFileStateInTransaction,
  upsertGraphIntegrityFilelessStateInTransaction,
  upsertRepo,
} from "../../dist/db/ladybug-queries.js";

function fileState(repoId: string, fileId: string, relPath: string) {
  return {
    stateId: JSON.stringify([repoId, fileId]),
    repoId,
    fileId,
    relPath,
    symbolCount: 1,
    digest: `${repoId}:${fileId}`,
    filelessReferencesJson: "[]",
  };
}

function filelessState(repoId: string, symbolId: string, referenceCount = 1) {
  return {
    stateId: JSON.stringify([repoId, symbolId]),
    repoId,
    symbolId,
    canonicalSymbolJson: JSON.stringify([symbolId]),
    referenceCount,
  };
}

describe("graph integrity manifest persistence", () => {
  let root = "";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-manifest-"));
    await initLadybugDb(join(root, "manifest.lbug"));
    await withWriteConn(async (conn) => {
      for (const repoId of ["repo-a", "repo-b"]) {
        await upsertRepo(conn, {
          repoId,
          rootPath: join(root, repoId),
          configJson: "{}",
          createdAt: "2026-07-21T00:00:00.000Z",
        });
      }
    });
  });

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("reads only relationship-owned rows in deterministic repository order", async () => {
    const upsertFile = upsertGraphIntegrityFileStateInTransaction;
    const upsertFileless = upsertGraphIntegrityFilelessStateInTransaction;
    const listFiles = listGraphIntegrityFileStates;
    const listFileless = listGraphIntegrityFilelessStates;

    await withWriteConn(async (conn) => {
      await upsertFile(conn, fileState("repo-a", "f-z", "z.ts"));
      await upsertFile(conn, fileState("repo-a", "f-b", "a.ts"));
      await upsertFile(conn, fileState("repo-a", "f-a", "a.ts"));
      await upsertFile(conn, fileState("repo-b", "f-other", "0.ts"));
      await upsertFileless(conn, filelessState("repo-a", "sym:z", 2));
      await upsertFileless(conn, filelessState("repo-a", "sym:a", 3));
      await upsertFileless(conn, filelessState("repo-b", "sym:other", 4));

      // Orphan rows prove repository reads traverse the manifest relationships.
      await exec(
        conn,
        `MERGE (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.repoId = $repoId, f.fileId = 'orphan-file', f.relPath = '00.ts',
             f.symbolCount = 1, f.digest = 'orphan', f.filelessReferencesJson = '[]'`,
        { stateId: JSON.stringify(["repo-a", "orphan-file"]), repoId: "repo-a" },
      );
      await exec(
        conn,
        `MERGE (s:GraphIntegrityFilelessState {stateId: $stateId})
         SET s.repoId = $repoId, s.symbolId = 'sym:orphan',
             s.canonicalSymbolJson = '[]', s.referenceCount = 1`,
        { stateId: JSON.stringify(["repo-a", "sym:orphan"]), repoId: "repo-a" },
      );

      assert.deepEqual(
        (await listFiles(conn, "repo-a")).map((row) => row.fileId),
        ["f-a", "f-b", "f-z"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-a")).map((row) => row.symbolId),
        ["sym:a", "sym:z"],
      );
      assert.deepEqual(
        (await listFiles(conn, "repo-b")).map((row) => row.fileId),
        ["f-other"],
      );
    });
  });

  it("rejects relationship-owned file rows with inconsistent tuple identities", async () => {
    const listFiles = listGraphIntegrityFileStates;

    await withWriteConn(async (conn) => {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.repoId = $repoId, f.fileId = $fileId, f.relPath = 'corrupt.ts',
             f.symbolCount = 1, f.digest = 'corrupt', f.filelessReferencesJson = '[]'
         MERGE (f)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(r)`,
        {
          stateId: JSON.stringify(["repo-a", "wrong-file"]),
          repoId: "repo-a",
          fileId: "actual-file",
        },
      );

      await assert.rejects(() => listFiles(conn, "repo-a"), {
        name: "DatabaseError",
        message: /file state identity is inconsistent/i,
      });
    });
  });

  it("rejects relationship-owned fileless rows with inconsistent tuple identities", async () => {
    const listFileless = listGraphIntegrityFilelessStates;

    await withWriteConn(async (conn) => {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (s:GraphIntegrityFilelessState {stateId: $stateId})
         SET s.repoId = $repoId, s.symbolId = $symbolId,
             s.canonicalSymbolJson = '[]', s.referenceCount = 1
         MERGE (s)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(r)`,
        {
          stateId: JSON.stringify(["repo-a", "wrong-symbol"]),
          repoId: "repo-a",
          symbolId: "actual-symbol",
        },
      );

      await assert.rejects(() => listFileless(conn, "repo-a"), {
        name: "DatabaseError",
        message: /fileless state identity is inconsistent/i,
      });
    });
  });

  it("rechecks stored identities after primary-key lookup and before delete", async () => {
    const getFile = getGraphIntegrityFileState;
    const deleteFile = deleteGraphIntegrityFileStateInTransaction;
    const deleteFileless = deleteGraphIntegrityFilelessStateInTransaction;

    await withWriteConn(async (conn) => {
      const fileStateId = JSON.stringify(["repo-a", "file"]);
      const symbolStateId = JSON.stringify(["repo-a", "symbol"]);
      await exec(
        conn,
        `MERGE (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.repoId = 'repo-b', f.fileId = 'wrong', f.relPath = 'wrong.ts',
             f.symbolCount = 1, f.digest = 'bad', f.filelessReferencesJson = '[]'`,
        { stateId: fileStateId },
      );
      await exec(
        conn,
        `MERGE (s:GraphIntegrityFilelessState {stateId: $stateId})
         SET s.repoId = 'repo-b', s.symbolId = 'wrong',
             s.canonicalSymbolJson = '[]', s.referenceCount = 1`,
        { stateId: symbolStateId },
      );
      await exec(
        conn,
        `MERGE (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.repoId = $repoId, f.fileId = $fileId, f.relPath = 'orphan.ts',
             f.symbolCount = 1, f.digest = 'orphan', f.filelessReferencesJson = '[]'`,
        {
          stateId: JSON.stringify(["repo-a", "orphan-exact"]),
          repoId: "repo-a",
          fileId: "orphan-exact",
        },
      );

      assert.equal(await getFile(conn, "repo-a", "file"), null);
      assert.equal(await getFile(conn, "repo-a", "orphan-exact"), null);
      await deleteFile(conn, "repo-a", "file");
      await deleteFileless(conn, "repo-a", "symbol");
      assert.equal(
        (await querySingle<{ stateId: string }>(
          conn,
          "MATCH (f:GraphIntegrityFileState {stateId: $stateId}) RETURN f.stateId AS stateId",
          { stateId: fileStateId },
        ))?.stateId,
        fileStateId,
      );
      assert.equal(
        (await querySingle<{ stateId: string }>(
          conn,
          "MATCH (s:GraphIntegrityFilelessState {stateId: $stateId}) RETURN s.stateId AS stateId",
          { stateId: symbolStateId },
        ))?.stateId,
        symbolStateId,
      );
    });
  });

  it("upserts, replaces, rolls back, deletes, and isolates repositories", async () => {
    const upsertFile = upsertGraphIntegrityFileStateInTransaction;
    const upsertFileless = upsertGraphIntegrityFilelessStateInTransaction;
    const listFiles = listGraphIntegrityFileStates;
    const listFileless = listGraphIntegrityFilelessStates;
    const replace = replaceGraphIntegrityManifestInTransaction;
    const deleteManifest = deleteGraphIntegrityManifestInTransaction;

    await withWriteConn(async (conn) => {
      await upsertFile(conn, fileState("repo-a", "old", "old.ts"));
      await upsertFile(conn, {
        ...fileState("repo-a", "old", "old.ts"),
        digest: "updated",
      });
      await upsertFileless(conn, filelessState("repo-a", "sym:old"));
      await upsertFile(conn, fileState("repo-b", "keep", "keep.ts"));
      await upsertFileless(conn, filelessState("repo-b", "sym:keep"));

      await withTransaction(conn, async (tx) => {
        await replace(tx, "repo-a", {
          files: [fileState("repo-a", "new", "new.ts")],
          fileless: [filelessState("repo-a", "sym:new", 5)],
        });
      });
      assert.deepEqual(
        (await listFiles(conn, "repo-a")).map((row) => [row.fileId, row.digest]),
        [["new", "repo-a:new"]],
      );

      await assert.rejects(
        withTransaction(conn, async (tx) => {
          await replace(tx, "repo-a", {
            files: [fileState("repo-a", "rolled-back", "rolled-back.ts")],
            fileless: [filelessState("repo-a", "sym:rolled-back")],
          });
          throw new Error("rollback manifest");
        }),
        /rollback manifest/,
      );
      assert.deepEqual(
        (await listFiles(conn, "repo-a")).map((row) => row.fileId),
        ["new"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-a")).map((row) => row.symbolId),
        ["sym:new"],
      );

      await deleteManifest(conn, "repo-a");
      assert.deepEqual(await listFiles(conn, "repo-a"), []);
      assert.deepEqual(await listFileless(conn, "repo-a"), []);
      assert.deepEqual(
        (await listFiles(conn, "repo-b")).map((row) => row.fileId),
        ["keep"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-b")).map((row) => row.symbolId),
        ["sym:keep"],
      );
    });
  });

  it("rejects duplicate file identities before replacing the manifest", async () => {
    const upsertFile = upsertGraphIntegrityFileStateInTransaction;
    const replace = replaceGraphIntegrityManifestInTransaction;
    const listFiles = listGraphIntegrityFileStates;

    await withWriteConn(async (conn) => {
      await upsertFile(conn, fileState("repo-a", "old", "old.ts"));
      const duplicate = fileState("repo-a", "duplicate", "duplicate.ts");

      await assert.rejects(
        () =>
          replace(conn, "repo-a", {
            files: [duplicate, { ...duplicate, digest: "contradictory" }],
            fileless: [],
          }),
        { name: "DatabaseError", message: /duplicate.*file/i },
      );
      assert.deepEqual(
        (await listFiles(conn, "repo-a")).map((row) => row.fileId),
        ["old"],
      );
    });
  });

  it("rejects duplicate fileless identities before replacing the manifest", async () => {
    const upsertFileless = upsertGraphIntegrityFilelessStateInTransaction;
    const replace = replaceGraphIntegrityManifestInTransaction;
    const listFileless = listGraphIntegrityFilelessStates;

    await withWriteConn(async (conn) => {
      await upsertFileless(conn, filelessState("repo-a", "sym:old"));
      const duplicate = filelessState("repo-a", "sym:duplicate");

      await assert.rejects(
        () =>
          replace(conn, "repo-a", {
            files: [],
            fileless: [
              duplicate,
              { ...duplicate, canonicalSymbolJson: '["contradictory"]' },
            ],
          }),
        { name: "DatabaseError", message: /duplicate.*fileless/i },
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-a")).map((row) => row.symbolId),
        ["sym:old"],
      );
    });
  });

  it("chunks 257-row replacements at 256 and persists every row", async () => {
    const replace = replaceGraphIntegrityManifestInTransaction;
    const listFiles = listGraphIntegrityFileStates;
    const listFileless = listGraphIntegrityFilelessStates;
    const files = Array.from({ length: 257 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return fileState("repo-a", `file-${suffix}`, `src/${suffix}.ts`);
    });
    const fileless = Array.from({ length: 257 }, (_, index) =>
      filelessState("repo-a", `sym:${String(index).padStart(3, "0")}`),
    );
    const batchSizes: number[] = [];
    const fakeConnection = {
      prepare: async (statement: string) => ({ statement }),
      execute: async (
        _prepared: unknown,
        params: Record<string, unknown> = {},
      ) => {
        if (Array.isArray(params.rows)) batchSizes.push(params.rows.length);
        return { close() {} };
      },
    } as unknown as Connection;

    await replace(fakeConnection, "repo-a", { files, fileless });
    assert.deepEqual(batchSizes, [256, 1, 256, 1]);

    await withWriteConn(async (conn) => {
      await withTransaction(conn, (tx) =>
        replace(tx, "repo-a", { files, fileless }),
      );
      assert.equal((await listFiles(conn, "repo-a")).length, 257);
      assert.equal((await listFileless(conn, "repo-a")).length, 257);
    });
  });

  it("leaves tuple-valid file and fileless orphans untouched on exact delete", async () => {
    const deleteFile = deleteGraphIntegrityFileStateInTransaction;
    const deleteFileless = deleteGraphIntegrityFilelessStateInTransaction;

    await withWriteConn(async (conn) => {
      const file = fileState("repo-a", "orphan", "orphan.ts");
      const fileless = filelessState("repo-a", "sym:orphan");
      await exec(
        conn,
        `MERGE (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.repoId = $repoId, f.fileId = $fileId, f.relPath = $relPath,
             f.symbolCount = $symbolCount, f.digest = $digest,
             f.filelessReferencesJson = $filelessReferencesJson`,
        file,
      );
      await exec(
        conn,
        `MERGE (s:GraphIntegrityFilelessState {stateId: $stateId})
         SET s.repoId = $repoId, s.symbolId = $symbolId,
             s.canonicalSymbolJson = $canonicalSymbolJson,
             s.referenceCount = $referenceCount`,
        fileless,
      );

      await deleteFile(conn, "repo-a", "orphan");
      await deleteFileless(conn, "repo-a", "sym:orphan");
      assert.equal(
        Number(
          await querySingle<{ count: unknown }>(
            conn,
            "MATCH (f:GraphIntegrityFileState {stateId: $stateId}) RETURN count(f) AS count",
            { stateId: file.stateId },
          ).then((row) => row?.count ?? 0),
        ),
        1,
      );
      assert.equal(
        Number(
          await querySingle<{ count: unknown }>(
            conn,
            "MATCH (s:GraphIntegrityFilelessState {stateId: $stateId}) RETURN count(s) AS count",
            { stateId: fileless.stateId },
          ).then((row) => row?.count ?? 0),
        ),
        1,
      );
    });
  });
});
