/**
 * Smoke integration test for sdl.search.edit.
 *
 * Covers:
 *  - preview returns a planHandle + file entries + preconditions
 *  - apply with fresh handle writes all files and surfaces indexUpdate
 *    for indexed source
 *  - apply with an unknown handle fails closed
 *  - apply after a file drifts fails closed and writes nothing
 *
 * Kept narrow on purpose. Full matrix (LRU eviction, TTL expiry,
 * backup rollback on mid-batch failure, golden snapshots, property
 * tests) is tracked in devdocs/plans/tool-enhancement-plan.md.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { handleSearchEdit } from "../../dist/mcp/tools/search-edit/index.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import {
  SearchEditRequestSchema,
  type SearchEditApplyResponse,
  type SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import {
  getLadybugConn,
  initLadybugDb,
  closeLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { normalizePath } from "../../dist/util/paths.js";
import { loadConfiguredAdapterPlugins } from "../../dist/startup/plugins.js";
import {
  loadBuiltInAdapters,
  resetRegistry,
} from "../../dist/indexer/adapter/registry.js";

const REPO_ID = "search-edit-smoke";

let repoRoot: string;

async function ensureRepoRegistered(root: string): Promise<void> {
  const conn = await getLadybugConn();
  const existing = await ladybugDb.getRepo(conn, REPO_ID);
  if (existing) {
    if (normalizePath(existing.rootPath) === normalizePath(root)) return;
    // Different root; re-register.
  }
  await ladybugDb.upsertRepo(conn, {
    repoId: REPO_ID,
    rootPath: root,
    configJson: "{}",
    createdAt: new Date().toISOString(),
  });
}

describe("sdl.search.edit", { concurrency: false }, () => {
  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-"));
    await writeFile(
      join(repoRoot, "a.txt"),
      "hello oldName world\nsecond oldName line\n",
      "utf-8",
    );
    await writeFile(join(repoRoot, "b.txt"), "third oldName line\n", "utf-8");
    await writeFile(join(repoRoot, "unrelated.txt"), "nothing here\n", "utf-8");
    await initLadybugDb(join(repoRoot, "test.lbug"));
    await ensureRepoRegistered(repoRoot);
    resetSearchEditPlanStore();
  });

  after(async () => {
    await closeLadybugDb();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("preview returns planHandle and per-file entries", async () => {
    const req = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: {
        literal: "oldName",
        replacement: "newName",
        global: true,
      },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
    });
    const response = (await handleSearchEdit(req)) as SearchEditPreviewResponse;

    assert.equal(response.mode, "preview");
    assert.ok(response.planHandle.startsWith("se-"));
    assert.equal(response.filesMatched, 2);
    assert.ok(response.matchesFound >= 2);
    assert.ok(response.requiresApply);
    assert.equal("preconditionSnapshot" in response, false);
    const files = response.fileEntries.map((e) => e.file).sort();
    assert.deepEqual(files, ["a.txt", "b.txt"]);
  });

  it("apply backup mismatch suggests preview createBackup", async () => {
    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
        },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: REPO_ID,
            planHandle: preview.planHandle,
            createBackup: false,
          }),
        ),
      /Re-run preview with createBackup=false/,
    );
  });


  it("identifier targeting edits AST identifiers without touching strings or comments", async () => {
    await writeFile(
      join(repoRoot, "ident.ts"),
      [


        "const oldName = 1;",
        'const text = "oldName";',
        "// oldName stays here",
        "oldName();",
        "object.oldName;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "identifier",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { include: ["ident.ts"] },
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 3);
    assert.equal(preview.fileEntries[0].astMatches?.[0]?.target.name, "target");
    assert.equal(
      preview.fileEntries[0].astMatches?.[0]?.target.nodeType,
      "identifier",
    );
    assert.match(preview.fileEntries[0].snippets.before, /oldName/);
    assert.match(preview.fileEntries[0].snippets.after, /newName/);

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    const updated = await readFile(join(repoRoot, "ident.ts"), "utf-8");
    assert.match(updated, /const newName = 1/);
    assert.match(updated, /newName\(\);/);
    assert.match(updated, /object\.newName;/);
    assert.match(updated, /const text = "oldName";/);
    assert.match(updated, /\/\/ oldName stays here/);
  });

  it("structural targeting edits a selected tree-sitter capture", async () => {
    await writeFile(
      join(repoRoot, "calls.ts"),
      'oldName("a");\nother("b");\n',
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery:
              "(call_expression function: (identifier) @callee arguments: (arguments) @args) @target",
            requiredCaptures: { callee: "oldName" },
          },
          replacement: "newName$args",
          global: true,
        },
        editMode: "replacePattern",
        filters: { include: ["calls.ts"] },
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 1);
    assert.equal(preview.fileEntries[0].astMatches?.[0]?.target.name, "target");
    assert.equal(
      preview.fileEntries[0].astMatches?.[0]?.captures.some(
        (capture) => capture.name === "callee",
      ),
      true,
    );

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    assert.equal(
      await readFile(join(repoRoot, "calls.ts"), "utf-8"),
      'newName("a");\nother("b");\n',
    );
  });

  it("identifier targeting edits non-TypeScript source", async () => {
    await writeFile(
      join(repoRoot, "ident.py"),
      [
        "old_name = 1",
        'text = "old_name"',
        "# old_name stays here",
        "old_name()",
        "",
      ].join("\n"),
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "identifier",
        query: { literal: "old_name", replacement: "new_name", global: true },
        editMode: "replacePattern",
        filters: { include: ["ident.py"] },
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 2);
    assert.equal(
      preview.fileEntries[0].astMatches?.[0]?.target.nodeType,
      "identifier",
    );

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    const updated = await readFile(join(repoRoot, "ident.py"), "utf-8");
    assert.match(updated, /new_name = 1/);
    assert.match(updated, /new_name\(\)/);
    assert.match(updated, /text = "old_name"/);
    assert.match(updated, /# old_name stays here/);
  });

  it("structural operations batch supports heterogeneous languages", async () => {
    await writeFile(join(repoRoot, "calls.py"), "old_name()\n", "utf-8");
    await writeFile(
      join(repoRoot, "calls.rs"),
      "fn main() { old_name(); }\n",
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "python-call",
            targeting: "structural",
            query: {
              structural: {
                language: "python",
                treeSitterQuery: "(identifier) @target",
                requiredCaptures: { target: "old_name" },
              },
              replacement: "new_name",
              global: true,
            },
            editMode: "replacePattern",
            filters: { include: ["calls.py"] },
          },
          {
            id: "rust-call",
            targeting: "structural",
            query: {
              structural: {
                language: "rust",
                treeSitterQuery: "(identifier) @target",
                requiredCaptures: { target: "old_name" },
              },
              replacement: "new_name",
              global: true,
            },
            editMode: "replacePattern",
            filters: { include: ["calls.rs"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 2);
    assert.equal(preview.matchesFound, 2);
    assert.deepEqual(
      preview.fileEntries.map((entry) => entry.operationIds?.[0]).sort(),
      ["python-call", "rust-call"],
    );
    for (const entry of preview.fileEntries) {
      assert.equal(entry.astMatches?.length, 1);
      assert.equal(entry.astMatches?.[0]?.target.text, "old_name");
    }

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 2);
    assert.equal(apply.fileEntries?.length, 2);
    for (const entry of apply.fileEntries ?? []) {
      assert.equal(entry.astMatches?.length, 1);
      assert.equal(entry.astMatches?.[0]?.target.text, "old_name");
    }
    assert.equal(
      await readFile(join(repoRoot, "calls.py"), "utf-8"),
      "new_name()\n",
    );
    assert.equal(
      await readFile(join(repoRoot, "calls.rs"), "utf-8"),
      "fn main() { new_name(); }\n",
    );
  });

  it("loads configured plugin structural matchers before search.edit planning", async () => {
    const pluginPath = join(repoRoot, "plugin-structural.mjs");
    const adapterIndex = pathToFileURL(
      join(process.cwd(), "dist/indexer/adapter/index.js"),
    ).href;
    const queryHelper = pathToFileURL(
      join(process.cwd(), "dist/indexer/treesitter/tsTreesitter.js"),
    ).href;
    await writeFile(
      pluginPath,
      `
        import { TypeScriptAdapter } from ${JSON.stringify(adapterIndex)};
        import { createQueryForExtensionOrThrow } from ${JSON.stringify(queryHelper)};

        export const manifest = {
          name: "search-edit-structural-plugin",
          version: "1.0.0",
          apiVersion: "1.0.0",
          adapters: [{ extension: ".plug", languageId: "plug-ts" }]
        };

        export async function createAdapters() {
          return [{
            extension: ".plug",
            languageId: "plug-ts",
            factory: () => new TypeScriptAdapter(),
            structuralMatcher: {
              identifierNodeTypes: ["identifier"],
              createQuery: (queryString) =>
                createQueryForExtensionOrThrow(".ts", queryString)
            }
          }];
        }

        export default { manifest, createAdapters };
      `,
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "plugin-source.plug"),
      [
        "const oldName = 1;",
        'const text = "oldName";',
        "// oldName stays here",
        "oldName();",
        "",
      ].join("\n"),
      "utf-8",
    );

    resetRegistry();
    try {
      await loadConfiguredAdapterPlugins(
        {
          repos: [],
          plugins: {
            enabled: true,
            paths: [pluginPath],
            strictVersioning: true,
          },
        },
        join(repoRoot, "sdlmcp.config.json"),
      );

      const preview = (await handleSearchEdit(
        SearchEditRequestSchema.parse({
          mode: "preview",
          repoId: REPO_ID,
          targeting: "identifier",
          query: { literal: "oldName", replacement: "newName", global: true },
          editMode: "replacePattern",
          filters: { include: ["plugin-source.plug"] },
        }),
      )) as SearchEditPreviewResponse;

      assert.equal(preview.filesMatched, 1);
      assert.equal(preview.matchesFound, 2);
      assert.equal(
        preview.fileEntries[0]?.astMatches?.[0]?.target.nodeType,
        "identifier",
      );
    } finally {
      resetRegistry();
      loadBuiltInAdapters();
    }
  });

  it("infers structural language from same-language brace globs", async () => {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "brace.ts"), "old_name();\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery:
              "(call_expression function: (identifier) @target) @call",
            requiredCaptures: { target: "old_name" },
            replacement: "new_name",
          },
        },
        editMode: "replacePattern",
        filters: { include: ["src/**/*.{ts,tsx,js,jsx}"] },
        maxFiles: 2,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0]?.astMatches?.[0]?.target.text, "old_name");

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    assert.equal(await readFile(join(srcDir, "brace.ts"), "utf-8"), "new_name();\n");
  });

  it("validates TSX structural queries against TSX grammar during warm-up", async () => {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "plain.ts"),
      "export const plain = oldName;\n",
      "utf-8",
    );
    await writeFile(
      join(srcDir, "view.tsx"),
      "export const View = () => <Button oldName={value} />;\n",
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            language: "typescript",
            treeSitterQuery: `
              (jsx_attribute
                (property_identifier) @name) @target
            `,
            requiredCaptures: { name: "oldName" },
            replacement: "newName={value}",
          },
        },
        editMode: "replacePattern",
        filters: { include: ["src/view.tsx"] },
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0]?.file, "src/view.tsx");
    assert.equal(preview.fileEntries[0]?.astMatches?.[0]?.target.text, "oldName={value}");

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            targeting: "structural",
            query: {
              structural: {
                language: "typescript",
                treeSitterQuery: `
                  (jsx_attribute
                    (property_identifier) @name) @target
                `,
                requiredCaptures: { name: "oldName" },
                replacement: "newName={value}",
              },
            },
            editMode: "replacePattern",
            filters: { include: ["src/plain.ts", "src/view.tsx"] },
          }),
        ),
      /Invalid structural tree-sitter query for src\/plain\.ts/i,
    );
  });

  it("validates malformed structural queries before candidate matching", async () => {
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            targeting: "structural",
            query: {
              structural: {
                language: "python",
                treeSitterQuery: "(identifier",
                requiredCaptures: { target: "old_name" },
              },
              replacement: "new_name",
              global: true,
            },
            editMode: "replacePattern",
            filters: { include: ["missing/**/*.py"] },
          }),
        ),
      /Invalid structural tree-sitter query/i,
    );
  });

  it("requires explicit structural language for ambiguous multi-language requests", async () => {
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            targeting: "structural",
            query: {
              structural: {
                treeSitterQuery: "(identifier) @target",
                requiredCaptures: { target: "old_name" },
              },
              replacement: "new_name",
              global: true,
            },
            editMode: "replacePattern",
            filters: { extensions: [".py", ".rs"] },
          }),
        ),
      /spans multiple languages|requires query\.structural\.language/i,
    );
  });

  it("filters explicit structural language before maxFiles capping", async () => {
    await writeFile(
      join(repoRoot, "002-before-java.ts"),
      "oldName();\n",
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "zzz-java-target.java"),
      "class Target { void m() { oldName(); } }\n",
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            language: "java",
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "oldName" },
          },
          replacement: "newName",
          global: true,
        },
        editMode: "replacePattern",
        filters: { include: ["002-before-java.ts", "zzz-java-target.java"] },
        maxFiles: 1,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0].file, "zzz-java-target.java");
    assert.equal(preview.matchesFound, 1);
    assert.equal(
      preview.filesSkipped.some(
        (entry) =>
          entry.path === "002-before-java.ts" &&
          entry.reason === "structural-language-mismatch:typescript->java",
      ),
      true,
      "candidate filtering should report mismatches without counting them against maxFiles",
    );
  });

  it("reports explicit structural language mismatches from extension hints", async () => {
    await writeFile(join(repoRoot, "extension-mismatch.ts"), "oldName();\n", "utf-8");
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "glob-mismatch.ts"), "oldName();\n", "utf-8");

    const extensionPreview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            language: "java",
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "oldName" },
          },
          replacement: "newName",
          global: true,
        },
        editMode: "replacePattern",
        filters: { extensions: [".ts"] },
        maxFiles: 5,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(extensionPreview.filesMatched, 0);
    assert.equal(
      extensionPreview.filesSkipped.some(
        (entry) =>
          entry.path === "extension-mismatch.ts" &&
          entry.reason === "structural-language-mismatch:typescript->java",
      ),
      true,
    );

    const globPreview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            language: "java",
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "oldName" },
          },
          replacement: "newName",
          global: true,
        },
        editMode: "replacePattern",
        filters: { include: ["src/**/*.ts"] },
        maxFiles: 5,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(globPreview.filesMatched, 0);
    assert.equal(
      globPreview.filesSkipped.some(
        (entry) =>
          entry.path === "src/glob-mismatch.ts" &&
          entry.reason === "structural-language-mismatch:typescript->java",
      ),
      true,
    );
  });

  it("omits unrelated unsupported files from broad structural language skip diagnostics", async () => {
    await writeFile(join(repoRoot, "README.md"), "old_name()\n", "utf-8");
    await writeFile(join(repoRoot, "target.py"), "old_name()\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "structural",
        query: {
          structural: {
            language: "python",
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "old_name" },
          },
          replacement: "new_name",
          global: true,
        },
        editMode: "replacePattern",
        maxFiles: 5,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0]?.file, "target.py");
    assert.equal(
      preview.filesSkipped.some((entry) => entry.path === "README.md"),
      false,
    );
  });

  it("AST-aware targeting filters source candidates before maxFiles cap", async () => {
    await writeFile(
      join(repoRoot, "000-noise.txt"),
      "budgetTarget();\n",
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "001-budget-target.ts"),
      "budgetTarget();\n",
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "identifier",
        query: {
          literal: "budgetTarget",
          replacement: "budgetNext",
          global: true,
        },
        editMode: "replacePattern",
        maxFiles: 1,
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.filesEligible, 1);
    assert.equal(preview.fileEntries[0].file, "001-budget-target.ts");
    assert.equal(preview.matchesFound, 1);
  });

  it("preview can spill the large response behind response.get", async () => {
    const req = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: {
        literal: "oldName",
        replacement: "newName",
        global: true,
      },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
      responseMode: "handle",
    });
    const response = (await handleSearchEdit(req)) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(
      (response.metadata as Record<string, unknown>).toolName,
      "sdl.search.edit",
    );

    const full = (await handleResponseGet({
      repoId: REPO_ID,
      handle: response.handle,
      full: true,
    })) as Record<string, unknown>;
    const preview = full.content as SearchEditPreviewResponse;
    assert.equal(preview.mode, "preview");
    assert.ok(preview.planHandle.startsWith("se-"));
    assert.equal(preview.filesMatched, 2);
  });

  it("apply writes all files and removes backups on success", async () => {
    const previewReq = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
    });
    const preview = (await handleSearchEdit(
      previewReq,
    )) as SearchEditPreviewResponse;

    const applyReq = SearchEditRequestSchema.parse({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: preview.planHandle,
    });
    const apply = (await handleSearchEdit(applyReq)) as SearchEditApplyResponse;

    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 2);
    assert.equal(apply.filesFailed, 0);
    assert.equal(apply.rollback.triggered, false);
    assert.equal(apply.fileEntries?.length, preview.fileEntries.length);
    assert.match(apply.fileEntries?.[0]?.snippets.before ?? "", /oldName/);
    assert.match(apply.fileEntries?.[0]?.snippets.after ?? "", /newName/);

    const a = await readFile(join(repoRoot, "a.txt"), "utf-8");
    const b = await readFile(join(repoRoot, "b.txt"), "utf-8");
    assert.ok(a.includes("newName"));
    assert.ok(b.includes("newName"));
    assert.ok(!a.includes("oldName"));
    assert.ok(!b.includes("oldName"));
  });

  it("apply with unknown planHandle fails closed", async () => {
    const applyReq = SearchEditRequestSchema.parse({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: "se-bogus-deadbeef",
    });
    await assert.rejects(
      () => handleSearchEdit(applyReq),
      /missing or expired/i,
    );
  });

  it("apply after drift fails closed and writes nothing further", async () => {
    // Reset content so preview sees "oldName".
    await writeFile(join(repoRoot, "a.txt"), "oldName again\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "oldName again\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Drift one file between preview and apply.
    await writeFile(
      join(repoRoot, "a.txt"),
      "someone else got there first\n",
      "utf-8",
    );

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: REPO_ID,
            planHandle: preview.planHandle,
          }),
        ),
      /drifted/i,
    );

    // b.txt must NOT have been written — drift check aborts before the
    // first write.
    const b = await readFile(join(repoRoot, "b.txt"), "utf-8");
    assert.ok(b.includes("oldName"));
  });

  it("preview populates retrievalEvidence when hybrid narrowing runs", async () => {
    // Reset content so preview has a literal match of >=3 chars.
    await writeFile(join(repoRoot, "a.txt"), "hello oldName world\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "oldName line\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
          global: true,
        },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Any literal of length >= 3 routes through narrowFilesForQuery ->
    // entitySearch(..., includeEvidence: true). Even when the hybrid
    // backend is degraded (no FTS index built on this temp repo, no
    // vector model available), entitySearch returns a fallback-evidence
    // payload so callers can reason about *why* narrowing produced no
    // candidates. The planner copies that through unchanged.
    assert.ok(
      preview.retrievalEvidence,
      "retrievalEvidence should be populated for text-mode preview with hybrid narrowing",
    );
    const ev = preview.retrievalEvidence!;
    assert.ok(
      Array.isArray(ev.sources),
      "retrievalEvidence.sources must be an array",
    );
    assert.ok(
      ev.topRanksPerSource && typeof ev.topRanksPerSource === "object",
      "retrievalEvidence.topRanksPerSource must be an object",
    );
    assert.ok(
      ev.candidateCountPerSource &&
        typeof ev.candidateCountPerSource === "object",
      "retrievalEvidence.candidateCountPerSource must be an object",
    );
    // Either the hybrid path produced real sources OR the orchestrator
    // recorded a fallbackReason describing why. Never both empty.
    const hasSources = ev.sources.length > 0;
    const hasFallback =
      typeof ev.fallbackReason === "string" && ev.fallbackReason.length > 0;
    assert.ok(
      hasSources || hasFallback,
      `retrievalEvidence should expose sources or fallbackReason; got ${JSON.stringify(ev)}`,
    );
  });

  it("apply rejects an expired planHandle (fail-closed on TTL)", async () => {
    // Swap in a store with a tiny TTL so we can expire a handle deterministically.
    resetSearchEditPlanStore({ ttlMs: 5 });
    try {
      const expiringRel = "expired.txt";
      await writeFile(join(repoRoot, expiringRel), "original\n", "utf-8");

      const preview = (await handleSearchEdit(
        SearchEditRequestSchema.parse({
          mode: "preview",
          repoId: REPO_ID,
          targeting: "text",
          query: {
            literal: "original",
            replacement: "replaced",
            global: true,
          },
          editMode: "replacePattern",
          filters: { extensions: [".txt"], include: [expiringRel] },
        }),
      )) as SearchEditPreviewResponse;
      assert.ok(preview.planHandle, "preview should return a handle");

      // Let the TTL expire.
      await new Promise((resolve) => setTimeout(resolve, 30));

      await assert.rejects(
        () =>
          handleSearchEdit(
            SearchEditRequestSchema.parse({
              mode: "apply",
              repoId: REPO_ID,
              planHandle: preview.planHandle,
            }),
          ),
        /expired|not.*found|unknown|invalid/i,
        "apply must reject expired handles",
      );

      // Disk content unchanged.
      const content = await readFile(join(repoRoot, expiringRel), "utf-8");
      assert.equal(content, "original\n");
    } finally {
      // Restore the default store for other tests.
      resetSearchEditPlanStore();
    }
  });

  it("double-apply with same planHandle fails closed (M4)", async () => {
    // Reset content so preview has matches.
    await writeFile(join(repoRoot, "a.txt"), "oldName here\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "oldName there\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // First apply should succeed.
    const apply1 = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;
    assert.equal(apply1.mode, "apply");
    assert.ok(apply1.filesWritten >= 1);

    // Second apply with same handle must fail.
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: REPO_ID,
            planHandle: preview.planHandle,
          }),
        ),
      /missing or expired/i,
    );
  });
  it("apply with mismatched repoId fails closed (M5)", async () => {
    // Reset content so preview has matches.
    await writeFile(join(repoRoot, "a.txt"), "oldName here\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Apply with wrong repoId must fail referencing the original repoId.
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: "wrong-repo-id",
            planHandle: preview.planHandle,
          }),
        ),
      new RegExp(REPO_ID),
    );
  });

  it("batch preview/apply merges two operations in one file", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "alpha-op",
            targeting: "text",
            query: { literal: "alpha", replacement: "ALPHA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "beta-op",
            targeting: "text",
            query: { literal: "beta", replacement: "BETA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 2);
    assert.deepEqual((preview.fileEntries[0] as any).operationIds, [
      "alpha-op",
      "beta-op",
    ]);

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    assert.equal(
      await readFile(join(repoRoot, "a.txt"), "utf-8"),
      "ALPHA BETA\n",
    );
  });

  it("batch preview preserves AST match summaries for AST-aware operations", async () => {
    await writeFile(
      join(repoRoot, "batch-ast.ts"),
      "oldName();\notherName();\n",
      "utf-8",
    );

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "identifier-op",
            targeting: "identifier",
            query: { literal: "oldName", replacement: "newName", global: true },
            editMode: "replacePattern",
            filters: { include: ["batch-ast.ts"] },
          },
          {
            id: "structural-op",
            targeting: "structural",
            query: {
              structural: {
                treeSitterQuery:
                  "(call_expression function: (identifier) @callee arguments: (arguments) @args) @target",
                requiredCaptures: { callee: "otherName" },
              },
              replacement: "nextName$args",
              global: true,
            },
            editMode: "replacePattern",
            filters: { include: ["batch-ast.ts"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 2);
    assert.equal(preview.fileEntries[0].astMatches?.length, 2);
    assert.deepEqual((preview.fileEntries[0] as any).operationIds, [
      "identifier-op",
      "structural-op",
    ]);

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    assert.equal(apply.fileEntries?.[0].astMatches?.length, 2);
    assert.equal(
      await readFile(join(repoRoot, "batch-ast.ts"), "utf-8"),
      "newName();\nnextName();\n",
    );
  });

  it("batch preview/apply supports operations across multiple files", async () => {
    await writeFile(join(repoRoot, "a.txt"), "left token\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "right token\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "left-op",
            targeting: "text",
            query: { literal: "left", replacement: "LEFT", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "right-op",
            targeting: "text",
            query: { literal: "right", replacement: "RIGHT", global: true },
            editMode: "replacePattern",
            filters: { include: ["b.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 2);
    assert.deepEqual(
      preview.fileEntries
        .map((entry) => [(entry as any).operationIds[0], entry.file])
        .sort(),
      [
        ["left-op", "a.txt"],
        ["right-op", "b.txt"],
      ],
    );

    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(
      await readFile(join(repoRoot, "a.txt"), "utf-8"),
      "LEFT token\n",
    );
    assert.equal(
      await readFile(join(repoRoot, "b.txt"), "utf-8"),
      "RIGHT token\n",
    );
  });

  it("batch apply only merges each operation's planned original-source diff", async () => {
    await writeFile(join(repoRoot, "a.txt"), "foo marker\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "foo-to-bar",
            targeting: "text",
            query: { literal: "foo", replacement: "bar", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "bar-to-baz",
            targeting: "text",
            query: { literal: "bar", replacement: "baz", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.matchesFound, 1);
    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(
      await readFile(join(repoRoot, "a.txt"), "utf-8"),
      "bar marker\n",
    );
  });

  it("batch preview applies shared top-level filters to operations", async () => {
    await writeFile(join(repoRoot, "a.txt"), "shared token\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "shared token\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        filters: { include: ["a.txt"] },
        operations: [
          {
            id: "shared-op",
            targeting: "text",
            query: { literal: "shared", replacement: "SHARED", global: true },
            editMode: "replacePattern",
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0].file, "a.txt");
  });

  it("batch preview permits disjoint edits when one operation has multiple matches", async () => {
    await writeFile(join(repoRoot, "a.txt"), "a x a\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "a-op",
            targeting: "text",
            query: { literal: "a", replacement: "A", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "x-op",
            targeting: "text",
            query: { literal: "x", replacement: "X", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 3);

    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(await readFile(join(repoRoot, "a.txt"), "utf-8"), "A X A\n");
  });

  it("batch preview rejects zero-width edits inside another operation range", async () => {
    await writeFile(join(repoRoot, "a.txt"), "abcdef\n", "utf-8");

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            operations: [
              {
                id: "replace-cde",
                targeting: "text",
                query: { literal: "cde", replacement: "XY", global: true },
                editMode: "replacePattern",
                filters: { include: ["a.txt"] },
              },
              {
                id: "insert-before-d",
                targeting: "text",
                query: { regex: "(?=d)", replacement: "_", global: true },
                editMode: "replacePattern",
                filters: { include: ["a.txt"] },
              },
            ],
          }),
        ),
      /replace-cde.*insert-before-d.*overlap/i,
    );
  });

  it("batch preview enforces aggregate top-level match caps", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        maxMatchesPerFile: 1,
        maxTotalMatches: 1,
        operations: [
          {
            id: "alpha-op",
            targeting: "text",
            query: { literal: "alpha", replacement: "ALPHA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "beta-op",
            targeting: "text",
            query: { literal: "beta", replacement: "BETA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 0);
    assert.equal(preview.matchesFound, 0);
    assert.ok(
      preview.filesSkipped.some((entry) =>
        entry.reason.startsWith("matches-exceed-per-file-cap:"),
      ),
    );
  });

  it("batch preview rejects overlapping operation ranges", async () => {
    await writeFile(join(repoRoot, "a.txt"), "one\ntwo\n", "utf-8");

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            operations: [
              {
                id: "first",
                targeting: "text",
                query: {
                  literal: "one",
                  replaceLines: { start: 0, end: 1, content: "ONE" },
                },
                editMode: "replaceLines",
                filters: { include: ["a.txt"] },
              },
              {
                id: "second",
                targeting: "text",
                query: {
                  literal: "one",
                  replaceLines: { start: 0, end: 1, content: "TWO" },
                },
                editMode: "replaceLines",
                filters: { include: ["a.txt"] },
              },
            ],
          }),
        ),
      /first.*second.*a\.txt.*overlap/i,
    );
  });

  it("batch preview rejects duplicate explicit operation ids", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    await assert.rejects(async () => {
      const request = SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "rename",
            targeting: "text",
            query: { literal: "alpha", replacement: "ALPHA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "rename",
            targeting: "text",
            query: { literal: "beta", replacement: "BETA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      });
      await handleSearchEdit(request);
    }, /duplicate.*operation.*rename/i);
  });
});
