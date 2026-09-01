import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  FileGatewayOutputSchema,
  FileGatewayRequestSchema,
  handleFileGateway,
} from "../../dist/mcp/tools/file-gateway.js";
import { handleFileRead } from "../../dist/mcp/tools/file-read.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import {
  FileReadRequestSchema,
  withProjectionOutputSchema,
} from "../../dist/mcp/tools.js";
import {
  MCPServer,
  type ToolResponseEnvelope,
} from "../../dist/server.js";

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: () => Promise<void>;
    signal: AbortSignal;
  },
) => Promise<ToolResponseEnvelope>;

const REPO_ID = "file-read-response-mode-test";
const SENTINEL = "LARGE_UNTARGETED_SENTINEL_NEAR_END";
const DELTA_SENTINEL = "LARGE_DELTA_SENTINEL_NEAR_END";
const LARGE_DELTA_LINES = Array.from(
  { length: 4_000 },
  (_, index) => `delta-line-${index.toString().padStart(4, "0")}`,
);
const originalConfig = process.env.SDL_CONFIG;
let testRoot: string;
let repoRoot: string;

function getCallToolHandler(server: MCPServer): CallToolHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, CallToolHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/call");
  assert.ok(handler);
  return handler;
}

async function callFileRead(
  callTool: CallToolHandler,
  args: Record<string, unknown>,
): Promise<ToolResponseEnvelope> {
  return callTool(
    {
      method: "tools/call",
      params: { name: "sdl.file.read", arguments: { repoId: REPO_ID, ...args } },
    },
    {
      _meta: {},
      sendNotification: async () => {},
      signal: new AbortController().signal,
    },
  );
}

function channelText(response: ToolResponseEnvelope): string {
  return JSON.stringify({
    content: response.content,
    structuredContent: response.structuredContent,
  });
}

