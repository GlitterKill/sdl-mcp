import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  RuntimeExecuteResponseSchema,
  RuntimeQueryOutputResponseSchema,
} from "../../dist/mcp/tools.js";
import { CodeModeConfigSchema } from "../../dist/config/types.js";
import { registerTools } from "../../dist/mcp/tools/index.js";
import {
  MCPServer,
  type ToolResponseEnvelope,
} from "../../dist/server.js";

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
    invalidateConfigCache();
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

    RuntimeExecuteResponseSchema.parse(result);
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

  it(
    "persists nested native-command output from PowerShell",
    { skip: process.platform !== "win32" },
    async () => {
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const { handleRuntimeQueryOutput } =
        await import("../../dist/mcp/tools/runtime-query.js");

      const run = await handleRuntimeExecute({
        repoId,
        runtime: "powershell",
        executable: "pwsh.exe",
        code: '& cmd.exe /c echo SDL_NATIVE_OK; Write-Output "EXIT:$LASTEXITCODE"',
        persistOutput: true,
        outputMode: "minimal",
      });

      assert.strictEqual(run.status, "success");
      assert.ok(run.artifactHandle);
      const query = await handleRuntimeQueryOutput({
        repoId,
        artifactHandle: run.artifactHandle,
        queryTerms: ["SDL_NATIVE_OK", "EXIT:0"],
        contextLines: 0,
        maxExcerpts: 2,
        stream: "stdout",
      });

      assert.strictEqual(query.matchStatus, "matched");
      assert.deepEqual(
        query.excerpts.map((excerpt) => excerpt.content.replace(/\r$/, "")),
        ["SDL_NATIVE_OK", "EXIT:0"],
      );
    },
  );

  it(
    "propagates final native-child exits and preserves PowerShell error records",
    { skip: process.platform !== "win32" },
    async () => {
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const missingPath = `sdl-mcp-missing-cmdlet-path-${process.pid}`;
      const cases = [
        {
          name: "native exit 0",
          code: "& cmd.exe /d /c exit 0",
          status: "success",
          exitCode: 0,
        },
        {
          name: "native exit 23",
          code: "& cmd.exe /d /c exit 23",
          status: "failure",
          exitCode: 23,
        },
        {
          name: "stale native exit followed by a successful cmdlet",
          code: "& cmd.exe /d /c exit 23; Write-Output 'RECOVERED'",
          status: "success",
          exitCode: 0,
        },
        {
          name: "non-terminating cmdlet error",
          code: `Get-Item -LiteralPath (Join-Path $env:TEMP '${missingPath}'); Write-Output 'AFTER_ERROR'`,
          status: "failure",
          exitCode: 0,
        },
      ] as const;

      for (const expected of cases) {
        const result = await handleRuntimeExecute({
          repoId,
          runtime: "powershell",
          executable: "pwsh.exe",
          code: expected.code,
          persistOutput: false,
          outputMode: "minimal",
        });

        assert.equal(result.status, expected.status, expected.name);
        assert.equal(result.exitCode, expected.exitCode, expected.name);
      }
    },
  );

  it("anchors persisted large-output recovery at the selected stream byte zero", async () => {
    const server = new MCPServer();
    registerTools(
      server,
      {},
      undefined,
      CodeModeConfigSchema.parse({ enabled: true, exclusive: true }),
    );
    const sdkServer = server.getServer() as unknown as {
      _requestHandlers: Map<
        string,
        (
          request: {
            method: "tools/call";
            params: {
              name: string;
              arguments?: Record<string, unknown>;
            };
          },
          extra: {
            _meta: Record<string, unknown>;
            sendNotification: () => Promise<void>;
            signal: AbortSignal;
          },
        ) => Promise<ToolResponseEnvelope>
      >;
    };
    const handler = sdkServer._requestHandlers.get("tools/call");
    assert.ok(handler);
    const cases = [
      {
        name: "stderr",
        code: `process.stderr.write("E".repeat(32_000));`,
        expectedCursor: "stderr/0",
      },
      {
        name: "stdout",
        code: `process.stdout.write("O".repeat(32_000));`,
        expectedCursor: "stdout/0",
      },
    ] as const;

    for (const expected of cases) {
      const response = await handler(
        {
          method: "tools/call",
          params: {
            name: "sdl.workflow",
            arguments: {
              repoId,
              steps: [
                {
                  fn: "runtimeExecute",
                  args: {
                    runtime: "node",
                    code: expected.code,
                    persistOutput: true,
                    outputMode: "minimal",
                  },
                },
              ],
            },
          },
        },
        {
          _meta: {},
          sendNotification: async () => {},
          signal: new AbortController().signal,
        },
      );
      const wire = response.structuredContent as {
        results?: Array<{
          result?: {
            artifactHandle?: string;
            nextAction?: {
              action?: string;
              args?: {
                steps?: Array<{
                  fn?: string;
                  args?: {
                    cursor?: { stream?: string; afterLine?: number };
                  };
                }>;
              };
            };
          };
        }>;
      };
      const runtimeResult = wire.results?.[0]?.result;
      const nextAction = runtimeResult?.nextAction;
      const recoveryStep = nextAction?.args?.steps?.[0];
      const cursor = recoveryStep?.args?.cursor;
      assert.equal(nextAction?.action, "sdl.workflow");
      assert.equal(recoveryStep?.fn, "runtimeQueryOutput");
      assert.equal(
        `${cursor?.stream}/${cursor?.afterLine}`,
        expected.expectedCursor,
        `${expected.name} ${JSON.stringify(response)}`,
      );
      assert.ok(runtimeResult?.artifactHandle, expected.name);
    }
  });

  it("keeps hidden minimal output recoverable with exact UTF-8 paging", async () => {
    const exclusiveServer = new MCPServer();
    registerTools(exclusiveServer, {}, undefined, { enabled: true, exclusive: true });

    type CallToolResponse = {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    type RecoveryAction = {
      action: string;
      args: {
        repoId: string;
        steps: Array<{
          fn: string;
          args: Record<string, unknown>;
        }>;
      };
    };

    const requestHandler = (
      exclusiveServer.server as unknown as {
        _requestHandlers: Map<
          string,
          (request: {
            method: "tools/call";
            params: {
              name: string;
              arguments: Record<string, unknown>;
              _meta: Record<string, unknown>;
            };
          }, extra: {
            signal: AbortSignal;
            sendNotification: () => Promise<void>;
          }) => Promise<CallToolResponse>
        >;
      }
    )._requestHandlers.get("tools/call");
    assert.ok(requestHandler);

    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const response = await requestHandler({
        method: "tools/call",
        params: { name, arguments: args, _meta: {} },
      }, {
        signal: new AbortController().signal,
        sendNotification: async () => {},
      });
      assert.equal(response.isError, undefined);
      if (
        response.structuredContent &&
        typeof response.structuredContent === "object"
      ) {
        return response.structuredContent as Record<string, unknown>;
      }
      const text = response.content?.find(
        (item) => item.type === "text" && typeof item.text === "string",
      )?.text;
      assert.ok(text);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const firstStep = (payload: Record<string, unknown>) => {
      const results = payload.results as Array<{
        result: Record<string, unknown>;
        nextAction?: RecoveryAction;
      }>;
      assert.equal(results.length, 1);
      return results[0]!;
    };

    const runRuntime = async (
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      firstStep(
        await callTool("sdl.workflow", {
          repoId,
          steps: [{ fn: "runtimeExecute", args: { repoId, ...args } }],
        }),
      ).result;

    const expectedOutput = Array.from(
      { length: 25 },
      (_, index) =>
        index === 12
          ? `PAGE-12-error-${"π🙂".repeat(300)}`
          : `PAGE-${String(index).padStart(2, "0")}-π🙂`,
    ).join("\n");
    const projected = await runRuntime({
      runtime: "node",
      code: `process.stdout.write(${JSON.stringify(expectedOutput)});`,
      outputMode: "minimal",
      persistOutput: true,
    });
    assert.ok(projected.artifactHandle);
    assert.ok(projected.nextAction);

    let recovery = projected.nextAction as RecoveryAction;
    assert.equal(recovery.action, "sdl.workflow");
    const emittedRecovery = structuredClone(recovery);
    assert.deepEqual(emittedRecovery.args.steps[0]?.args.queryTerms, []);
    const firstPage = firstStep(
      await callTool(emittedRecovery.action, emittedRecovery.args),
    );

    let page = firstPage.result;
    let nextAction = firstPage.nextAction;
    let pageCount = 0;
    const recovered: string[] = [];
    while (true) {
      pageCount += 1;
      assert.ok(pageCount <= 3);
      const excerpts = page.excerpts as Array<{ content: string }>;
      recovered.push(...excerpts.map((excerpt) => excerpt.content));
      if (!nextAction) {
        break;
      }
      recovery = nextAction;
      const nextPage = firstStep(await callTool(recovery.action, recovery.args));
      page = nextPage.result;
      nextAction = nextPage.nextAction;
    }

    assert.ok(pageCount >= 2, JSON.stringify(firstPage));
    assert.deepEqual(
      Buffer.from(recovered.join("\n"), "utf8"),
      Buffer.from(expectedOutput, "utf8"),
    );

    const summary = await runRuntime({
      runtime: "node",
      code: 'process.stdout.write("VISIBLE SUMMARY");',
      outputMode: "summary",
      persistOutput: true,
    });
    assert.equal(summary.artifactHandle, undefined);
    assert.equal(summary.nextAction, undefined);
    assert.ok(summary.stdoutSummary);

    const digest = await runRuntime({
      runtime: "node",
      code: 'process.stdout.write("VISIBLE DIGEST");',
      outputMode: "digest",
      persistOutput: true,
    });
    assert.equal(digest.artifactHandle, undefined);
    assert.equal(digest.nextAction, undefined);
    assert.ok(digest.excerpts);
  });

  it(
    "propagates a final native-child exit through a workflow step",
    { skip: process.platform !== "win32" },
    async () => {
      const server = new MCPServer();
      registerTools(
        server,
        {},
        undefined,
        CodeModeConfigSchema.parse({ enabled: true, exclusive: true }),
      );
      const sdkServer = server.getServer() as unknown as {
        _requestHandlers: Map<
          string,
          (
            request: {
              method: "tools/call";
              params: {
                name: string;
                arguments?: Record<string, unknown>;
              };
            },
            extra: {
              _meta: Record<string, unknown>;
              sendNotification: () => Promise<void>;
              signal: AbortSignal;
            },
          ) => Promise<ToolResponseEnvelope>
        >;
      };
      const handler = sdkServer._requestHandlers.get("tools/call");
      assert.ok(handler);

      const response = await handler(
        {
          method: "tools/call",
          params: {
            name: "sdl.workflow",
            arguments: {
              repoId,
              onError: "continueAll",
              steps: [
                {
                  fn: "runtimeExecute",
                  args: {
                    runtime: "powershell",
                    executable: "pwsh.exe",
                    code: "& cmd.exe /d /c exit 23",
                    persistOutput: false,
                    outputMode: "minimal",
                  },
                },
              ],
            },
          },
        },
        {
          _meta: {},
          sendNotification: async () => {},
          signal: new AbortController().signal,
        },
      );
      const result = response.structuredContent as {
        results?: Array<{ status?: string; error?: string }>;
      };

      assert.equal(
        result.results?.[0]?.status,
        "error",
        JSON.stringify(response),
      );
      assert.match(result.results?.[0]?.error ?? "", /exit code 23/u);
    },
  );

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

  describe("repository inspection guard", () => {
    const repositorySource = "repository-source.ts";

    beforeEach(() => {
      writeFileSync(
        join(testDir, repositorySource),
        "export const repositorySecret = 'SOURCE_SNIPPET_MUST_NOT_LEAK';\n",
        "utf-8",
      );
    });

    it("rejects inline repository reads before any user code executes", async () => {
      const sentinel = join(testDir, "blocked-inline-sentinel.txt");
      const {
        ErrorCode,
        RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
        RuntimeRepositoryInspectionError,
      } = await import("../../dist/domain/errors.js");
      const { errorToMcpResponse } =
        await import("../../dist/mcp/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const code = [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `readFileSync(${JSON.stringify(repositorySource)}, 'utf-8');`,
        `writeFileSync(${JSON.stringify(sentinel)}, 'created', 'utf-8');`,
      ].join("\n");

      let thrown: unknown;
      try {
        await handleRuntimeExecute({
          repoId,
          runtime: "node",
          code,
          persistOutput: false,
          outputMode: "summary",
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown instanceof RuntimeRepositoryInspectionError);
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.name, "RuntimeRepositoryInspectionError");
      assert.equal(thrown.code, ErrorCode.POLICY_ERROR);
      assert.equal(thrown.message, RUNTIME_REPOSITORY_INSPECTION_DISALLOWED);
      assert.equal(existsSync(sentinel), false);

      const mapped = errorToMcpResponse(thrown);
      assert.deepEqual(mapped, {
        error: {
          message: RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
          code: "POLICY_ERROR",
          classification: "policy_denied",
          retryable: false,
        },
      });
      const publicJson = JSON.stringify(mapped);
      for (const privateValue of [
        "SOURCE_SNIPPET_MUST_NOT_LEAK",
        repositorySource,
        "inlineStaticRead",
        "ruleId",
        "durationMs",
        "timestamp",
        testDir,
      ]) {
        assert.equal(publicJson.includes(privateValue), false, privateValue);
      }
    });

    it("rejects repository reads supplied through direct runtime arguments", async () => {
      const { RuntimeRepositoryInspectionError } =
        await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");

      await assert.rejects(
        () =>
          handleRuntimeExecute({
            repoId,
            runtime: "node",
            args: [
              "-e",
              `import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(repositorySource)}, 'utf-8')`,
            ],
            persistOutput: false,
          }),
        RuntimeRepositoryInspectionError,
      );
    });

    it("keeps empty code in code mode instead of executing source arguments", async () => {
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const cases = [
        {
          runtime: "node" as const,
          flag: "-e",
          source: (sentinel: string) =>
            `const fs=require('node:fs'); fs.readFileSync(${JSON.stringify(repositorySource)}, 'utf8'); fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran')`,
        },
        {
          runtime: "python" as const,
          flag: "-c",
          source: (sentinel: string) =>
            `from pathlib import Path; Path(${JSON.stringify(repositorySource)}).read_text(); Path(${JSON.stringify(sentinel)}).write_text('ran')`,
        },
      ];

      for (const testCase of cases) {
        const sentinel = join(
          testDir,
          `empty-code-${testCase.runtime}-must-not-run.txt`,
        );
        const result = await handleRuntimeExecute({
          repoId,
          runtime: testCase.runtime,
          code: "",
          args: [testCase.flag, testCase.source(sentinel)],
          persistOutput: false,
          outputMode: "minimal",
        });

        assert.equal(result.status, "success", testCase.runtime);
        assert.equal(existsSync(sentinel), false, testCase.runtime);
      }
    });

    it("classifies relative reads from the canonical execution cwd", async () => {
      const targetCwd = join(testDir, "nested", "deep");
      const aliasCwd = join(testDir, "alias");
      const sentinel = join(testDir, "blocked-canonical-cwd-sentinel.txt");
      mkdirSync(targetCwd, { recursive: true });
      symlinkSync(
        targetCwd,
        aliasCwd,
        process.platform === "win32" ? "junction" : "dir",
      );
      const { RuntimeRepositoryInspectionError } =
        await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const code = [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `readFileSync(${JSON.stringify(`../../${repositorySource}`)}, 'utf-8');`,
        `writeFileSync(${JSON.stringify(sentinel)}, 'created', 'utf-8');`,
      ].join("\n");

      await assert.rejects(
        () =>
          handleRuntimeExecute({
            repoId,
            runtime: "node",
            relativeCwd: "alias",
            code,
            persistOutput: false,
          }),
        RuntimeRepositoryInspectionError,
      );
      assert.equal(existsSync(sentinel), false);
    });

    it("classifies absolute reads through the registered root alias", async () => {
      const aliasRoot = `${testDir}-registered-root-alias`;
      const sentinel = join(testDir, "blocked-root-alias-sentinel.txt");
      if (existsSync(aliasRoot)) rmSync(aliasRoot, { recursive: true, force: true });
      symlinkSync(
        testDir,
        aliasRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const conn = await getLadybugConn();
      const now = new Date().toISOString();
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: aliasRoot,
        configJson: JSON.stringify({
          repoId,
          rootPath: aliasRoot,
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
      const { RuntimeRepositoryInspectionError } =
        await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const sourcePath = join(aliasRoot, repositorySource);
      const code = [
        `require('node:fs').readFileSync(${JSON.stringify(sourcePath)}, 'utf-8');`,
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'created', 'utf-8');`,
      ].join("\n");

      try {
        await assert.rejects(
          () =>
            handleRuntimeExecute({
              repoId,
              runtime: "node",
              args: ["-e", code],
              persistOutput: false,
            }),
          RuntimeRepositoryInspectionError,
        );
        assert.equal(existsSync(sentinel), false);
      } finally {
        if (existsSync(aliasRoot)) {
          rmSync(aliasRoot, { recursive: true, force: true });
        }
      }
    });

    it("rejects attached Node source before either payload executes", async () => {
      const {
        RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
        RuntimeRepositoryInspectionError,
      } = await import("../../dist/domain/errors.js");
      const { errorToMcpResponse } =
        await import("../../dist/mcp/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const cases = [
        {
          name: "long eval",
          prefix: "--eval=",
          sentinel: join(testDir, "blocked-attached-long-eval.txt"),
        },
        {
          name: "short eval",
          prefix: "-e",
          sentinel: join(testDir, "blocked-attached-short-eval.txt"),
        },
      ];

      for (const testCase of cases) {
        const source = [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          `readFileSync(${JSON.stringify(repositorySource)}, 'utf-8');`,
          `writeFileSync(${JSON.stringify(testCase.sentinel)}, 'created', 'utf-8');`,
        ].join("\n");
        let thrown: unknown;
        try {
          await handleRuntimeExecute({
            repoId,
            runtime: "node",
            args: [`${testCase.prefix}${source}`],
            persistOutput: false,
          });
        } catch (error) {
          thrown = error;
        }

        assert.ok(
          thrown instanceof RuntimeRepositoryInspectionError,
          testCase.name,
        );
        assert.equal(
          thrown.message,
          RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
          testCase.name,
        );
        assert.deepEqual(errorToMcpResponse(thrown), {
          error: {
            message: RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
            code: "POLICY_ERROR",
            classification: "policy_denied",
            retryable: false,
          },
        });
        assert.equal(existsSync(testCase.sentinel), false, testCase.name);
      }
    });

    it("classifies repository reads before applying live concurrency capacity", async () => {
      writeConfig({ maxConcurrentJobs: 1 });
      const ready = join(testDir, "runtime-holder-ready.txt");
      const release = join(testDir, "runtime-holder-release.txt");
      const { RuntimeRepositoryInspectionError } =
        await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const baseline = await handleRuntimeExecute({
        repoId,
        runtime: "node",
        code: "console.log('baseline-probe')",
        persistOutput: false,
      });
      assert.equal(baseline.status, "success", baseline.stderrSummary);
      const holder = handleRuntimeExecute({
        repoId,
        runtime: "node",
        code: [
          "import { existsSync, writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(ready)}, 'ready', 'utf-8');`,
          `while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
        ].join("\n"),
        persistOutput: false,
      });

      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(ready) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(existsSync(ready), true, "holder did not acquire the runtime slot");

        await assert.rejects(
          () =>
            handleRuntimeExecute({
              repoId,
              runtime: "node",
              code: `import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(repositorySource)}, 'utf-8')`,
              persistOutput: false,
            }),
          RuntimeRepositoryInspectionError,
        );

        const capacityDenied = await handleRuntimeExecute({
          repoId,
          runtime: "node",
          code: "console.log('capacity-probe')",
          persistOutput: false,
        });
        assert.equal(capacityDenied.status, "denied");
        assert.equal(
          capacityDenied.stderrSummary,
          "",
        );
        assert.deepEqual(capacityDenied.policyDecision?.deniedReasons, [
          "Concurrency limit reached (1/1 active jobs)",
        ]);
        assert.notEqual(
          capacityDenied.policyDecision?.auditHash,
          baseline.policyDecision?.auditHash,
          "capacity denial must use tracker-derived policy evidence",
        );
      } finally {
        writeFileSync(release, "release", "utf-8");
        const holderResult = await holder;
        assert.equal(holderResult.status, "success", holderResult.stderrSummary);
      }
    });

    it("preserves repository, cwd, runtime, and executable denial precedence", async () => {
      const {
        DatabaseError,
        RuntimePolicyDeniedError,
        RuntimeRepositoryInspectionError,
        ValidationError,
      } = await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const inspectionCode =
        `import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(repositorySource)}, 'utf-8')`;

      await assert.rejects(
        () =>
          handleRuntimeExecute({
            repoId: "missing-repository",
            runtime: "node",
            code: inspectionCode,
          }),
        (error: Error) => {
          assert.ok(error instanceof DatabaseError);
          assert.equal(error instanceof RuntimeRepositoryInspectionError, false);
          return true;
        },
      );

      await assert.rejects(
        () =>
          handleRuntimeExecute({
            repoId,
            runtime: "node",
            relativeCwd: "missing-working-directory",
            code: inspectionCode,
          }),
        (error: Error) => {
          assert.ok(error instanceof RuntimePolicyDeniedError);
          assert.equal(error instanceof RuntimeRepositoryInspectionError, false);
          assert.match(error.message, /Working directory does not exist/);
          return true;
        },
      );

      await assert.rejects(
        () =>
          handleRuntimeExecute({
            repoId,
            runtime: "not-a-runtime",
            code: inspectionCode,
          }),
        (error: Error) => {
          assert.ok(error instanceof ValidationError);
          assert.equal(error instanceof RuntimeRepositoryInspectionError, false);
          return true;
        },
      );

      const executableDenied = await handleRuntimeExecute({
        repoId,
        runtime: "node",
        executable: "powershell",
        code: inspectionCode,
        persistOutput: false,
      });
      assert.equal(executableDenied.status, "denied");
      assert.ok(
        executableDenied.policyDecision?.deniedReasons?.some((reason) =>
          reason.includes("not compatible with runtime"),
        ),
      );
    });

    it("blocks every static alias and namespace read before user code executes", async () => {
      const {
        RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
        RuntimeRepositoryInspectionError,
      } = await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      writeFileSync(join(testDir, "package.json"), "{}\n", "utf-8");

      const cases: Array<{
        name: string;
        sentinel: string;
        request: Record<string, unknown>;
      }> = [
        {
          name: "node:fs promises alias",
          sentinel: "blocked-fs-promises-alias.txt",
          request: {
            runtime: "node",
            code: [
              `import { promises as fs, writeFileSync } from "node:fs";`,
              `await fs.readFile("package.json");`,
              `writeFileSync("blocked-fs-promises-alias.txt", "ran");`,
            ].join("\n"),
          },
        },
        {
          name: "node:fs/promises direct import",
          sentinel: "blocked-fs-promises-direct.txt",
          request: {
            runtime: "node",
            code: [
              `import { readFile } from "node:fs/promises";`,
              `import { writeFileSync } from "node:fs";`,
              `await readFile("package.json");`,
              `writeFileSync("blocked-fs-promises-direct.txt", "ran");`,
            ].join("\n"),
          },
        },
        {
          name: "ESM createRequire",
          sentinel: "blocked-create-require.txt",
          request: {
            runtime: "node",
            code: [
              `import { createRequire } from "node:module";`,
              `const require = createRequire(import.meta.url);`,
              `const fs = require("node:fs");`,
              `fs.readFileSync("package.json", "utf8");`,
              `fs.writeFileSync("blocked-create-require.txt", "ran");`,
            ].join("\n"),
          },
        },
        {
          name: "pathlib namespace",
          sentinel: "blocked-pathlib-namespace.txt",
          request: {
            runtime: "python",
            code: [
              "import pathlib",
              'pathlib.Path("package.json").read_text()',
              'pathlib.Path("blocked-pathlib-namespace.txt").write_text("ran")',
            ].join("\n"),
          },
        },
        {
          name: "pathlib alias",
          sentinel: "blocked-pathlib-alias.txt",
          request: {
            runtime: "python",
            code: [
              "import pathlib as pl",
              'pl.Path("package.json").read_bytes()',
              'pl.Path("blocked-pathlib-alias.txt").write_text("ran")',
            ].join("\n"),
          },
        },
        {
          name: "Path constructor alias",
          sentinel: "blocked-path-constructor-alias.txt",
          request: {
            runtime: "python",
            code: [
              "from pathlib import Path as P",
              'P("package.json").read_text()',
              'P("blocked-path-constructor-alias.txt").write_text("ran")',
            ].join("\n"),
          },
        },
      ];

      for (const testCase of cases) {
        let thrown: unknown;
        try {
          await handleRuntimeExecute({
            repoId,
            persistOutput: false,
            outputMode: "minimal",
            ...testCase.request,
          });
        } catch (error) {
          thrown = error;
        }
        assert.ok(
          thrown instanceof RuntimeRepositoryInspectionError,
          testCase.name,
        );
        assert.equal(thrown.message, RUNTIME_REPOSITORY_INSPECTION_DISALLOWED);
        assert.equal(existsSync(join(testDir, testCase.sentinel)), false);
      }
    });

    it(
      "blocks static Windows wrappers, GNU readers, and device aliases before execution",
      { skip: process.platform !== "win32" },
      async () => {
        const { RuntimeRepositoryInspectionError } =
          await import("../../dist/domain/errors.js");
        const { handleRuntimeExecute } =
          await import("../../dist/mcp/tools/runtime.js");
        writeFileSync(join(testDir, "package.json"), "{}\n", "utf-8");
        const devicePackage = `\\\\?\\${join(testDir, "package.json")}`;
        const cases: Array<{
          name: string;
          runtime: "powershell" | "shell";
          code: string;
        }> = [
          {
            name: "powershell -NoProfile",
            runtime: "powershell",
            code: 'powershell -NoProfile -Command "Get-Content -LiteralPath package.json"',
          },
          {
            name: "pwsh -NoProfile",
            runtime: "powershell",
            code: 'pwsh -NoProfile -Command "Get-Content -LiteralPath package.json"',
          },
          {
            name: "cmd switches and outer quotes",
            runtime: "shell",
            code: 'cmd.exe /d /s /c "type package.json"',
          },
          ...["grep", "sed", "awk"].map((command) => ({
            name: `cmd GNU ${command}`,
            runtime: "shell" as const,
            code: `cmd.exe /d /s /c "${command} needle package.json"`,
          })),
          {
            name: "Windows device path",
            runtime: "shell",
            code: `cmd.exe /d /s /c "type ${devicePackage}"`,
          },
        ];

        for (const testCase of cases) {
          await assert.rejects(
            () =>
              handleRuntimeExecute({
                repoId,
                runtime: testCase.runtime,
                code: testCase.code,
                persistOutput: false,
                outputMode: "minimal",
              }),
            RuntimeRepositoryInspectionError,
            testCase.name,
          );
        }
      },
    );

    it("blocks an outside-root filesystem alias that resolves into the repository", async () => {
      const aliasRoot = `${testDir}-outside-target-alias`;
      const sentinel = join(testDir, "blocked-outside-target-alias.txt");
      if (existsSync(aliasRoot)) rmSync(aliasRoot, { recursive: true, force: true });
      symlinkSync(
        testDir,
        aliasRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const { RuntimeRepositoryInspectionError } =
        await import("../../dist/domain/errors.js");
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const sourcePath = join(aliasRoot, repositorySource);
      const code = [
        `import { readFileSync, writeFileSync } from "node:fs";`,
        `readFileSync(${JSON.stringify(sourcePath)}, "utf8");`,
        `writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
      ].join("\n");

      try {
        await assert.rejects(
          () =>
            handleRuntimeExecute({
              repoId,
              runtime: "node",
              code,
              persistOutput: false,
              outputMode: "minimal",
            }),
          RuntimeRepositoryInspectionError,
        );
        assert.equal(existsSync(sentinel), false);
      } finally {
        if (existsSync(aliasRoot)) rmSync(aliasRoot, { recursive: true, force: true });
      }
    });

    it("continues to execute named scripts, executable scripts, normal commands, and outside-root reads", async () => {
      const { handleRuntimeExecute } =
        await import("../../dist/mcp/tools/runtime.js");
      const executableScript = join(testDir, "allowed-script.mjs");
      const outsideSource = join(dirname(testDir), "outside-runtime-source.txt");
      writeFileSync(executableScript, "console.log('executable-script-ok');\n", "utf-8");
      writeFileSync(outsideSource, "outside-read-ok\n", "utf-8");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          scripts: {
            "guard:named": "node -e \"console.log('named-script-ok')\"",
          },
        }),
        "utf-8",
      );

      try {
        const normal = await handleRuntimeExecute({
          repoId,
          runtime: "node",
          args: ["-e", "console.log('normal-command-ok')"],
          outputMode: "summary",
          persistOutput: false,
        });
        const script = await handleRuntimeExecute({
          repoId,
          runtime: "node",
          args: [executableScript],
          outputMode: "summary",
          persistOutput: false,
        });
        const named = await handleRuntimeExecute({
          repoId,
          runtime: "shell",
          code: "npm run guard:named",
          outputMode: "summary",
          persistOutput: false,
        });
        const outside = await handleRuntimeExecute({
          repoId,
          runtime: "node",
          code: [
            "import { readFileSync } from 'node:fs';",
            `console.log(readFileSync(${JSON.stringify(outsideSource)}, 'utf-8').trim());`,
          ].join("\n"),
          outputMode: "summary",
          persistOutput: false,
        });

        assert.equal(normal.status, "success", normal.stderrSummary);
        assert.match(normal.stdoutSummary, /normal-command-ok/);
        assert.equal(script.status, "success", script.stderrSummary);
        assert.match(script.stdoutSummary, /executable-script-ok/);
        assert.equal(named.status, "success", named.stderrSummary);
        assert.match(named.stdoutSummary, /named-script-ok/);
        assert.equal(outside.status, "success", outside.stderrSummary);
        assert.match(outside.stdoutSummary, /outside-read-ok/);
      } finally {
        rmSync(outsideSource, { force: true });
      }
    });
  });

  it("never persists complete large output when persistOutput is false", async () => {
    const artifactBaseDir = join(testDir, "artifacts-disabled");
    writeConfig({
      artifactBaseDir,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 262_144,
    });
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "node",
      code: `process.stdout.write("x".repeat(100_000));`,
      persistOutput: false,
      outputMode: "minimal",
    });

    assert.equal(result.status, "success");
    assert.equal(result.artifactHandle, null);
    assert.equal(existsSync(artifactBaseDir), false);
  });

  it("reports a missing repository before parsing invalid runtime configuration", async () => {
    writeConfig({ maxConcurrentJobs: 0 });
    const { DatabaseError } = await import("../../dist/domain/errors.js");
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    await assert.rejects(
      () =>
        handleRuntimeExecute({
          repoId: "missing-repository",
          runtime: "node",
          code: "console.log('must-not-run')",
        }),
      (error: Error) => {
        assert.ok(error instanceof DatabaseError);
        assert.equal(error.message, "Repository missing-repository not found");
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

    RuntimeQueryOutputResponseSchema.parse(query);
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

    RuntimeExecuteResponseSchema.parse(run);
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

    const status = await handleRepoStatus({
      repoId,
      detail: "minimal",
      includeTelemetry: true,
    });
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

  it("removes a blank line immediately preceding a Windows prompt echo", async () => {
    const { projectRuntimeOutputExcerpts } =
      await import("../../dist/mcp/runtime-output-projection.js");
    const rawContent =
      "\r\n" +
      String.raw`F:\Claude\projects\sdl-mcp\sdl-mcp>echo qa-runtime-probe` +
      " \r\nqa-runtime-probe\r\n";

    const projected = projectRuntimeOutputExcerpts([
      {
        lineStart: 1,
        lineEnd: 4,
        content: rawContent,
        source: "stdout",
      },
    ]);

    assert.strictEqual(projected[0]?.lineStart, 3);
    assert.strictEqual(projected[0]?.content, "qa-runtime-probe\r\n");
  });

  it("does not warn for semicolons inside quoted Windows shell arguments", async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    const result = await handleRuntimeExecute({
      repoId,
      runtime: "shell",
      code: 'node -e "console.log(\'a;b\')"',
      outputMode: "minimal",
      persistOutput: false,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.quotingWarnings, undefined);
  });

});
