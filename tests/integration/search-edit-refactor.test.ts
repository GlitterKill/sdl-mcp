/**
 * Integration coverage for sdl.search.edit symbolic refactor ops.
 *
 * Covers:
 *  - targeting:"rename" preview -> apply across declaration + callers
 *  - rename drift-abort: apply fails closed, zero partial writes
 *  - targeting:"signature" fanout: declaration + 3 callsites
 *  - signature drift-abort: preflight abort, zero writes anywhere
 *
 * Args are dispatched through SearchEditRequestSchema.parse to mirror the
 * production server/gateway dispatch paths.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
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
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import {
  SearchEditRequestSchema,
  type SearchEditApplyResponse,
  type SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import type { SymbolRow } from "../../dist/db/ladybug-symbols.js";

const repoId = "search-edit-refactor-test";
const now = "2026-07-03T00:00:00Z";

let testRoot: string;
let repoRoot: string;

function symbol(
  overrides: Partial<SymbolRow> & Pick<SymbolRow, "symbolId" | "fileId" | "name">,
): SymbolRow {
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
    astFingerprint: `${overrides.symbolId}-ast`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: overrides.searchText ?? overrides.name,
    updatedAt: now,
  };
}

async function seedFile(
  fileId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const conn = await getLadybugConn();
  await writeFile(join(repoRoot, ...relPath.split("/")), content, "utf-8");
  await queries.upsertFile(conn, {
    fileId,
    repoId,
    relPath,
    contentHash: `hash-${fileId}`,
    language: "typescript",
    byteSize: Buffer.byteLength(content),
    lastIndexedAt: now,
  });
}

async function seedCallerEdge(fromSymbolId: string, toSymbolId: string): Promise<void> {
  const conn = await getLadybugConn();
  await queries.insertEdges(conn, [
    {
      repoId,
      fromSymbolId,
      toSymbolId,
      edgeType: "calls",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      resolverId: "integration",
      resolutionPhase: "test",
      provenance: "integration",
    },
  ]);
}

async function seedRenameFixture(): Promise<void> {
  const conn = await getLadybugConn();
  await queries.upsertRepo(conn, { repoId, rootPath: repoRoot, configJson: "{}", createdAt: now });
  await seedFile("file-lib", "src/lib.ts", "export function greet() {\n  return 1;\n}\n");
  await seedFile("file-user1", "src/user1.ts", "import { greet } from './lib';\nexport const v1 = greet();\n");
  await seedFile("file-user2", "src/user2.ts", "import { greet } from './lib';\nexport const v2 = greet();\n");
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-greet", fileId: "file-lib", name: "greet" }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-u1", fileId: "file-user1", name: "v1", kind: "variable" }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-u2", fileId: "file-user2", name: "v2", kind: "variable" }));
  await seedCallerEdge("sym-u1", "sym-greet");
  await seedCallerEdge("sym-u2", "sym-greet");
}

async function seedSignatureFixture(): Promise<void> {
  const conn = await getLadybugConn();
  await queries.upsertRepo(conn, { repoId, rootPath: repoRoot, configJson: "{}", createdAt: now });
  await seedFile("file-lib", "src/lib.ts", "export function handler(a: string, b: number) {\n  return a + b;\n}\n");
  for (const n of [1, 2, 3]) {
    await seedFile(
      `file-caller${n}`,
      `src/caller${n}.ts`,
      `import { handler } from './lib';\nexport const c${n} = handler('x', ${n});\n`,
    );
    await queries.upsertSymbol(
      conn,
      symbol({ symbolId: `sym-c${n}`, fileId: `file-caller${n}`, name: `c${n}`, kind: "variable" }),
    );
  }
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-handler", fileId: "file-lib", name: "handler" }));
  for (const n of [1, 2, 3]) await seedCallerEdge(`sym-c${n}`, "sym-handler");
}

async function previewRename(newName: string): Promise<SearchEditPreviewResponse> {
  return (await handleSearchEdit(
    SearchEditRequestSchema.parse({
      mode: "preview",
      repoId,
      targeting: "rename",
      query: { symbolRef: { name: "greet" }, rename: { newName } },
      editMode: "replacePattern",
      maxFiles: 10,
      responseMode: "inline",
    }),
  )) as SearchEditPreviewResponse;
}

async function previewSignatureAdd(): Promise<SearchEditPreviewResponse> {
  return (await handleSearchEdit(
    SearchEditRequestSchema.parse({
      mode: "preview",
      repoId,
      targeting: "signature",
      query: {
        symbolIds: ["sym-handler"],
        signature: { add: [{ name: "opts", typeText: "Options", argText: "{}" }] },
      },
      editMode: "replacePattern",
      maxFiles: 10,
      responseMode: "inline",
    }),
  )) as SearchEditPreviewResponse;
}

async function applyPlan(preview: SearchEditPreviewResponse): Promise<SearchEditApplyResponse> {
  return (await handleSearchEdit(
    SearchEditRequestSchema.parse(preview.applyArgs),
  )) as SearchEditApplyResponse;
}

async function fileContent(relPath: string): Promise<string> {
  return readFile(join(repoRoot, ...relPath.split("/")), "utf-8");
}

describe("sdl.search.edit refactor ops", { concurrency: false }, () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-refactor-"));
    await initLadybugDb(join(testRoot, "graph"));
    repoRoot = join(testRoot, "repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    resetSearchEditPlanStore();
  });

  afterEach(async () => {
    await closeLadybugDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("renames a symbol across declaration and callers end-to-end", async () => {
    await seedRenameFixture();

    const preview = await previewRename("salute");
    assert.equal(preview.filesMatched, 3);
    assert.deepEqual(
      preview.fileEntries.map((entry) => entry.file).sort(),
      ["src/lib.ts", "src/user1.ts", "src/user2.ts"],
    );

    const apply = await applyPlan(preview);
    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 3);

    assert.match(await fileContent("src/lib.ts"), /export function salute\(\)/);
    for (const user of ["src/user1.ts", "src/user2.ts"]) {
      const content = await fileContent(user);
      assert.match(content, /import \{ salute \} from '.\/lib';/);
      assert.match(content, /salute\(\)/);
      assert.doesNotMatch(content, /greet/);
    }
  });

  it("rename apply aborts on drift with zero partial writes", async () => {
    await seedRenameFixture();

    const preview = await previewRename("salute");
    assert.equal(preview.filesMatched, 3);

    const libBefore = await fileContent("src/lib.ts");
    const user2Before = await fileContent("src/user2.ts");

    // Drift one caller between preview and apply.
    await writeFile(
      join(repoRoot, "src", "user1.ts"),
      "import { greet } from './lib';\nexport const v1 = greet() + 1;\n",
      "utf-8",
    );

    await assert.rejects(() => applyPlan(preview), /drifted/i);

    // Rollback contract: the untouched files must be byte-identical.
    assert.equal(await fileContent("src/lib.ts"), libBefore);
    assert.equal(await fileContent("src/user2.ts"), user2Before);
  });

  it("propagates a signature add across declaration and three callsites", async () => {
    await seedSignatureFixture();

    const preview = await previewSignatureAdd();
    assert.equal(preview.filesMatched, 4);
    assert.deepEqual(
      preview.fileEntries.map((entry) => entry.file).sort(),
      ["src/caller1.ts", "src/caller2.ts", "src/caller3.ts", "src/lib.ts"],
    );

    const apply = await applyPlan(preview);
    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 4);

    assert.match(
      await fileContent("src/lib.ts"),
      /handler\(a: string, b: number, opts: Options\)/,
    );
    for (const n of [1, 2, 3]) {
      assert.match(
        await fileContent(`src/caller${n}.ts`),
        new RegExp(`handler\\('x', ${n}, \\{\\}\\)`),
      );
    }
  });

  it("signature apply aborts on drift with zero writes anywhere", async () => {
    await seedSignatureFixture();

    const preview = await previewSignatureAdd();
    assert.equal(preview.filesMatched, 4);

    const before = new Map<string, string>();
    for (const rel of ["src/lib.ts", "src/caller1.ts", "src/caller3.ts"]) {
      before.set(rel, await fileContent(rel));
    }

    await writeFile(
      join(repoRoot, "src", "caller2.ts"),
      "import { handler } from './lib';\nexport const c2 = handler('y', 2);\n",
      "utf-8",
    );

    await assert.rejects(() => applyPlan(preview), /drifted/i);

    for (const [rel, content] of before) {
      assert.equal(await fileContent(rel), content);
    }
  });
});
