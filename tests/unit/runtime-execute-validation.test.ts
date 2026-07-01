import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeExecute } from "../../dist/mcp/tools/runtime.js";

describe("runtime.execute validation", () => {
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
