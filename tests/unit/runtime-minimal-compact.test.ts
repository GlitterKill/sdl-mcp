import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("runtime minimal mode compact response", () => {
  const testDir = join(__dirname, "test-runtime-minimal-compact");
  const graphDbPath = join(testDir, "graph");
  const configPath = join(testDir, "sdlmcp.config.json");
  const repoId = "test-minimal-repo";
  const originalConfigPath = process.env.SDL_CONFIG;

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [{ repoId, rootPath: testDir }],
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1400,
            requireIdentifiers: true,
            allowBreakGlass: true,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: testDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: testDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
  });

  afterEach(async () => {
    await closeLadybugDb();
    invalidateConfigCache();
    if (originalConfigPath) {
      process.env.SDL_CONFIG = originalConfigPath;
    } else {
      delete process.env.SDL_CONFIG;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("strips outputLines and outputBytes for small non-truncated output in minimal mode", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello')"],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.strictEqual(result.status, "success");
    assert.ok(
      result.stdoutPreview?.includes("hello"),
      "stdoutPreview should contain output",
    );
    // Small output should NOT have outputLines/outputBytes
    assert.strictEqual(
      (result as Record<string, unknown>).outputLines,
      undefined,
      "outputLines should be omitted for small output",
    );
    assert.strictEqual(
      (result as Record<string, unknown>).outputBytes,
      undefined,
      "outputBytes should be omitted for small output",
    );
  });

  it("preserves full shape for summary mode regardless of output size", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello')"],
      persistOutput: false,
      outputMode: "summary",
    });

    assert.strictEqual(result.status, "success");
    // Summary mode should always have the full fields
    assert.ok("stdoutSummary" in result, "stdoutSummary should be present");
  });

  it("still includes policyDecision and stdoutPreview in compact minimal mode", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log(42)"],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.strictEqual(result.status, "success");
    assert.ok(result.policyDecision, "policyDecision must always be present");
    assert.ok(
      result.policyDecision.auditHash,
      "auditHash must always be present",
    );
    assert.ok(
      result.stdoutPreview !== undefined,
      "stdoutPreview must always be present",
    );
  });
});
