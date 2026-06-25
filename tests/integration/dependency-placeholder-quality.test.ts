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
import { unresolvedCallSymbolId } from "../../dist/db/symbol-placeholders.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

const REPO_ID = "test-dependency-placeholder-quality";
const MISSING_CALL_SYMBOL_ID = unresolvedCallSymbolId("missingCall");

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("dependency placeholder quality integration", () => {
  const graphDbPath = mkdtempSync(join(tmpdir(), "sdl-placeholder-quality-db-"));
  const configPath = join(graphDbPath, "sdl-placeholder-quality-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "sdl-placeholder-quality-repo-"));
    writeRepoFile(
      repoDir,
      "src/index.ts",
      [
        'import { describe } from "node:test";',
        'import { z } from "zod";',
        'import { MissingThing } from "./missing.js";',
        "",
        "export function runPlaceholders(): void {",
        '  describe("placeholder quality", () => {});',
        "  z.string();",
        "  MissingThing();",
        "  missingCall();",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "package.json",
      JSON.stringify(
        {
          name: "dependency-placeholder-quality-test",
          version: "1.0.0",
          type: "module",
        },
        null,
        2,
      ),
    );
    writeRepoFile(
      repoDir,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          semantic: { enabled: false },
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
        includeNodeModulesTypes: false,
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
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {}
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = null;
    }
  });

  it("finishes with typed active placeholders and clean placeholder hygiene counters", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const rows = await ladybugDb.queryAll<{
      symbolId: string;
      status: string;
      placeholderKind: string;
      placeholderTarget: string;
      external: boolean;
      edgeType: string;
    }>(
      conn,
      `MATCH (:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
       WHERE NOT (b)-[:SYMBOL_IN_FILE]->(:File)
         AND (
           b.symbolId STARTS WITH 'unresolved:'
           OR coalesce(b.symbolStatus, '') = 'unresolved'
           OR coalesce(b.symbolStatus, '') = 'external'
           OR coalesce(b.external, false) = true
         )
       RETURN DISTINCT b.symbolId AS symbolId,
              b.symbolStatus AS status,
              b.placeholderKind AS placeholderKind,
              b.placeholderTarget AS placeholderTarget,
              coalesce(b.external, false) AS external,
              d.edgeType AS edgeType
       ORDER BY symbolId`,
      { repoId: REPO_ID },
    );
    const bySymbol = new Map(rows.map((row) => [row.symbolId, row]));

    assert.deepEqual(bySymbol.get("unresolved:node:test:describe"), {
      symbolId: "unresolved:node:test:describe",
      status: "external",
      placeholderKind: "import",
      placeholderTarget: "describe (from node:test)",
      external: true,
      edgeType: "import",
    });
    assert.deepEqual(bySymbol.get("unresolved:zod:z"), {
      symbolId: "unresolved:zod:z",
      status: "external",
      placeholderKind: "import",
      placeholderTarget: "z (from zod)",
      external: true,
      edgeType: "import",
    });
    assert.deepEqual(bySymbol.get("unresolved:./missing.js:MissingThing"), {
      symbolId: "unresolved:./missing.js:MissingThing",
      status: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "MissingThing (from ./missing.js)",
      external: false,
      edgeType: "import",
    });
    assert.equal(
      bySymbol.get(MISSING_CALL_SYMBOL_ID)?.status,
      "unresolved",
    );
    assert.equal(
      bySymbol.get(MISSING_CALL_SYMBOL_ID)?.placeholderKind,
      "call",
    );

    const [untyped, fileBacked, isolated] = await Promise.all([
      ladybugDb.querySingle<{ count: unknown }>(
        conn,
        `MATCH (:Symbol {repoId: $repoId})-[:DEPENDS_ON]->(b:Symbol)
         WHERE NOT (b)-[:SYMBOL_IN_FILE]->(:File)
           AND (b.symbolStatus IS NULL OR b.symbolStatus = '')
         RETURN count(b) AS count`,
        { repoId: REPO_ID },
      ),
      ladybugDb.querySingle<{ count: unknown }>(
        conn,
        `MATCH (s:Symbol {repoId: $repoId})-[:SYMBOL_IN_FILE]->(:File)
         WHERE coalesce(s.symbolStatus, 'real') <> 'real'
            OR coalesce(s.placeholderKind, '') <> ''
            OR coalesce(s.placeholderTarget, '') <> ''
            OR coalesce(s.external, false) = true
         RETURN count(s) AS count`,
        { repoId: REPO_ID },
      ),
      ladybugDb.querySingle<{ count: unknown }>(
        conn,
        `MATCH (s:Symbol {repoId: $repoId})
         WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
           AND (
             s.symbolId STARTS WITH 'unresolved:'
             OR coalesce(s.symbolStatus, '') = 'unresolved'
             OR coalesce(s.symbolStatus, '') = 'external'
           )
           AND NOT (:Symbol)-[:DEPENDS_ON]->(s)
           AND NOT (s)-[:DEPENDS_ON]->(:Symbol)
         RETURN count(s) AS count`,
        { repoId: REPO_ID },
      ),
    ]);

    assert.equal(ladybugDb.toNumber(untyped?.count ?? 0), 0);
    assert.equal(ladybugDb.toNumber(fileBacked?.count ?? 0), 0);
    assert.equal(ladybugDb.toNumber(isolated?.count ?? 0), 0);
  });
});
