import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildToolResponseEnvelope } from "../../dist/server.js";
import { RepoStatusResponseSchema } from "../../dist/mcp/tools.js";

function firstText(envelope: { content: Array<{ text?: string }> }): string {
  return envelope.content[0]?.text ?? "";
}

describe("tool response envelope model projection", () => {
  it("formats default workflow text from the compact projected payload", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [
          {
            stepIndex: 0,
            fn: "repoStatus",
            result: { repoId: "sdl-mcp", truncated: false },
            tokens: 100,
            durationMs: 12,
            status: "ok",
          },
        ],
        totalTokens: 100,
        durationMs: 12,
        etagCache: { "repo.status": "etag-1" },
        truncated: false,
      },
      null,
      "",
      "sdl.workflow",
      {},
    );

    assert.deepEqual(envelope.structuredContent, {
      results: [
        {
          fn: "repoStatus",
          result: { repoId: "sdl-mcp" },
        },
      ],
    });
    const text = firstText(envelope);
    assert.match(text, /workflow -> 1 steps \(1 ok\)/);
    assert.doesNotMatch(text, /tokens/);
    assert.doesNotMatch(text, /etagCache/);
  });

  it("projects repo.status structured content to compact fields by default", () => {
    const envelope = buildToolResponseEnvelope(
      {
        repoId: "sdl-mcp",
        rootPath: "F:/secret/workspace/sdl-mcp",
        rootAvailability: { status: "available" },
        latestVersionId: null,
        lastIndexedAt: "2026-07-16T12:34:56.000Z",
        filesIndexed: 10,
        symbolsIndexed: 20,
        healthComponents: { freshness: 1, coverage: 1 },
        healthAvailable: false,
        derivedState: { stale: false, clustersDirty: false },
        serverInfo: {
          version: "0.11.13",
          node: "v24.14.0",
          startedAt: "2026-06-30T00:00:00.000Z",
          driftWarnings: [],
        },
        prefetchStats: { hits: 1 },
        liveIndexStatus: { enabled: true },
      },
      null,
      "",
      "repo.status",
      { detail: "compact" },
    );

    assert.equal(envelope.structuredContent?.repoId, "sdl-mcp");
    assert.equal(envelope.structuredContent?.filesIndexed, 10);
    assert.equal(envelope.structuredContent?.rootPath, undefined);
    assert.equal(envelope.structuredContent?.lastIndexedAt, undefined);
    const serialized = JSON.stringify(envelope.structuredContent);
    assert.doesNotMatch(serialized, /F:\/secret\/workspace\/sdl-mcp/);
    assert.doesNotMatch(serialized, /2026-07-16T12:34:56\.000Z/);
    assert.equal(envelope.structuredContent?.healthComponents, undefined);
    assert.equal(envelope.structuredContent?.serverInfo, undefined);
    assert.equal(envelope.structuredContent?.prefetchStats, undefined);
    assert.equal(envelope.structuredContent?.liveIndexStatus, undefined);
    assert.equal(
      RepoStatusResponseSchema.safeParse(envelope.structuredContent).success,
      true,
      "advertised outputSchema must accept projected structuredContent",
    );
    const raw = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: "F:/workspace/sdl-mcp",
      rootAvailability: { status: "available" },
      latestVersionId: null,
      filesIndexed: 10,
      symbolsIndexed: 20,
      lastIndexedAt: null,
    });
    assert.equal(
      "rootPath" in raw ? raw.rootPath : undefined,
      "F:/workspace/sdl-mcp",
      "raw handler validation must preserve detailed-only fields",
    );
  });

  it("sanitizes nested workflow child structured content", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              etag: "child-etag",
              diagnostics: { timings: { totalMs: 5 } },
              retrievalEvidence: { fusionLatencyMs: 3 },
              _displayFooter: "child footer",
              _packedStats: { savedRatio: 0.4 },
            },
            status: "ok",
          },
        ],
      },
      null,
      "",
      "sdl.workflow",
      { steps: [{ fn: "repoStatus", args: {} }] },
    );

    const child = envelope.structuredContent?.results as Array<{ result?: Record<string, unknown> }>;
    assert.equal(child[0]?.result?.etag, undefined);
    assert.equal(child[0]?.result?.diagnostics, undefined);
    assert.equal(child[0]?.result?.retrievalEvidence, undefined);
    assert.equal(child[0]?.result?._displayFooter, undefined);
    assert.equal(child[0]?.result?._packedStats, undefined);
  });

  it("uses stepIndex when preserving workflow child diagnostics", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [
          {
            stepIndex: 1,
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              diagnostics: { timings: { totalMs: 5 } },
              retrievalEvidence: { fusionLatencyMs: 3 },
            },
            status: "ok",
          },
        ],
      },
      null,
      "",
      "sdl.workflow",
      {
        steps: [
          { fn: "repoStatus", args: {} },
          {
            fn: "repoStatus",
            args: { includeDiagnostics: true, includeRetrievalEvidence: true },
          },
        ],
      },
    );

    const children = envelope.structuredContent?.results as Array<{ result?: Record<string, unknown> }>;
    assert.deepEqual(children[0]?.result?.diagnostics, { timings: { totalMs: 5 } });
    assert.deepEqual(children[0]?.result?.retrievalEvidence, { fusionLatencyMs: 3 });
  });

  it("preserves nested workflow child diagnostics when requested by the child step", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              diagnostics: { timings: { totalMs: 5 } },
              retrievalEvidence: { fusionLatencyMs: 3 },
            },
            status: "ok",
          },
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp-compact",
              diagnostics: { timings: { totalMs: 8 } },
              retrievalEvidence: { fusionLatencyMs: 6 },
            },
            status: "ok",
          },
        ],
      },
      null,
      "",
      "sdl.workflow",
      {
        steps: [
          {
            fn: "repoStatus",
            args: { includeDiagnostics: true, includeRetrievalEvidence: true },
          },
          { fn: "repoStatus", args: {} },
        ],
      },
    );

    const children = envelope.structuredContent?.results as Array<{ result?: Record<string, unknown> }>;
    assert.deepEqual(children[0]?.result?.diagnostics, { timings: { totalMs: 5 } });
    assert.deepEqual(children[0]?.result?.retrievalEvidence, { fusionLatencyMs: 3 });
    assert.equal(children[1]?.result?.diagnostics, undefined);
    assert.equal(children[1]?.result?.retrievalEvidence, undefined);
  });

  it("preserves diagnostics and retrieval evidence in full detail structured content", () => {
    const envelope = buildToolResponseEnvelope(
      {
        repoId: "sdl-mcp",
        diagnostics: { timings: { totalMs: 5 } },
        retrievalEvidence: { fusionLatencyMs: 3 },
        _displayFooter: "internal footer",
      },
      null,
      "",
      "repo.status",
      { detail: "full" },
    );

    assert.deepEqual(envelope.structuredContent?.diagnostics, { timings: { totalMs: 5 } });
    assert.deepEqual(envelope.structuredContent?.retrievalEvidence, { fusionLatencyMs: 3 });
    assert.equal(envelope.structuredContent?._displayFooter, undefined);
  });

  it("ignores raw precomputed display text for model content", () => {
    const envelope = buildToolResponseEnvelope(
      {
        results: [
          {
            stepIndex: 0,
            fn: "repoStatus",
            result: { repoId: "sdl-mcp" },
            tokens: 100,
            durationMs: 12,
            status: "ok",
          },
        ],
        totalTokens: 100,
        etagCache: { "repo.status": "etag-1" },
        truncated: false,
      },
      "workflow -> 1 steps (1 ok) ~100 tokens",
      "",
      "sdl.workflow",
      {},
    );

    const text = firstText(envelope);
    assert.match(text, /workflow -> 1 steps \(1 ok\)/);
    assert.doesNotMatch(text, /tokens/);
    assert.doesNotMatch(text, /etagCache/);
  });

  it("strips token usage accounting from structured content", () => {
    const envelope = buildToolResponseEnvelope(
      {
        status: "success",
        _tokenUsage: { sdlTokens: 1, rawEquivalent: 2 },
      },
      null,
      "",
      "sdl.example",
      {},
    );

    assert.equal(envelope.structuredContent?._tokenUsage, undefined);
  });

  it("formats generic text from projected payloads while hiding etags", () => {
    const envelope = buildToolResponseEnvelope(
      {
        status: "success",
        responseHandle: "response-1",
        etag: "etag-1",
      },
      null,
      "",
      "sdl.example",
      {},
    );

    assert.equal(envelope.structuredContent?.etag, undefined);
    const text = firstText(envelope);
    assert.match(text, /responseHandle: response-1/);
    assert.doesNotMatch(text, /etag/);
  });
});
