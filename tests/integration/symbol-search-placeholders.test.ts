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
import { handleSymbolSearch } from "../../dist/mcp/tools/symbol.js";

describe("symbol.search placeholder contract", () => {
  const repoId = "symbol-search-placeholders-repo";
  const dbPath = join(
    tmpdir(),
    ".lbug-symbol-search-placeholders-test-db.lbug",
  );
  const configPath = join(
    tmpdir(),
    `sdl-symbol-search-placeholders-${Date.now()}.json`,
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
      rootPath: "C:/tmp/symbol-search-placeholders-repo",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-core",
      repoId,
      relPath: "src/core.ts",
      contentHash: "h1",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-shared-real",
      repoId,
      fileId: "file-core",
      kind: "function",
      name: "SharedThing",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 0,
      astFingerprint: "real",
      signatureJson: null,
      summary: "real shared thing",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
    await ladybugDb.exec(
      conn,
      `MATCH (r:Repo {repoId: $repoId})
       CREATE (p:Symbol {
         symbolId: 'unresolved:call:SharedThing',
         repoId: $repoId,
         kind: 'function',
         name: 'SharedThing',
         exported: false,
         visibility: '',
         language: 'typescript',
         rangeStartLine: null,
         rangeStartCol: null,
         rangeEndLine: null,
         rangeEndCol: null,
         astFingerprint: '',
         signatureJson: null,
         summary: 'stale unresolved dependency placeholder',
         invariantsJson: null,
         sideEffectsJson: null,
         roleTagsJson: '[]',
         searchText: 'SharedThing placeholder',
         updatedAt: $now,
         external: false,
         symbolStatus: 'real',
         placeholderKind: 'call',
         placeholderTarget: 'SharedThing'
       })
       CREATE (p)-[:SYMBOL_IN_REPO]->(r)`,
      { repoId, now },
    );
    await ladybugDb.batchMergeExternalSymbols(conn, repoId, [
      {
        symbolId: "scip-external-chunk",
        kind: "function",
        name: "chunk",
        exported: true,
        language: "typescript",
        rangeStartLine: 0,
        rangeStartCol: 0,
        rangeEndLine: 0,
        rangeEndCol: 0,
        external: true,
        scipSymbol: "scip-typescript npm lodash 4.17.21 `chunk`().",
        source: "scip",
        packageName: "lodash",
        packageVersion: "4.17.21",
        updatedAt: now,
      },
    ]);
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

  it("returns real symbols but not unresolved dependency placeholders", async () => {
    const search = await handleSymbolSearch({
      repoId,
      query: "SharedThing",
      limit: 10,
      wireFormat: "json",
    });
    const results = getResultRows(search);

    assert.equal(
      results.some((row) => row.symbolId === "sym-shared-real"),
      true,
      "real file-backed symbol should still be searchable",
    );
    assert.equal(
      results.some((row) => row.symbolId === "unresolved:call:SharedThing"),
      false,
      "unresolved dependency placeholder should not be exposed by symbol.search",
    );
  });

  it("keeps SCIP external symbols searchable until excludeExternal is requested", async () => {
    const search = await handleSymbolSearch({
      repoId,
      query: "chunk",
      limit: 10,
      wireFormat: "json",
    });
    const results = getResultRows(search);

    assert.equal(
      results.some((row) => row.symbolId === "scip-external-chunk"),
      true,
      "SCIP external symbol should be searchable by default",
    );

    const filteredSearch = await handleSymbolSearch({
      repoId,
      query: "chunk",
      limit: 10,
      excludeExternal: true,
      wireFormat: "json",
    });
    const filteredResults = getResultRows(filteredSearch);

    assert.equal(
      filteredResults.some((row) => row.symbolId === "scip-external-chunk"),
      false,
      "excludeExternal should suppress SCIP external symbols",
    );
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
