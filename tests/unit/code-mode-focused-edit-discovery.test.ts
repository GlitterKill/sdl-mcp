import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { handleManual, handleActionSearch } from "../../dist/code-mode/index.js";
import { invalidateCatalog } from "../../dist/code-mode/action-catalog.js";
import { FileWriteRequestSchema, SymbolEditRequestSchema } from "../../dist/mcp/tools.js";

describe("focused edit schema discovery", () => {
  it("exposes required line fields and indexing semantics in every focused format", () => {
    for (const format of ["json", "typescript", "markdown"]) {
      const args = { actions: ["file.write"], includeSchemas: true, includeExamples: true, format };
      const result = handleManual(args);
      const rendered = JSON.stringify(result);
      assert.match(rendered, /0-based, inclusive/);
      assert.match(rendered, /0-based, exclusive/);
      assert.ok(rendered.length < 14000, "one focused action stays bounded");
      invalidateCatalog();
      assert.equal(JSON.stringify(handleManual(args)), rendered);
    }
    const result = handleManual({
      actions: ["file.write"], includeSchemas: true, includeExamples: true, format: "json",
    });
    const action = result.actions[0];
    const range = action.schemaSummary.fields.find((field) => field.name === "replaceLines");
    assert.deepEqual(range.subFields.filter((field) => field.required).map((field) => field.name), ["start", "end", "content"]);
    assert.ok(FileWriteRequestSchema.safeParse({ repoId: "test", ...action.example }).success);
    assert.deepEqual(action.example.replaceLines, { start: 0, end: 1, content: "const value = 1;" });
  });

  it("resolves file symbol edit selectors to a usable canonical schema and example", () => {
    for (const selector of ["file.symbolEditPreview", "file.symbolEditApply", "file.symbolEditApplyNow", "sdl.file.symbolEditPreview"]) {
      const result = handleManual({
        actions: [selector], includeSchemas: true, includeExamples: true, format: "json",
      });
      assert.equal(result.actions.length, 1);
      const action = result.actions[0];
      assert.equal(action.action, "symbol.edit");
      const operation = action.schemaSummary.fields.find((field) => field.name === "operation");
      assert.equal(operation.discriminator, "kind");
      assert.deepEqual(operation.variants.find((variant) => variant.value === "replaceBody").requiredFields, ["kind", "content"]);
      assert.ok(SymbolEditRequestSchema.safeParse({ repoId: "test", ...action.example }).success);
      assert.ok(JSON.stringify(result).length < 18000);
    }
  });

  it("keeps focused edit manuals byte-stable across fresh processes", () => {
    const moduleUrl = new URL("../../dist/code-mode/index.js", import.meta.url).href;
    const script = `
      import { handleManual } from ${JSON.stringify(moduleUrl)};
      const results = ["json", "typescript", "markdown"].map((format) =>
        handleManual({
          actions: ["file.write", "file.symbolEditPreview", "file.symbolEditApply"],
          includeSchemas: true,
          includeExamples: true,
          detail: "compact",
          format,
        }, { actionAvailability: { memoryTools: false, infoTool: true } })
      );
      process.stdout.write(JSON.stringify(results));
    `;
    const run = () => {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 128 * 1024,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      return child.stdout;
    };
    const first = run();
    assert.equal(run(), first);
    const results = JSON.parse(first);
    assert.deepEqual(results[0].actions.map((action) => action.action), ["file.write", "symbol.edit"]);
    assert.match(first, /0-based, exclusive/);
  });

  it("keeps broad wildcard and action search schemas compact", () => {
    const wildcard = handleManual({ actions: ["file.*"], includeSchemas: true, format: "json" });
    const file = wildcard.actions.find((action) => action.action === "file.write");
    const range = file.schemaSummary.fields.find((field) => field.name === "replaceLines");
    assert.equal(range.subFields, undefined);
    assert.equal(range.nestedFieldCount, 3);
    const search = handleActionSearch({ query: "file.write", includeSchemas: true });
    assert.ok(search.actions.every((action) => action.schemaSummary?.fields.every((field) => !field.subFields)));
  });
});
