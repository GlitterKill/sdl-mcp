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


/**
 * Integration tests for the sdl.runtime.execute MCP tool handler.
 *
 * The handler flow is: parse args → load config → DB conn → repo lookup → policy eval.
 * Policy evaluation happens after DB access, so we need a working LadybugDB with
 * a registered repo to reach the policy path.
 *
 * With default config (no runtime section), runtime defaults should permit
 * execution for allowlisted runtimes before more specific policy checks apply.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("sdl.runtime.execute - MCP Tool Handler", () => {
  const testDir = join(__dirname, "test-mcp-runtime-tool");
  const graphDbPath = join(testDir, "graph");
  const configPath = join(testDir, "sdlmcp.config.json");
  const repoId = "test-runtime-repo";
  const originalConfigPath = process.env.SDL_CONFIG;

  function writeConfig(runtime: Record<string, unknown>): void {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [
            {
              repoId,
              rootPath: testDir,
            },
          ],
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1400,
            requireIdentifiers: true,
            allowBreakGlass: true,
            defaultDenyRaw: true,
            budgetCaps: {
              maxCards: 60,
              maxEstimatedTokens: 12000,
            },
          },
          runtime,
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
  }

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Write a default config with NO runtime section so that
    // RuntimeConfigSchema.parse({}) supplies the built-in defaults.
    // This avoids picking up a user-level SDL_CONFIG that may
    // override runtime behavior.
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

  it("should allow execution with the default runtime config when omitted", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello')"],
      persistOutput: false,
      outputMode: "summary",
    });

    assert.ok(result, "Expected a response object");
    assert.strictEqual(
      result.status,
      "success",
      `Expected status "success" with default runtime config, got "${result.status}"`,
    );
    assert.ok(result.stdoutSummary.includes("hello"));
  });

  it("should pass stdin through the handler without echoing it as metadata", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    const stdin = "alpha\nbeta\n";

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: [
        "-e",
        "process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(input.split(/\\n/).filter(Boolean).length));",
      ],
      stdin,
      persistOutput: false,
      outputMode: "summary",
    });

    assert.equal(result.status, "success");
    assert.ok(result.stdoutSummary.includes("2"));
    assert.equal(result.stdinBytes, Buffer.byteLength(stdin, "utf-8"));
    assert.match(result.stdinSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /alpha\\nbeta/);
  });

  it("should surface quoting warnings for base64 command workarounds", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: [
        "-e",
        "console.log(Buffer.from('YQ==', 'base64').toString('utf8'))",
      ],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "success");
    assert.ok(result.quotingWarnings?.some((warning) => /base64/i.test(warning)));
    assert.ok(
      result.quotingWarnings?.some((warning) => /stdin|searchEditPreview/i.test(warning)),
    );
  });

  it("should not warn about balanced quotes inside direct argv code", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log(\"it's fine\")"],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "success");
    assert.notEqual(
      result.quotingWarnings?.some((warning) => /unbalanced quotes/i.test(warning)),
      true,
    );
  });

  it("should preserve minimal stderr summaries for short failures", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.error('short-failure'); process.exit(2)"],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "failure");
    assert.equal(result.exitCode, 2);
    assert.match(result.stderrSummary, /short-failure/);
  });

  it("should include denied reasons in the response", async () => {
    writeConfig({
      enabled: false,
      allowedRuntimes: ["node", "typescript", "python", "shell"],
      allowedExecutables: [],
      maxDurationMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 262_144,
      maxArtifactBytes: 10_485_760,
      artifactTtlHours: 24,
      maxConcurrentJobs: 2,
      envAllowlist: [],
    });

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

  it("should deny executable overrides that do not belong to the selected runtime", async () => {
    writeConfig({
      enabled: true,
      allowedRuntimes: ["node", "python", "shell"],
      allowedExecutables: [],
      maxDurationMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 262_144,
      maxArtifactBytes: 10_485_760,
      artifactTtlHours: 24,
      maxConcurrentJobs: 2,
      envAllowlist: [],
    });

    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      executable: "powershell",
      args: ["-NoProfile", "-Command", "Write-Output should-not-run"],
      persistOutput: false,
    });

    assert.strictEqual(result.status, "denied");
    assert.ok(result.policyDecision?.deniedReasons);
    assert.ok(
      result.policyDecision.deniedReasons.some((reason: string) =>
        reason.includes("not compatible with runtime"),
      ),
    );
  });

  it("should allow the resolved default executable when it is explicitly allowlisted", async () => {
    // Use node runtime instead of shell — shell's default (cmd.exe on Windows)
    // may not be on PATH in all environments (e.g. Git Bash without System32).
    writeConfig({
      enabled: true,
      allowedRuntimes: ["node"],
      allowedExecutables: ["node", "node.exe"],
      maxDurationMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 262_144,
      maxArtifactBytes: 10_485_760,
      artifactTtlHours: 24,
      maxConcurrentJobs: 2,
      envAllowlist: [],
    });

    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('hello-runtime')"],
      persistOutput: false,
      outputMode: "summary",
    });

    assert.notStrictEqual(
      result.status,
      "denied",
      "Expected node request to pass allowlist",
    );
    assert.strictEqual(result.status, "success");
    assert.ok(result.stdoutSummary.includes("hello-runtime"));
  });
});
