import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLspSpawnCommand,
  SemanticLspClient,
} from "../../dist/semantic/providers/lsp/client.js";

function npmShim(
  script = "%~dp0\\node_modules\\typescript-language-server\\lib\\cli.js",
): string {
  return `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "${script}" %*
) ELSE (
  node "${script}" %*
)`;
}

describe("SemanticLspClient", () => {
  it("guards LSP requests until initialize completes", async () => {
    const client = new SemanticLspClient({
      serverId: "mock",
      command: process.execPath,
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
    });

    await assert.rejects(
      () => client.hover("file:///tmp/example.ts", { line: 0, character: 0 }),
      /not initialized/,
    );
  });

  it("starts explicit Windows npm command shims through node entrypoints", () => {
    assert.deepEqual(
      resolveLspSpawnCommand({
        command: "C:\\tools\\typescript-language-server.cmd",
        args: ["--stdio"],
        platform: "win32",
        nodeExecPath: "C:\\node\\node.exe",
        readFileText: () => npmShim(),
      }),
      {
        command: "C:\\node\\node.exe",
        args: [
          "C:\\tools\\node_modules\\typescript-language-server\\lib\\cli.js",
          "--stdio",
        ],
        shell: false,
      },
    );
  });

  it("resolves bare Windows commands through PATH and PATHEXT", () => {
    assert.deepEqual(
      resolveLspSpawnCommand({
        command: "typescript-language-server",
        args: ["--stdio"],
        platform: "win32",
        envPath: "C:\\tools;C:\\unused",
        pathExt: ".CMD;.EXE",
        nodeExecPath: "C:\\node\\node.exe",
        fileExists: (path) =>
          path === "C:\\tools\\typescript-language-server.CMD",
        readFileText: () => npmShim(),
      }),
      {
        command: "C:\\node\\node.exe",
        args: [
          "C:\\tools\\node_modules\\typescript-language-server\\lib\\cli.js",
          "--stdio",
        ],
        shell: false,
      },
    );
  });

  it("rejects unsupported Windows batch shims instead of invoking cmd.exe", () => {
    assert.throws(
      () =>
        resolveLspSpawnCommand({
          command: '"C:\\Program Files\\server.bat"',
          platform: "win32",
          readFileText: () => "echo unsafe %*",
        }),
      /not a supported npm-style shim/,
    );
  });

  it("keeps native executables and non-Windows commands shell-free", () => {
    assert.equal(
      resolveLspSpawnCommand({
        command: "C:\\tools\\server.exe",
        platform: "win32",
      }).shell,
      false,
    );
    assert.equal(
      resolveLspSpawnCommand({
        command: "/usr/local/bin/server.cmd",
        platform: "linux",
      }).shell,
      false,
    );
  });
});
