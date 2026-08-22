import { describe, it } from "node:test";
import assert from "node:assert";

import { z } from "zod";

import {
  buildToolResponseContentBlocks,
  buildToolResponseEnvelope,
  MCPServer,
} from "../../dist/server.js";
import {
  projectCompatibilityValue,
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
  resolveCompatibilityProjectionProfile,
} from "../../dist/mcp/context-response-projection.js";
import { projectModelValue } from "../../dist/mcp/response-projection/projectors/index.js";
import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";
import { formatCliToolOutput } from "../../dist/cli/commands/tool-dispatch.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

const REPRESENTATIVE_TOOL_NAMES = [
  "sdl.action.search",
  "sdl.agent.feedback",
  "sdl.buffer.checkpoint",
  "sdl.code.getHotPath",
  "sdl.code.getSkeleton",
  "sdl.code.needWindow",
  "sdl.context",
  "sdl.delta.get",
  "sdl.file",
  "sdl.file.read",
  "sdl.file.write",
  "sdl.index.refresh",
  "sdl.manual",
  "sdl.memory.query",
  "sdl.memory.store",
  "sdl.policy.get",
  "sdl.pr.risk.analyze",
  "sdl.repo.overview",
  "sdl.repo.status",
  "sdl.runtime.execute",
  "sdl.search.edit",
  "sdl.semantic.enrichment.status",
  "sdl.slice.build",
  "sdl.symbol.getCard",
  "sdl.symbol.search",
  "sdl.usage.stats",
  "sdl.workflow",
];

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: (notification: {
      params?: { data?: unknown };
    }) => Promise<void>;
    signal: AbortSignal;
  },
) => Promise<Record<string, unknown>>;

function getCallToolHandler(server: MCPServer): CallToolHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, CallToolHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/call");
  assert.ok(handler, "tools/call handler should be registered");
  return handler;
}

