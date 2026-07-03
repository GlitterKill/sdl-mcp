import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as queries from "../../dist/db/ladybug-queries.js";
import { handleSearchEdit } from "../../dist/mcp/tools/search-edit/index.js";
import type { SearchEditPreviewResponse } from "../../dist/mcp/tools.js";
import type { SymbolRow } from "../../dist/db/ladybug-symbols.js";

const repoId = "search-edit-rename-test";
const now = "2026-07-03T00:00:00Z";

let testRoot: string;
let repoRoot: string;

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
    astFingerprint: overrides.astFingerprint ?? `${overrides.symbolId}-ast`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: overrides.searchText ?? overrides.name,
    updatedAt: now,
  };
}

async function seedRepo(): Promise<void> {
  const conn = await getLadybugConn();
  await queries.upsertRepo(conn, {
    repoId,
    rootPath: repoRoot,
    configJson: "{}",
    createdAt: now,
  });
  for (const [fileId, relPath] of [
    ["file-a", "src/a.ts"],
    ["file-b", "src/b.ts"],
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
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-foo", fileId: "file-a", name: "foo", rangeStartLine: 1, rangeEndLine: 3 }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-caller", fileId: "file-b", name: "caller", rangeStartLine: 1, rangeEndLine: 3 }));
  await queries.insertEdges(conn, [
    {
      repoId,
      fromSymbolId: "sym-caller",
      toSymbolId: "sym-foo",
      edgeType: "calls",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      resolverId: "unit",
      resolutionPhase: "test",
      provenance: "unit",
    },
  ]);
}

async function addIndexedFile(
  fileId: string,
  relPath: string,
  content: string,
  symbolId: string,
  name: string,
  edgeToFoo = true,
): Promise<void> {
  const conn = await getLadybugConn();
  await writeFile(join(repoRoot, ...relPath.split("/")), content, "utf-8");
  await queries.upsertFile(conn, {
    fileId,
    repoId,
    relPath,
    contentHash: `hash-${fileId}`,
    language: relPath.endsWith(".ts") ? "typescript" : "text",
    byteSize: Buffer.byteLength(content),
    lastIndexedAt: now,
  });
  await queries.upsertSymbol(conn, symbol({ symbolId, fileId, name }));
  if (!edgeToFoo) return;
  await queries.insertEdges(conn, [
    {
      repoId,
      fromSymbolId: symbolId,
      toSymbolId: "sym-foo",
      edgeType: "calls",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      resolverId: "unit",
      resolutionPhase: "test",
      provenance: "unit",
    },
  ]);
}

function skipReasons(preview: SearchEditPreviewResponse): Map<string, string> {
  return new Map(preview.filesSkipped.map((entry) => [entry.path, entry.reason]));
}

describe("search.edit rename", { concurrency: false }, () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-rename-"));
    await initLadybugDb(join(testRoot, "graph"));
    repoRoot = join(testRoot, "repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "a.ts"), "export function foo() {\n  return 1;\n}\n", "utf-8");
    await writeFile(join(repoRoot, "src", "b.ts"), "import { foo } from './a';\nexport const value = foo();\n", "utf-8");
    await seedRepo();
  });

  afterEach(async () => {
    await closeLadybugDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("renames a graph-scoped symbol declaration and caller identifiers", async () => {
    const preview = (await handleSearchEdit({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: {
        symbolIds: ["sym-foo"],
        rename: { newName: "bar" },
      },
      editMode: "replacePattern",
      maxFiles: 10,
    })) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 2);
    assert.deepEqual(preview.fileEntries.map((entry) => entry.file).sort(), ["src/a.ts", "src/b.ts"]);

    const apply = await handleSearchEdit(preview.applyArgs);
    assert.equal(apply.mode, "apply");

    assert.match(await readFile(join(repoRoot, "src", "a.ts"), "utf-8"), /function bar/);
    assert.match(await readFile(join(repoRoot, "src", "b.ts"), "utf-8"), /import \{ bar \}/);
    assert.match(await readFile(join(repoRoot, "src", "b.ts"), "utf-8"), /bar\(\)/);
  });

  it("skips graph candidates that would collide with an existing symbol name", async () => {
    const conn = await getLadybugConn();
    await queries.upsertSymbol(conn, symbol({ symbolId: "sym-bar", fileId: "file-b", name: "bar" }));

    const preview = (await handleSearchEdit({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: {
        symbolIds: ["sym-foo"],
        rename: { newName: "bar" },
      },
      editMode: "replacePattern",
      maxFiles: 10,
    })) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(skipReasons(preview).get("src/b.ts"), "name-collision");
  });

  it("reports text-only recall matches when requested without editing them", async () => {
    await addIndexedFile(
      "file-loose",
      "src/loose.ts",
      "export const loose = foo();\n",
      "sym-loose",
      "loose",
      false,
    );

    const defaultPreview = (await handleSearchEdit({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: {
        symbolIds: ["sym-foo"],
        rename: { newName: "bar" },
      },
      editMode: "replacePattern",
      maxFiles: 10,
    })) as SearchEditPreviewResponse;
    assert.equal(skipReasons(defaultPreview).has("src/loose.ts"), false);

    const recallPreview = (await handleSearchEdit({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: {
        symbolIds: ["sym-foo"],
        rename: { newName: "bar", includeTextOnlyMatches: true },
      },
      editMode: "replacePattern",
      maxFiles: 10,
    })) as SearchEditPreviewResponse;

    assert.equal(skipReasons(recallPreview).get("src/loose.ts"), "text-only-match");
    assert.equal(recallPreview.fileEntries.some((entry) => entry.file === "src/loose.ts"), false);
  });

  it("reports unsupported-language and stale-edge graph candidates", async () => {
    await addIndexedFile("file-stale", "src/stale.ts", "export const value = 1;\n", "sym-stale", "stale");
    await addIndexedFile("file-text", "src/readme.txt", "foo\n", "sym-text", "textCaller");

    const preview = (await handleSearchEdit({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: {
        symbolIds: ["sym-foo"],
        rename: { newName: "bar" },
      },
      editMode: "replacePattern",
      maxFiles: 10,
    })) as SearchEditPreviewResponse;

    const reasons = skipReasons(preview);
    assert.equal(reasons.get("src/stale.ts"), "no-identifier-match");
    assert.equal(reasons.get("src/readme.txt"), "unsupported-language");
  });

  it("rejects invalid rename identifiers", async () => {
    await assert.rejects(
      () =>
        handleSearchEdit({
          mode: "preview",
          repoId,
          targeting: "rename",
          query: {
            symbolIds: ["sym-foo"],
            rename: { newName: "not valid" },
          },
          editMode: "replacePattern",
        }),
      /identifier|newName/i,
    );
  });
});
