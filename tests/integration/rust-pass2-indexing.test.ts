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
} from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";

const REPO_ID = "test-rust-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("Rust pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-rust-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-rust-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-rust-pass2-repo-"));
    writeRepoFile(repoDir, "src/lib.rs", "pub mod utils;\npub mod service;\n");
    writeRepoFile(
      repoDir,
      "src/utils.rs",
      "pub fn helper() -> String { String::new() }\n",
    );
    writeRepoFile(
      repoDir,
      "src/service.rs",
      "use crate::utils::helper;\npub fn run() { helper(); }\n",
    );

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
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["rs"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
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
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(configPath, { recursive: true, force: true });
    } catch {}
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = null;
    }
  });

  it("creates pass2-rust use-import call edges", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const run = symbols.find(
      (symbol) => symbol.name === "run" && symbol.kind === "function",
    );
    const helper = symbols.find(
      (symbol) => symbol.name === "helper" && symbol.kind === "function",
    );

    assert.ok(run);
    assert.ok(helper);

    const runEdges = await ladybugDb.getEdgesFrom(conn, run.symbolId);
    const helperCall = runEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === helper.symbolId,
    );

    assert.ok(helperCall);
    assert.equal(helperCall.resolverId, "pass2-rust");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.equal(helperCall.resolution, "use-import");
  });
});