function captureConsoleLog(run: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

function buildVisibleEnvelope(
  toolName: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  return buildToolResponseEnvelope(payload, null, "", toolName, args);
}

describe("visible tool output", () => {
  it("preserves conditional not-modified symbol card responses", () => {
    const conditional = {
      notModified: true,
      etag: "card-etag",
      ledgerVersion: "v1",
    };

    assert.deepEqual(
      projectModelValue(
        {
          canonicalResult: conditional,
          action: "symbol.getCard",
          profile: resolveCompatibilityProjectionProfile("symbol.getCard"),
          options: { detail: "compact", includeDiagnostics: false },
          context: {
            toolName: "symbol.getCard",
            requestArgs: { detail: "compact" },
          },
        },
        projectCompatibilityValue,
      ),
      conditional,
    );
    assert.deepEqual(
      projectToolResultForModelContent("symbol.getCard", conditional, {
        detail: "compact",
      }),
      conditional,
    );
    assert.deepEqual(
      projectWorkflowChildResultForModel(
        "symbolGetCard",
        conditional,
        { repoId: "sdl-mcp" },
        { detail: "compact" },
      ),
      conditional,
    );
  });

  it("suppresses token-meter footer output by default", () => {
    const footer = "100 / 1.0k tokens (SDL/raw-equiv)";
    const envelope = buildToolResponseEnvelope(
      {
        filePath: "src/server.ts",
        mode: "replacePattern",
        etag: "file-etag",
        diagnostics: { timings: { totalMs: 10 } },
        _packedStats: { savedRatio: 0.2 },
        _displayFooter: footer,
      },
      null,
      footer,
      "sdl.file",
      { op: "write" },
    );

    assert.match(envelope.content[0]?.text ?? "", /file\.write \(replacePattern\)/);
    assert.doesNotMatch(envelope.content[0]?.text ?? "", /^\s*\{/);
    assert.equal(envelope.content[1], undefined);
    assert.equal(envelope._displayFooter, undefined);
    assert.equal(envelope.structuredContent?.etag, undefined);
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.equal(envelope.structuredContent?._displayFooter, undefined);
    assert.ok(envelope.projectionStats);
  });

  it("shows display footers when telemetry is explicitly requested", () => {
    const footer = "100 / 1.0k tokens (SDL/raw-equiv)";
    const envelope = buildToolResponseEnvelope(
      { filePath: "src/server.ts", mode: "replacePattern", etag: "file-etag" },
      null,
      footer,
      "file.write",
      { includeTelemetry: true },
    );

    assert.ok((envelope.content[0]?.text ?? "").includes(footer));
    assert.equal(envelope.content[1], undefined);
    assert.equal(envelope._displayFooter, footer);
    assert.equal(envelope.structuredContent?.etag, undefined);
  });

  it("bounds direct legacy content-block helper output through model projection", () => {
    const blocks = buildToolResponseContentBlocks(
      { status: "success", stdoutSummary: "complete" },
      `#PACKED/v1\ncanonical-secret\n${"unbounded ".repeat(500)}`,
      "",
      "sdl.runtime.execute",
      {},
    );

    assert.equal(blocks.length, 1);
    assert.ok(estimateTokens(blocks[0]?.text ?? "") <= 120);
    assert.doesNotMatch(blocks[0]?.text ?? "", /#PACKED\/|canonical-secret/);
  });

  it("formats sdl.context as an evidence summary without internal noise", () => {
    const blocks = buildToolResponseContentBlocks(
      {
        status: "complete",
        taskType: "debug",
        evidence: [
          {
            symbolId: "symbol:abc",
            rung: "card",
            card: { file: "src/server.ts" },
          },
          {
            symbolId: "symbol:def",
            rung: "hotPath",
            hotPath: { code: "function attachDisplayFooter() {}" },
          },
        ],
        diagnostics: { timings: { totalMs: 12 } },
        path: { rungs: [{ type: "card" }] },
        actionsTaken: [{ fn: "getCard" }],
        etag: "abc123",
      },
      null,
      "",
      "sdl.context",
      {},
    );

    assert.equal(
      blocks[0]?.text,
      [
        "Sdl context",
        "",
        "status: complete",
        "taskType: debug",
        "evidence: 2 items",
      ].join("\n"),
    );
    assert.doesNotMatch(blocks[0]?.text ?? "", /diagnostics|actionsTaken|taskId|rungs/);
    assert.doesNotMatch(blocks[0]?.text ?? "", /etag|abc123/);
  });

  it("keeps task-relevant structured content and omits internal fields by default", () => {
    const envelope = buildToolResponseEnvelope(
      {
        status: "complete",
        taskType: "debug",
        evidence: [
          {
            symbolId: "symbol:1",
            rung: "card",
            card: { file: "src/config/load-config.ts" },
          },
        ],
        retrievalEvidence: { fusionLatencyMs: 10 },
        diagnostics: { timings: { totalMs: 12 } },
        _packedStats: { savedRatio: 0.5 },
        actionsTaken: [{ fn: "getCard" }],
        path: { rungs: [{ type: "card" }] },
        etag: "abc123",
      },
      null,
      "",
      "sdl.context",
      {},
    );

    assert.equal(envelope.structuredContent?.status, "complete");
    assert.equal(envelope.structuredContent?.taskType, "debug");
    assert.equal(envelope.structuredContent?.etag, undefined);
    assert.equal(envelope.structuredContent?.retrievalEvidence, undefined);
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.equal(envelope.structuredContent?.actionsTaken, undefined);
    assert.equal(envelope.structuredContent?.path, undefined);

    const evidence = envelope.structuredContent?.evidence as Record<string, unknown>[];
    assert.equal(evidence[0]?.symbolId, "symbol:1");
  });

  it("omits memory hints from generic structured content", () => {
    const envelope = buildToolResponseEnvelope(
      {
        repoId: "repo",
        memories: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
        _memoryHint: {
          suggestedType: "bugfix",
          message: "Consider storing context about this debugging session.",
          pattern: "deep_debugging",
        },
      },
      null,
      "",
      "sdl.memory.query",
      {},
    );

    assert.equal(envelope.structuredContent?._memoryHint, undefined);
  });

  it("omits workflow etag cache from agent-visible output", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [],
        totalTokens: 0,
        durationMs: 1,
        truncated: false,
        etagCache: { sym: "etag-sym" },
      },
      null,
      "",
      "sdl.workflow",
      { includeTelemetry: true },
    );

    assert.equal(envelope.structuredContent?.etagCache, undefined);
    assert.doesNotMatch(envelope.content[0]?.text ?? "", /etag-sym|etagCache/);
  });

  it("marks workflows with failed steps as MCP errors without duplicating raw errors", () => {
    const failedResults = [
      { fn: "fileWrite", status: "error", result: { message: "invalid syntax" } },
      { fn: "searchEditApply", status: "skipped" },
    ];
    const failedEnvelope = buildToolResponseEnvelope(
      { results: failedResults },
      null,
      "",
      "sdl.workflow",
      { detail: "full" },
    );

    assert.equal(failedEnvelope.isError, true);
    assert.deepEqual(failedEnvelope.structuredContent?.results, [
      { stepIndex: 0, fn: "fileWrite", status: "error" },
      { stepIndex: 1, fn: "searchEditApply", status: "skipped" },
    ]);

    const successfulEnvelope = buildToolResponseEnvelope(
      {
        results: [
          { fn: "repoStatus", status: "ok", result: { repoId: "repo" } },
          { fn: "searchEditApply", status: "skipped" },
        ],
      },
      null,
      "",
      "sdl.workflow",
    );

    assert.equal(successfulEnvelope.isError, undefined);
  });

  it("keeps requested diagnostics in structured content without adding them to visible text", () => {
    const envelope = buildToolResponseEnvelope(
      {
        status: "complete",
        taskType: "debug",
        evidence: [],
        diagnosticTimings: { totalMs: 12 },
        _packedStats: { savedRatio: 0.5 },
      },
      null,
      "",
      "sdl.context",
      {
        includeDiagnostics: true,
      },
    );

    assert.deepEqual(envelope.structuredContent?.diagnosticTimings, { totalMs: 12 });
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.doesNotMatch(
      envelope.content[0]?.text ?? "",
      /totalMs|diagnosticTimings|_packedStats/,
    );
  });

  it("preserves requested timing diagnostics for generic tools", () => {
    const envelope = buildToolResponseEnvelope(
      {
        ok: true,
        repoId: "repo",
        versionId: "v1",
        diagnostics: { timings: { totalMs: 12, phases: { dispatch: 10 } } },
      },
      null,
      "",
      "sdl.index.refresh",
      { includeDiagnostics: true },
    );

    assert.deepEqual(envelope.structuredContent?.diagnostics, {
      timings: { totalMs: 12, phases: { dispatch: 10 } },
    });
  });

  it("omits the slice refresh lease without mutating the canonical result", () => {
    const canonical = {
      sliceHandle: "slice-1",
      currentVersion: "version-2",
      delta: null,
      lease: {
        expiresAt: "2026-08-22T12:00:00.000Z",
        minVersion: "version-1",
        maxVersion: "version-2",
      },
    };
    const snapshot = structuredClone(canonical);

    const envelope = buildToolResponseEnvelope(
      canonical,
      null,
      "",
      "sdl.slice.refresh",
      {},
    );

    assert.deepEqual(envelope.structuredContent, {
      sliceHandle: "slice-1",
      currentVersion: "version-2",
      delta: null,
    });
    assert.deepEqual(canonical, snapshot);
  });

  it("formats every representative tool with non-JSON visible text", () => {
    for (const toolName of REPRESENTATIVE_TOOL_NAMES) {
      const display = formatToolCallForUser(toolName, {}, {
        success: true,
        status: "ok",
        etag: `${toolName}-etag`,
        summary: `${toolName} completed`,
      });

      assert.ok(display, toolName);
      assert.doesNotMatch(display ?? "", /^\s*\{/, toolName);
    }
  });

  it("hides etag fields in generic fallback output", () => {
    const display = formatToolCallForUser("sdl.unformatted", {}, {
      status: "ok",
      etag: "generic-etag",
      etagCache: { step: "cache-etag" },
      sliceEtag: "slice-etag",
    });

    assert.ok(display);
    assert.doesNotMatch(display ?? "", /etag|etagCache|sliceEtag|generic-etag|cache-etag|slice-etag/i);
  });

  it("formats CLI direct-action pretty output through the tool formatter", () => {
    const output = captureConsoleLog(() =>
      formatCliToolOutput(
        "repo.status",
        {},
        {
          repoId: "sdl-mcp",
          status: "ok",
          etag: "repo-etag",
          diagnostics: { timings: { totalMs: 2 } },
        },
        "pretty",
      ),
    );

    assert.doesNotMatch(output, /^\s*\{/);
    assert.match(output, /repo\.status ->/);
    assert.doesNotMatch(output, /diagnostics|timings|totalMs/);
  });

  it("keeps CLI pretty edit output on full presentation", () => {
    const output = captureConsoleLog(() =>
      formatCliToolOutput(
        "file.write",
        { filePath: "src/server.ts", editMode: "replacePattern" },
        {
          filePath: "src/server.ts",
          mode: "replacePattern",
          replacementCount: 1,
          snippets: {
            before: "  1 | oldCliValue",
            after: "  1 | newCliValue",
          },
        },
        "pretty",
      ),
    );

    assert.match(output, /--- before[\s\S]*oldCliValue/);
    assert.match(output, /\+\+\+ after[\s\S]*newCliValue/);
  });

  it("leaves non-edit formatting unchanged in summary presentation", () => {
    const payload = {
      status: "complete",
      exitCode: 0,
      stdoutSummary: "diff-looking text: --- before and +++ after",
    };
    const full = formatToolCallForUser("sdl.runtime.execute", {}, payload);
    const summary = formatToolCallForUser("sdl.runtime.execute", {}, payload, {
      presentation: "summary",
    });
    const envelope = buildVisibleEnvelope("sdl.runtime.execute", {}, payload);

    assert.equal(summary, full);
    assert.equal(
      envelope.content[0]?.text,
      "runtime.execute -> complete (exit 0)\n"
        + "  stdout:\n"
        + "    diff-looking text: --- before and +++ after",
    );
  });

  it("projects sdl.context structured fields after compact visible projection", () => {
    const result = buildVisibleEnvelope(
      "sdl.context",
      {},
      {
        status: "complete",
        taskType: "debug",
        evidence: [],
        etag: "context-etag",
        diagnostics: { timings: { totalMs: 12 } },
      },
    );

    const content = result.content as Array<Record<string, unknown>>;
    const structuredContent = result.structuredContent as Record<string, unknown>;
    assert.equal(structuredContent.etag, undefined);
    assert.equal(structuredContent.diagnostics, undefined);
    assert.doesNotMatch(String(content[0]?.text), /totalMs/);
    assert.doesNotMatch(String(content[0]?.text), /context-etag/);
  });

  it("projects compact usageStats aggregate and top tools", async () => {
    const server = new MCPServer();
    server.registerTool(
      "sdl.usage.stats",
      "Usage stats test tool",
      z.object({}),
      async () => ({
        session: {
          totalSdlTokens: 120,
          totalRawEquivalent: 500,
          totalSavedTokens: 380,
          overallSavingsPercent: 76,
          callCount: 2,
          toolBreakdown: [{
            tool: "sdl.symbol.search",
            sdlTokens: 120,
            rawEquivalent: 500,
            savedTokens: 380,
            callCount: 2,
          }],
        },
      }),
    );

    const handler = getCallToolHandler(server);
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "sdl.usage.stats", arguments: {} },
      },
      {
        _meta: {},
        sendNotification: async () => {},
        signal: new AbortController().signal,
      },
    );

    const structuredContent = result.structuredContent as Record<string, unknown>;
    const aggregate = structuredContent.aggregate as Record<string, unknown>;
    const topTools = structuredContent.topTools as Array<Record<string, unknown>>;
    assert.equal(aggregate.totalSdlTokens, 120);
    assert.equal(aggregate.totalSavedTokens, 380);
    assert.equal(topTools[0]?.tool, "sdl.symbol.search");
    assert.doesNotMatch(
      (result.content as Array<Record<string, unknown>>)
        .map((block) => String(block.text))
        .join("\n"),
      /^\s*[\[{]/,
    );
  });

  it("projects actual server validation errors into structured content", async () => {
    const server = new MCPServer();
    server.registerTool(
      "sdl.info",
      "Validation test tool",
      z.object({ filePath: z.string() }),
      async () => ({ success: true }),
    );

    const handler = getCallToolHandler(server);
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "sdl.info", arguments: {} },
      },
      {
        _meta: {},
        sendNotification: async () => {},
        signal: new AbortController().signal,
      },
    );

    const content = result.content as Array<Record<string, unknown>>;
    const structuredContent = result.structuredContent as Record<string, unknown>;
    const error = structuredContent.error as Record<string, unknown>;
    const details = error.details as Array<Record<string, unknown>>;

    assert.equal(result.isError, true);
    assert.match(String(content[0]?.text), /^sdl.info \[error\]/);
    assert.match(String(content[0]?.text), /Invalid tool arguments/);
    assert.doesNotMatch(String(content[0]?.text), /^\s*\{/);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(details[0]?.path, "filePath");
  });

  it("formats tool errors for self-correction while preserving structured details", () => {
    const envelope = buildToolResponseEnvelope(
      {
        error: {
          message: "Invalid tool arguments: missing filePath",
          code: "VALIDATION_ERROR",
          details: [{ path: "filePath", message: "Required" }],
        },
        diagnostics: { timings: { totalMs: 2 } },
        etag: "err-etag",
      },
      null,
      "",
      "sdl.file",
      { op: "read" },
    );

    assert.match(envelope.content[0]?.text ?? "", /Invalid tool arguments/);
    assert.equal(envelope.structuredContent?.etag, undefined);
    assert.deepEqual((envelope.structuredContent?.error as Record<string, unknown>)?.details, [
      { path: "filePath", message: "Required" },
    ]);
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
  });

  it("keeps file-write snippets only in structured content for real MCP envelopes", async () => {
    const snippets = {
      before: "  1 | oldValue",
      after: "  1 | newValue",
    };
    const notifications: string[] = [];
    const server = new MCPServer();
    server.registerTool(
      "sdl.file.write",
      "File write visibility test tool",
      z.object({ filePath: z.string() }),
      async ({ filePath }) => ({
        filePath,
        mode: "replacePattern",
        bytesWritten: 10,
        linesWritten: 1,
        replacementCount: 1,
        snippets,
      }),
    );

    const result = await getCallToolHandler(server)(
      {
        method: "tools/call",
        params: {
          name: "sdl.file.write",
          arguments: { filePath: "src/server.ts" },
        },
      },
      {
        _meta: {},
        sendNotification: async (notification) => {
          if (typeof notification.params?.data === "string") {
            notifications.push(notification.params.data);
          }
        },
        signal: new AbortController().signal,
      },
    );

    const visibleText = String(
      (result.content as Array<Record<string, unknown>>)[0]?.text,
    );
    assert.equal(
      visibleText,
      "file.write (replacePattern) -> src/server.ts, 1 replacement (applied)",
    );
    assert.doesNotMatch(visibleText, /--- before|\+\+\+ after|oldValue|newValue/);
    assert.deepEqual(
      (result.structuredContent as Record<string, unknown>).snippets,
      snippets,
    );
    assert.equal(JSON.stringify(result).match(/oldValue/g)?.length, 1);
    assert.equal(JSON.stringify(result).match(/newValue/g)?.length, 1);
    assert.match(notifications.join("\n"), /--- before[\s\S]*oldValue/);
    assert.match(notifications.join("\n"), /\+\+\+ after[\s\S]*newValue/);
  });

  it("uses edit summaries for file-gateway edit operations", () => {
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      payload: Record<string, unknown>;
      expected: string;
    }> = [
      {
        name: "write",
        args: { op: "write", filePath: "src/server.ts" },
        payload: {
          filePath: "src/server.ts",
          mode: "replacePattern",
          replacementCount: 1,
          snippets: { before: "oldGateway", after: "newGateway" },
        },
        expected:
          "file.write (replacePattern) -> src/server.ts, 1 replacement (applied)",
      },
      {
        name: "search preview",
        args: { op: "searchEditPreview" },
        payload: {
          mode: "preview",
          planHandle: "gateway-search-plan",
          matchesFound: 1,
          filesMatched: 1,
          fileEntries: [{ file: "src/server.ts", matchCount: 1 }],
        },
        expected:
          "search.edit preview -> 1 match in 1 file (plan gateway-search-plan)",
      },
      {
        name: "search apply",
        args: { op: "searchEditApply" },
        payload: {
          mode: "apply",
          planHandle: "gateway-search-apply-plan",
          filesAttempted: 1,
          filesWritten: 1,
          filesFailed: 0,
          filesSkipped: 0,
          fileEntries: [{ file: "src/server.ts", matchCount: 1 }],
          results: [{ file: "src/server.ts", status: "written" }],
        },
        expected:
          "search.edit apply -> applied 1 edit in 1/1 file (plan gateway-search-apply-plan)",
      },
      {
        name: "symbol preview",
        args: { op: "symbolEditPreview" },
        payload: {
          mode: "preview",
          planHandle: "gateway-symbol-plan",
          symbolName: "Widget",
          operation: "replaceBody",
          file: "src/widget.ts",
          writeTarget: "file",
          fileEntries: [{ file: "src/widget.ts", matchCount: 1 }],
        },
        expected:
          "symbol.edit preview -> replaceBody Widget in src/widget.ts (file); 1 edit; plan gateway-symbol-plan",
      },
      {
        name: "symbol apply-now",
        args: { op: "symbolEditApplyNow" },
        payload: {
          mode: "apply",
          planHandle: "gateway-symbol-apply-plan",
          symbolName: "Widget",
          operation: "replaceBody",
          file: "src/widget.ts",
          writeTarget: "file",
          filesAttempted: 1,
          filesWritten: 1,
          filesFailed: 0,
          filesSkipped: 0,
        },
        expected:
          "symbol.edit apply -> replaceBody Widget in src/widget.ts (file); applied 1/1 edit; plan gateway-symbol-apply-plan",
      },
    ];

    for (const testCase of cases) {
      const envelope = buildVisibleEnvelope(
        "sdl.file",
        testCase.args,
        testCase.payload,
      );
      assert.equal(envelope.content[0]?.text, testCase.expected, testCase.name);
    }
  });

  it("renders file-gateway search preview response artifacts as continuation handles", () => {
    const payload = {
      responseMode: "handle",
      kind: "responseArtifact",
      handle: "response-search-preview-123",
      action: "response.get",
      metadata: {
        toolName: "sdl.search.edit",
        contentKind: "json",
        originalBytes: 100_000,
      },
    };
    const args = { op: "searchEditPreview" };
    const envelope = buildVisibleEnvelope("sdl.file", args, payload);

    assert.equal(
      envelope.content[0]?.text,
      "search.edit preview -> Response artifact (handle: response-search-preview-123; action: response.get).",
    );
    assert.doesNotMatch(envelope.content[0]?.text ?? "", /0 matches|0 files/);
  });

  it("keeps file-gateway response artifact notifications truthful in full presentation", () => {
    const display = formatToolCallForUser(
      "sdl.file",
      { op: "searchEditPreview" },
      {
        responseMode: "handle",
        kind: "responseArtifact",
        handle: "response-search-preview-456",
        action: "response.get",
      },
    );

    assert.equal(
      display,
      "search.edit preview -> Response artifact (handle: response-search-preview-456; action: response.get).",
    );
  });

  it("renders canonical search preview artifacts as stable continuation handles", () => {
    const args = { mode: "preview" };
    const payload = {
      responseMode: "handle",
      kind: "responseArtifact",
      handle: "response-canonical-preview-123",
      action: "response.get",
      metadata: {
        toolName: "sdl.search.edit",
        contentKind: "json",
        originalBytes: 100_000,
      },
    };
    const first = buildVisibleEnvelope("sdl.search.edit", args, payload);
    const second = buildVisibleEnvelope("sdl.search.edit", args, payload);
    const notification = formatToolCallForUser(
      "sdl.search.edit",
      args,
      payload,
    );
    const expected =
      "search.edit preview -> Response artifact (handle: response-canonical-preview-123; action: response.get).";

    assert.equal(first.content[0]?.text, expected);
    assert.equal(notification, expected);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("reports an edit count for file writes without replacement matches", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.file.write",
      { filePath: "src/new-file.ts", content: "export {};" },
      {
        filePath: "src/new-file.ts",
        mode: "create",
        bytesWritten: 12,
        linesWritten: 1,
      },
    );

    assert.equal(
      envelope.content[0]?.text,
      "file.write (create) -> src/new-file.ts, 1 edit (applied)",
    );
  });

  it("summarizes search-edit previews with match, file, and plan counts", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.search.edit",
      { mode: "preview" },
      {
        mode: "preview",
        planHandle: "plan-preview-123",
        matchesFound: 3,
        filesMatched: 2,
        fileEntries: [
          {
            file: "src/one.ts",
            matchCount: 2,
            editMode: "replacePattern",
            snippets: { before: "oldOne", after: "newOne" },
          },
          {
            file: "src/two.ts",
            matchCount: 1,
            editMode: "replacePattern",
            snippets: { before: "oldTwo", after: "newTwo" },
          },
        ],
      },
    );

    const visibleText = envelope.content[0]?.text ?? "";
    assert.equal(
      visibleText,
      "search.edit preview -> 3 matches in 2 files (plan plan-preview-123)",
    );
    assert.doesNotMatch(visibleText, /oldOne|newOne|oldTwo|newTwo|--- before|\+\+\+ after/);
    assert.equal(JSON.stringify(envelope).match(/oldOne/g)?.length, 1);
    assert.equal(JSON.stringify(envelope).match(/newOne/g)?.length, 1);
  });

  it("summarizes applied search edits with edit, file, and plan counts", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.search.edit",
      { mode: "apply", planHandle: "plan-apply-456" },
      {
        mode: "apply",
        planHandle: "plan-apply-456",
        filesAttempted: 2,
        filesWritten: 2,
        filesFailed: 0,
        filesSkipped: 0,
        results: [
          { file: "src/one.ts", status: "written" },
          { file: "src/two.ts", status: "written" },
        ],
        fileEntries: [
          {
            file: "src/one.ts",
            matchCount: 2,
            snippets: { before: "oldOne", after: "newOne" },
          },
          {
            file: "src/two.ts",
            matchCount: 1,
            snippets: { before: "oldTwo", after: "newTwo" },
          },
        ],
      },
    );

    const visibleText = envelope.content[0]?.text ?? "";
    assert.equal(
      visibleText,
      "search.edit apply -> applied 3 edits in 2/2 files (plan plan-apply-456)",
    );
    assert.doesNotMatch(visibleText, /oldOne|newOne|oldTwo|newTwo|--- before|\+\+\+ after/);
    assert.equal(JSON.stringify(envelope).match(/oldOne/g)?.length, 1);
    assert.equal(JSON.stringify(envelope).match(/newOne/g)?.length, 1);
  });

  it("counts only written search edits and reports rollback, failure, and skip state", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.search.edit",
      { mode: "apply", planHandle: "plan-mixed-result" },
      {
        mode: "apply",
        planHandle: "plan-mixed-result",
        filesAttempted: 4,
        filesWritten: 1,
        filesFailed: 1,
        filesSkipped: 1,
        results: [
          { file: "src/written.ts", status: "written" },
          { file: "src/restored.ts", status: "rolled-back" },
          { file: "src/failed.ts", status: "failed" },
          { file: "src/skipped.ts", status: "skipped" },
        ],
        fileEntries: [
          { file: "src/written.ts", matchCount: 2 },
          { file: "src/restored.ts", matchCount: 3 },
          { file: "src/failed.ts", matchCount: 4 },
          { file: "src/skipped.ts", matchCount: 5 },
        ],
        rollback: {
          triggered: true,
          restoredFiles: ["src/restored.ts"],
        },
      },
    );

    assert.equal(
      envelope.content[0]?.text,
      "search.edit apply -> applied 2 edits in 1/4 files, 1 failed, 1 skipped, 1 rolled back (plan plan-mixed-result)",
    );
  });

  it("reports a triggered rollback when no file needed restoration", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.search.edit",
      { mode: "apply", planHandle: "plan-first-write-failed" },
      {
        mode: "apply",
        planHandle: "plan-first-write-failed",
        filesAttempted: 2,
        filesWritten: 0,
        filesFailed: 1,
        filesSkipped: 1,
        results: [
          { file: "src/failed.ts", status: "failed" },
          { file: "src/skipped.ts", status: "skipped" },
        ],
        fileEntries: [
          { file: "src/failed.ts", matchCount: 4 },
          { file: "src/skipped.ts", matchCount: 5 },
        ],
        rollback: {
          triggered: true,
          restoredFiles: [],
        },
      },
    );

    assert.equal(
      envelope.content[0]?.text,
      "search.edit apply -> applied 0 edits in 0/2 files, 1 failed, 1 skipped, rollback triggered (plan plan-first-write-failed)",
    );
  });

  it("summarizes symbol-edit previews with operation, path, edit count, and plan", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.symbol.edit",
      { mode: "preview" },
      {
        mode: "preview",
        planHandle: "symbol-plan-1",
        symbolName: "Widget",
        operation: "replaceBody",
        file: "src/widget.ts",
        writeTarget: "file",
        fileEntries: [
          {
            file: "src/widget.ts",
            matchCount: 1,
            snippets: { before: "oldBody", after: "newBody" },
          },
        ],
      },
    );

    assert.equal(
      envelope.content[0]?.text,
      "symbol.edit preview -> replaceBody Widget in src/widget.ts (file); 1 edit; plan symbol-plan-1",
    );
    assert.equal(JSON.stringify(envelope).match(/oldBody/g)?.length, 1);
    assert.equal(JSON.stringify(envelope).match(/newBody/g)?.length, 1);
    const entries = (envelope.structuredContent?.fileEntries ?? []) as Array<
      Record<string, unknown>
    >;
    assert.equal(entries[0]?.matchCount, 1);
  });

  it("summarizes applied symbol edits with operation, path, edit count, and plan", () => {
    const envelope = buildVisibleEnvelope(
      "sdl.symbol.edit",
      { mode: "apply", planHandle: "symbol-plan-2" },
      {
        mode: "apply",
        planHandle: "symbol-plan-2",
        symbolName: "Widget",
        operation: "rename",
        file: "src/widget.ts",
        writeTarget: "file",
        filesAttempted: 1,
        filesWritten: 1,
        filesFailed: 0,
        filesSkipped: 0,
      },
    );

    assert.equal(
      envelope.content[0]?.text,
      "symbol.edit apply -> rename Widget in src/widget.ts (file); applied 1/1 edit; plan symbol-plan-2",
    );
  });

  it("formats file and edit operations with concise visible diffs", () => {
    const writeDisplay = formatToolCallForUser(
      "sdl.file",
      { op: "write" },
      {
        filePath: "src/server.ts",
        mode: "replacePattern",
        bytesWritten: 10,
        linesWritten: 1,
        snippets: {
          before: "  1 | oldValue",
          after: "  1 | newValue",
        },
      },
    );

    assert.ok(writeDisplay);
    assert.match(writeDisplay, /file\.write \(replacePattern\)/);
    assert.match(writeDisplay, /--- before/);
    assert.match(writeDisplay, /\+\+\+ after/);

    const applyDisplay = formatToolCallForUser(
      "sdl.file",
      { op: "searchEditApply" },
      {
        mode: "apply",
        filesAttempted: 1,
        filesWritten: 1,
        filesFailed: 0,
        filesSkipped: 0,
        results: [{ file: "src/server.ts", status: "written" }],
        fileEntries: [
          {
            file: "src/server.ts",
            matchCount: 1,
            editMode: "replacePattern",
            snippets: {
              before: "  1 | oldValue",
              after: "  1 | newValue",
            },
          },
        ],
      },
    );

    assert.ok(applyDisplay);
    assert.match(applyDisplay, /search\.edit apply -> 1\/1 file written/);
    assert.match(applyDisplay, /oldValue/);
    assert.match(applyDisplay, /newValue/);
  });

  it("captures exact compact and full envelopes with observability disabled", () => {
    const canonical = {
      status: "complete",
      taskType: "debug",
      durationMs: 41,
      exitCode: 0,
      evidence: [{ symbolId: "symbol:control", rung: "card" }],
      source: "canonical-source",
    };
    const capture = (detail: "compact" | "full") => {
      const envelope = buildToolResponseEnvelope(
        canonical,
        null,
        "",
        "sdl.context",
        { detail },
      );
      const structuredJson = JSON.stringify(envelope.structuredContent);
      return {
        contentText: envelope.content[0]?.text,
        structuredJson,
        structuredBytes: Buffer.byteLength(structuredJson, "utf8"),
        keyOrder: Object.keys(envelope.structuredContent ?? {}),
        isError: envelope.isError,
        recovery: envelope.structuredContent?.nextAction,
      };
    };

    const compactJson =
      '{"status":"complete","taskType":"debug","evidence":[{"symbolId":"symbol:control","rung":"card"}]}';
    const fullJson =
      '{"status":"complete","taskType":"debug","evidence":[{"symbolId":"symbol:control","rung":"card"}]}';

    assert.deepEqual(capture("compact"), {
      contentText: "Sdl context\n\nstatus: complete\ntaskType: debug\nevidence: 1 item",
      structuredJson: compactJson,
      structuredBytes: Buffer.byteLength(compactJson, "utf8"),
      keyOrder: ["status", "taskType", "evidence"],
      isError: undefined,
      recovery: undefined,
    });
    assert.deepEqual(capture("full"), {
      contentText: "Sdl context\n\nstatus: complete\ntaskType: debug\nevidence: 1 item",
      structuredJson: fullJson,
      structuredBytes: Buffer.byteLength(fullJson, "utf8"),
      keyOrder: ["status", "taskType", "evidence"],
      isError: undefined,
      recovery: undefined,
    });
  });
});
