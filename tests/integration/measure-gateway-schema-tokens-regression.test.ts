import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

describe("measure-gateway-schema-tokens regression", () => {
  it("runs successfully after createMCPServer became async", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/measure-gateway-schema-tokens.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.strictEqual(
      result.status,
      0,
      `script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /SDL-MCP Gateway Schema Token Measurement/);
  });
});
