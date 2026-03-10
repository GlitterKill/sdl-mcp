import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { traceProcessesTS } from "../../dist/graph/process.js";

const REPO_ID = "test-ts-process-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("traceProcessesTS", () => {
  const graphDbPath = join(__dirname, ".lbug-ts-process-test-db");

  let entryId: string;
  let midId: string;
  let exitId: string;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-ts-process",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-ts-process",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: REPO_ID,
      relPath: "src/test.ts",
      contentHash: "hash-test",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    entryId = `entry-${REPO_ID}`;
    midId = `mid-${REPO_ID}`;
    exitId = `exit-${REPO_ID}`;

    await ladybugDb.upsertSymbol(conn, {
      symbolId: entryId,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "entry",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: `fp-${entryId}`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: midId,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "mid",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: `fp-${midId}`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: exitId,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "exit",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: `fp-${exitId}`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: entryId,
      toSymbolId: midId,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: null,
      createdAt: now,
    });

    await ladybugDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: midId,
      toSymbolId: exitId,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: null,
      createdAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("traces a simple call chain deterministically", async () => {
    const r1 = await traceProcessesTS(REPO_ID, ["entry"], { maxDepth: 20 });
    const r2 = await traceProcessesTS(REPO_ID, ["entry"], { maxDepth: 20 });

    assert.strictEqual(r1.length, 1);
    assert.deepStrictEqual(r1, r2);

    const proc = r1[0]!;
    assert.strictEqual(proc.entrySymbolId, entryId);
    assert.strictEqual(proc.depth, 2);
    assert.deepStrictEqual(
      proc.steps.map((s) => s.symbolId),
      [entryId, midId, exitId],
    );
    assert.deepStrictEqual(
      proc.steps.map((s) => s.stepOrder),
      [0, 1, 2],
    );
  });
});

