import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeConfigSchema } from "../../dist/config/types.js";
import { handleRuntimeExecute } from "../../dist/mcp/tools/runtime.js";
import {
  getRuntime,
  getRuntimeDefaultExecutable,
  isExecutableCompatibleWithRuntime,
} from "../../dist/runtime/runtimes.js";

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

  it("registers PowerShell as a distinct runtime", () => {
    const runtime = getRuntime("powershell");
    const expectedExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";

    assert.ok(runtime);
    assert.strictEqual(getRuntimeDefaultExecutable("powershell"), expectedExecutable);
    assert.ok(isExecutableCompatibleWithRuntime("powershell", expectedExecutable));
    assert.ok(isExecutableCompatibleWithRuntime("powershell", "powershell"));
    assert.deepStrictEqual(runtime.buildCommand([], { codePath: "script.ps1" }), {
      executable: expectedExecutable,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "script.ps1"],
    });
    assert.ok(RuntimeConfigSchema.parse({}).allowedRuntimes.includes("powershell"));
  });
});
