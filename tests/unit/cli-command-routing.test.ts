import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("CLI command routing", () => {
  it("includes summary and health commands in CLI entrypoint", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "index.ts"),
      "utf8",
    );

    assert.match(source, /case "summary":/);
    assert.match(source, /case "health":/);
  });
});
