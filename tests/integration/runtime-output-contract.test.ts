import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { projectCompatibilityValue } from "../../dist/mcp/context-response-projection.js";
import {
  projectModelResponse,
} from "../../dist/mcp/response-projection/projectors/index.js";
import {
  extractRuntimeObservability,
  RUNTIME_INLINE_OUTPUT_BYTES,
} from "../../dist/mcp/response-projection/projectors/runtime.js";
import { PROJECTION_PROFILE_REGISTRY } from "../../dist/mcp/response-projection/registry.js";
import { handleRuntimeQueryOutput } from "../../dist/mcp/tools/runtime-query.js";
import { RuntimeQueryOutputRequestSchema } from "../../dist/mcp/tools.js";
import {
  applyRedaction,
  writeArtifact,
} from "../../dist/runtime/artifacts.js";

type Detail = "compact" | "standard" | "full";

interface RuntimeFixtureOptions {
  status?: "success" | "failure" | "timeout" | "cancelled" | "denied";
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  artifactHandle?: string | null;
  totalStdoutBytes?: number;
  totalStderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  digest?: Record<string, unknown>;
  excerpts?: Array<{
    lineStart: number;
    lineEnd: number;
    content: string;
    source: "stdout" | "stderr";
  }>;
}

function runtimeFixture(options: RuntimeFixtureOptions = {}) {
  const stdoutSummary = options.stdoutSummary ?? "";
  const stderrSummary = options.stderrSummary ?? "";
  return {
    status: options.status ?? "success",
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    signal: options.signal ?? null,
    durationMs: options.durationMs ?? 37,
    stdoutSummary,
    stderrSummary,
    artifactHandle: options.artifactHandle ?? null,
    ...(options.excerpts ? { excerpts: options.excerpts } : {}),
    ...(options.digest ? { digest: options.digest } : {}),
    truncation: {
      stdoutTruncated: options.stdoutTruncated ?? false,
      stderrTruncated: options.stderrTruncated ?? false,
      totalStdoutBytes:
        options.totalStdoutBytes ?? Buffer.byteLength(stdoutSummary, "utf8"),
      totalStderrBytes:
        options.totalStderrBytes ?? Buffer.byteLength(stderrSummary, "utf8"),
    },
  };
}

function projectRuntime(
  canonicalResult: unknown,
  requestArgs: Record<string, unknown> = {},
  detail: Detail = "compact",
  includeDiagnostics = false,
) {
  return projectModelResponse(
    {
      canonicalResult,
      action: "runtime.execute",
      profile: PROJECTION_PROFILE_REGISTRY["runtime.execute"],
      options: { detail, includeDiagnostics },
      context: {
        toolName: "runtime.execute",
        requestArgs: { repoId: "repo-a", outputMode: "summary", ...requestArgs },
      },
    },
    { projectCompatibilityValue },
  );
}

