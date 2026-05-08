import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SemanticLspClient } from "../../dist/semantic/providers/lsp/client.js";

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
});