describe("sdl.file.read responseMode preflight", { concurrency: false }, () => {
  let callTool: CallToolHandler;

  before(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-file-read-response-mode-"));
    repoRoot = join(testRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "small.txt"), "small inline text\n", "utf-8");
    await writeFile(
      join(repoRoot, "large.txt"),
      "preview-start\n" + "x".repeat(80_000) + "\n" + SENTINEL + "\n",
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "large-delta.txt"),
      LARGE_DELTA_LINES.join("\n") + "\n" + DELTA_SENTINEL + "\n",
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "data.json"),
      JSON.stringify({ outer: { wanted: "json-target" }, padding: "z".repeat(40_000) }),
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "multibyte.json"),
      JSON.stringify({
        outer: {
          wanted: "é🙂終",
          object: { label: "é🙂終" },
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "multibyte-search.txt"),
      "context é🙂\nneedle é🙂終\ncontext 終🙂\n",
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "multibyte-range.txt"),
      "é🙂終\nsecond\n",
      "utf-8",
    );

    const configPath = join(testRoot, "sdl.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        repos: [],
        policy: {},
        runtime: { artifactBaseDir: join(testRoot, "artifacts") },
      }),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    await initLadybugDb(join(testRoot, "graph"));
    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoRoot,
        ignore: [],
        languages: ["md"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    const server = new MCPServer();
    server.registerTool(
      "sdl.file.read",
      "Read a non-indexed file",
      FileReadRequestSchema,
      (args, context) => handleFileRead(args, context),
    );
    server.registerTool(
      "sdl.file",
      "Read through the unified file gateway",
      FileGatewayRequestSchema,
      (args, context) => handleFileGateway(args, context),
      undefined,
      undefined,
      undefined,
      withProjectionOutputSchema("file", FileGatewayOutputSchema),
    );
    callTool = getCallToolHandler(server);
  });

  after(async () => {
    await closeLadybugDb();
    if (originalConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalConfig;
    invalidateConfigCache();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("defaults responseMode to auto", () => {
    assert.equal(
      FileReadRequestSchema.parse({
        repoId: REPO_ID,
        filePath: "small.txt",
      }).responseMode,
      "auto",
    );
  });

  it("keeps small reads inline", async () => {
    const response = await callFileRead(callTool, { filePath: "small.txt" });
    assert.match(channelText(response), /small inline text/);
    assert.doesNotMatch(channelText(response), /responseArtifact/);
  });

  it("preflights large untargeted reads into one recoverable handle without sentinel delivery", async () => {
    const response = await callFileRead(callTool, { filePath: "large.txt" });
    const wire = channelText(response);
    assert.doesNotMatch(wire, new RegExp(SENTINEL));
    assert.match(wire, /preview-start/);
    assert.match(wire, /responseArtifact/);
    assert.match(wire, /response\.get/);

    const handleMatches = [...wire.matchAll(/response-[^"\\]+/g)].map(
      (match) => match[0],
    );
    assert.equal(new Set(handleMatches).size, 1);

    const artifact = response.structuredContent as { handle: string };
    const recovered = await handleResponseGet({
      repoId: REPO_ID,
      handle: artifact.handle,
      full: true,
    }) as Record<string, unknown>;
    assert.match(JSON.stringify(recovered.content), new RegExp(SENTINEL));
  });

  it("always handles explicit handle mode and rejects oversized inline delivery", async () => {
    const handled = await callFileRead(callTool, {
      filePath: "small.txt",
      responseMode: "handle",
    });
    assert.match(channelText(handled), /responseArtifact/);
    const projectedPreview = (
      handled.structuredContent as { preview: Record<string, unknown> }
    ).preview;
    assert.equal(projectedPreview.truncated, false);
    assert.equal("truncatedAt" in projectedPreview, false);

    const directHandled = await handleFileRead({
      repoId: REPO_ID,
      filePath: "small.txt",
      responseMode: "handle",
    }) as Record<string, unknown>;
    const directPreview = directHandled.preview as Record<string, unknown>;
    assert.equal(directPreview.truncated, false);
    assert.equal("truncatedAt" in directPreview, false);

    const inline = await callFileRead(callTool, {
      filePath: "large.txt",
      responseMode: "inline",
    });
    const wire = channelText(inline);
    assert.doesNotMatch(wire, new RegExp(SENTINEL));
    assert.match(wire, /INLINE_RESPONSE_TOO_LARGE/);
    assert.match(wire, /response\.get/);
  });

  it("keeps the unified sdl.file oversized-inline error inside its output schema", async () => {
    const response = await callTool(
      {
        method: "tools/call",
        params: {
          name: "sdl.file",
          arguments: {
            repoId: REPO_ID,
            op: "read",
            filePath: "large.txt",
            responseMode: "inline",
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
    assert.doesNotMatch(
      JSON.stringify(response),
      /Structured content does not match internal output schema/i,
    );
  });

  it("preserves explicitly bounded, search, range, and JSON-path requests", async () => {
    const range = await handleFileRead({
      repoId: REPO_ID,
      filePath: "large.txt",
      offset: 0,
      limit: 1,
      maxBytes: 64,
      maxTokens: 16,
    }) as Record<string, unknown>;
    assert.equal(range.content, "1: preview-start");

    const search = await handleFileRead({
      repoId: REPO_ID,
      filePath: "large.txt",
      search: SENTINEL,
      searchContext: 0,
      maxBytes: 128,
      responseMode: "inline",
    }) as Record<string, unknown>;
    assert.match(String(search.content), new RegExp(SENTINEL));

    const json = await handleFileRead({
      repoId: REPO_ID,
      filePath: "data.json",
      jsonPath: "outer.wanted",
      maxBytes: 64,
      maxTokens: 16,
    }) as Record<string, unknown>;
    assert.equal(json.content, "json-target");
  });

  it("clamps targeted multibyte content at valid UTF-8 boundaries", async () => {
    const jsonString = await handleFileRead({
      repoId: REPO_ID,
      filePath: "multibyte.json",
      jsonPath: "outer.wanted",
      maxBytes: 3,
    }) as Record<string, unknown>;
    assert.equal(jsonString.content, "é");
    assert.equal(jsonString.extractedPath, "outer.wanted");
    assert.equal(jsonString.bytes, Buffer.byteLength("é🙂終", "utf-8"));
    assert.equal(jsonString.totalLines, 1);
    assert.equal(jsonString.returnedLines, 1);
    assert.equal(jsonString.truncated, true);
    assert.equal(jsonString.truncatedAt, 3);
    assert.ok(Buffer.byteLength(String(jsonString.content), "utf-8") <= 3);
    assert.doesNotMatch(String(jsonString.content), /\uFFFD/);

    const jsonObjectArgs = {
      repoId: REPO_ID,
      filePath: "multibyte.json",
      jsonPath: "outer.object",
      maxBytes: 18,
    };
    const jsonObject = await handleFileRead(jsonObjectArgs) as Record<string, unknown>;
    const repeatedJsonObject = await handleFileRead(jsonObjectArgs) as Record<string, unknown>;
    assert.equal(jsonObject.content, '{\n  "label": "é');
    assert.equal(jsonObject.content, repeatedJsonObject.content);
    assert.equal(jsonObject.extractedPath, "outer.object");
    assert.equal(jsonObject.totalLines, 1);
    assert.equal(jsonObject.returnedLines, 2);
    assert.equal(
      jsonObject.bytes,
      Buffer.byteLength(JSON.stringify({ label: "é🙂終" }, null, 2), "utf-8"),
    );
    assert.equal(jsonObject.truncated, true);
    assert.equal(jsonObject.truncatedAt, 18);
    assert.ok(Buffer.byteLength(String(jsonObject.content), "utf-8") <= 18);
    assert.doesNotMatch(String(jsonObject.content), /\uFFFD/);

    const searchArgs = {
      repoId: REPO_ID,
      filePath: "multibyte-search.txt",
      search: "needle",
      searchContext: 1,
      maxBytes: 15,
    };
    const search = await handleFileRead(searchArgs) as Record<string, unknown>;
    const repeatedSearch = await handleFileRead(searchArgs) as Record<string, unknown>;
    assert.equal(search.content, " 1: context é");
    assert.equal(search.content, repeatedSearch.content);
    assert.equal(search.matchCount, 1);
    assert.equal(search.totalLines, 4);
    assert.equal(search.returnedLines, 3);
    assert.equal(search.truncated, true);
    assert.equal(search.truncatedAt, 15);
    assert.ok(Buffer.byteLength(String(search.content), "utf-8") <= 15);
    assert.doesNotMatch(String(search.content), /\uFFFD/);

    const rangeArgs = {
      repoId: REPO_ID,
      filePath: "multibyte-range.txt",
      offset: 0,
      limit: 1,
      maxBytes: 7,
    };
    const range = await handleFileRead(rangeArgs) as Record<string, unknown>;
    const repeatedRange = await handleFileRead(rangeArgs) as Record<string, unknown>;
    assert.equal(range.content, "1: é");
    assert.equal(range.content, repeatedRange.content);
    assert.equal(range.totalLines, 3);
    assert.equal(range.returnedLines, 1);
    assert.equal(range.bytes, Buffer.byteLength("1: é🙂終", "utf-8"));
    assert.equal(range.truncated, true);
    assert.equal(range.truncatedAt, 7);
    assert.ok(Buffer.byteLength(String(range.content), "utf-8") <= 7);
    assert.doesNotMatch(String(range.content), /\uFFFD/);
  });

  it("decodes default bounded multibyte reads at complete UTF-8 boundaries", async () => {
    const source = "\u00e9\u{1F642}\u7d42\nsecond\n";
    const cases = [
      {
        args: { maxBytes: 7 },
        effectiveBytes: 7,
        expectedContent: "\u00e9\u{1F642}",
      },
      {
        args: { maxTokens: 1 },
        effectiveBytes: 4,
        expectedContent: "\u00e9",
      },
      {
        args: { maxBytes: 7, maxTokens: 1 },
        effectiveBytes: 4,
        expectedContent: "\u00e9",
      },
    ];

    for (const testCase of cases) {
      const args = {
        repoId: REPO_ID,
        filePath: "multibyte-range.txt",
        ...testCase.args,
      };
      const response = await handleFileRead(args) as Record<string, unknown>;
      const repeated = await handleFileRead(args) as Record<string, unknown>;
      const content = String(response.content);

      assert.equal(content, testCase.expectedContent);
      assert.equal(content, repeated.content);
      assert.ok(
        Buffer.byteLength(content, "utf-8") <= testCase.effectiveBytes,
      );
      assert.doesNotMatch(content, /\uFFFD/);
      assert.equal(response.bytes, Buffer.byteLength(source, "utf-8"));
      assert.equal(response.totalLines, 1);
      assert.equal(response.returnedLines, 1);
      assert.equal(response.truncated, true);
      assert.equal(response.truncatedAt, testCase.effectiveBytes);
    }
  });

  it("sizes same-session large delta reads after shaping", async () => {
    const context = {
      sessionId: "large-file-read-delta-session",
      sendNotification: async () => {},
      signal: new AbortController().signal,
    };
    const request = {
      repoId: REPO_ID,
      filePath: "large-delta.txt",
      deltaMode: "auto" as const,
    };

    const first = await handleFileRead(request, context) as Record<string, unknown>;
    assert.equal(first.responseMode, "handle");
    assert.doesNotMatch(JSON.stringify(first), new RegExp(DELTA_SENTINEL));
    const firstRecovered = await handleResponseGet({
      repoId: REPO_ID,
      handle: first.handle,
      full: true,
    }, context) as Record<string, unknown>;
    assert.match(
      JSON.stringify(firstRecovered.content),
      new RegExp(DELTA_SENTINEL),
    );

    const unchanged = await handleFileRead(request, context) as Record<string, unknown>;
    assert.equal("handle" in unchanged, false);
    assert.equal(unchanged.content, "");
    assert.equal(
      (unchanged.sessionDelta as Record<string, unknown>).cacheHit,
      true,
    );
    assert.equal(
      (unchanged.delta as Record<string, unknown>).status,
      "unchanged",
    );
    assert.doesNotMatch(JSON.stringify(unchanged), new RegExp(DELTA_SENTINEL));
    const repeatedUnchanged = await handleFileRead(
      request,
      context,
    ) as Record<string, unknown>;
    assert.deepEqual(repeatedUnchanged, unchanged);

    const changedLines = [...LARGE_DELTA_LINES];
    changedLines[2_000] = "delta-line-2000-changed";
    await writeFile(
      join(repoRoot, "large-delta.txt"),
      changedLines.join("\n") + "\n" + DELTA_SENTINEL + "\n",
      "utf-8",
    );
    const changed = await handleFileRead(request, context) as Record<string, unknown>;
    assert.equal("handle" in changed, false);
    assert.equal(changed.content, "");
    assert.equal((changed.delta as Record<string, unknown>).status, "changed");
    assert.match(
      String((changed.delta as Record<string, unknown>).excerpt),
      /delta-line-2000-changed/,
    );
    assert.doesNotMatch(JSON.stringify(changed), new RegExp(DELTA_SENTINEL));

    const oversizedSentinel = "OVERSIZED_DELTA_SENTINEL_NEAR_END";
    const oversizedLines = [...changedLines];
    oversizedLines[1_000] = "delta-line-1000-oversized-change";
    oversizedLines[3_000] = "delta-line-3000-oversized-change";
    await writeFile(
      join(repoRoot, "large-delta.txt"),
      oversizedLines.join("\n") + "\n" + oversizedSentinel + "\n",
      "utf-8",
    );
    const oversized = await handleFileRead(
      { ...request, maxDeltaLines: 1 },
      context,
    ) as Record<string, unknown>;
    assert.equal(oversized.responseMode, "handle");
    assert.doesNotMatch(JSON.stringify(oversized), new RegExp(oversizedSentinel));
    const oversizedRecovered = await handleResponseGet({
      repoId: REPO_ID,
      handle: oversized.handle,
      full: true,
    }, context) as Record<string, unknown>;
    assert.match(
      JSON.stringify(oversizedRecovered.content),
      new RegExp(oversizedSentinel),
    );
  });
});
