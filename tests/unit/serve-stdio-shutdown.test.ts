import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("serve command stdio shutdown wiring", () => {
  it("registers stdin end/close handlers to prevent silent exit on non-TTY environments", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    assert.match(
      source,
      /process\.stdin\.once\("end",/,
      "serve.ts must register a stdin 'end' handler so Node.js does not " +
        "silently exit when stdin closes (e.g. Nix shells, CI, piped invocations)",
    );

    assert.match(
      source,
      /process\.stdin\.once\("close",/,
      "serve.ts must register a stdin 'close' handler so Node.js does not " +
        "silently exit when the MCP client disconnects",
    );
  });

  it("gates stdin handlers on stdio transport only", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    // Handlers should be inside an `if (options.transport === "stdio")` block
    // so they are not registered for the HTTP transport path.
    const stdioBlock = source.match(
      /if\s*\(options\.transport\s*===\s*["']stdio["']\)\s*\{[^}]+process\.stdin\.once/s,
    );

    assert.ok(
      stdioBlock,
      "stdin close handlers must be gated on options.transport === 'stdio'",
    );
  });
});
