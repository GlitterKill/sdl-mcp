import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { computeBlastRadius } from "../../dist/delta/blastRadius.js";
import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../dist/db/kuzu.js";
import * as kuzuDb from "../../dist/db/kuzu-queries.js";

const REPO_ID = "test-process-blast-radius-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("process-aware blast radius", () => {
  const graphDbPath = join(__dirname, ".kuzu-process-blast-radius-test-db");

  const changed = `${REPO_ID}-changed`;
  const caller = `${REPO_ID}-caller`;
  const mid = `${REPO_ID}-mid`;
  const exit = `${REPO_ID}-exit`;
  const later = `${REPO_ID}-later`;

  const otherChanged = `${REPO_ID}-other-changed`;
  const otherCaller = `${REPO_ID}-other-caller`;

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
      rootPath: "/tmp/test-process-blast-radius",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-process-blast-radius",
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
      relPath: "src/app.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
      directory: "src",
    });

    for (const [symbolId, name] of [
      [changed, "changed"],
      [caller, "caller"],
      [mid, "mid"],
      [exit, "exit"],
      [later, "later"],
      [otherChanged, "otherChanged"],
      [otherCaller, "otherCaller"],
    ] as const) {
      await kuzuDb.upsertSymbol(conn, {
        symbolId,
        repoId: REPO_ID,
        fileId: "file-1",
        kind: "function",
        name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 1,
        astFingerprint: `fp-${symbolId}`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    // Graph dependents (incoming to changed)
    await kuzuDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: caller,
      toSymbolId: changed,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: "static",
      createdAt: now,
    });

    // Create an overlap: mid is also an incoming dependent of changed
    await kuzuDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: mid,
      toSymbolId: changed,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: "static",
      createdAt: now,
    });

    // A separate graph-only change with no process data
    await kuzuDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: otherCaller,
      toSymbolId: otherChanged,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: "static",
      createdAt: now,
    });

    // Seed a process that includes changed -> mid -> exit -> later
    const processId = `${REPO_ID}-process-1`;
    await kuzuDb.upsertProcess(conn, {
      processId,
      repoId: REPO_ID,
      entrySymbolId: changed,
      label: "process 1",
      depth: 3,
      versionId: null,
      createdAt: now,
    });

    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: changed,
      stepOrder: 0,
      role: "entry",
    });
    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: mid,
      stepOrder: 1,
      role: "intermediate",
    });
    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: exit,
      stepOrder: 2,
      role: "intermediate",
    });
    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: later,
      stepOrder: 3,
      role: "exit",
    });
  });

  after(async () => {
    await closeKuzuDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("includes downstream process steps with signal=process and ranks by step distance", async () => {
    const conn = await getKuzuConn();
    const result = await computeBlastRadius(conn, [changed], {
      repoId: REPO_ID,
      maxHops: 1,
      maxResults: 50,
    });

    const byId = new Map(result.map((item) => [item.symbolId, item] as const));

    assert.strictEqual(byId.get(caller)?.signal, "directDependent");

    // Dedup: graph (directDependent) wins over process for the same symbol
    assert.strictEqual(byId.get(mid)?.signal, "directDependent");

    const exitItem = byId.get(exit);
    const laterItem = byId.get(later);

    assert.ok(exitItem, "Expected downstream exit step in blast radius");
    assert.ok(laterItem, "Expected downstream later step in blast radius");
    assert.strictEqual(exitItem.signal, "process");
    assert.strictEqual(laterItem.signal, "process");

    assert.ok(exitItem.distance < laterItem.distance);
    assert.ok(exitItem.rank > laterItem.rank);
  });

  it("degrades gracefully when no process data exists", async () => {
    const conn = await getKuzuConn();
    const result = await computeBlastRadius(conn, [otherChanged], {
      repoId: REPO_ID,
      maxHops: 1,
      maxResults: 50,
    });

    assert.ok(result.some((i) => i.symbolId === otherCaller));
    assert.ok(result.every((i) => i.signal !== "process"));
  });
});

