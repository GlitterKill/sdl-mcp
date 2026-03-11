import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

/**
 * Integration tests for the sdl.runtime.execute MCP tool handler.
 *
 * The handler flow is: parse args → load config → DB conn → repo lookup → policy eval.
 * Policy evaluation happens after DB access, so we need a working LadybugDB with
 * a registered repo to reach the policy path.
 *
 * With default config (no runtime section), runtime.enabled defaults to false,
 * so policy denies execution before any subprocess is spawned.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("sdl.runtime.execute - MCP Tool Handler", () => {
  const testDir = join(__dirname, "test-mcp-runtime-tool");
  const graphDbPath = join(testDir, "graph");
  const repoId = "test-runtime-repo";

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

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
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should deny execution when runtime.enabled is false (default config)", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello')"],
    });

    assert.ok(result, "Expected a response object");
    assert.strictEqual(
      result.status,
      "denied",
      `Expected status "denied" when runtime is disabled, got "${result.status}"`,
    );
    assert.ok(
      result.policyDecision,
      "Expected policyDecision in denied response",
    );
    assert.ok(
      result.policyDecision.auditHash,
      "Expected auditHash in policyDecision",
    );
  });

  it("should include denied reasons in the response", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello')"],
    });

    assert.ok(result.policyDecision?.deniedReasons);
    assert.ok(result.policyDecision.deniedReasons.length > 0);
    assert.ok(
      result.policyDecision.deniedReasons.some((r: string) =>
        r.includes("disabled"),
      ),
    );
  });

  it("should throw DatabaseError for unregistered repo", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    await assert.rejects(
      () =>
        handleRuntimeExecute({
          repoId: "nonexistent-repo",
          runtime: "node",
          args: ["-e", "console.log('hello')"],
        }),
      (err: Error) => {
        assert.ok(err.message.includes("not found"));
        return true;
      },
    );
  });
});
