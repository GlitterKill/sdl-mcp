import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  createMCPServer,
  MCPServer,
  type ToolResponseEnvelope,
} from "../../dist/server.js";
import {
  getResponseArtifactBaseDir,
  maybeStoreLargeResponse,
} from "../../dist/runtime/response-artifacts.js";
import {
  handleRetrieve,
  RetrieveRequestSchema,
} from "../../dist/code-mode/retrieve.js";
import { withExclusiveCodeModeRecoveryProjection } from "../../dist/code-mode/action-reference-projection.js";
import { ACTION_DEFINITION_BY_ACTION } from "../../dist/code-mode/action-catalog.js";
import { errorToMcpResponse } from "../../dist/mcp/errors.js";
import {
  beginRepoRemoval,
  replaceRegisteredRepoIds,
  resetRepoLifecycleForTests,
} from "../../dist/services/repo-lifecycle.js";
import {
  _setResponseRepoExistsForTesting,
  handleResponseGet,
} from "../../dist/mcp/tools/response.js";
import {
  ResponseGetRequestSchema,
  ResponseGetResponseSchema,
} from "../../dist/mcp/tools.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: () => Promise<void>;
    signal: AbortSignal;
    sessionId?: string;
  },
) => Promise<ToolResponseEnvelope>;

const originalSdlConfig = process.env.SDL_CONFIG;
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-response-artifact-recovery-"));
  tempDirs.push(dir);
  return dir;
}

function configureArtifacts(baseDir: string): void {
  const configPath = join(baseDir, "sdl.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ repos: [], policy: {}, runtime: { artifactBaseDir: baseDir } }),
  );
  process.env.SDL_CONFIG = configPath;
  invalidateConfigCache();
}

function getCallToolHandler(server: MCPServer): CallToolHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, CallToolHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/call");
  assert.ok(handler);
  return handler;
}

async function exhaustArtifact(repoId: string, handle: string): Promise<Buffer> {
  let args = ResponseGetRequestSchema.parse({ repoId, handle });
  const chunks: Buffer[] = [];

  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = ResponseGetResponseSchema.parse(await handleResponseGet(args));
    assert.equal(Object.keys(page).filter((key) => key === "handle").length, 1);

    if (page.contentKind === "binary") {
      assert.deepStrictEqual(
        Object.keys(page.content as Record<string, unknown>),
        ["encoding", "data"],
      );
      const encoded = page.content as { encoding: string; data: string };
      assert.equal(encoded.encoding, "base64");
      chunks.push(Buffer.from(encoded.data, "base64"));
    } else {
      assert.equal(typeof page.content, "string");
      chunks.push(Buffer.from(page.content, "utf-8"));
    }

    if (page.complete) {
      assert.equal(page.nextAction, undefined);
      return Buffer.concat(chunks);
    }

    assert.ok(page.nextAction);
    assert.equal(page.nextAction.action, "response.get");
    args = ResponseGetRequestSchema.parse(page.nextAction.args);
    assert.deepStrictEqual(Object.keys(args.cursor), ["offsetBytes"]);
    assert.equal(args.handle, handle);
    assert.equal(args.view, "model");
    assert.ok(args.maxBytes <= 65_536);
  }

  assert.fail("response artifact recovery did not terminate");
}

const DETAIL_FIXTURES = {
  compact: {
    status: "success",
    summary: "compact",
    padding: "c".repeat(40_000),
  },
  standard: {
    status: "success",
    summary: "standard",
    result: { count: 2 },
    padding: "s".repeat(40_000),
  },
  full: {
    status: "success",
    summary: "full",
    result: { count: 2, semantic: "preserved" },
    fullOnly: { command: "stable-command" },
    padding: "f".repeat(40_000),
  },
  diagnostic: {
    status: "success",
    summary: "diagnostic",
    result: { count: 2, semantic: "preserved" },
    fullOnly: { command: "stable-command" },
    diagnostics: { timings: { totalMs: 7 } },
    padding: "d".repeat(40_000),
  },
} as const;

