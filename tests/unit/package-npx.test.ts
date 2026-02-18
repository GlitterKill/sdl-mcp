import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("npx packaging metadata", () => {
  it("includes correct bin entry and runtime asset files", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      bin?: Record<string, string>;
      files?: string[];
    };

    assert.strictEqual(pkg.bin?.["sdl-mcp"], "dist/cli/index.js");
    const files = new Set(pkg.files ?? []);
    assert.ok(files.has("dist"));
    assert.ok(files.has("config"));
    assert.ok(files.has("migrations"));
    assert.ok(files.has("templates"));
  });
});
