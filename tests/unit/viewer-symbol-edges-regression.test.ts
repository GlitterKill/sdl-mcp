import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("viewer symbol edges omit boundary edges without crashing on an empty kind filter", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-viewer-symbol-edges-"));
  const graphDbPath = join(tempDir, "graph.lbug");
  const script = `
    import { writeSync } from "node:fs";
    import { initLadybugDb, getLadybugConn } from "./dist/db/ladybug.js";
    import * as ladybugDb from "./dist/db/ladybug-queries.js";
    import { getSymbolEdges } from "./dist/viewer/service.js";

    const graphDbPath = process.argv[1];
    const repoId = "viewer-symbol-edges";
    const clusterId = "cluster-a";
    const now = "2026-07-11T00:00:00.000Z";

    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "/viewer-symbol-edges",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "src/test.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });
    for (const symbolId of ["a", "b", "c"]) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId,
        repoId,
        fileId: "file-1",
        kind: "function",
        name: symbolId,
        exported: false,
        visibility: null,
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 1,
        astFingerprint: "fp-" + symbolId,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }
    for (const cluster of [
      { clusterId, label: "cluster a", symbolCount: 2 },
      { clusterId: "cluster-b", label: "cluster b", symbolCount: 1 },
    ]) {
      await ladybugDb.upsertCluster(conn, {
        ...cluster,
        repoId,
        cohesionScore: 1,
        versionId: null,
        createdAt: now,
      });
    }
    for (const [symbolId, memberClusterId] of [
      ["a", clusterId],
      ["b", clusterId],
      ["c", "cluster-b"],
    ]) {
      await ladybugDb.upsertClusterMember(conn, {
        symbolId,
        clusterId: memberClusterId,
        membershipScore: 1,
      });
    }
    for (const [fromSymbolId, toSymbolId, edgeType] of [
      ["a", "b", "call"],
      ["a", "c", "import"],
      ["c", "b", "config"],
    ]) {
      await ladybugDb.insertEdge(conn, {
        repoId,
        fromSymbolId,
        toSymbolId,
        edgeType,
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: null,
        createdAt: now,
      });
    }

    const unfiltered = await getSymbolEdges(conn, repoId, clusterId, [], 0, 5000);
    const calls = await getSymbolEdges(conn, repoId, clusterId, ["call"], 0, 5000);
    writeSync(1, JSON.stringify({ unfiltered, calls }));
    process.exit(0);
  `;

  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, graphDbPath],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );

    assert.equal(
      result.status,
      0,
      `Symbol-edge child process crashed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nExit code: ${result.status}`,
    );
    const expected = {
      edges: [
        { from: "a", to: "b", kind: "call", confidence: 1, resolution: "exact" },
      ],
    };
    assert.deepEqual(JSON.parse(result.stdout), {
      unfiltered: expected,
      calls: expected,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
