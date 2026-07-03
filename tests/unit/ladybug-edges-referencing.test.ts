import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as queries from "../../dist/db/ladybug-queries.js";
import type { SymbolRow } from "../../dist/db/ladybug-symbols.js";

const repoId = "referencing-symbols-test";
const now = "2026-07-03T00:00:00Z";

let testRoot: string;

function symbol(overrides: Partial<SymbolRow> & Pick<SymbolRow, "symbolId" | "fileId" | "name">): SymbolRow {
  return {
    symbolId: overrides.symbolId,
    repoId,
    fileId: overrides.fileId,
    kind: overrides.kind ?? "function",
    name: overrides.name,
    exported: overrides.exported ?? true,
    visibility: overrides.visibility ?? "public",
    language: overrides.language ?? "typescript",
    rangeStartLine: overrides.rangeStartLine ?? 1,
    rangeStartCol: overrides.rangeStartCol ?? 0,
    rangeEndLine: overrides.rangeEndLine ?? 3,
    rangeEndCol: overrides.rangeEndCol ?? 1,
    astFingerprint: overrides.astFingerprint ?? `ast-${overrides.symbolId}`,
    signatureJson: overrides.signatureJson ?? null,
    summary: overrides.summary ?? null,
    invariantsJson: overrides.invariantsJson ?? null,
    sideEffectsJson: overrides.sideEffectsJson ?? null,
    roleTagsJson: overrides.roleTagsJson ?? null,
    searchText: overrides.searchText ?? overrides.name,
    updatedAt: overrides.updatedAt ?? now,
  };
}

async function seedGraph(): Promise<void> {
  const conn = await getLadybugConn();
  await queries.upsertRepo(conn, {
    repoId,
    rootPath: testRoot,
    configJson: "{}",
    createdAt: now,
  });
  for (const [fileId, relPath] of [
    ["file-a", "src/a.ts"],
    ["file-b", "src/b.ts"],
    ["file-c", "src/c.ts"],
  ] as const) {
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath,
      contentHash: `hash-${fileId}`,
      language: "typescript",
      byteSize: 10,
      lastIndexedAt: now,
    });
  }
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-foo", fileId: "file-a", name: "foo", rangeStartLine: 10, rangeEndLine: 12 }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-b", fileId: "file-b", name: "callerB", rangeStartLine: 20, rangeEndLine: 24 }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-c", fileId: "file-c", name: "callerC", rangeStartLine: 30, rangeEndLine: 34 }));
  await queries.insertEdges(conn, [
    {
      repoId,
      fromSymbolId: "sym-b",
      toSymbolId: "sym-foo",
      edgeType: "calls",
      weight: 1,
      confidence: 0.95,
      resolution: "exact",
      resolverId: "unit",
      resolutionPhase: "test",
      provenance: "unit",
    },
    {
      repoId,
      fromSymbolId: "sym-c",
      toSymbolId: "sym-foo",
      edgeType: "calls",
      weight: 1,
      confidence: 0.6,
      resolution: "heuristic",
      resolverId: "unit",
      resolutionPhase: "test",
      provenance: "unit",
    },
  ]);
}

describe("getReferencingSymbolsForTarget", { concurrency: false }, () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-referencing-symbols-"));
    await initLadybugDb(join(testRoot, "graph"));
    await seedGraph();
  });

  afterEach(async () => {
    await closeLadybugDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("returns incoming dependency symbols with file paths and confidence filtering", async () => {
    const conn = await getLadybugConn();
    const all = await queries.getReferencingSymbolsForTarget(conn, repoId, "sym-foo", 0.5);

    assert.deepEqual(
      all.map((row) => ({
        symbolId: row.symbolId,
        name: row.name,
        kind: row.kind,
        relPath: row.relPath,
        rangeStartLine: row.rangeStartLine,
        rangeEndLine: row.rangeEndLine,
        confidence: row.confidence,
        resolution: row.resolution,
        edgeType: row.edgeType,
      })),
      [
        {
          symbolId: "sym-b",
          name: "callerB",
          kind: "function",
          relPath: "src/b.ts",
          rangeStartLine: 20,
          rangeEndLine: 24,
          confidence: 0.95,
          resolution: "exact",
          edgeType: "calls",
        },
        {
          symbolId: "sym-c",
          name: "callerC",
          kind: "function",
          relPath: "src/c.ts",
          rangeStartLine: 30,
          rangeEndLine: 34,
          confidence: 0.6,
          resolution: "heuristic",
          edgeType: "calls",
        },
      ],
    );

    const exactOnly = await queries.getReferencingSymbolsForTarget(conn, repoId, "sym-foo", 0.9);
    assert.deepEqual(exactOnly.map((row) => row.symbolId), ["sym-b"]);
  });
});