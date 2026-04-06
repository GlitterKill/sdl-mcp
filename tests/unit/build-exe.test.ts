import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNexeInvocation,
  buildPkgInvocation,
  resolveNpxExecutable,
  resolveRepoRootFromScriptDir,
} from "../../dist/scripts/build-exe.js";

describe("build-exe helpers", () => {
  it("uses npx.cmd on Windows", () => {
    assert.equal(resolveNpxExecutable("win32"), "npx.cmd");
  });

  it("uses npx on non-Windows platforms", () => {
    assert.equal(resolveNpxExecutable("linux"), "npx");
  });

  it("builds pkg arguments without shell interpolation", () => {
    assert.deepEqual(
      buildPkgInvocation("dist/cli/index.js", ["node18-linux-x64"], "dist/exe/sdl-mcp", "linux"),
      {
        command: "npx",
        args: [
          "pkg",
          "dist/cli/index.js",
          "--targets",
          "node18-linux-x64",
          "--output",
          "dist/exe/sdl-mcp",
        ],
      },
    );
  });

  it("builds nexe arguments without shell interpolation", () => {
    assert.deepEqual(
      buildNexeInvocation("dist/cli/index.js", "dist/exe/sdl-mcp.exe", "win32"),
      {
        command: "npx.cmd",
        args: [
          "nexe",
          "dist/cli/index.js",
          "--output",
          "dist/exe/sdl-mcp.exe",
        ],
      },
    );
  });

  it("resolves the repository root from source and dist script directories", () => {
    assert.equal(
      resolveRepoRootFromScriptDir("F:/repo/scripts"),
      "F:/repo",
    );
    assert.equal(
      resolveRepoRootFromScriptDir("F:/repo/dist/scripts"),
      "F:/repo",
    );
  });
});
