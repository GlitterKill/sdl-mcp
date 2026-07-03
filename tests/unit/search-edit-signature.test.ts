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

const repoId = "search-edit-signature-test";
const now = "2026-07-03T00:00:00Z";

let testRoot: string;
let repoRoot: string;

type SignaturePayload = {
  add?: Array<{ name: string; typeText?: string; defaultText?: string; index?: number; argText?: string }>;
  remove?: Array<{ name: string }>;
  renameParam?: Array<{ from: string; to: string }>;
};

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
    astFingerprint: overrides.symbolId + "-ast",
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
  await queries.upsertRepo(conn, { repoId, rootPath: repoRoot, configJson: "{}", createdAt: now });
  for (const [fileId, relPath] of [["file-a", "src/a.ts"], ["file-b", "src/b.ts"]] as const) {
    await queries.upsertFile(conn, { fileId, repoId, relPath, contentHash: "hash-" + fileId, language: "typescript", byteSize: 10, lastIndexedAt: now });
  }
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-handler", fileId: "file-a", name: "handler", rangeStartLine: 1, rangeEndLine: 3 }));
  await queries.upsertSymbol(conn, symbol({ symbolId: "sym-caller", fileId: "file-b", name: "caller", rangeStartLine: 1, rangeEndLine: 3 }));
  await queries.insertEdges(conn, [{ repoId, fromSymbolId: "sym-caller", toSymbolId: "sym-handler", edgeType: "calls", weight: 1, confidence: 1, resolution: "exact", resolverId: "unit", resolutionPhase: "test", provenance: "unit" }]);
}

async function previewSignature(signature: SignaturePayload): Promise<SearchEditPreviewResponse> {
  return (await handleSearchEdit({
    mode: "preview",
    repoId,
    targeting: "signature",
    query: {
      symbolIds: ["sym-handler"],
      signature,
    },
    editMode: "replacePattern",
    maxFiles: 10,
  })) as SearchEditPreviewResponse;
}

function skipReasons(preview: SearchEditPreviewResponse): Map<string, string> {
  return new Map(preview.filesSkipped.map((entry) => [entry.path, entry.reason]));
}

async function sourceA(): Promise<string> {
  return readFile(join(repoRoot, "src", "a.ts"), "utf-8");
}

async function sourceB(): Promise<string> {
  return readFile(join(repoRoot, "src", "b.ts"), "utf-8");
}

