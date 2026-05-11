import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLspSpawnCommand,
  SemanticLspClient,
} from "../../dist/semantic/providers/lsp/client.js";

describe("SemanticLspClient", () => {
  it("guards LSP requests until initialize completes", async () => {
    const client = new SemanticLspClient({
      serverId: "mock",
      command: process.execPath,
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
    });

    await assert.rejects(
      () => client.documentSymbols("file:///tmp/example.ts"),
      /not initialized/,
    );
  });
  it("wraps Windows command shims with cmd.exe", () => {
    assert.deepEqual(
      resolveLspSpawnCommand({
        command: "C:\\tools\\typescript-language-server.cmd",
        args: ["--stdio"],
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
      {
        command: "C:\\Windows\\System32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "C:\\tools\\typescript-language-server.cmd",
          "--stdio",
        ],
        shell: false,
      },
    );

    assert.deepEqual(
      resolveLspSpawnCommand({
        command: '"C:\\Program Files\\server.bat"',
        platform: "win32",
        comspec: "cmd.exe",
      }),
      {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "C:\\Program Files\\server.bat"],
        shell: false,
      },
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
