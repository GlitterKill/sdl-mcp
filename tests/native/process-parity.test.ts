import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../dist/db/kuzu.js";
import * as kuzuDb from "../../dist/db/kuzu-queries.js";
import { traceProcessesTS } from "../../dist/graph/process.js";
import {
  isRustEngineAvailable,
  traceProcessesRust,
} from "../../src/indexer/rustIndexer.js";

const REPO_ID = "test-native-process-parity-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("native process parity", () => {
  const graphDbPath = join(__dirname, ".kuzu-native-process-parity-test-db");

  let entryId: string;
  let midId: string;
  let exitId: string;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeKuzuDb();
    await initKuzuDb(graphDbPath);
    const conn = await getKuzuConn();

    const now = new Date().toISOString();

    await kuzuDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-native-process-parity",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-native-process-parity",
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

    await kuzuDb.upsertFile(conn, {
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

    await kuzuDb.upsertSymbol(conn, {
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

    await kuzuDb.upsertSymbol(conn, {
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

    await kuzuDb.upsertSymbol(conn, {
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

    await kuzuDb.insertEdge(conn, {
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

    await kuzuDb.insertEdge(conn, {
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
    await closeKuzuDb();
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("matches TypeScript fallback output when native addon is available", async () => {
    if (!isRustEngineAvailable()) return;

    const ts = await traceProcessesTS(REPO_ID, ["entry"], { maxDepth: 20 });
    const rust = traceProcessesRust(
      [
        { symbolId: entryId, name: "entry" },
        { symbolId: midId, name: "mid" },
        { symbolId: exitId, name: "exit" },
      ],
      [
        { callerId: entryId, calleeId: midId },
        { callerId: midId, calleeId: exitId },
      ],
      20,
      ["entry"],
    );

    assert.ok(rust, "Expected native output");
    assert.deepStrictEqual(rust, ts);
  });
});

