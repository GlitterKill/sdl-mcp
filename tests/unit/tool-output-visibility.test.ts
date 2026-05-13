import { describe, it } from "node:test";
import assert from "node:assert";

import { z } from "zod";

import {
  buildToolResponseContentBlocks,
  buildToolResponseEnvelope,
  MCPServer,
} from "../../dist/server.js";
import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";
import { formatCliToolOutput } from "../../dist/cli/commands/tool-dispatch.js";

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
    sendNotification: () => Promise<void>;
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

describe("visible tool output", () => {
  it("returns human-readable MCP content first and projected structured content", () => {
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
    assert.equal(envelope.content[1]?.text, footer);
    assert.equal(envelope._displayFooter, footer);
    assert.equal(envelope.structuredContent?.etag, "file-etag");
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.equal(envelope.structuredContent?._displayFooter, undefined);
  });

  it("formats sdl.context as an evidence list without internal noise", () => {
    const blocks = buildToolResponseContentBlocks(
      {
        taskId: "task-1",
        taskType: "debug",
        success: true,
        summary: "internal action summary",
        finalEvidence: [
          {
            type: "symbolCard",
            reference: "symbol:abc",
            summary: "function attachDisplayFooter | src/server.ts | fileAlias: Server",
            timestamp: 12345,
          },
          {
            type: "hotPath",
            reference: "hotpath:def",
            summary: "symbol | Hot path (0 matches, ~42 tokens): code",
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
        "taskType: debug",
        "",
        "symbol:abc",
        "summary: function attachDisplayFooter | src/server.ts | fileAlias: Server",
        "",
        "hotpath:def",
        "summary: symbol | Hot path (0 matches, ~42 tokens): code",
        "",
        "etag: abc123",
      ].join("\n"),
    );
    assert.doesNotMatch(blocks[0]?.text ?? "", /diagnostics|actionsTaken|taskId|rungs|internal action summary/);
  });

  it("keeps task-relevant structured content and omits internal fields by default", () => {
    const envelope = buildToolResponseEnvelope(
      {
        taskType: "debug",
        success: true,
        answer: "# Debug Results",
        finalEvidence: [
          {
            type: "symbolCard",
            reference: "symbol:1",
            summary: "function loadConfig | src/config/loadConfig.ts",
            timestamp: 12345,
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

    assert.equal(envelope.structuredContent?.taskType, "debug");
    assert.equal(envelope.structuredContent?.success, true);
    assert.equal(envelope.structuredContent?.answer, "# Debug Results");
    assert.equal(envelope.structuredContent?.etag, "abc123");
    assert.equal(envelope.structuredContent?.retrievalEvidence, undefined);
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.equal(envelope.structuredContent?.actionsTaken, undefined);
    assert.equal(envelope.structuredContent?.path, undefined);

    const evidence = envelope.structuredContent?.finalEvidence as Record<string, unknown>[];
    assert.equal(evidence[0]?.reference, "symbol:1");
    assert.equal(evidence[0]?.timestamp, undefined);
  });

  it("keeps requested diagnostics in structured content without adding them to visible text", () => {
    const envelope = buildToolResponseEnvelope(
      {
        taskType: "debug",
        success: true,
        finalEvidence: [],
        retrievalEvidence: { fusionLatencyMs: 10 },
        diagnostics: { timings: { totalMs: 12 } },
        _packedStats: { savedRatio: 0.5 },
      },
      null,
      "",
      "sdl.context",
      {
        includeDiagnostics: true,
        options: { includeRetrievalEvidence: true },
      },
    );

    assert.deepEqual(envelope.structuredContent?.retrievalEvidence, { fusionLatencyMs: 10 });
    assert.deepEqual(envelope.structuredContent?.diagnostics, { timings: { totalMs: 12 } });
    assert.equal(envelope.structuredContent?._packedStats, undefined);
    assert.doesNotMatch(envelope.content[0]?.text ?? "", /diagnostics|fusionLatencyMs|_packedStats/);
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

  it("projects actual server validation errors into structured content", async () => {
    const server = new MCPServer();
    server.registerTool(
      "sdl.test.validation",
      "Validation test tool",
      z.object({ filePath: z.string() }),
      async () => ({ success: true }),
    );

    const handler = getCallToolHandler(server);
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "sdl.test.validation", arguments: {} },
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
    assert.equal(envelope.structuredContent?.etag, "err-etag");
    assert.deepEqual((envelope.structuredContent?.error as Record<string, unknown>)?.details, [
      { path: "filePath", message: "Required" },
    ]);
    assert.equal(envelope.structuredContent?.diagnostics, undefined);
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
});
