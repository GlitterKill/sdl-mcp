import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("serve command stdio shutdown wiring", () => {
  it("uses ShutdownManager with monitorStdin for stdin end/close handling", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    assert.match(
      source,
      /ShutdownManager/,
      "serve.ts must use ShutdownManager for shutdown coordination",
    );

    assert.match(
      source,
      /monitorStdin/,
      "serve.ts must call monitorStdin() so Node.js does not " +
        "silently exit when stdin closes (e.g. Nix shells, CI, piped invocations)",
    );
  });

  it("ShutdownManager.monitorStdin registers stdin end/close handlers", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );

    assert.match(
      source,
      /process\.stdin\.once\("end",/,
      "ShutdownManager must register a stdin 'end' handler",
    );

    assert.match(
      source,
      /process\.stdin\.once\("close",/,
      "ShutdownManager must register a stdin 'close' handler",
    );
  });

  it("gates stdin monitoring on stdio transport only", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    // monitorStdin should be inside an `if (options.transport === "stdio")` block
    // so it is not registered for the HTTP transport path.
    const stdioBlock = source.match(
      /if\s*\(options\.transport\s*===\s*["']stdio["']\)\s*\{[^}]*monitorStdin/s,
    );

    assert.ok(
      stdioBlock,
      "stdin monitoring must be gated on options.transport === 'stdio'",
    );
  });
});
