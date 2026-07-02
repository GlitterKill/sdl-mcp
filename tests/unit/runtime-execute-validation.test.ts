import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeExecuteRequestSchema } from "../../dist/mcp/tools.js";
import { handleRuntimeExecute } from "../../dist/mcp/tools/runtime.js";

describe("runtime.execute validation", () => {

  it("normalizes shell command alias to code", () => {
    const parsed = RuntimeExecuteRequestSchema.parse({
      repoId: "demo",
      runtime: "shell",
      command: "git status --short",
    });

    assert.equal(parsed.code, "git status --short");
  });

  it("adds platform-aware shell guidance to invalid args-only shell requests", async () => {
    await assert.rejects(
      () =>
        handleRuntimeExecute({
          repoId: "demo",
          runtime: "shell",
          args: ["echo", "ok"],
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(process.platform));
        assert.match(message, /runtime:\s*\"shell\"|runtime: 'shell'/);
        assert.match(message, /code/);
        assert.match(message, /Use code, not args/);
        return true;
      },
    );
  });
});
