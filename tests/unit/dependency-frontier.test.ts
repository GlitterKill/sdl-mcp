import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { buildDependencyFrontier } from "../../dist/live-index/dependency-frontier.js";

describe("buildDependencyFrontier", () => {
  const dbPath = join(tmpdir(), ".lbug-dependency-frontier-test-db.lbug");
  const repoId = "dependency-frontier-repo";

  before(async () => {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
    await closeLadybugDb();
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/repo",
      configJson: JSON.stringify({ repoId, rootPath: "C:/repo", languages: ["ts"] }),
      createdAt: now,
    });

    for (const file of [
      { fileId: "file-a", relPath: "src/a.ts" },
      { fileId: "file-b", relPath: "src/b.ts" },
      { fileId: "file-c", relPath: "src/c.ts" },
    ]) {
      await ladybugDb.upsertFile(conn, {
        fileId: file.fileId,
        repoId,
        relPath: file.relPath,
        contentHash: `${file.fileId}-hash`,
        language: "ts",
        byteSize: 10,
        lastIndexedAt: now,
      });
    }

    for (const symbol of [
      { symbolId: "sym-a", fileId: "file-a", name: "alpha" },
      { symbolId: "sym-b", fileId: "file-b", name: "beta" },
      { symbolId: "sym-c", fileId: "file-c", name: "gamma" },
    ]) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId,
        fileId: symbol.fileId,
        kind: "function",
        name: symbol.name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 0,
        astFingerprint: `${symbol.symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    await ladybugDb.insertEdges(conn, [
      {
        repoId,
        fromSymbolId: "sym-b",
        toSymbolId: "sym-a",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: now,
      },
      {
        repoId,
        fromSymbolId: "sym-a",
        toSymbolId: "sym-c",
        edgeType: "import",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: now,
      },
    ]);
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("captures inbound dependents and imported target files", async () => {
    const conn = await getLadybugConn();
    const frontier = await buildDependencyFrontier({
      conn,
      touchedSymbolIds: ["sym-a"],
      outgoingEdges: [{ toSymbolId: "sym-c", edgeType: "import" }],
      currentFilePath: "src/a.ts",
    });

    assert.deepStrictEqual(frontier.touchedSymbolIds, ["sym-a"]);
    assert.deepStrictEqual(frontier.dependentSymbolIds, ["sym-b"]);
    assert.deepStrictEqual(frontier.dependentFilePaths, ["src/b.ts"]);
    assert.deepStrictEqual(frontier.importedFilePaths, ["src/c.ts"]);
    assert.deepStrictEqual(frontier.invalidations, [
      "metrics",
      "clusters",
      "processes",
    ]);
  });
});
