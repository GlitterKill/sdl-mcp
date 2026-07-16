import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

import {
  projectToolResultForModelContent,
} from "../../dist/mcp/context-response-projection.js";
import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";
import { handleActionSearch } from "../../dist/code-mode/index.js";
import {
  buildContextFtsQuery,
  buildSeedEntitySearchPlan,
} from "../../dist/agent/context-seeding.js";
import { extractSymbols } from "../../dist/indexer/treesitter/extractSymbols.js";

describe("SDL tool functionality QA", () => {
  it("preserves compact usage summaries through workflow projection", () => {
    const projected = projectToolResultForModelContent(
      "sdl.usage.stats",
      { formattedSummary: "session: 2 calls, 120 tokens" },
      { detail: "compact" },
    );

    assert.deepEqual(projected, {
      formattedSummary: "session: 2 calls, 120 tokens",
    });
  });

  it("keeps search-edit preview text and structured match counts consistent", () => {
    const projected = projectToolResultForModelContent(
      "sdl.file",
      {
        planHandle: "se-test",
        targeting: "text",
        editMode: "replacePattern",
        matchesFound: 1,
        filesMatched: 1,
        fileEntries: [
          {
            file: "qa-fixture.txt",
            matchCount: 1,
            replacements: 1,
          },
        ],
        diff: "--- a/qa-fixture.txt\n+++ b/qa-fixture.txt\n-qa-original\n+qa-updated",
      },
      { op: "searchEditPreview" },
    ) as Record<string, unknown>;

    const fileEntries = projected.fileEntries as Array<Record<string, unknown>>;
    assert.equal(fileEntries[0]?.matchCount, 1);

    const summary = formatToolCallForUser(
      "sdl.file",
      { op: "searchEditPreview" },
      projected,
    );
    assert.match(summary, /1 match/);
    assert.doesNotMatch(summary, /0 matches/);
  });

  it("strips tree-sitter type annotation punctuation from signatures", () => {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(
      "function sha256(value: string, count?: number): void {}",
    );

    const symbol = extractSymbols(tree).find(
      (candidate) => candidate.name === "sha256",
    );
    assert.deepEqual(symbol?.signature?.params, [
      { name: "value", type: "string" },
      { name: "count", type: "number" },
    ]);
  });

  it("omits volatile status telemetry unless explicitly requested", () => {
    const repoStatus = projectToolResultForModelContent(
      "sdl.repo.status",
      {
        repoId: "sdl-mcp",
        createdAt: "2026-07-14T12:00:00.000Z",
        lastIndexedAt: "2026-07-14T12:01:00.000Z",
        serverInfo: {
          pid: 42,
          startedAt: "2026-07-14T11:59:00.000Z",
        },
        derivedState: {
          state: "ready",
          updatedAt: "2026-07-14T12:02:00.000Z",
          graphIntegrityState: "failed",
          graphIntegrityVersionId: "v2",
          graphIntegrityDigest: null,
          graphIntegrityError: "internal mismatch detail",
          nextBestAction:
            'Graph integrity verification failed. Run sdl.index.refresh with mode:"full" to rebuild and verify the graph.',
        },
      },
      { detail: "full" },
    ) as Record<string, unknown>;
    const serverInfo = repoStatus.serverInfo as Record<string, unknown>;
    const derivedState = repoStatus.derivedState as Record<string, unknown>;

    assert.equal("createdAt" in repoStatus, false);
    assert.equal("lastIndexedAt" in repoStatus, false);
    assert.equal("startedAt" in serverInfo, false);
    assert.equal("updatedAt" in derivedState, false);
    assert.equal(derivedState.graphIntegrityState, "failed");
    assert.equal(derivedState.graphIntegrityVersionId, "v2");
    assert.equal("graphIntegrityError" in derivedState, false);

    const semanticStatus = projectToolResultForModelContent(
      "sdl.semantic.enrichment.status",
      {
        lastRuns: [
          {
            runId: "semantic-1784030000000",
            status: "complete",
            startedAt: "2026-07-14T12:00:00.000Z",
            finishedAt: "2026-07-14T12:03:00.000Z",
          },
        ],
      },
      { detail: "compact" },
    ) as Record<string, unknown>;
    const lastRuns = semanticStatus.lastRuns as Array<Record<string, unknown>>;

    assert.equal("runId" in lastRuns[0], false);
    assert.equal("startedAt" in lastRuns[0], false);
    assert.equal("finishedAt" in lastRuns[0], false);

    const telemetryStatus = projectToolResultForModelContent(
      "sdl.repo.status",
      {
        lastIndexedAt: "2026-07-14T12:01:00.000Z",
        serverInfo: { startedAt: "2026-07-14T11:59:00.000Z" },
      },
      { detail: "full", includeTelemetry: true },
    ) as Record<string, unknown>;

    assert.equal(
      (telemetryStatus.serverInfo as Record<string, unknown>).startedAt,
      "2026-07-14T11:59:00.000Z",
    );
  });

  it("does not render object-valued errors as an extra object footer", () => {
    const output = formatToolCallForUser(
      "sdl.file",
      { op: "read", filePath: "src/main.ts" },
      {
        error: {
          message: "Indexed source must be read through code tools.",
          code: "VALIDATION_ERROR",
        },
      },
    );

    assert.match(output, /Indexed source must be read through code tools/);
    assert.doesNotMatch(output, /error: object/);
  });

  it("filters status telemetry through workflow action aliases", () => {
    const projected = projectToolResultForModelContent(
      "sdl.workflow",
      {
        results: [
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              lastIndexedAt: "2026-07-14T12:01:00.000Z",
              serverInfo: { startedAt: "2026-07-14T11:59:00.000Z" },
            },
          },
          {
            fn: "semanticEnrichmentStatus",
            result: {
              lastRuns: [
                {
                  runId: "semantic-1784030000000",
                  status: "complete",
                  startedAt: "2026-07-14T12:00:00.000Z",
                  finishedAt: "2026-07-14T12:03:00.000Z",
                },
              ],
            },
          },
        ],
      },
      {
        steps: [
          { fn: "repoStatus", args: { detail: "full" } },
          { fn: "semanticEnrichmentStatus", args: { detail: "compact" } },
        ],
      },
    );
    const serialized = JSON.stringify(projected);

    assert.doesNotMatch(
      serialized,
      /lastIndexedAt|runId|startedAt|finishedAt/,
    );
  });

  it("uses the failure trace index in concise workflow errors", () => {
    const output = formatToolCallForUser(
      "sdl.workflow",
      {},
      {
        results: [
          {
            fn: "runtimeExecute",
            status: "error",
            error: "request denied",
            failureTrace: { stepIndex: 1, message: "request denied" },
          },
        ],
      },
    );

    assert.match(output, /first error: step 1 runtimeExecute/);
  });

  it("falls back to inventory for generic summary-only catalog discovery", () => {
    const result = handleActionSearch({
      query: "enabled categories inventory",
      summaryOnly: true,
      excludeDisabled: true,
      limit: 50,
    }) as {
      summary?: { total: number; byNamespace: Record<string, number> };
    };

    assert.ok((result.summary?.total ?? 0) > 0);
    assert.ok(Object.keys(result.summary?.byNamespace ?? {}).length > 0);
  });

  it("prioritizes discriminating terms for broad tool-QA context", () => {
    const taskText =
      "existing test files symbols cover workflow result aggregation usage stats " +
      "through search edit preview delta signature prompt cache deterministic tool output";
    const query = buildContextFtsQuery(taskText);
    const plan = buildSeedEntitySearchPlan(taskText, true);

    assert.match(query, /delta/);
    assert.match(query, /signature/);
    assert.match(query, /prompt/);
    assert.doesNotMatch(query, /\b(existing|files|symbols|cover|through)\b/);
    assert.equal(plan.toolQaFocused, true);
    assert.ok(plan.actionSeedQueries.length >= 3);
    assert.match(plan.ftsQuery, /\btest\b/);
    assert.deepEqual(plan.entityTypes, ["symbol", "fileSummary"]);
  });
});
