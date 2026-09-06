import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../../dist/code-mode/action-catalog.js";
import { MANUAL_DESCRIPTION } from "../../dist/code-mode/descriptions.js";
import { FileReadRequestSchema, FileWriteRequestSchema, FileWriteResponseSchema } from "../../dist/mcp/tools.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";

describe("agent editing and discovery ergonomics", () => {
  it("exposes regex semantics, context bounds and newline-safe examples in focused discovery", () => {
    assert.match(MANUAL_DESCRIPTION, /actions/);
    assert.match(MANUAL_DESCRIPTION, /reuse/i);
    assert.doesNotMatch(MANUAL_DESCRIPTION, /before using sdl.context/);
    const catalog = buildCatalog({ includeSchemas: true, includeExamples: true, detail: "full" });
    const read = catalog.find((entry) => entry.action === "file.read");
    assert.ok(read);
    assert.match(read.schemaSummary?.fields.find((field) => field.name === "search")?.description ?? "", /regex.*escape/i);
    assert.match(read.schemaSummary?.fields.find((field) => field.name === "searchContext")?.description ?? "", /0.?20/);
    FileReadRequestSchema.parse({ repoId: "fixture", ...read.example });
    const write = catalog.find((entry) => entry.action === "file.write");
    assert.ok(write);
    const example = FileWriteRequestSchema.parse({ repoId: "fixture", ...write.example });
    assert.ok(example.replacePattern);
    const pattern = new RegExp(example.replacePattern.pattern);
    assert.ok(pattern.test("oldName\r\n"));
    assert.ok(pattern.test("oldName\n"));
    assert.match(write.schemaSummary?.fields.find((field) => field.name === "replacePattern")?.description ?? "", /line endings/);
    const output = catalog.find((entry) => entry.action === "runtime.queryOutput");
    assert.equal(output?.example?.stream, "both");
    assert.match(output?.description ?? "", /replay.*nextAction/i);
    assert.deepEqual(output?.schemaSummary?.fields.find((field) => field.name === "stream")?.enumValues, ["stdout", "stderr", "both"]);
  });

  it("preserves bounded no-change guidance through compact and full file-write projections", () => {
    const canonical = {
      filePath: "config/example.txt",
      bytesWritten: 0,
      linesWritten: 0,
      mode: "replacePattern",
      replacementCount: 0,
      hint: "No text changed. Check the pattern and line endings (\\r?\\n), or use replaceLines.",
    };
    for (const detail of ["compact", "full"]) {
      for (const tool of ["sdl.file.write", "sdl.file"]) {
        const args = { repoId: "fixture", detail, ...(tool === "sdl.file" ? { op: "write" } : {}) };
        const projected = projectToolResultForModelContent(tool, canonical, args);
        const parsed = FileWriteResponseSchema.parse(projected);
        assert.equal(parsed.hint, canonical.hint);
        assert.equal(parsed.indexUpdate, undefined);
        assert.equal(JSON.stringify(projected), JSON.stringify(projectToolResultForModelContent(tool, canonical, args)));
      }
    }
  });
});
