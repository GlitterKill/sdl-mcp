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

  it("should resolve node code relative imports from the requested working directory", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    mkdirSync(join(testDir, "fixtures"), { recursive: true });
    writeFileSync(
      join(testDir, "fixtures", "relative-module.mjs"),
      "export const value = 'relative-ok';\n",
      "utf-8",
    );

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      code: [
        "import { readdirSync } from 'node:fs';",
        "const mod = await import('./fixtures/relative-module.mjs');",
        "const repoTemps = readdirSync(process.cwd()).filter((name) => name.startsWith('.sdl-runtime-code-'));",
        "console.log(JSON.stringify({ value: mod.value, repoTemps }));",
      ].join("\n"),
      persistOutput: false,
      outputMode: "summary",
    });

    assert.equal(result.status, "success");
    const payload = JSON.parse(result.stdoutSummary.trim()) as {
      value: string;
      repoTemps: string[];
    };
    assert.equal(payload.value, "relative-ok");
    assert.deepEqual(payload.repoTemps, []);
  });

  it("should keep node code temp files out of cwd when stdin is provided", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    const stdin = "payload\n";

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      code: [
        "import { readdirSync } from 'node:fs';",
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "for await (const chunk of process.stdin) input += chunk;",
        "const repoTemps = readdirSync(process.cwd()).filter((name) => name.startsWith('.sdl-runtime-code-'));",
        "console.log(JSON.stringify({ input, repoTemps }));",
      ].join("\n"),
      stdin,
      persistOutput: false,
      outputMode: "summary",
    });

    assert.equal(result.status, "success", result.stderrSummary);
    const payload = JSON.parse(result.stdoutSummary.trim()) as {
      input: string;
      repoTemps: string[];
    };
    assert.equal(payload.input, stdin);
    assert.deepEqual(payload.repoTemps, []);
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
    assert.ok(
      result.quotingWarnings?.some((warning) => /base64/i.test(warning)),
    );
    assert.ok(
      result.quotingWarnings?.some((warning) =>
        /stdin|searchEditPreview/i.test(warning),
      ),
    );
  });

  it("returns exact intent matches when contextLines is zero", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: [
        "-e",
        "console.log('noise before'); console.log('TARGET only'); console.log('noise after')",
      ],
      persistOutput: false,
      outputMode: "intent",
      queryTerms: ["TARGET"],
      contextLines: 0,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.excerpts?.map((excerpt) => excerpt.content), [
      "TARGET only",
    ]);
  });

  it("warns about Windows shell semicolon command separators", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "shell",
      code: "echo first; echo second",
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "success");
    if (process.platform === "win32") {
      assert.ok(
        result.quotingWarnings?.some((warning) =>
          /Use newlines or & between commands/.test(warning),
        ),
      );
    }
  });

  it("should not warn about balanced quotes inside direct argv code", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", 'console.log("it\'s fine")'],
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "success");
    assert.notEqual(
      result.quotingWarnings?.some((warning) =>
        /unbalanced quotes/i.test(warning),
      ),
      true,
    );
  });

  it("should omit minimal stderr summaries for short failures", async () => {
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
    assert.equal(result.stderrSummary, "");
    assert.equal(result.stdoutSummary, "");
    assert.equal(result.stdoutPreview, undefined);
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


  describe("runtime trust metadata", () => {
  it("runtime.queryOutput exposes match metadata", async () => {
    const { handleRuntimeExecute } = await import("../../dist/mcp/tools/runtime.js");
    const { handleRuntimeQueryOutput } = await import("../../dist/mcp/tools/runtime-query.js");

    const run = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('trust alpha')"],
      outputMode: "minimal",
      persistOutput: true,
      timeoutMs: 10000,
    });

    assert.ok(run.artifactHandle);
    const query = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["not-present"],
      maxExcerpts: 1,
      contextLines: 0,
      stream: "stdout",
    });

    assert.strictEqual(query.matchStatus, "noMatchFallback");
    assert.strictEqual(query.matchCount, 0);
  });

  it("runtime.execute persists artifacts for TypeScript compile failures", async () => {
    const { handleRuntimeExecute } = await import("../../dist/mcp/tools/runtime.js");
    const { handleRuntimeQueryOutput } = await import("../../dist/mcp/tools/runtime-query.js");

    const run = await handleRuntimeExecute({
      repoId,
      runtime: "typescript",
      code: "const value: = ;\nconsole.log(value);\n",
      outputMode: "minimal",
      persistOutput: true,
      timeoutMs: 30000,
    });

    assert.notStrictEqual(run.status, "success");
    assert.ok(run.artifactHandle, "compile failures should persist stderr/stdout artifacts");
    const query = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["error", "TS"],
      maxExcerpts: 3,
      contextLines: 1,
      stream: "stderr",
    });
    assert.strictEqual(query.matchStatus, "matched");
  });

  it("runtime.execute persists a marker for no-output failures", async () => {
    const { handleRuntimeExecute } = await import("../../dist/mcp/tools/runtime.js");
    const { handleRuntimeQueryOutput } = await import("../../dist/mcp/tools/runtime-query.js");

    const run = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "process.exit(7)"],
      outputMode: "minimal",
      persistOutput: true,
      timeoutMs: 10000,
    });

    assert.strictEqual(run.status, "failure");
    assert.ok(run.artifactHandle, "no-output failures should persist an artifact marker");
    const query = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["error", "failed"],
      maxExcerpts: 3,
      contextLines: 0,
      stream: "stderr",
    });
    assert.strictEqual(query.matchStatus, "matched");
  });

  it("runtime.execute artifact provenance does not store raw args", async () => {
    const { handleRuntimeExecute } = await import("../../dist/mcp/tools/runtime.js");
    const { readArtifactManifest } = await import("../../dist/runtime/artifacts.js");

    const run = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", "console.log('provenance ok')", "SECRET_SHOULD_NOT_APPEAR"],
      outputMode: "minimal",
      persistOutput: true,
      timeoutMs: 10000,
    });

    assert.strictEqual(run.status, "success");
    assert.ok(run.artifactHandle);
    const manifest = await readArtifactManifest(run.artifactHandle);
    assert.ok(manifest?.commandSummary);
    assert.match(manifest.commandSummary, /argCount=3/);
    assert.doesNotMatch(manifest.commandSummary, /SECRET_SHOULD_NOT_APPEAR/);
  });

  it("repo.status schema preserves serverInfo", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const { RepoStatusResponseSchema } = await import("../../dist/mcp/tools.js");

    const status = await handleRepoStatus({ repoId, detail: "minimal" });
    const parsed = RepoStatusResponseSchema.parse(status);

    assert.ok(parsed.serverInfo);
    assert.strictEqual(typeof parsed.serverInfo.version, "string");
    assert.ok(Array.isArray(parsed.serverInfo.driftWarnings));
  });

  it("gateway runtime.queryOutput rejects mismatched cursor stream", async () => {
    const { AgentGatewaySchema } = await import("../../dist/gateway/schemas.js");

    assert.throws(
      () =>
        AgentGatewaySchema.parse({
          action: "runtime.queryOutput",
          repoId,
          artifactHandle: "runtime-test-123",
          queryTerms: ["error"],
          cursor: { stream: "stdout", afterLine: 10 },
          stream: "stderr",
        }),
      /stream must match cursor\.stream/,
    );
  });


  it("gateway runtime.execute accepts all registered runtime names", async () => {
    const { AgentGatewaySchema } = await import("../../dist/gateway/schemas.js");
    const parsed = AgentGatewaySchema.parse({
      action: "runtime.execute",
      repoId,
      runtime: "rust",
      args: ["--version"],
      outputMode: "minimal",
    });

    assert.strictEqual(parsed.runtime, "rust");
  });
});


  it("projects runtime query output for models while preserving raw recovery", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    const { handleRuntimeQueryOutput } =
      await import("../../dist/mcp/tools/runtime-query.js");
    const { queryArtifactContent } =
      await import("../../dist/runtime/artifacts.js");
    const fixture = [
      String.raw`F:\Claude\projects\sdl-mcp\sdl-mcp>node --test fixture`,
      "not ok 1 - fails cleanly (12.34ms)",
      "application retry took (12.34ms)",
      String.raw`F:\interior>keep this`,
    ];
    const code = `console.log(${JSON.stringify(fixture)}.join("\\n"))`;
    const run = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", code],
      outputMode: "minimal",
      persistOutput: true,
      timeoutMs: 10000,
    });

    assert.ok(run.artifactHandle);
    const raw = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["not ok"],
      maxExcerpts: 1,
      contextLines: 3,
      stream: "stdout",
      view: "raw",
    });
    const unprojected = await queryArtifactContent(
      run.artifactHandle,
      ["not ok"],
      { maxExcerpts: 1, contextLines: 3, stream: "stdout" },
    );
    const { runtime: _runtime, commandSummary: _commandSummary, ...rawResult } =
      unprojected;
    const { _rawContext, ...rawResponse } = raw as typeof raw & {
      _rawContext?: unknown;
    };
    assert.deepStrictEqual(rawResponse, {
      artifactHandle: run.artifactHandle,
      ...rawResult,
    });

    const model = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["not ok"],
      maxExcerpts: 1,
      contextLines: 3,
      stream: "stdout",
    });
    const rawContent = raw.excerpts[0]?.content ?? "";
    const modelContent = model.excerpts[0]?.content ?? "";

    assert.match(rawContent, /F:\\Claude\\projects\\sdl-mcp\\sdl-mcp>/);
    assert.match(rawContent, /not ok 1 - fails cleanly \(12\.34ms\)/);
    assert.doesNotMatch(
      modelContent,
      /F:\\Claude\\projects\\sdl-mcp\\sdl-mcp>/,
    );
    assert.match(modelContent, /^not ok 1 - fails cleanly$/m);
    assert.doesNotMatch(
      modelContent,
      /not ok 1 - fails cleanly \(12\.34ms\)/,
    );
    assert.match(modelContent, /application retry took \(12\.34ms\)/);
    assert.match(modelContent, /F:\\interior>keep this/);
    assert.strictEqual(model.excerpts[0]?.lineStart, 2);
    assert.ok(
      Buffer.byteLength(JSON.stringify(model)) <=
        Buffer.byteLength(JSON.stringify(raw)),
    );
  });

  it("uses the model projection for runtime summary and intent excerpts", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    const fixture = [
      String.raw`F:\Claude\projects\sdl-mcp\sdl-mcp>node --test fixture`,
      "not ok 1 - fails cleanly (12.34ms)",
      "application retry took (12.34ms)",
    ];
    const code = `console.log(${JSON.stringify(fixture)}.join("\\n"))`;
    const summary = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", code],
      outputMode: "summary",
      persistOutput: false,
      timeoutMs: 10000,
    });
    const intent = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      args: ["-e", code],
      outputMode: "intent",
      queryTerms: ["fails cleanly"],
      persistOutput: false,
      timeoutMs: 10000,
    });
    const intentContent = intent.excerpts?.[0]?.content ?? "";

    assert.doesNotMatch(
      summary.stdoutSummary,
      /F:\\Claude\\projects\\sdl-mcp\\sdl-mcp>/,
    );
    assert.match(summary.stdoutSummary, /^not ok 1 - fails cleanly$/m);
    assert.match(summary.stdoutSummary, /application retry took \(12\.34ms\)/);
    assert.doesNotMatch(
      intentContent,
      /F:\\Claude\\projects\\sdl-mcp\\sdl-mcp>/,
    );
    assert.match(intentContent, /^not ok 1 - fails cleanly$/m);
    assert.match(intentContent, /application retry took \(12\.34ms\)/);
  });

});
