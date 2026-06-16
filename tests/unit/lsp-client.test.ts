import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

  it("pulls diagnostics from diagnosticProvider servers", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests/fixtures/lsp/mock-diagnostic-server.mjs",
    );
    const sourcePath = join(
      process.cwd(),
      "tests/fixtures/lsp/diagnostic-example.py",
    );
    const sourceText = "x = unknown\n";

    const client = new SemanticLspClient({
      serverId: "mock-diagnostic",
      command: process.execPath,
      args: [fixturePath],
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
    });

    try {
      const initializeResult = await client.start();
      assert.ok(initializeResult.capabilities.diagnosticProvider);
      const uri = pathToFileURL(sourcePath).toString();
      await client.openDocument({
        uri,
        languageId: "python",
        version: 1,
        text: sourceText,
      });

      const diagnostics = await client.pullDiagnostics(uri, 1000);

      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].message, "Pulled diagnostic");
      assert.equal(diagnostics[0].source, "client-capability-advertised");
      assert.deepEqual(client.diagnostics(uri), diagnostics);
    } finally {
      await client.dispose();
    }
  });

  it("accepts LSP responses with Content-Type before Content-Length", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests/fixtures/lsp/mock-content-type-first-server.mjs",
    );
    const client = new SemanticLspClient({
      serverId: "content-type-first",
      command: process.execPath,
      args: [fixturePath],
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
    });

    try {
      const initializeResult = await client.start();
      assert.equal(initializeResult.serverInfo?.name, "content-type-first");
      assert.equal(initializeResult.capabilities.documentSymbolProvider, true);
    } finally {
      await client.dispose();
    }
  });

  it("passes configured environment variables to the LSP process", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests/fixtures/lsp/mock-env-server.mjs",
    );
    const client = new SemanticLspClient({
      serverId: "env-server",
      command: process.execPath,
      args: [fixturePath],
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
      env: {
        MOCK_LSP_ENV_VALUE: "configured",
      },
    });

    try {
      const initializeResult = await client.start();
      assert.equal(initializeResult.serverInfo?.version, "configured");
    } finally {
      await client.dispose();
    }
  });

  it("advertises standard initialize capabilities", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests/fixtures/lsp/mock-capabilities-server.mjs",
    );
    const client = new SemanticLspClient({
      serverId: "capabilities-server",
      command: process.execPath,
      args: [fixturePath],
      workspaceRoot: process.cwd(),
      timeoutMs: 1000,
    });

    try {
      const initializeResult = await client.start();
      assert.equal(initializeResult.serverInfo?.version, "standard");
    } finally {
      await client.dispose();
    }
  });

  it("does not hang when a server ignores shutdown", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests/fixtures/lsp/mock-no-shutdown-server.mjs",
    );
    const client = new SemanticLspClient({
      serverId: "no-shutdown",
      command: process.execPath,
      args: [fixturePath],
      workspaceRoot: process.cwd(),
      timeoutMs: 5_000,
    });

    const initializeResult = await client.start();
    assert.equal(initializeResult.serverInfo?.name, "no-shutdown");

    const startedAt = Date.now();
    await client.dispose();

    assert.ok(
      Date.now() - startedAt < 2_000,
      "dispose should use the bounded shutdown timeout",
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

  it("preserves spaces when resolving Windows npm shim entrypoints", () => {
    assert.deepEqual(
      resolveLspSpawnCommand({
        command:
          "C:\\Users\\me\\AppData\\Local\\lsp io\\servers\\node_modules\\.bin\\server.cmd",
        args: ["--stdio"],
        platform: "win32",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        readFileText: () =>
          npmShim("%~dp0\\..\\server package\\bin\\language-server.js"),
      }),
      {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [
          "C:\\Users\\me\\AppData\\Local\\lsp io\\servers\\node_modules\\server package\\bin\\language-server.js",
          "--stdio",
        ],
        shell: false,
      },
    );
  });

  it("starts Windows RubyGems command shims through ruby entrypoints", () => {
    assert.deepEqual(
      resolveLspSpawnCommand({
        command: "C:\\tools\\ruby-lsp.bat",
        args: ["--stdio"],
        platform: "win32",
        readFileText: () => '@ECHO OFF\r\n@ruby.exe "%~dpn0" %*\r\n',
      }),
      {
        command: "ruby.exe",
        args: ["C:\\tools\\ruby-lsp", "--stdio"],
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
