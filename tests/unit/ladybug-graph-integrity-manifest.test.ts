import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { exec, querySingle, withTransaction } from "../../dist/db/ladybug-core.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

const manifestDb = await import(
  "../../dist/db/ladybug-queries.js"
).catch(() => null);

type AsyncFn = (...args: any[]) => Promise<any>;

function requiredFunction(name: string): AsyncFn {
  const candidate = manifestDb?.[name as keyof typeof manifestDb];
  assert.equal(typeof candidate, "function", `${name} must be implemented`);
  return candidate as AsyncFn;
}

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
        await ladybugDb.upsertRepo(conn, {
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
    const upsertFile = requiredFunction(
      "upsertGraphIntegrityFileStateInTransaction",
    );
    const upsertFileless = requiredFunction(
      "upsertGraphIntegrityFilelessStateInTransaction",
    );
    const listFiles = requiredFunction("listGraphIntegrityFileStates");
    const listFileless = requiredFunction("listGraphIntegrityFilelessStates");

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
        (await listFiles(conn, "repo-a")).map((row: any) => row.fileId),
        ["f-a", "f-b", "f-z"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-a")).map((row: any) => row.symbolId),
        ["sym:a", "sym:z"],
      );
      assert.deepEqual(
        (await listFiles(conn, "repo-b")).map((row: any) => row.fileId),
        ["f-other"],
      );
    });
  });

  it("rejects relationship-owned file rows with inconsistent tuple identities", async () => {
    const listFiles = requiredFunction("listGraphIntegrityFileStates");

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
    const listFileless = requiredFunction("listGraphIntegrityFilelessStates");

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
    const getFile = requiredFunction("getGraphIntegrityFileState");
    const deleteFile = requiredFunction(
      "deleteGraphIntegrityFileStateInTransaction",
    );
    const deleteFileless = requiredFunction(
      "deleteGraphIntegrityFilelessStateInTransaction",
    );

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
    const upsertFile = requiredFunction(
      "upsertGraphIntegrityFileStateInTransaction",
    );
    const upsertFileless = requiredFunction(
      "upsertGraphIntegrityFilelessStateInTransaction",
    );
    const listFiles = requiredFunction("listGraphIntegrityFileStates");
    const listFileless = requiredFunction("listGraphIntegrityFilelessStates");
    const replace = requiredFunction(
      "replaceGraphIntegrityManifestInTransaction",
    );
    const deleteManifest = requiredFunction(
      "deleteGraphIntegrityManifestInTransaction",
    );

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
        (await listFiles(conn, "repo-a")).map((row: any) => [row.fileId, row.digest]),
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
        (await listFiles(conn, "repo-a")).map((row: any) => row.fileId),
        ["new"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-a")).map((row: any) => row.symbolId),
        ["sym:new"],
      );

      await deleteManifest(conn, "repo-a");
      assert.deepEqual(await listFiles(conn, "repo-a"), []);
      assert.deepEqual(await listFileless(conn, "repo-a"), []);
      assert.deepEqual(
        (await listFiles(conn, "repo-b")).map((row: any) => row.fileId),
        ["keep"],
      );
      assert.deepEqual(
        (await listFileless(conn, "repo-b")).map((row: any) => row.symbolId),
        ["sym:keep"],
      );
    });
  });
});
