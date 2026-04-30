import { after, before, describe, it } from "node:test";
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

import { closeLadybugDb, initLadybugDb } from "../../dist/db/ladybug.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { handleSymbolSearch } from "../../dist/mcp/tools/symbol.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { getLadybugConn } from "../../dist/db/ladybug.js";

// Regression: when symbol.search resolves results via the camelCase
// fallback path (initial compound query returns 0 rows, subword/joined
// search supplies hits), `_rawContext.fileIds` must reflect those hits.
// Previously fileIds were derived from the original `rows` only, so
// fallback-only results returned `_rawContext: { fileIds: [] }`.
// Empty fileIds caused sdl.workflow envelopes to skip computeTokenUsage,
// which suppressed the per-call savings footer for any large workflow
// step that hit the fallback path.
describe("symbol.search _rawContext.fileIds (camelFallback regression)", () => {
  const repoId = "symbol-search-fileids-repo";
  const dbPath = join(tmpdir(), ".lbug-symbol-search-fileids-test-db.lbug");
  const configPath = join(
    tmpdir(),
    `sdl-symbol-search-fileids-${Date.now()}.json`,
  );
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-symbol-search-fileids-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "scoring.ts"),
      [
        "export function scoreThing(x: number): number {",
        "  return x * 2;",
        "}",
        "export function scoreBalanced(x: number): number {",
        "  return Math.min(1, Math.max(0, x));",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "src", "math-utils.ts"),
      [
        "export function clampValue(x: number): number {",
        "  return Math.min(1, Math.max(0, x));",
        "}",
        "export function roundHalf(x: number): number {",
        "  return Math.round(x * 2) / 2;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
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
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: "2026-04-30T00:00:00.000Z",
    });
    await indexRepo(repoId, "full");
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath !== undefined)
      process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("populates _rawContext.fileIds when results come from camelCase fallback", async () => {
    // Compound query "scoreClampRound" has no symbol with that exact substring,
    // so initial lexical/hybrid search returns 0 rows. splitCamelSubwords yields
    // ["score","clamp","round"]; the joined-term and/or per-subword wildcard
    // fallback then surfaces scoreThing/scoreBalanced/clampValue/roundHalf.
    const search = await handleSymbolSearch({
      repoId,
      query: "scoreClampRound",
      limit: 10,
    });

    const results = Array.isArray(search.results)
      ? (search.results as Array<{ name: string; file: string }>)
      : [];
    assert.ok(results.length > 0, "fallback should surface at least one symbol");

    const rawContext = (search as Record<string, unknown>)._rawContext as
      | { fileIds?: string[] }
      | undefined;
    assert.ok(rawContext, "_rawContext must be attached");
    assert.ok(
      Array.isArray(rawContext.fileIds),
      "_rawContext.fileIds must be an array",
    );
    assert.ok(
      rawContext.fileIds.length > 0,
      `_rawContext.fileIds must be non-empty when results are present. ` +
        `Saw ${results.length} result(s) but fileIds=${JSON.stringify(rawContext.fileIds)}. ` +
        `This is the camelFallback regression that suppressed workflow savings footers.`,
    );

    // fileIds should cover at least one of the files containing the matched symbols
    const resultFiles = new Set(results.map((r) => r.file));
    const fileIdsCoverResults = rawContext.fileIds.some((fid) => {
      // fileId in the DB stores the relative path; relax to suffix match
      // to avoid coupling to internal id format.
      return [...resultFiles].some((rf) => fid.endsWith(rf));
    });
    assert.ok(
      fileIdsCoverResults,
      `_rawContext.fileIds (${JSON.stringify(rawContext.fileIds)}) ` +
        `should reference at least one of the result files (${JSON.stringify([...resultFiles])}).`,
    );
  });

  it("keeps _rawContext.fileIds non-empty for direct lexical hits as well", async () => {
    // Sanity: the non-fallback path was not regressed by the fix.
    const search = await handleSymbolSearch({
      repoId,
      query: "scoreBalanced",
      limit: 5,
    });
    const results = Array.isArray(search.results)
      ? (search.results as Array<{ name: string }>)
      : [];
    assert.ok(
      results.some((r) => r.name === "scoreBalanced"),
      "exact match should be returned",
    );
    const rawContext = (search as Record<string, unknown>)._rawContext as
      | { fileIds?: string[] }
      | undefined;
    assert.ok(
      rawContext &&
        Array.isArray(rawContext.fileIds) &&
        rawContext.fileIds.length > 0,
      "_rawContext.fileIds must remain non-empty for direct lexical matches",
    );
  });
});
