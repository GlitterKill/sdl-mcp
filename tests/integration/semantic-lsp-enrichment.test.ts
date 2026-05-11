import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { refreshSemanticEnrichment } from "../../dist/semantic/enrichment.js";
import type { AppConfig } from "../../dist/config/types.js";

const REPO_ID = "test-semantic-lsp-enrichment";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const absolute = join(repoRoot, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

describe("semantic enrichment LSP integration", () => {
  let graphDbPath = "";
  let repoRoot = "";
  let configPath = "";
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  const previousDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    const root = mkdtempSync(join(tmpdir(), "sdl-lsp-enrichment-"));
    graphDbPath = join(root, "graph.lbug");
    repoRoot = join(root, "repo");
    configPath = join(root, "sdlmcp.config.json");
    mkdirSync(repoRoot, { recursive: true });

    writeRepoFile(
      repoRoot,
      "src/caller.ts",
      [
        "export function caller(): number {",
        "  return providedByLsp();",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoRoot,
      "src/target.ts",
      [
        "export function actualTarget(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({ name: "semantic-lsp-fixture", version: "1.0.0" }),
    );
    writeRepoFile(
      repoRoot,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" } }),
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          scip: { enabled: false, indexes: [] },
          semanticEnrichment: {
            enabled: true,
            languages: ["typescript"],
            providers: {
              scip: { enabled: false },
              lsp: {
                enabled: true,
                confidence: 0.95,
                candidateLimit: 10,
                servers: {
                  typescript: {
                    enabled: true,
                    serverId: "mock-ts-lsp",
                    command: process.execPath,
                    args: [
                      join(
                        process.cwd(),
                        "tests/fixtures/lsp/mock-definition-server.mjs",
                      ),
                    ],
                    languages: ["typescript"],
                    documentLanguageIds: ["typescript"],
                    filePatterns: ["**/*.ts"],
                    capabilities: ["definition"],
                  },
                },
              },
            },
          },
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
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    if (previousDisableNative === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousDisableNative;
    }
    const root = dirname(graphDbPath);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("replaces an unresolved call edge with the exact LSP definition target", async () => {
    const indexed = await indexRepo(REPO_ID, "full");
    assert.ok(indexed.symbolsIndexed >= 2);

    const config: AppConfig = {
      repos: [],
      policy: {},
      indexing: { engine: "typescript", enableFileWatching: false },
      scip: { enabled: false, indexes: [] },
      semanticEnrichment: {
        enabled: true,
        autoRunOnIndexRefresh: false,
        installPolicy: "never",
        cacheDir: null,
        concurrency: 1,
        timeoutMs: 5_000,
        languages: ["typescript"],
        providers: {
          scip: { enabled: false, indexes: [] },
          lsp: {
            enabled: true,
            confidence: 0.95,
            candidateLimit: 10,
            servers: {
              typescript: {
                enabled: true,
                serverId: "mock-ts-lsp",
                command: process.execPath,
                args: [
                  join(
                    process.cwd(),
                    "tests/fixtures/lsp/mock-definition-server.mjs",
                  ),
                ],
                languages: ["typescript"],
                documentLanguageIds: ["typescript"],
                filePatterns: ["**/*.ts"],
                capabilities: ["definition"],
              },
            },
          },
        },
      },
    };

    const result = await refreshSemanticEnrichment(
      { repoId: REPO_ID, languages: ["typescript"] },
      config,
    );
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, "completed");

    const conn = await getLadybugConn();
    const rows = await ladybugDb.queryAll<{
      sourceName: string;
      targetName: string;
      resolution: string;
      resolverId: string;
    }>(
      conn,
      `MATCH (source:Symbol)-[d:DEPENDS_ON]->(target:Symbol)
       WHERE source.name = 'caller'
         AND target.name = 'actualTarget'
         AND d.edgeType = 'call'
       RETURN source.name AS sourceName,
              target.name AS targetName,
              d.resolution AS resolution,
              d.resolverId AS resolverId`,
      {},
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].resolution, "exact");
    assert.equal(rows[0].resolverId, "lsp:mock-ts-lsp");

    const unresolvedRows = await ladybugDb.queryAll<{ targetName: string }>(
      conn,
      `MATCH (source:Symbol)-[:DEPENDS_ON {edgeType: 'call'}]->(target:Symbol)
       WHERE source.name = 'caller'
         AND target.symbolId STARTS WITH 'unresolved:call:'
       RETURN target.name AS targetName`,
      {},
    );
    assert.equal(unresolvedRows.length, 0);
  });
});