beforeEach(() => {
  _setResponseRepoExistsForTesting(async () => true);
});

afterEach(() => {
  _setResponseRepoExistsForTesting();
  if (originalSdlConfig !== undefined) {
    process.env.SDL_CONFIG = originalSdlConfig;
  } else {
    delete process.env.SDL_CONFIG;
  }
  invalidateConfigCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("response artifact recovery", () => {
  it("exhausts compact, standard, full, and diagnostic sanitized artifacts", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);

    for (const [name, fixture] of Object.entries(DETAIL_FIXTURES)) {
      const source = structuredClone(fixture);
      const stored = await maybeStoreLargeResponse({
        repoId: "repo-a",
        toolName: "runtime.execute",
        payload: fixture,
        responseMode: "handle",
        artifactBaseDir: baseDir,
      });
      assert.equal(stored.responseMode, "handle");
      if (stored.responseMode !== "handle") assert.fail("expected handle");

      const recovered = await exhaustArtifact("repo-a", stored.payload.handle);
      assert.deepStrictEqual(fixture, source, `${name} source mutated`);
      assert.deepStrictEqual(
        JSON.parse(recovered.toString("utf-8")),
        source,
        `${name} reconstructed projection`,
      );
      assert.deepStrictEqual(
        recovered,
        Buffer.from(JSON.stringify(source), "utf-8"),
        name,
      );
    }
  });

  it("returns terminal pages at and beyond the response byte boundary", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const payload = "exact boundary";
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "runtime.execute",
      payload,
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    const totalBytes = Buffer.byteLength(payload, "utf-8");
    for (const offsetBytes of [totalBytes, totalBytes + 7]) {
      const page = ResponseGetResponseSchema.parse(
        await handleResponseGet({
          repoId: "repo-a",
          handle: stored.payload.handle,
          cursor: { offsetBytes },
          maxBytes: 4,
        }),
      );
      assert.equal(page.content, "");
      assert.equal(page.complete, true);
      assert.equal(page.truncated, false);
      assert.equal(page.range?.offsetBytes, totalBytes);
      assert.equal(page.range?.returnedBytes, 0);
      assert.equal(page.range?.totalBytes, totalBytes);
      assert.equal(page.nextAction, undefined);
    }
  });

  it("rejects invalid response.get cursors with typed validation details", async () => {
    await assert.rejects(
      () =>
        handleResponseGet({
          repoId: "repo-a",
          handle: "response-repo-a-1778234400000-0123456789abcdef",
          cursor: { offsetBytes: -1 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof z.ZodError);
        assert.deepStrictEqual(
          error.issues.map(({ code, path }) => ({ code, path })),
          [{ code: "too_small", path: ["cursor", "offsetBytes"] }],
        );
        return true;
      },
    );
  });

  it("keeps UTF-8 pages valid when the requested boundary falls inside a character", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    let payload = { message: "" };

    for (let prefix = 8_000; prefix < 8_192; prefix += 1) {
      const candidate = { message: `${"a".repeat(prefix)}😀tail` };
      const bytes = Buffer.from(JSON.stringify(candidate), "utf-8");
      if ((bytes[8_192] ?? 0) >> 6 === 0b10) {
        payload = candidate;
        break;
      }
    }
    assert.notEqual(payload.message, "");

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "runtime.execute",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    const recovered = await exhaustArtifact("repo-a", stored.payload.handle);
    assert.deepStrictEqual(recovered, Buffer.from(JSON.stringify(payload), "utf-8"));
    assert.equal(recovered.toString("utf-8").includes("�"), false);
  });

  it("makes progress when maxBytes is smaller than the leading UTF-8 character", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const payload = "\u{1f642}x";
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "runtime.execute",
      payload,
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    let args = ResponseGetRequestSchema.parse({
      repoId: "repo-a",
      handle: stored.payload.handle,
      maxBytes: 1,
    });
    const chunks: Buffer[] = [];
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      const page = ResponseGetResponseSchema.parse(await handleResponseGet(args));
      chunks.push(Buffer.from(page.content as string, "utf-8"));
      if (pageCount === 0) {
        assert.ok(page.range);
        assert.equal(page.range.returnedBytes, 0);
        assert.ok(page.range.returnedBytes <= args.maxBytes);
      }
      if (page.complete) break;
      assert.ok(page.nextAction);
      const nextArgs = ResponseGetRequestSchema.parse(page.nextAction.args);
      assert.equal(nextArgs.view, "model");
      assert.ok(nextArgs.maxBytes <= 65_536);
      if (pageCount === 0) assert.equal(nextArgs.maxBytes, 4);
      args = nextArgs;
    }
    assert.equal(Buffer.concat(chunks).toString("utf-8"), payload);
  });

  it("preserves legacy JSON-path pagination in executable next actions", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const payload = {
      finalEvidence: [
        { summary: "alpha" },
        { summary: "beta" },
        { summary: "omega" },
      ],
    };
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    let args = ResponseGetRequestSchema.parse({
      repoId: "repo-a",
      handle: stored.payload.handle,
      jsonPath: "finalEvidence",
      offset: 0,
      limit: 1,
    });
    const restored: unknown[] = [];
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      const page = ResponseGetResponseSchema.parse(await handleResponseGet(args));
      restored.push(...(page.content as unknown[]));
      if (page.complete) {
        assert.equal(page.nextAction, undefined);
        break;
      }
      assert.ok(page.nextAction);
      args = ResponseGetRequestSchema.parse(page.nextAction.args);
      assert.equal(args.jsonPath, "finalEvidence");
      assert.equal(args.cursor.offsetBytes, 0);
      assert.equal(args.limit, 1);
    }
    assert.deepStrictEqual(restored, payload.finalEvidence);
  });

  it("returns supported non-text pages as base64 with typed metadata", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "runtime.execute",
      payload,
      responseMode: "handle",
      contentKind: "binary",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    const recovered = await exhaustArtifact("repo-a", stored.payload.handle);
    assert.deepStrictEqual(recovered, payload);
  });

  it("uses the ARTIFACT_PROFILE standard budget for auto responses", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    let padding = "";
    let projectedTokens = 0;
    while (projectedTokens < 3_400) {
      padding += "artifact budget evidence 0123456789 ";
      projectedTokens = estimateTokens(
        JSON.stringify({ status: "success", summary: "profile budget", padding }),
      );
    }
    assert.ok(projectedTokens >= 3_400 && projectedTokens < 3_600);

    const server = new MCPServer({
      responseProjectionBoundaryOverrides: {
        projectCompatibilityValue(input) {
          const canonical = input.canonicalResult as Record<string, unknown>;
          return {
            status: canonical.status,
            summary: canonical.summary,
            padding: canonical.padding,
          };
        },
      },
    });
    server.clearTools();
    server.registerTool(
      "sdl.retrieve",
      "Test artifact-profile auto budget",
      z.object({
        repoId: z.string(),
        responseMode: z.enum(["inline", "auto"]),
        detail: z.literal("standard"),
      }),
      async () => ({
        status: "success",
        summary: "profile budget",
        padding,
      }),
    );

    const callTool = getCallToolHandler(server);
    const extra = {
      _meta: {},
      sendNotification: async () => {},
      signal: new AbortController().signal,
    };
    const inline = await callTool(
      {
        method: "tools/call",
        params: {
          name: "sdl.retrieve",
          arguments: {
            repoId: "repo-a",
            responseMode: "inline",
            detail: "standard",
          },
        },
      },
      extra,
    );
    const combinedTokens =
      estimateTokens(inline.content.map((block) => block.text).join("\n")) +
      estimateTokens(JSON.stringify(inline.structuredContent));
    assert.ok(combinedTokens >= 3_400 && combinedTokens < 3_600);

    const auto = await callTool(
      {
        method: "tools/call",
        params: {
          name: "sdl.retrieve",
          arguments: {
            repoId: "repo-a",
            responseMode: "auto",
            detail: "standard",
          },
        },
      },
      extra,
    );
    assert.equal(
      (auto.structuredContent as { kind?: string } | undefined)?.kind,
      "responseArtifact",
    );
  });

  it("preserves literal auto args while suppressing handler-side storage", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    let receivedMode: string | undefined;
    let handlerStorageMode: string | undefined;
    const server = new MCPServer({
      responseProjectionBoundaryOverrides: {
        projectCompatibilityValue(input) {
          const canonical = input.canonicalResult as Record<string, unknown>;
          return {
            status: canonical.status,
            summary: canonical.summary,
            padding: canonical.padding,
          };
        },
      },
    });
    server.clearTools();
    server.registerTool(
      "sdl.retrieve",
      "Test literal auto preservation",
      z.object({
        repoId: z.string(),
        responseMode: z.literal("auto"),
        detail: z.literal("standard"),
      }),
      async (args) => {
        const request = args as { responseMode: "auto" };
        receivedMode = request.responseMode;
        const stored = await maybeStoreLargeResponse({
          repoId: "repo-a",
          toolName: "sdl.retrieve",
          payload: {
            status: "success",
            summary: "literal auto",
            padding: "x".repeat(40_000),
            rawCanonicalSecret: "must-not-be-stored",
          },
          responseMode: request.responseMode,
          artifactBaseDir: baseDir,
        });
        handlerStorageMode = stored.responseMode;
        return stored.payload;
      },
    );

    const response = await getCallToolHandler(server)(
      {
        method: "tools/call",
        params: {
          name: "sdl.retrieve",
          arguments: {
            repoId: "repo-a",
            responseMode: "auto",
            detail: "standard",
          },
        },
      },
      {
        _meta: {},
        sendNotification: async () => {},
        signal: new AbortController().signal,
      },
    );
    assert.equal(receivedMode, "auto");
    assert.equal(handlerStorageMode, "inline");

    const artifact = response.structuredContent as
      | { kind?: string; handle?: string }
      | undefined;
    assert.equal(artifact?.kind, "responseArtifact");
    const recovered = await exhaustArtifact("repo-a", artifact.handle ?? "");
    const restored = JSON.parse(recovered.toString("utf-8")) as Record<
      string,
      unknown
    >;
    assert.equal(restored.rawCanonicalSecret, undefined);
    assert.equal(restored.summary, "literal auto");
  });

  it("stores sanitized projections for handler-managed auto and handle modes", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);

    for (const toolName of ["sdl.repo.status", "sdl.retrieve"] as const) {
      for (const responseMode of ["auto", "handle"] as const) {
      const server = new MCPServer({
        responseProjectionBoundaryOverrides: {
          projectCompatibilityValue(input) {
            const canonical = input.canonicalResult as Record<string, unknown>;
            if (canonical.kind === "responseArtifact") return canonical;
            return {
              status: canonical.status,
              summary: canonical.summary,
              padding: canonical.padding,
              ...(input.options.detail === "full"
                ? { result: canonical.result, fullOnly: canonical.fullOnly }
                : {}),
            };
          },
        },
      });
      server.clearTools();
      server.registerTool(
        toolName,
        "Test centralized artifact handling",
        z.object({
          repoId: z.string(),
          responseMode: z.enum(["auto", "handle"]),
          detail: z.literal("full"),
        }),
        async (args) => {
          const request = args as { responseMode: "auto" | "handle" };
          const stored = await maybeStoreLargeResponse({
            repoId: "repo-a",
            toolName,
            payload: {
              ...DETAIL_FIXTURES.full,
              rawCanonicalSecret: "must-not-be-stored",
            },
            responseMode: request.responseMode,
            artifactBaseDir: baseDir,
          });
          return stored.payload;
        },
      );

      const response = await getCallToolHandler(server)(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: { repoId: "repo-a", responseMode, detail: "full" },
          },
        },
        {
          _meta: {},
          sendNotification: async () => {},
          signal: new AbortController().signal,
        },
      );
      const artifact = response.structuredContent as
        | { kind?: string; handle?: string }
        | undefined;
      assert.equal(response.isError, undefined);
      assert.equal(artifact?.kind, "responseArtifact");
      assert.equal(typeof artifact.handle, "string");

      const recovered = await exhaustArtifact("repo-a", artifact.handle ?? "");
      const restored = JSON.parse(recovered.toString("utf-8")) as Record<
        string,
        unknown
      >;
      assert.equal(restored.rawCanonicalSecret, undefined);
      assert.deepStrictEqual(restored.result, DETAIL_FIXTURES.full.result);
      assert.deepStrictEqual(restored.fullOnly, DETAIL_FIXTURES.full.fullOnly);
      }
    }
  });

  it("does not recursively rehandle page-native response.get artifacts", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: DETAIL_FIXTURES.full,
      responseMode: "handle",
      artifactBaseDir: baseDir,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    let receivedMode: string | undefined;
    const server = new MCPServer({
      responseProjectionBoundaryOverrides: {
        projectCompatibilityValue(input) {
          return input.canonicalResult;
        },
      },
    });
    server.clearTools();
    server.registerTool(
      "sdl.response.get",
      "Test page-native exclusion",
      z.object({
        repoId: z.string(),
        responseMode: z.literal("handle"),
      }),
      async (args) => {
        receivedMode = (args as { responseMode: string }).responseMode;
        return stored.payload;
      },
    );

    const response = await getCallToolHandler(server)(
      {
        method: "tools/call",
        params: {
          name: "sdl.response.get",
          arguments: { repoId: "repo-a", responseMode: "handle" },
        },
      },
      {
        _meta: {},
        sendNotification: async () => {},
        signal: new AbortController().signal,
      },
    );
    const artifact = response.structuredContent as
      | { handle?: string }
      | undefined;
    assert.equal(receivedMode, "handle");
    assert.equal(artifact?.handle, stored.payload.handle);
  });

  it("stores the effective sanitized projection when inline delivery is too large", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const server = new MCPServer({
      responseProjectionBoundaryOverrides: {
        projectCompatibilityValue(input) {
          const canonical = input.canonicalResult as Record<string, unknown>;
          return {
            status: canonical.status,
            summary: canonical.summary,
            padding: canonical.padding,
            ...(input.options.detail !== "compact"
              ? { result: canonical.result }
              : {}),
            ...(input.options.detail === "full"
              ? { fullOnly: canonical.fullOnly }
              : {}),
            ...(input.options.includeDiagnostics
              ? { diagnostics: canonical.diagnostics }
              : {}),
          };
        },
      },
    });
    server.clearTools();
    server.registerTool(
      "sdl.response.get",
      "Test response boundary",
      z.object({
        repoId: z.string(),
        handle: z.string(),
        responseMode: z.literal("inline"),
        detail: z.enum(["compact", "standard", "full"]),
        includeDiagnostics: z.boolean().default(false),
      }),
      async (args) => {
        const request = args as {
          detail: keyof typeof DETAIL_FIXTURES;
          includeDiagnostics: boolean;
        };
        const fixture = request.includeDiagnostics
          ? DETAIL_FIXTURES.diagnostic
          : DETAIL_FIXTURES[request.detail];
        return { ...fixture, rawCanonicalSecret: "must-not-be-stored" };
      },
    );
    const callTool = getCallToolHandler(server);

    for (const request of [
      { detail: "compact", includeDiagnostics: false, fixture: DETAIL_FIXTURES.compact },
      { detail: "standard", includeDiagnostics: false, fixture: DETAIL_FIXTURES.standard },
      { detail: "full", includeDiagnostics: false, fixture: DETAIL_FIXTURES.full },
      { detail: "full", includeDiagnostics: true, fixture: DETAIL_FIXTURES.diagnostic },
    ] as const) {
      const response = await callTool(
        {
          method: "tools/call",
          params: {
            name: "sdl.response.get",
            arguments: {
              repoId: "repo-a",
              handle: "source-handle",
              responseMode: "inline",
              detail: request.detail,
              includeDiagnostics: request.includeDiagnostics,
            },
          },
        },
        {
          _meta: {},
          sendNotification: async () => {},
          signal: new AbortController().signal,
        },
      );

      assert.equal(response.isError, true);
      assert.equal(
        (response.structuredContent?.error as { code?: string } | undefined)?.code,
        "INLINE_RESPONSE_TOO_LARGE",
      );
      const nextAction = response.structuredContent?.nextAction as
        | { action: string; args: Record<string, unknown> }
        | undefined;
      assert.ok(nextAction);
      const recoveryArgs = ResponseGetRequestSchema.parse(nextAction.args);
      const recovered = await exhaustArtifact("repo-a", recoveryArgs.handle);
      const restored = JSON.parse(recovered.toString("utf-8")) as Record<
        string,
        unknown
      >;

      assert.equal(restored.rawCanonicalSecret, undefined);
      assert.equal("fullOnly" in restored, request.detail === "full");
      assert.equal("diagnostics" in restored, request.includeDiagnostics);
      if (request.includeDiagnostics) {
        assert.deepStrictEqual(restored.result, request.fixture.result);
        assert.deepStrictEqual(restored.fullOnly, request.fixture.fullOnly);
        assert.ok(restored.diagnostics);
      } else {
        assert.deepStrictEqual(restored, request.fixture);
      }
    }
  });
});

