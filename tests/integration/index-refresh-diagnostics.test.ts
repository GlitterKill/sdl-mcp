import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
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
import { handleIndexRefresh } from "../../dist/mcp/tools/repo.js";

const REPO_ID = "test-index-refresh-diagnostics";

describe("index.refresh diagnostics", () => {
  let graphDbPath = "";
  let configPath = "";
  let repoDir = "";
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;

  before(async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-index-refresh-diag-db-"));
    configPath = join(graphDbPath, "test-config.json");
    repoDir = mkdtempSync(join(tmpdir(), "sdl-index-refresh-diag-repo-"));

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "index-refresh-diagnostics-test",
          version: "1.0.0",
          type: "module",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          semanticEnrichment: { enabled: false },
          scip: { enabled: false },
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
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: "package.json",
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
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

    if (repoDir && existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("accepts includeDiagnostics without returning timing diagnostics", async () => {
    await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "full",
      includeDiagnostics: false,
    });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b + 1;",
        "}",
        "export const value = add(1, 2);",
      ].join("\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });

    assert.equal(result.ok, true);
    assert.ok(result.versionId, "expected versionId to be present");
    assert.equal("diagnostics" in result, false);
  });

  it("omits diagnostics for full refreshes even when requested", async () => {
    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "full",
      includeDiagnostics: true,
    });

    assert.equal(result.ok, true);
    assert.equal("diagnostics" in result, false);
  });

  it("omits diagnostics when the flag is not set", async () => {
    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
    });

    assert.equal(result.ok, true);
    assert.equal("diagnostics" in result, false);
  });

  it("short-circuits unchanged incremental refreshes without returning diagnostics", async () => {
    const initial = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });
    const noop = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });

    assert.equal(initial.ok, true);
    assert.equal(noop.ok, true);
    assert.equal(noop.versionId, initial.versionId);
    assert.equal(noop.changedFiles, 0);
    assert.equal("diagnostics" in noop, false);
  });
});
