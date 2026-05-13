import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildToolResponseContentBlocks,
  buildToolResponseEnvelope,
} from "../../dist/server.js";
import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";

describe("visible tool output", () => {
  it("returns user display and savings meter as visible MCP content blocks", () => {
    const footer = "📊 100 / 1.0k tokens (SDL/raw-equiv) █░░░░░░░░░ 90%";
    const userDisplay = "search.edit preview -> 2 matches in 1 file";

    const blocks = buildToolResponseContentBlocks(
      { ok: true, _displayFooter: footer },
      userDisplay,
      footer,
    );

    assert.equal(blocks.length, 3);
    assert.match(blocks[0].text, /"ok": true/);
    assert.equal(blocks[1].text, userDisplay);
    assert.equal(blocks[2].text, footer);
  });

  it("projects sdl.context JSON content to model-facing fields by default", () => {
    const footer = "meter text";
    const blocks = buildToolResponseContentBlocks(
      {
        taskId: "task-1",
        taskType: "debug",
        success: true,
        summary: "internal action summary",
        answer: "# Debug Results\n\nFound relevant context.",
        finalEvidence: [
          {
            type: "symbolCard",
            reference: "symbol:1",
            summary: "function loadConfig | src/config/loadConfig.ts",
            timestamp: 12345,
          },
        ],
        retrievalEvidence: { fusionLatencyMs: 10 },
        _packedStats: { savedRatio: 0.5 },
        diagnostics: { timings: { totalMs: 12 } },
        etag: "abc123",
        _displayFooter: footer,
      },
      "sdl.context [success] -> 0 rungs",
      footer,
      "sdl.context",
      {},
    );

    const payload = JSON.parse(blocks[0].text) as Record<string, unknown>;
    assert.equal(payload.taskType, "debug");
    assert.equal(payload.success, true);
    assert.equal(payload.answer, "# Debug Results\n\nFound relevant context.");
    assert.equal(payload.taskId, undefined);
    assert.equal(payload.summary, undefined);
    assert.equal(payload.retrievalEvidence, undefined);
    assert.equal(payload._packedStats, undefined);
    assert.equal(payload.diagnostics, undefined);
    assert.equal(payload.etag, "abc123");
    assert.equal(payload._displayFooter, undefined);

    const evidence = payload.finalEvidence as Record<string, unknown>[];
    assert.equal(evidence[0]?.timestamp, undefined);
    assert.equal(evidence[0]?.reference, "symbol:1");
    assert.equal(blocks[1]?.text, "sdl.context [success] -> 0 rungs");
    assert.equal(blocks[2]?.text, footer);
  });

  it("keeps explicitly requested sdl.context diagnostics and retrieval evidence", () => {
    const blocks = buildToolResponseContentBlocks(
      {
        taskType: "debug",
        success: true,
        answer: "# Debug Results",
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

    const payload = JSON.parse(blocks[0].text) as Record<string, unknown>;
    assert.deepEqual(payload.retrievalEvidence, { fusionLatencyMs: 10 });
    assert.deepEqual(payload.diagnostics, { timings: { totalMs: 12 } });
    assert.equal(payload._packedStats, undefined);
  });

  it("keeps response-level display footer while preserving JSON-first content", () => {
    const footer = "usage.stats summary";
    const envelope = buildToolResponseEnvelope({ ok: true }, null, footer);

    assert.equal(envelope._displayFooter, footer);
    assert.equal(envelope.content.length, 2);
    assert.match(envelope.content[0].text, /"ok": true/);
    assert.equal(envelope.content[1].text, footer);
  });

  it("formats sdl.file edit previews with a visible diff preview", () => {
    const display = formatToolCallForUser(
      "sdl.file",
      { op: "searchEditPreview" },
      {
        mode: "preview",
        planHandle: "se-test",
        filesMatched: 1,
        matchesFound: 2,
        fileEntries: [
          {
            file: "src/server.ts",
            matchCount: 2,
            editMode: "replacePattern",
            snippets: {
              before: "  1 | oldValue",
              after: "  1 | newValue",
            },
          },
        ],
      },
    );

    assert.ok(display);
    assert.match(display, /search\.edit preview -> 2 matches in 1 file/);
    assert.match(display, /src\/server\.ts/);
    assert.match(display, /--- before/);
    assert.match(display, /\+\+\+ after/);
    assert.match(display, /oldValue/);
    assert.match(display, /newValue/);
  });

  it("projects non-context tool content away from internal fields", () => {
    const blocks = buildToolResponseContentBlocks(
      {
        filePath: "src/server.ts",
        mode: "replacePattern",
        bytesWritten: 10,
        linesWritten: 1,
        etag: "file-etag",
        backupPath: "src/server.ts.bak",
        indexUpdate: { applied: true, symbolsMatched: 2 },
        diagnostics: { timings: { totalMs: 10 } },
        _packedStats: { savedRatio: 0.2 },
        _displayFooter: "meter",
        policyDecision: { auditHash: "abc", deniedReasons: ["blocked"] },
        snippets: {
          before: "  1 | oldValue",
          after: "  1 | newValue",
        },
      },
      null,
      "meter",
      "sdl.file",
      { op: "write" },
    );

    const payload = JSON.parse(blocks[0].text) as Record<string, unknown>;
    assert.equal(payload.filePath, "src/server.ts");
    assert.equal(payload.mode, "replacePattern");
    assert.equal(payload.etag, "file-etag");
    assert.ok(payload.snippets);
    assert.equal(payload.backupPath, undefined);
    assert.equal(payload.indexUpdate, undefined);
    assert.equal(payload.diagnostics, undefined);
    assert.equal(payload._packedStats, undefined);
    assert.equal(payload._displayFooter, undefined);
    assert.deepEqual(payload.policyDecision, { deniedReasons: ["blocked"] });
    assert.equal(blocks[1]?.text, "meter");
  });

  it("keeps non-context diagnostics only when explicitly requested", () => {
    const blocks = buildToolResponseContentBlocks(
      {
        status: "success",
        diagnostics: { timings: { totalMs: 10 } },
      },
      null,
      "",
      "sdl.workflow",
      { includeDiagnostics: true },
    );

    const payload = JSON.parse(blocks[0].text) as Record<string, unknown>;
    assert.deepEqual(payload.diagnostics, { timings: { totalMs: 10 } });
  });

  it("formats file.write results with a visible diff preview", () => {
    const display = formatToolCallForUser(
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

    assert.ok(display);
    assert.match(display, /file\.write \(replacePattern\)/);
    assert.match(display, /--- before/);
    assert.match(display, /\+\+\+ after/);
    assert.match(display, /oldValue/);
    assert.match(display, /newValue/);
  });

  it("formats search.edit apply results with a visible applied diff", () => {
    const display = formatToolCallForUser(
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

    assert.ok(display);
    assert.match(display, /search\.edit apply -> 1\/1 file written/);
    assert.match(display, /--- before/);
    assert.match(display, /\+\+\+ after/);
    assert.match(display, /oldValue/);
    assert.match(display, /newValue/);
  });

  it("formats nested sdl.file code windows", () => {
    const display = formatToolCallForUser(
      "sdl.file",
      { op: "previewWindow" },
      {
        codeWindow: {
          approved: true,
          range: { startLine: 10, endLine: 20 },
          estimatedTokens: 123,
        },
      },
    );

    assert.ok(display);
    assert.match(display, /code\.needWindow -> \[approved\]/);
    assert.match(display, /L10.*20/);
    assert.match(display, /~123 tokens/);
  });

  it("formats action.search summary-only responses", () => {
    const display = formatToolCallForUser(
      "sdl.action.search",
      { query: "memory", summaryOnly: true },
      {
        summary: {
          total: 2,
          byKind: { gateway: 2 },
          matchedActions: ["sdl.memory.query", "sdl.memory.store"],
        },
      },
    );

    assert.ok(display);
    assert.match(display, /action\.search "memory" -> 2\/2 actions/);
    assert.match(display, /sdl\.memory\.query/);
    assert.match(display, /sdl\.memory\.store/);
  });
});
