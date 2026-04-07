/**
 * End-to-end integration test for SCIP ingestion.
 *
 * Exercises the full pipeline:
 *   1. Build a tiny on-disk TS repo and index it.
 *   2. Construct a SCIP index in memory via the fixture builder and write it
 *      to a `.scip` file inside the repo root.
 *   3. Call `ingestScipIndex` and assert counters + DB state:
 *        - symbolsMatched > 0 for in-repo definitions
 *        - externalSymbolsCreated > 0 for external npm package symbols
 *        - A ScipIngestion record is written and retrievable
 *        - External symbols are reachable via sdl.symbol.search
 *          (i.e. the SYMBOL_IN_REPO edge was created — regression guard
 *          for review finding #2).
 *   4. Call `ingestScipIndex` a second time on the same file and assert
 *      `status === "alreadyIngested"` (content-hash short-circuit).
 */

import { describe, before, after, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { ingestScipIndex } from "../../dist/scip/ingestion.js";
import { getScipIngestionRecord } from "../../dist/db/ladybug-scip.js";
import type { ScipConfig } from "../../dist/config/types.js";
import { buildTestScipIndex } from "../fixtures/scip/builder.ts";

const REPO_ID = "test-scip-ingestion-e2e";

// Minimal ScipConfig matching the zod schema defaults.
const scipConfig: ScipConfig = {
  enabled: true,
  indexes: [],
  externalSymbols: { enabled: true, maxPerIndex: 10_000 },
  confidence: 0.95,
  autoIngestOnRefresh: false,
  generator: {
    enabled: false,
    binary: "scip-io",
    args: [],
    autoInstall: false,
    timeoutMs: 600_000,
  },
};

describe("SCIP Ingestion E2E", () => {
  let graphDbPath = "";
  let repoDir = "";
  let indexFilePath = "";
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  const prevDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

  before(async () => {
    // Force TS decoder so the test is deterministic regardless of native
    // addon presence (napi-rs build is optional in CI).
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";

    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-mcp-scip-ingest-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-scip-ingest-repo-"));

    // Write a tiny TS source tree the indexer can parse.
    const srcDir = join(repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "main.ts"),
      [
        "export function greet(name: string): string {",
        '  return "hello " + name;',
        "}",
        "",
        "export function farewell(name: string): string {",
        '  return "goodbye " + name;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        { name: "scip-ingest-fixture", version: "1.0.0" },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      JSON.stringify(
        { compilerOptions: { target: "ES2022", module: "ESNext" } },
        null,
        2,
      ),
      "utf8",
    );

    const configPath = join(graphDbPath, "test-config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    // Register the repo so ingestScipIndex can resolve the rootPath.
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: "package.json",
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: new Date().toISOString(),
    });

    // Index the repo so File + Symbol nodes exist for `src/main.ts`.
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(
      result.versionId.length > 0,
      "indexRepo should produce a version",
    );

    // Build a SCIP index that:
    //  - has one internal document matching src/main.ts
    //  - defines greet() and farewell() (both should match SDL symbols)
    //  - contains a reference occurrence from greet -> farewell (edge)
    //  - declares one external npm symbol (lodash.chunk)
    const greetScipSymbol =
      "scip-typescript npm scip-ingest-fixture 1.0.0 src/main.ts/greet().";
    const farewellScipSymbol =
      "scip-typescript npm scip-ingest-fixture 1.0.0 src/main.ts/farewell().";
    const lodashChunkSymbol = "scip-typescript npm lodash 4.17.21 `chunk`.";

    const bytes = buildTestScipIndex({
      metadata: {
        version: 0,
        toolName: "scip-typescript",
        toolVersion: "0.3.0",
        projectRoot: `file://${repoDir}`,
      },
      documents: [
        {
          language: "TypeScript",
          relativePath: "src/main.ts",
          symbols: [
            {
              symbol: greetScipSymbol,
              kind: 17, // Function
              displayName: "greet",
            },
            {
              symbol: farewellScipSymbol,
              kind: 17,
              displayName: "farewell",
            },
          ],
          occurrences: [
            // Definition of greet at line 0, cols 16..21
            {
              range: [0, 16, 21],
              symbol: greetScipSymbol,
              symbolRoles: 1, // Definition
            },
            // Definition of farewell at line 4, cols 16..24
            {
              range: [4, 16, 24],
              symbol: farewellScipSymbol,
              symbolRoles: 1,
            },
            // Reference occurrence — greet() body references farewell()
            // (this creates an opportunity for an edge to be built).
            {
              range: [1, 9, 17],
              symbol: farewellScipSymbol,
              symbolRoles: 8, // ReadAccess
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: lodashChunkSymbol,
          kind: 17, // Function
          displayName: "chunk",
        },
      ],
    });

    indexFilePath = join(repoDir, "index.scip");
    writeFileSync(indexFilePath, bytes);
  });

  after(async () => {
    await closeLadybugDb();

    if (prevSDL_CONFIG === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = prevSDL_CONFIG;
    }
    if (prevSDL_CONFIG_PATH === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = prevSDL_CONFIG_PATH;
    }
    if (prevDisableNative === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = prevDisableNative;
    }

    for (const p of [graphDbPath, repoDir]) {
      if (p && existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  it("ingests a SCIP index end-to-end and writes the ingestion record", async () => {
    const response = await ingestScipIndex(
      { repoId: REPO_ID, indexPath: "index.scip" },
      scipConfig,
    );

    assert.equal(response.status, "ingested");
    assert.equal(response.decoderBackend, "typescript");
    assert.equal(
      response.documentsProcessed,
      1,
      "should process the single src/main.ts document",
    );
    assert.equal(
      response.documentsSkipped,
      0,
      "no SDL-indexed file should be skipped",
    );
    assert.ok(
      response.symbolsMatched >= 1,
      `expected at least 1 SCIP definition to match an SDL symbol, got ${response.symbolsMatched}`,
    );
    assert.equal(
      response.externalSymbolsCreated,
      1,
      "one external symbol (lodash.chunk) should be created",
    );
    assert.equal(
      response.truncated,
      false,
      "external cap was 10_000 — should not truncate",
    );
    assert.ok(response.durationMs >= 0);

    // The ScipIngestion record should be persisted and retrievable.
    const conn = await getLadybugConn();
    const record = await getScipIngestionRecord(conn, REPO_ID, "index.scip");
    assert.ok(record, "ingestion record should be persisted");
    assert.ok(
      typeof record.id === "string" && record.id.length > 0,
      "ingestion record should have a stable id",
    );
    assert.ok(
      typeof record.contentHash === "string" && record.contentHash.length > 0,
      "content hash should be non-empty",
    );
    assert.ok(
      typeof record.ingestedAt === "string" && record.ingestedAt.length > 0,
      "ingestedAt should be a timestamp string",
    );
  });

  it("links external symbols to the Repo via SYMBOL_IN_REPO (regression: review finding #2)", async () => {
    // Fix #2: external symbols must carry a SYMBOL_IN_REPO edge so they are
    // reachable from the Repo node and scoped by repo-aware graph queries.
    //
    // We verify the edge directly via Cypher instead of going through
    // `ladybugDb.searchSymbols`: that helper additionally joins on
    // SYMBOL_IN_FILE, but external SCIP symbols intentionally have no File
    // node (they live outside the repo tree). A direct edge query is the
    // precise regression guard for Fix #2.
    const conn = await getLadybugConn();
    const rows = await ladybugDb.queryAll<{
      symbolId: string;
      name: string;
      external: boolean;
      scipSymbol: string;
    }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE s.external = true AND s.name = $name
       RETURN s.symbolId AS symbolId,
              s.name AS name,
              s.external AS external,
              s.scipSymbol AS scipSymbol`,
      { repoId: REPO_ID, name: "chunk" },
    );
    assert.equal(
      rows.length,
      1,
      "exactly one external 'chunk' symbol should be linked to the repo via SYMBOL_IN_REPO",
    );
    const [row] = rows;
    assert.ok(row.external, "symbol row should be marked external=true");
    assert.ok(
      row.scipSymbol.includes("lodash"),
      `scipSymbol should preserve the lodash descriptor, got: ${row.scipSymbol}`,
    );
  });

  it("makes external symbols findable via searchSymbols (Fix #7: OPTIONAL MATCH on SYMBOL_IN_FILE)", async () => {
    // Fix #7 (two parts):
    //   1. searchSymbolsSingleTerm previously used a rigid INNER join on
    //      SYMBOL_IN_FILE, which excluded external SCIP symbols (they have no
    //      :File node). Changed to OPTIONAL MATCH so externals pass the join.
    //   2. The Cypher RETURN clause and SearchSymbolsRawRow / mapSearchSymbolRow
    //      did not include the external/scipSymbol/packageName/packageVersion
    //      fields, so even after step 1 mapped rows lacked external=true and
    //      callers filtering by s.external could not see them. RETURN, the
    //      raw-row interface, and the mapper now project all SCIP fields.
    // Together this matches the documented behavior in
    // docs/feature-deep-dives/scip-integration.md.
    const conn = await getLadybugConn();
    const rows = await ladybugDb.searchSymbols(conn, REPO_ID, "chunk", 20);
    const external = rows.find(
      (s) => s.name === "chunk" && s.external === true,
    );
    assert.ok(
      external,
      "external symbol 'chunk' should be reachable via searchSymbols after Fix #7",
    );
    assert.equal(
      external.fileId,
      "",
      "external symbol with no :File node should have empty fileId (coalesced from null)",
    );

    // excludeExternal must still suppress externals when explicitly requested.
    const filtered = await ladybugDb.searchSymbols(
      conn,
      REPO_ID,
      "chunk",
      20,
      undefined,
      true,
    );
    assert.equal(
      filtered.find((s) => s.name === "chunk" && s.external === true),
      undefined,
      "excludeExternal=true should still hide external symbols",
    );
  });

  it("short-circuits on second ingestion with identical content hash", async () => {
    const response = await ingestScipIndex(
      { repoId: REPO_ID, indexPath: "index.scip" },
      scipConfig,
    );
    assert.equal(
      response.status,
      "alreadyIngested",
      "second ingest of the same file should be a no-op",
    );
    // Counters must be zeroed when we short-circuit.
    assert.equal(response.documentsProcessed, 0);
    assert.equal(response.symbolsMatched, 0);
    assert.equal(response.externalSymbolsCreated, 0);
    assert.equal(response.edgesCreated, 0);
  });
});
