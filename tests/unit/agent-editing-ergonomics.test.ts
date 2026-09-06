import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../../dist/code-mode/action-catalog.js";
import { MANUAL_DESCRIPTION } from "../../dist/code-mode/descriptions.js";
import { FileReadRequestSchema, FileWriteRequestSchema, FileWriteResponseSchema } from "../../dist/mcp/tools.js";
import { buildToolResponseEnvelope } from "../../dist/server.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";

describe("agent editing and discovery ergonomics", () => {

  it("keeps routine workflow command evidence useful without diagnostic flags", () => {
    for (const outputMode of ["summary", "digest", "minimal"]) {
      const args = { repoId: "fixture", outputMode };
      const canonical = {
        status: "success", exitCode: 0, durationMs: 99,
        stdoutSummary: "## main...origin/main",
        stderrSummary: "",
        digest: { summary: "checks passed" },
        artifactHandle: "runtime-fixture-output",
        truncation: { totalStdoutBytes: 24, totalStderrBytes: 0 },
      };
      const runtime = projectToolResultForModelContent("sdl.runtime.execute", canonical, args);
      const envelope = buildToolResponseEnvelope({
        results: [{ fn: "runtimeExecute", result: runtime }],
        diagnostics: { timings: { totalMs: 99 } },
      }, null, "", "sdl.workflow", {
        repoId: "fixture", steps: [{ fn: "runtimeExecute", args: { outputMode } }],
      });
      const text = JSON.stringify(envelope.structuredContent);
      assert.doesNotMatch(text, /durationMs|totalMs|diagnostics/);
      if (outputMode === "summary") assert.match(text, /main\.\.\.origin\/main/);
      if (outputMode === "digest") assert.match(text, /checks passed/);
      if (outputMode === "minimal") {
        assert.match(text, /artifactHandle/);
        assert.match(text, /runtimeQueryOutput/);
      }
      assert.equal(canonical.durationMs, 99);
    }
    const failure = buildToolResponseEnvelope({
      results: [{
        fn: "runtimeExecute", status: "error",
        error: "runtime.execute failed: exit code 1",
        result: { exitCode: 1, stderrSummary: "check failed" },
      }],
    }, null, "", "sdl.workflow", {
      repoId: "fixture", steps: [{ fn: "runtimeExecute", args: { outputMode: "summary" } }],
    });
    assert.match(JSON.stringify(failure.structuredContent), /check failed/);
    assert.match(JSON.stringify(failure.structuredContent), /"status":"error"/);
  });

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
