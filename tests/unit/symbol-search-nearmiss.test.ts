import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { buildIdentifierAwareFtsQuery } from "../../dist/retrieval/orchestrator.js";
import { handleSymbolSearch } from "../../dist/mcp/tools/symbol.js";

describe("symbol.search identifier near misses", () => {
  const repoId = "symbol-search-nearmiss-repo";
  const dbPath = join(tmpdir(), ".lbug-symbol-search-nearmiss-test-db.lbug");
  const configPath = join(
    tmpdir(),
    `sdl-symbol-search-nearmiss-${Date.now()}.json`,
  );
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          semantic: { enabled: false },
          liveIndex: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-04T00:00:00Z";

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/symbol-search-nearmiss-repo",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-slice",
      repoId,
      relPath: "src/slice.ts",
      contentHash: "h1",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-store",
      repoId,
      relPath: "src/store.ts",
      contentHash: "h2",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-build-slice",
      repoId,
      fileId: "file-slice",
      kind: "function",
      name: "buildSlice",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 0,
      astFingerprint: "build-slice",
      signatureJson: null,
      summary: "Builds a graph slice from dependency edges",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-hydrate-store",
      repoId,
      fileId: "file-store",
      kind: "function",
      name: "hydrateStore",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 10,
      rangeStartCol: 0,
      rangeEndLine: 12,
      rangeEndCol: 0,
      astFingerprint: "hydrate-store",
      signatureJson: null,
      summary: "Hydrates persisted store state",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
  });

  it("builds identifier-aware FTS queries", () => {
    assert.equal(
      buildIdentifierAwareFtsQuery("buildGraphSlice"),
      "buildGraphSlice OR (build AND graph AND slice)",
    );
    assert.equal(buildIdentifierAwareFtsQuery("slice"), "slice");
  });

  it("returns the real symbol for camelCase drift", async () => {
    const search = await handleSymbolSearch({
      repoId,
      query: "buildGraphSlice",
      limit: 5,
      semantic: false,
      wireFormat: "json",
    });
    const results = getResultRows(search);

    assert.equal(
      results.slice(0, 5).some((row) => row.name === "buildSlice"),
      true,
      JSON.stringify(search),
    );
  });

  it("returns structured near misses without symbol IDs on weak misses", async () => {
    const search = await handleSymbolSearch({
      repoId,
      query: "storeAlphaBetaGammaDeltaEpsilonZetaEtaThetaIotaKappa",
      limit: 5,
      semantic: false,
      wireFormat: "json",
    });
    const results = getResultRows(search);
    const nearMisses = getNearMissRows(search);

    assert.deepEqual(results, []);
    assert.deepEqual(nearMisses[0], {
      name: "hydrateStore",
      kind: "function",
      file: "src/store.ts",
    });
    assert.equal(
      search.suggestion,
      "No strong match. nearMisses lists closest names; search again with one of them.",
    );
    assert.equal(Object.hasOwn(nearMisses[0] ?? {}, "symbolId"), false);
  });
});

function getResultRows(search: { results: unknown }): Array<{
  symbolId: string;
  name: string;
  file: string;
  kind: string;
}> {
  assert.ok(Array.isArray(search.results), "symbol.search should return JSON");
  return search.results as Array<{
    symbolId: string;
    name: string;
    file: string;
    kind: string;
  }>;
}

function getNearMissRows(search: { nearMisses?: unknown }): Array<{
  name: string;
  kind: string;
  file: string;
}> {
  assert.ok(Array.isArray(search.nearMisses), "nearMisses should be present");
  return search.nearMisses as Array<{ name: string; kind: string; file: string }>;
}