describe("runtime output contract", () => {
  const testDir = join(tmpdir(), "sdl-runtime-output-contract");
  const artifactBaseDir = join(testDir, "artifacts");
  const configPath = join(testDir, "sdlmcp.config.json");
  const originalConfig = process.env.SDL_CONFIG;

  afterEach(() => {
    invalidateConfigCache();
    if (originalConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalConfig;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("omits empty streams and inlines each small canonical stream exactly once", () => {
    const cases = [
      {
        name: "success with no output",
        canonical: runtimeFixture(),
        expected: { status: "success" },
      },
      {
        name: "small stdout only",
        canonical: runtimeFixture({ stdoutSummary: "stdout-only\n" }),
        expected: { status: "success", stdoutSummary: "stdout-only\n" },
      },
      {
        name: "small stderr only",
        canonical: runtimeFixture({ stderrSummary: "stderr-only\n" }),
        expected: { status: "success", stderrSummary: "stderr-only\n" },
      },
      {
        name: "mixed bounded streams",
        canonical: runtimeFixture({
          stdoutSummary: "stdout\n",
          stderrSummary: "stderr\n",
        }),
        expected: {
          status: "success",
          stdoutSummary: "stdout\n",
          stderrSummary: "stderr\n",
        },
      },
      {
        name: "nonzero exit",
        canonical: runtimeFixture({
          status: "failure",
          exitCode: 3,
          stderrSummary: "failed\n",
        }),
        expected: { status: "failure", stderrSummary: "failed\n" },
      },
      {
        name: "timeout and signal",
        canonical: runtimeFixture({
          status: "timeout",
          exitCode: null,
          signal: "SIGTERM",
          stderrSummary: "timed out\n",
        }),
        expected: { status: "timeout", stderrSummary: "timed out\n" },
      },
    ];

    for (const fixture of cases) {
      const projected = projectRuntime(fixture.canonical).value as Record<
        string,
        unknown
      >;
      assert.deepEqual(projected, fixture.expected, fixture.name);
      for (const key of ["stdoutSummary", "stderrSummary"] as const) {
        const expectedStream = fixture.expected[key];
        if (typeof expectedStream !== "string") continue;
        assert.equal(
          Object.values(projected).filter((value) => value === expectedStream).length,
          1,
          fixture.name,
        );
      }
    }
  });

  it("inlines output exactly at the boundary and handles output above it", () => {
    const atBoundary = "x".repeat(RUNTIME_INLINE_OUTPUT_BYTES);
    const inline = projectRuntime(
      runtimeFixture({
        stdoutSummary: atBoundary,
        artifactHandle: "runtime-inline",
        totalStdoutBytes: RUNTIME_INLINE_OUTPUT_BYTES,
      }),
    ).value as Record<string, unknown>;
    assert.equal(inline.stdoutSummary, atBoundary);
    assert.equal("preview" in inline, false);
    assert.equal("artifactHandle" in inline, false);
    assert.equal("nextAction" in inline, false);

    const handled = projectRuntime(
      runtimeFixture({
        stdoutSummary: atBoundary,
        artifactHandle: "runtime-large",
        totalStdoutBytes: RUNTIME_INLINE_OUTPUT_BYTES + 1,
        stdoutTruncated: false,
      }),
      { maxResponseLines: 100 },
    ).value as Record<string, unknown>;

    assert.deepEqual(Object.keys(handled), [
      "status",
      "preview",
      "artifactHandle",
      "nextAction",
    ]);
    assert.equal(handled.artifactHandle, "runtime-large");
    assert.ok(
      Buffer.byteLength(JSON.stringify(handled.preview), "utf8") <=
        RUNTIME_INLINE_OUTPUT_BYTES,
    );
    const nextAction = handled.nextAction as {
      action: string;
      args: Record<string, unknown>;
    };
    assert.equal(nextAction.action, "runtime.queryOutput");
    assert.deepEqual(nextAction.args, {
      repoId: "repo-a",
      artifactHandle: "runtime-large",
      view: "model",
      queryTerms: [],
          cursor: {
            stream: "stdout",
            afterLine: 0,
          },
      stream: "stdout",
      maxExcerpts: 10,
      contextLines: 3,
    });
    RuntimeQueryOutputRequestSchema.parse(nextAction.args);
    assert.equal(
      JSON.stringify(handled).split("runtime-large").length - 1,
      2,
      "one handle field plus one recovery argument",
    );

    const refused = projectRuntime(
      runtimeFixture({
        stdoutSummary: "bounded preview",
        totalStdoutBytes: RUNTIME_INLINE_OUTPUT_BYTES + 1,
        stdoutTruncated: false,
      }),
    ).value as Record<string, unknown>;
    assert.deepEqual(Object.keys(refused), [
      "status",
      "preview",
      "handlingError",
    ]);
    assert.deepEqual(refused.handlingError, {
      code: "RUNTIME_OUTPUT_RECOVERY_UNAVAILABLE",
      message:
        "Captured runtime output exceeded the inline limit but could not be persisted within the configured artifact limits.",
      retryable: false,
    });
  });

  it("keeps projected runtime envelopes byte-stable", () => {
    const first = projectRuntime(
      runtimeFixture({
        stdoutSummary: "captured output",
        totalStdoutBytes: 100_000,
        artifactHandle: "runtime-output-1",
      }),
      { outputMode: "summary" },
    ).value;

    const second = projectRuntime(first, { outputMode: "summary" }).value;

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  it("preserves outputMode selection without duplicating canonical excerpts", () => {
    const excerpt = {
      lineStart: 4,
      lineEnd: 4,
      content: "needle",
      source: "stderr" as const,
    };
    const canonical = runtimeFixture({
      stderrSummary: "needle",
      excerpts: [excerpt],
      digest: {
        kind: "node-test",
        ok: false,
        summary: "1 test failed",
        failures: [{ message: "needle" }],
      },
    });

    const minimal = projectRuntime(canonical, { outputMode: "minimal" }).value;
    assert.deepEqual(minimal, { status: "success" });

    for (const outputMode of ["summary", "intent", "digest"]) {
      const projected = projectRuntime(canonical, { outputMode }).value;
      assert.equal(
        JSON.stringify(projected).split("needle").length - 1,
        1,
        outputMode,
      );
    }
  });

  it("defaults omitted outputMode to minimal without leaking denial stderr", () => {
    const canonical = runtimeFixture({
      status: "denied",
      exitCode: null,
      stderrSummary: "Runtime concurrency limit reached.",
    });

    assert.deepEqual(
      projectRuntime(canonical, { outputMode: undefined }).value,
      { status: "denied" },
    );
    assert.deepEqual(
      projectRuntime(canonical, { outputMode: "summary" }).value,
      {
        status: "denied",
        stderrSummary: "Runtime concurrency limit reached.",
      },
    );
  });

  it("keeps runtime observability typed and out of normal model output", () => {
    const digest = {
      kind: "generic",
      ok: false,
      summary: "failed",
      failures: [{ message: "boom" }],
    };
    const canonical = runtimeFixture({
      status: "failure",
      exitCode: 7,
      signal: "SIGABRT",
      durationMs: 91,
      stdoutSummary: "out",
      stderrSummary: "err",
      totalStdoutBytes: 301,
      totalStderrBytes: 401,
      digest,
    });

    assert.deepEqual(extractRuntimeObservability(canonical), {
      exitCode: 7,
      signal: "SIGABRT",
      totalStdoutBytes: 301,
      totalStderrBytes: 401,
      digest,
      durationMs: 91,
    });

    for (const detail of ["compact", "standard", "full"] as const) {
      const projected = projectRuntime(canonical, {}, detail).value as Record<
        string,
        unknown
      >;
      for (const hidden of [
        "exitCode",
        "signal",
        "truncation",
        "digest",
        "durationMs",
      ]) {
        assert.equal(hidden in projected, false, `${detail}: ${hidden}`);
      }
    }

    const diagnostics = projectRuntime(
      canonical,
      {},
      "full",
      true,
    ).value as Record<string, unknown>;
    assert.equal(diagnostics.durationMs, 91);
    for (const hidden of ["exitCode", "signal", "truncation", "digest"]) {
      assert.equal(hidden in diagnostics, false, hidden);
    }
  });

  it("redacts repository roots before persisting runtime output", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: testDir }],
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: true,
          defaultDenyRaw: true,
          budgetCaps: { maxCards: 60, maxEstimatedTokens: 12_000 },
        },
        runtime: { artifactBaseDir },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const slashRoot = testDir.replaceAll("\\", "/");
    const immediate = applyRedaction(
      `${testDir}\n${slashRoot}`,
      undefined,
      [testDir],
    );
    assert.equal(immediate.includes(testDir), false);
    assert.equal(immediate.includes(slashRoot), false);
    assert.match(immediate, /<repo-root>/);

    const artifact = await writeArtifact({
      repoId: "repo-a",
      runtime: "node",
      argsHash: "a".repeat(64),
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: Buffer.from(`${testDir}\n${slashRoot}`, "utf8"),
      stderr: Buffer.alloc(0),
      policyAuditHash: "b".repeat(64),
      artifactTtlHours: 1,
      maxArtifactBytes: 1024 * 1024,
      artifactBaseDir,
      machinePaths: [testDir],
    });

    for (const view of ["model", "raw"] as const) {
      const response = await handleRuntimeQueryOutput({
        repoId: "repo-a",
        artifactHandle: artifact.artifactHandle,
        view,
        queryTerms: [],
        lineRange: { stream: "stdout", startLine: 1, endLine: 2 },
      });
      const content = response.excerpts.map((excerpt) => excerpt.content).join("\n");
      assert.equal(content.includes(testDir), false, view);
      assert.equal(content.includes(slashRoot), false, view);
      assert.match(content, /<repo-root>/, view);
    }
  });

  it("exhausts persisted redacted stdout and stderr byte-for-byte via runtime.queryOutput", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: testDir }],
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: true,
          defaultDenyRaw: true,
          budgetCaps: { maxCards: 60, maxEstimatedTokens: 12_000 },
        },
        runtime: { artifactBaseDir },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const longStdoutLine = `stdout-long-${"界".repeat(700)}`;
    const longStderrLine = `stderr-long-${"λ".repeat(700)}`;
    const originalStdout = Buffer.from(
      [
        longStdoutLine,
        ...Array.from(
          { length: 120 },
          (_, index) => `stdout-${index}-secret-α`,
        ),
      ].join("\n"),
      "utf8",
    );
    const originalStderr = Buffer.from(
      [
        longStderrLine,
        ...Array.from(
          { length: 95 },
          (_, index) => `stderr-${index}-secret-β`,
        ),
      ].join("\n"),
      "utf8",
    );
    const expectedStdout = Buffer.from(
      originalStdout.toString("utf8").replaceAll("secret", "[REDACTED:test]"),
      "utf8",
    );
    const expectedStderr = Buffer.from(
      originalStderr.toString("utf8").replaceAll("secret", "[REDACTED:test]"),
      "utf8",
    );

    const artifact = await writeArtifact({
      repoId: "repo-a",
      runtime: "node",
      argsHash: "a".repeat(64),
      exitCode: 1,
      signal: null,
      durationMs: 22,
      stdout: originalStdout,
      stderr: originalStderr,
      policyAuditHash: "b".repeat(64),
      artifactTtlHours: 1,
      maxArtifactBytes: 1024 * 1024,
      artifactBaseDir,
      redactionConfig: {
        enabled: true,
        includeDefaults: false,
        patterns: [{ pattern: "secret", flags: "g", name: "test" }],
      },
    });
    assert.notEqual(artifact.artifactDir, "");

    async function readStream(stream: "stdout" | "stderr"): Promise<Buffer> {
      const response = await handleRuntimeQueryOutput({
        repoId: "repo-a",
        artifactHandle: artifact.artifactHandle,
        view: "raw",
        lineRange: { stream, startLine: 1, endLine: 10_000 },
        stream,
        maxExcerpts: 10,
        contextLines: 3,
        queryTerms: [],
      });
      assert.equal(response.excerpts.length, 1);
      return Buffer.from(response.excerpts[0].content, "utf8");
    }

    assert.deepEqual(await readStream("stdout"), expectedStdout);
    assert.deepEqual(await readStream("stderr"), expectedStderr);
  });

  it("persists compressible recovery output within the configured on-disk cap", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: testDir }],
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: true,
          defaultDenyRaw: true,
          budgetCaps: { maxCards: 60, maxEstimatedTokens: 12_000 },
        },
        runtime: { artifactBaseDir, maxArtifactBytes: 2048 },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const originalStdout = Buffer.from(
      `secret-${"界".repeat(RUNTIME_INLINE_OUTPUT_BYTES)}`,
      "utf8",
    );
    assert.ok(originalStdout.length > 2048);

    const artifact = await writeArtifact({
      repoId: "repo-a",
      runtime: "node",
      argsHash: "c".repeat(64),
      exitCode: 0,
      signal: null,
      durationMs: 18,
      stdout: originalStdout,
      stderr: Buffer.alloc(0),
      policyAuditHash: "d".repeat(64),
      artifactTtlHours: 1,
      maxArtifactBytes: 2048,
      artifactBaseDir,
      redactionConfig: {
        enabled: true,
        includeDefaults: false,
        patterns: [{ pattern: "secret", flags: "g", name: "test" }],
      },
    });
    assert.notEqual(artifact.artifactDir, "");

    const projected = projectRuntime(
      runtimeFixture({
        stdoutSummary: "bounded preview",
        artifactHandle: artifact.artifactHandle,
        totalStdoutBytes: originalStdout.length,
      }),
    ).value as Record<string, unknown>;
    assert.deepEqual(Object.keys(projected), [
      "status",
      "preview",
      "artifactHandle",
      "nextAction",
    ]);
    assert.ok(
      Buffer.byteLength(JSON.stringify(projected.preview), "utf8") <=
        RUNTIME_INLINE_OUTPUT_BYTES,
    );
    const nextAction = projected.nextAction as {
      action: string;
      args: Record<string, unknown>;
    };
    assert.equal(nextAction.action, "runtime.queryOutput");
    RuntimeQueryOutputRequestSchema.parse(nextAction.args);

    const recovered = await handleRuntimeQueryOutput({
      ...(nextAction.args as {
        repoId: string;
        artifactHandle: string;
        stream: "stdout";
        maxExcerpts: number;
        contextLines: number;
      }),
      view: "raw",
      queryTerms: [],
      lineRange: { stream: "stdout", startLine: 1, endLine: 1 },
    });
    assert.equal(recovered.excerpts.length, 1);
    assert.deepEqual(
      Buffer.from(recovered.excerpts[0].content, "utf8"),
      Buffer.from(
        originalStdout
          .toString("utf8")
          .replaceAll("secret", "[REDACTED:test]"),
        "utf8",
      ),
    );
  });

  it("reports capture loss instead of advertising discarded bytes as recoverable", async () => {
    mkdirSync(testDir, { recursive: true });
    const graphDbPath = join(testDir, "graph");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: testDir }],
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: true,
          defaultDenyRaw: true,
          budgetCaps: { maxCards: 60, maxEstimatedTokens: 12_000 },
        },
        runtime: {
          enabled: true,
          allowedRuntimes: ["node"],
          allowedExecutables: ["node", "node.exe"],
          maxDurationMs: 10_000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          maxArtifactBytes: 1024 * 1024,
          artifactBaseDir,
          artifactTtlHours: 1,
          maxConcurrentJobs: 1,
          envAllowlist: [],
        },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const { initLadybugDb, closeLadybugDb, getLadybugConn } =
      await import("../../dist/db/ladybug.js");
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    try {
      const conn = await getLadybugConn();
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo-a",
        rootPath: testDir,
        configJson: JSON.stringify({
          repoId: "repo-a",
          rootPath: testDir,
          ignore: [],
          languages: ["ts"],
          maxFileBytes: 2_000_000,
          includeNodeModulesTypes: false,
          packageJsonPath: null,
          tsconfigPath: null,
          workspaceGlobs: null,
        }),
        createdAt: new Date().toISOString(),
      });

      for (const persistOutput of [false, true]) {
        const canonical = await handleRuntimeExecute({
          repoId: "repo-a",
          runtime: "node",
          code: 'process.stdout.write("x".repeat(2048));',
          outputMode: "summary",
          persistOutput,
          timeoutMs: 10_000,
        });
        assert.equal(canonical.truncation.stdoutTruncated, true);
        assert.equal(canonical.truncation.stderrTruncated, false);
        assert.equal(canonical.truncation.totalStdoutBytes, 2048);
        assert.equal(
          typeof canonical.artifactHandle === "string",
          persistOutput,
        );

        for (const outputMode of [undefined, "minimal"] as const) {
          const minimal = projectRuntime(
            canonical,
            { outputMode },
          ).value as Record<string, unknown>;
          assert.deepEqual(Object.keys(minimal), persistOutput
            ? [
                "status",
                "incompleteCapture",
                "handlingError",
                "artifactHandle",
                "nextAction",
              ]
            : ["status", "incompleteCapture", "handlingError"]);
          assert.equal("preview" in minimal, false);
          assert.equal("artifactHandle" in minimal, persistOutput);
          assert.equal("nextAction" in minimal, persistOutput);
          assert.equal(
            JSON.stringify(minimal).includes("runtime.queryOutput"),
            persistOutput,
          );
          assert.deepEqual(minimal.incompleteCapture, {
            stdoutTruncated: true,
            stderrTruncated: false,
            recoverable: false,
          });
        }

        const projected = projectRuntime(
          canonical,
          { outputMode: "summary" },
        ).value as Record<string, unknown>;
        assert.deepEqual(Object.keys(projected), persistOutput
          ? [
              "status",
              "preview",
              "incompleteCapture",
              "handlingError",
              "artifactHandle",
              "nextAction",
            ]
          : ["status", "preview", "incompleteCapture", "handlingError"]);
        assert.match(JSON.stringify(projected.preview), /x{16}/);
        assert.equal(
          JSON.stringify(projected).includes("runtime.queryOutput"),
          persistOutput,
        );
        assert.deepEqual(projected.incompleteCapture, {
          stdoutTruncated: true,
          stderrTruncated: false,
          recoverable: false,
        });
        assert.deepEqual(projected.handlingError, {
          code: "RUNTIME_OUTPUT_CAPTURE_INCOMPLETE",
          message:
            "Runtime output exceeded capture limits; discarded bytes are not recoverable.",
          retryable: false,
        });
        assert.equal("artifactHandle" in projected, persistOutput);
        assert.equal("nextAction" in projected, persistOutput);
        assert.ok(
          Buffer.byteLength(JSON.stringify(projected), "utf8") <
            canonical.truncation.totalStdoutBytes,
        );
      }
    } finally {
      await closeLadybugDb();
    }
  });
});