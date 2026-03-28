import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PolicyConfigSchema,
  PrefetchConfigSchema,
} from "../../dist/config/types.js";
import { PolicyGetResponseSchema } from "../../dist/mcp/tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

describe("config surface sync", () => {
  it("keeps allowBreakGlass defaults aligned across config, MCP schema, sample config, and init dry-run", () => {
    assert.strictEqual(PolicyConfigSchema.parse({}).allowBreakGlass, false);
    assert.strictEqual(
      PolicyGetResponseSchema.parse({ policy: {} }).policy.allowBreakGlass,
      false,
    );

    const schema = JSON.parse(
      readFileSync(resolve(repoRoot, "config/sdlmcp.config.schema.json"), "utf8"),
    );
    assert.strictEqual(
      schema.properties.policy.properties.allowBreakGlass.default,
      false,
    );
    assert.strictEqual(schema.properties.policy.default.allowBreakGlass, false);

    const sample = JSON.parse(
      readFileSync(resolve(repoRoot, "config/sdlmcp.config.example.json"), "utf8"),
    );
    assert.strictEqual(sample.policy.allowBreakGlass, false);

    const tempRepo = mkdtempSync(join(tmpdir(), "sdl-init-defaults-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "dist/cli/index.js",
          "init",
          "--repo-path",
          tempRepo,
          "--dry-run",
          "--yes",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10000,
        },
      );

      assert.strictEqual(
        result.status,
        0,
        `Expected init --dry-run to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
      assert.match(result.stdout, /"allowBreakGlass": false/);
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it("keeps prefetch defaults aligned across config and generated schema", () => {
    assert.strictEqual(PrefetchConfigSchema.parse({}).enabled, true);

    const schema = JSON.parse(
      readFileSync(resolve(repoRoot, "config/sdlmcp.config.schema.json"), "utf8"),
    );
    assert.strictEqual(schema.properties.prefetch.properties.enabled.default, true);
    assert.strictEqual(schema.properties.prefetch.default.enabled, true);

    const sample = JSON.parse(
      readFileSync(resolve(repoRoot, "config/sdlmcp.config.example.json"), "utf8"),
    );
    assert.strictEqual(sample.prefetch.enabled, true);

    const serveSource = readFileSync(
      resolve(repoRoot, "src/cli/commands/serve.ts"),
      "utf8",
    );
    assert.match(serveSource, /config\.prefetch\?\.enabled \?\? true/);
  });
});