function registerResponseContinuationTools(server: MCPServer): void {
  const responseActions = {
    "response.get": {
      schema: ResponseGetRequestSchema,
      definition: ACTION_DEFINITION_BY_ACTION["response.get"],
      handler: handleResponseGet,
    },
  };
  server.clearTools();
  server.registerTool(
    "sdl.response.get",
    "Response artifact test tool",
    ResponseGetRequestSchema,
    handleResponseGet,
  );
  server.registerTool(
    "sdl.retrieve",
    "Response continuation test tool",
    RetrieveRequestSchema,
    async (request, context) =>
      withExclusiveCodeModeRecoveryProjection(
        true,
        () => handleRetrieve(request, responseActions as never, context),
        request,
      ),
  );
}

async function callStoredResponse(
  handler: CallToolHandler,
  name: "sdl.response.get" | "sdl.retrieve",
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<ToolResponseEnvelope> {
  return handler(
    {
      method: "tools/call",
      params: { name, arguments: args },
    },
    {
      _meta: {},
      sendNotification: async () => {},
      signal: new AbortController().signal,
      ...(sessionId ? { sessionId } : {}),
    },
  );
}

interface CanonicalErrorEnvelope {
  code?: string;
  classification?: string;
  message?: string;
}

function canonicalErrorEnvelopeFrom(value: unknown): CanonicalErrorEnvelope {
  const candidate = value as {
    code?: unknown;
    classification?: unknown;
    message?: unknown;
    error?: {
      code?: unknown;
      classification?: unknown;
      message?: unknown;
    };
  };
  const detail = candidate.error ?? candidate;
  return {
    ...(typeof detail.code === "string" ? { code: detail.code } : {}),
    ...(typeof detail.classification === "string"
      ? { classification: detail.classification }
      : {}),
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
  };
}

async function canonicalErrorEnvelope(
  call: () => Promise<unknown>,
): Promise<CanonicalErrorEnvelope> {
  try {
    return canonicalErrorEnvelopeFrom(await call());
  } catch (error) {
    return canonicalErrorEnvelopeFrom(errorToMcpResponse(error));
  }
}

describe("sdl.retrieve responseGet artifact continuation", () => {
  it("classifies misplaced and invalid responseGet projection controls at tools/call", async () => {
    const server = await createMCPServer({
      codeModeConfig: {
        enabled: true,
        exclusive: true,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 60_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    });
    const handler = getCallToolHandler(server);
    const baseArgs = {
      repoId: "repo-a",
      op: "responseGet",
      args: {
        handle: "response-repo-a-1784866000000-deadbeefdeadbeef",
      },
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "nested detail",
        { ...baseArgs, args: { ...baseArgs.args, detail: "full" } },
      ],
      [
        "nested includeDiagnostics",
        { ...baseArgs, args: { ...baseArgs.args, includeDiagnostics: true } },
      ],
      ["invalid outer detail", { ...baseArgs, detail: 42 }],
      [
        "invalid outer includeDiagnostics",
        { ...baseArgs, includeDiagnostics: "yes" },
      ],
    ];

    for (const [label, args] of cases) {
      const error = await canonicalErrorEnvelope(async () => {
        const response = await callStoredResponse(handler, "sdl.retrieve", args);
        return response.structuredContent;
      });
      assert.equal(error.code, "VALIDATION_ERROR", label);
    }
  });

  it("returns page-native content for auto and handle modes and replays to completion", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const payload = {
      rows: Array.from({ length: 1_000 }, (_, index) => ({
        index,
        value: `row-${index}-${"x".repeat(32)}`,
      })),
    };
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      sessionId: "session-a",
      requiresSameSession: true,
    });
    assert.equal(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") assert.fail("expected handle");

    const server = new MCPServer();
    registerResponseContinuationTools(server);
    const handler = getCallToolHandler(server);
    const firstArgs = {
      repoId: "repo-a",
      op: "responseGet",
      args: {
        handle: stored.payload.handle,
        cursor: { offsetBytes: 0 },
        maxBytes: 8192,
      },
    };

    const first = await callStoredResponse(
      handler,
      "sdl.retrieve",
      { ...firstArgs, responseMode: "auto" },
      "session-a",
    );
    const firstPage = first.structuredContent as {
      kind?: string;
      content?: string;
      complete?: boolean;
      nextAction?: {
        action?: string;
        args?: Record<string, unknown>;
      };
    };
    assert.equal(first.isError, undefined);
    assert.equal(firstPage.kind, undefined);
    assert.equal(typeof firstPage.content, "string");
    assert.equal(firstPage.complete, false);

    const chunks = [firstPage.content ?? ""];
    let nextAction = firstPage.nextAction;
    for (let pages = 1; nextAction && pages < 100; pages += 1) {
      assert.equal(nextAction.action, "sdl.retrieve");
      assert.equal(
        typeof nextAction.args?.repoId,
        "string",
        JSON.stringify(nextAction),
      );
      const response = await callStoredResponse(
        handler,
        "sdl.retrieve",
        nextAction.args ?? {},
        "session-a",
      );
      const page = response.structuredContent as {
        content?: string;
        complete?: boolean;
        nextAction?: {
          action?: string;
          args?: Record<string, unknown>;
        };
      };
      assert.equal(response.isError, undefined);
      assert.equal(typeof page.content, "string");
      chunks.push(page.content ?? "");
      nextAction = page.nextAction;
      if (page.complete) {
        assert.equal(nextAction, undefined);
        break;
      }
    }
    assert.deepEqual(JSON.parse(chunks.join("")), payload);

    const explicitHandle = await callStoredResponse(
      handler,
      "sdl.retrieve",
      { ...firstArgs, responseMode: "handle" },
      "session-a",
    );
    const handlePage = explicitHandle.structuredContent as {
      kind?: string;
      handle?: string;
      content?: string;
      complete?: boolean;
    };
    assert.equal(explicitHandle.isError, undefined);
    assert.equal(handlePage.kind, undefined);
    assert.equal(handlePage.handle, stored.payload.handle);
    assert.equal(typeof handlePage.content, "string");
    assert.equal(handlePage.complete, false);
  });

  it("preserves response.get security and lifecycle error codes", async () => {
    const baseDir = makeTempDir();
    configureArtifacts(baseDir);
    const responseActions = {
      "response.get": {
        schema: ResponseGetRequestSchema,
        definition: ACTION_DEFINITION_BY_ACTION["response.get"],
        handler: handleResponseGet,
      },
    };

    const store = async (
      entropy: string,
      options: Record<string, unknown> = {},
    ) => {
      const stored = await maybeStoreLargeResponse({
        repoId: "repo-a",
        toolName: "sdl.context",
        payload: "A".repeat(2048),
        responseMode: "handle",
        contentKind: "text",
        artifactBaseDir: baseDir,
        entropy: () => entropy,
        ...options,
      });
      assert.equal(stored.responseMode, "handle");
      if (stored.responseMode !== "handle") assert.fail("expected handle");
      return stored.payload.handle;
    };
    const compare = async (
      direct: Record<string, unknown>,
      retrieve: Record<string, unknown>,
      sessionId?: string,
    ) => {
      const context = {
        _meta: {},
        sendNotification: async () => {},
        signal: new AbortController().signal,
        ...(sessionId ? { sessionId } : {}),
      };
      const flatError = await canonicalErrorEnvelope(
        () => handleResponseGet(direct, context),
      );
      const retrieveError = await canonicalErrorEnvelope(
        () => handleRetrieve(retrieve, responseActions as never, context),
      );
      assert.notDeepStrictEqual(flatError, {});
      assert.deepStrictEqual(retrieveError, flatError);
    };
    const argsFor = (repoId: string, handle: string) => ({
      repoId,
      handle,
      view: "model",
      cursor: { offsetBytes: 0 },
      maxBytes: 8192,
    });
    const retrieveFor = (repoId: string, handle: string) => ({
      repoId,
      op: "responseGet",
      args: {
        handle,
        cursor: { offsetBytes: 0 },
        maxBytes: 8192,
      },
    });

    const wrongRepo = await store("1111111111111111");
    await compare(
      argsFor("repo-b", wrongRepo),
      retrieveFor("repo-b", wrongRepo),
    );

    const wrongSession = await store("2222222222222222", {
      sessionId: "session-a",
      requiresSameSession: true,
    });
    await compare(
      argsFor("repo-a", wrongSession),
      retrieveFor("repo-a", wrongSession),
      "session-b",
    );

    const expiredDirect = await store("3333333333333333", {
      artifactTtlHours: 1,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const expiredRetrieve = await store("4444444444444444", {
      artifactTtlHours: 1,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    await compare(
      argsFor("repo-a", expiredDirect),
      retrieveFor("repo-a", expiredRetrieve),
    );

    replaceRegisteredRepoIds(["repo-a"]);
    const epochDirect = await store("5555555555555555");
    const epochRetrieve = await store("6666666666666666");
    const removal = await beginRepoRemoval("repo-a");
    removal.commitTombstone();
    await compare(
      argsFor("repo-a", epochDirect),
      retrieveFor("repo-a", epochRetrieve),
    );
    resetRepoLifecycleForTests();

    const corrupt = async (entropy: string) => {
      const handle = await store(entropy);
      const manifestPath = join(
        getResponseArtifactBaseDir(baseDir),
        handle,
        "manifest.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
        string,
        unknown
      >;
      manifest.originalBytes = "invalid";
      writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
      return handle;
    };
    const corruptDirect = await corrupt("7777777777777777");
    const corruptRetrieve = await corrupt("8888888888888888");
    await compare(
      argsFor("repo-a", corruptDirect),
      retrieveFor("repo-a", corruptRetrieve),
    );

    const boundedDirect = await store("9999999999999999", {
      maxArtifactBytes: 4096,
    });
    const boundedRetrieve = await store("aaaaaaaaaaaaaaaa", {
      maxArtifactBytes: 4096,
    });
    writeFileSync(
      join(baseDir, "sdl.config.json"),
      JSON.stringify({
        repos: [],
        policy: {},
        runtime: { artifactBaseDir: baseDir, maxArtifactBytes: 1024 },
      }),
    );
    invalidateConfigCache();
    await compare(
      argsFor("repo-a", boundedDirect),
      retrieveFor("repo-a", boundedRetrieve),
    );
  });
});