describe("search.edit signature", { concurrency: false }, () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-signature-"));
    await initLadybugDb(join(testRoot, "graph"));
    repoRoot = join(testRoot, "repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "a.ts"), "export function handler(a: string, b: number) {\n  return a + b;\n}\n", "utf-8");
    await writeFile(join(repoRoot, "src", "b.ts"), "import { handler } from './a';\nexport const value = handler('x', 1);\n", "utf-8");
    await seedRepo();
  });

  afterEach(async () => {
    await closeLadybugDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("adds a parameter and propagates callsite argText", async () => {
    const preview = await previewSignature({ add: [{ name: "opts", typeText: "Options", argText: "{}" }] });

    assert.equal(preview.filesMatched, 2);
    const apply = await handleSearchEdit(preview.applyArgs);
    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(a: string, b: number, opts: Options\)/);
    assert.match(await sourceB(), /handler\('x', 1, \{\}\)/);
  });

  it("adds a defaulted parameter at an explicit index and leaves callsites for review without argText", async () => {
    const preview = await previewSignature({ add: [{ name: "flag", typeText: "boolean", defaultText: "false", index: 1 }] });

    assert.equal(preview.filesMatched, 1);
    assert.equal(skipReasons(preview).get("src/b.ts"), "needs-arg-value");
    const apply = await handleSearchEdit(preview.applyArgs);
    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(a: string, flag: boolean = false, b: number\)/);
    assert.match(await sourceB(), /handler\('x', 1\)/);
  });

  it("removes a parameter and removes positional callsite arguments", async () => {
    const preview = await previewSignature({ remove: [{ name: "b" }] });

    assert.equal(preview.filesMatched, 2);
    const apply = await handleSearchEdit(preview.applyArgs);
    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(a: string\)/);
    assert.match(await sourceB(), /handler\('x'\)/);
  });

  it("renames a parameter in the declaration and function body", async () => {
    // Shadowed nested-scope identifiers remain a known limitation for this lightweight planner.
    const preview = await previewSignature({ renameParam: [{ from: "a", to: "value" }] });

    assert.equal(preview.filesMatched, 1);
    const apply = await handleSearchEdit(preview.applyArgs);
    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(value: string, b: number\)/);
    assert.match(await sourceA(), /return value \+ b/);
  });

  it("renameParam-only previews scope to the declaration file", async () => {
    const preview = await previewSignature({ renameParam: [{ from: "a", to: "alpha" }] });

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.filesEligible, 1);
    assert.equal(preview.fileEntries[0].file, "src/a.ts");
  });

  it("handles arrow function declarations", async () => {
    await writeFile(join(repoRoot, "src", "a.ts"), "export const handler = (a: string, b: number) => a + b;\n", "utf-8");

    const preview = await previewSignature({ remove: [{ name: "b" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler = \(a: string\) => a \+ b/);
    assert.match(await sourceB(), /handler\('x'\)/);
  });

  it("handles class method declarations", async () => {
    await writeFile(join(repoRoot, "src", "a.ts"), "export class Service {\n  handler(a: string, b: number) {\n    return a + b;\n  }\n}\n", "utf-8");
    await writeFile(join(repoRoot, "src", "b.ts"), "import { Service } from './a';\nconst svc = new Service();\nexport const value = svc.handler('x', 1);\n", "utf-8");

    const preview = await previewSignature({ remove: [{ name: "b" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(a: string\)/);
    assert.match(await sourceB(), /svc\.handler\('x'\)/);
  });

  it("rejects overloaded declarations instead of guessing", async () => {
    await writeFile(join(repoRoot, "src", "a.ts"), "export function handler(a: string): string;\nexport function handler(a: string, b: number) {\n  return a + b;\n}\n", "utf-8");

    await assert.rejects(
      () => previewSignature({ add: [{ name: "opts", argText: "{}" }] }),
      /overloads-not-supported/,
    );
  });

  it("rejects non-TypeScript/JavaScript declaration files", async () => {
    const conn = await getLadybugConn();
    await writeFile(join(repoRoot, "src", "a.py"), "def handler(a):\n    return a\n", "utf-8");
    await queries.upsertFile(conn, { fileId: "file-a", repoId, relPath: "src/a.py", contentHash: "hash-file-a-py", language: "python", byteSize: 10, lastIndexedAt: now });

    await assert.rejects(
      () => previewSignature({ add: [{ name: "opts", argText: "{}" }] }),
      /TypeScript\/JavaScript|unsupported-language/,
    );
  });

  it("rejects remove operations for missing parameters with the parameter name", async () => {
    await assert.rejects(
      () => previewSignature({ remove: [{ name: "missing" }] }),
      /missing/,
    );
  });

  it("does not edit call-shaped text inside string literals", async () => {
    await writeFile(
      join(repoRoot, "src", "b.ts"),
      "import { handler } from './a';\ndeclare function log(m: string): void;\nlog(\"handler(1)\");\nexport const value = handler('x', 1);\n",
      "utf-8",
    );

    const preview = await previewSignature({ add: [{ name: "opts", typeText: "Options", argText: "{}" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceB(), /log\("handler\(1\)"\);/);
    assert.match(await sourceB(), /handler\('x', 1, \{\}\)/);
  });

  it("does not edit call-shaped text inside comments", async () => {
    await writeFile(
      join(repoRoot, "src", "b.ts"),
      "import { handler } from './a';\n// handler(1) legacy\nexport const value = handler('x', 1);\n",
      "utf-8",
    );

    const preview = await previewSignature({ add: [{ name: "opts", typeText: "Options", argText: "{}" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceB(), /\/\/ handler\(1\) legacy/);
    assert.match(await sourceB(), /handler\('x', 1, \{\}\)/);
  });

  it("handles template literals containing braces and ${} around the declaration", async () => {
    await writeFile(
      join(repoRoot, "src", "a.ts"),
      "export function handler(a: string, b: number) {\n  const t = `x${\"`\"}y`;\n  return a + b;\n}\n",
      "utf-8",
    );

    const preview = await previewSignature({ renameParam: [{ from: "a", to: "value" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceA(), /handler\(value: string, b: number\)/);
    assert.match(await sourceA(), /return value \+ b/);
  });

  it("edits calls nested inside template literal interpolations", async () => {
    await writeFile(
      join(repoRoot, "src", "b.ts"),
      "import { handler } from './a';\nexport const s = `x ${handler('x', 1)} y`;\n",
      "utf-8",
    );

    const preview = await previewSignature({ add: [{ name: "opts", typeText: "Options", argText: "{}" }] });
    const apply = await handleSearchEdit(preview.applyArgs);

    assert.equal(apply.mode, "apply");
    assert.match(await sourceB(), /\$\{handler\('x', 1, \{\}\)\} y/);
  });

  it("skips spread callsites for manual review", async () => {
    await writeFile(join(repoRoot, "src", "b.ts"), "import { handler } from './a';\nconst args = ['x', 1] as const;\nexport const value = handler(...args);\n", "utf-8");

    const preview = await previewSignature({ add: [{ name: "opts", typeText: "Options", argText: "{}" }] });

    assert.equal(preview.filesMatched, 1);
    assert.equal(skipReasons(preview).get("src/b.ts"), "manual-review");
  });

  it("skips callsites whose arity is too small for a removed parameter", async () => {
    await writeFile(join(repoRoot, "src", "b.ts"), "import { handler } from './a';\nexport const value = handler('x');\n", "utf-8");

    const preview = await previewSignature({ remove: [{ name: "b" }] });

    assert.equal(preview.filesMatched, 1);
    assert.equal(skipReasons(preview).get("src/b.ts"), "arity-mismatch");
  });
});
