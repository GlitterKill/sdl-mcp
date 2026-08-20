import assert from "node:assert/strict";
import test from "node:test";

import { setupObservabilityDashboardSidecar } from "../../dist/cli/transport/http.js";
import {
  Aggregator,
  DEFAULT_AGGREGATOR_OPTIONS,
} from "../../dist/observability/aggregator.js";
import type {
  ToolOutputMetricSummary,
  ToolOutputSnapshot,
} from "../../src/observability/types.js";

const CONTEXT_TOOL_OUTPUT = {
  calls: 3,
  errors: 1,
  rawBytesTotal: 3000,
  projectedBytesTotal: 1450,
  rawTokensTotal: 1200,
  projectedTokensTotal: 580,
  reductionRatio: 1550 / 3000,
  removedFieldTotal: 6,
  handledCount: 2,
  handledRate: 2 / 3,
  truncatedCount: 1,
  truncatedRate: 1 / 3,
  detailCounts: { compact: 2, standard: 0, full: 1 },
  profileCounts: { standard: 3 },
  recoveryEmittedCount: 1,
  invalidRecoveryCount: 2,
  p50ProjectedBytes: 400,
  p95ProjectedBytes: 1000,
  maxProjectedBytes: 1000,
  p50ProjectedTokens: 160,
  p95ProjectedTokens: 400,
  maxProjectedTokens: 400,
} satisfies ToolOutputMetricSummary;

const EXPECTED_TOOL_OUTPUT = {
  schemaVersion: 1,
  overall: {
    ...CONTEXT_TOOL_OUTPUT,
    calls: 5,
    rawBytesTotal: 4100,
    projectedBytesTotal: 1850,
    rawTokensTotal: 1640,
    projectedTokensTotal: 740,
    reductionRatio: 2250 / 4100,
    removedFieldTotal: 10,
    handledCount: 2,
    handledRate: 2 / 5,
    truncatedCount: 2,
    truncatedRate: 2 / 5,
    detailCounts: { compact: 3, standard: 0, full: 2 },
    profileCounts: { standard: 3, usage: 2 },
    p50ProjectedBytes: 300,
    p95ProjectedBytes: 1000,
    p50ProjectedTokens: 120,
    p95ProjectedTokens: 400,
  },
  perTool: [
    { tool: "sdl.context", ...CONTEXT_TOOL_OUTPUT },
    {
      tool: "sdl.manual",
      calls: 2,
      errors: 0,
      rawBytesTotal: 1100,
      projectedBytesTotal: 400,
      rawTokensTotal: 440,
      projectedTokensTotal: 160,
      reductionRatio: 700 / 1100,
      removedFieldTotal: 4,
      handledCount: 0,
      handledRate: 0,
      truncatedCount: 1,
      truncatedRate: 0.5,
      detailCounts: { compact: 1, standard: 0, full: 1 },
      profileCounts: { usage: 2 },
      recoveryEmittedCount: 0,
      invalidRecoveryCount: 0,
      p50ProjectedBytes: 300,
      p95ProjectedBytes: 300,
      maxProjectedBytes: 300,
      p50ProjectedTokens: 120,
      p95ProjectedTokens: 120,
      maxProjectedTokens: 120,
    },
  ],
} satisfies ToolOutputSnapshot;

const EXPECTED_EMPTY_TOOL_OUTPUT = {
  schemaVersion: 1,
  overall: {
    calls: 0,
    errors: 0,
    rawBytesTotal: 0,
    projectedBytesTotal: 0,
    rawTokensTotal: 0,
    projectedTokensTotal: 0,
    reductionRatio: 0,
    removedFieldTotal: 0,
    handledCount: 0,
    handledRate: 0,
    truncatedCount: 0,
    truncatedRate: 0,
    detailCounts: { compact: 0, full: 0, standard: 0 },
    profileCounts: {},
    recoveryEmittedCount: 0,
    invalidRecoveryCount: 0,
    p50ProjectedBytes: 0,
    p95ProjectedBytes: 0,
    maxProjectedBytes: 0,
    p50ProjectedTokens: 0,
    p95ProjectedTokens: 0,
    maxProjectedTokens: 0,
  },
  perTool: [],
} satisfies ToolOutputSnapshot;

type ToolProjection = NonNullable<
  Parameters<Aggregator["recordToolCall"]>[0]["projection"]
>;

function toolProjection(
  overrides: Partial<ToolProjection>,
  observabilityProfile: "standard" | "usage" = "standard",
): ToolProjection {
  return {
    profile: {
      projector: "test",
      observabilityProfile,
      defaultDetail: "compact",
      budgetClass: "small",
      largeResponseStrategy: "truncate",
      recoveryPolicy: "none",
    },
    effectiveDetail: "compact",
    diagnosticsIncluded: false,
    rawBytes: 0,
    rawTokens: 0,
    projectedBytes: 0,
    projectedTokens: 0,
    removedFieldCount: 0,
    truncated: false,
    responseHandled: false,
    recoveryEmitted: false,
    invalidRecoveryCount: 0,
    ...overrides,
  };
}

function populatedAggregatorSnapshot(repoId: string) {
  const aggregator = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
  const fixtures = [
    ["sdl.context", false, toolProjection({
      rawBytes: 1000, rawTokens: 400, projectedBytes: 400,
      projectedTokens: 160, removedFieldCount: 3,
    })],
    ["sdl.context", false, toolProjection({
      rawBytes: 2000, rawTokens: 800, projectedBytes: 1000,
      projectedTokens: 400, removedFieldCount: 2, effectiveDetail: "full",
      truncated: true, responseHandled: true, recoveryEmitted: true,
    })],
    ["sdl.context", true, toolProjection({
      projectedBytes: 50, projectedTokens: 20, removedFieldCount: 1,
      responseHandled: true, invalidRecoveryCount: 2,
    })],
    ["sdl.manual", false, toolProjection({
      rawBytes: 500, rawTokens: 200, projectedBytes: 100,
      projectedTokens: 40,
    }, "usage")],
    ["sdl.manual", false, toolProjection({
      rawBytes: 600, rawTokens: 240, projectedBytes: 300,
      projectedTokens: 120, removedFieldCount: 4, effectiveDetail: "full",
      truncated: true,
    }, "usage")],
  ] as const;

  for (const [tool, errored, projection] of fixtures) {
    aggregator.recordToolCall({
      tool,
      request: {
        args: "request-secret",
        path: "C:\\private\\repo\\source.ts",
        handle: "request-handle-secret",
      },
      response: {
        canonicalResult: "response-secret",
        stdout: "runtime-output-secret",
        stderr: "runtime-error-secret",
        source: "source-secret",
        content: "response-content-secret",
        handle: "response-handle-secret",
        ...(errored ? { error: { message: "failed" } } : {}),
      },
      durationMs: 10,
      projection,
    });
  }

  return aggregator.getSnapshot(repoId);
}

async function withCapturedStdout<T>(action: () => Promise<T>): Promise<{
  result: T;
  stdout: string[];
}> {
  const stdout: string[] = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    return { result: await action(), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("stdio observability dashboard sidecar serves only observability routes", async () => {
  const aggregateSnapshot = populatedAggregatorSnapshot("test-repo");
  assert.deepEqual(aggregateSnapshot.toolOutput, EXPECTED_TOOL_OUTPUT);
  const snapshotCalls: string[] = [];
  const observabilityService = {
    getSnapshot(repoId: string) {
      snapshotCalls.push(repoId);
      assert.equal(repoId, aggregateSnapshot.repoId);
      return aggregateSnapshot;
    },
    getTimeseries(repoId: string, window: string) {
      return { schemaVersion: 1, repoId, window, points: [] };
    },
    getBeamExplain(repoId: string, sliceHandle: string, symbolId?: string) {
      return { repoId, sliceHandle, symbolId: symbolId ?? null };
    },
    onSnapshot() {
      return () => {};
    },
  } as unknown as NonNullable<
    NonNullable<Parameters<typeof setupObservabilityDashboardSidecar>[1]>["observabilityService"]
  >;

  const { result: server, stdout } = await withCapturedStdout(() =>
    setupObservabilityDashboardSidecar(
      0,
      { observabilityService },
      { enabled: true, token: "test-token" },
      async () => true,
    ),
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const html = await fetch(`${baseUrl}/ui/observability`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    const htmlBody = await html.text();
    assert.match(htmlBody, /observability/i);
    assert.match(htmlBody, /id="layoutEditBtn"[^>]+aria-pressed="false"/);
    assert.match(htmlBody, /id="layoutResetBtn"/);
    assert.match(htmlBody, /id="layoutStatus"[^>]+aria-live="polite"/);
    assert.doesNotMatch(htmlBody, /class="kv-(?:row|key|val)"/);
    assert.match(htmlBody, /class="stat-cell"[\s\S]*?class="stat-label"[\s\S]*?class="stat-values"/);
    assert.match(htmlBody, />SESSION</);
    assert.match(htmlBody, />REPO LIFETIME</);
    assert.match(htmlBody, />CURRENT</);
    assert.match(htmlBody, />SERVER PEAK</);
    assert.match(htmlBody, /data-panel="delta"/);
    for (const scope of ["pool", "audit", "resources"]) {
      const cell = htmlBody.match(new RegExp(`<[^>]+data-metric-scope="${scope}"[\\s\\S]*?<\\/div>`))?.[0] ?? "";
      assert.notEqual(cell, "", scope);
      assert.doesNotMatch(cell, /REPO LIFETIME/, scope);
    }

    const js = await fetch(`${baseUrl}/ui/observability.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const jsBody = await js.text();
    for (const builder of [
      "renderLatencyTable", "renderToolVolumeTable", "renderCompressionTable",
      "renderEncoderTable", "renderToolOutputTable",
    ]) assert.match(jsBody, new RegExp(`function ${builder}\\b`));
    for (const caption of [
      "Latency by tool and phase", "Tool calls and errors", "Compression by source",
      "Packed wire encoders", "Tool output health",
    ]) assert.match(jsBody, new RegExp(`caption:\\s*"${caption}"`));

    const toolOutputJs = await fetch(
      `${baseUrl}/ui/observability-tool-output.js`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(toolOutputJs.status, 200);
    assert.match(toolOutputJs.headers.get("content-type") ?? "", /javascript/);

    const css = await fetch(`${baseUrl}/ui/observability.css`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const health = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await readJson(health)).status, "ok");

    const unauthorized = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(unauthorized.status, 401);

    const snapshot = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(snapshot.status, 200);
    const snapshotBody = await readJson(snapshot);
    assert.equal(snapshotBody.repoId, "test-repo");
    assert.deepEqual(snapshotBody.toolOutput, EXPECTED_TOOL_OUTPUT);
    assert.equal("lifetime" in snapshotBody, false);
    assert.equal("freshness" in snapshotBody, false);
    const snapshotJson = JSON.stringify(snapshotBody);
    for (const forbidden of [
      "request-secret",
      "request-handle-secret",
      "response-secret",
      "response-handle-secret",
      "source-secret",
      "runtime-output-secret",
      "runtime-error-secret",
      "response-content-secret",
      "C:\\private",
    ]) {
      assert.equal(snapshotJson.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(snapshotCalls, ["test-repo"]);

    // The SDL Galaxy viewer is served on the dashboard surface too.
    const viewerHtml = await fetch(`${baseUrl}/ui/viewer`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(viewerHtml.status, 200);
    assert.match(viewerHtml.headers.get("content-type") ?? "", /text\/html/);

    // /api/graph/* shares the dashboard bearer gate.
    const graphUnauthorized = await fetch(`${baseUrl}/api/graph/skins`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(graphUnauthorized.status, 401);

    const graphSkins = await fetch(`${baseUrl}/api/graph/skins`, {
      headers: { Authorization: "Bearer test-token" },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(graphSkins.status, 200);
    assert.deepEqual(Object.keys(await readJson(graphSkins)), ["skins"]);

    for (const path of [
      "/mcp",
      "/sse",
      "/message",
      "/api/config",
      "/api/sessions",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 404, path);
    }
  } finally {
    const closed = server.serverClosed.then(() => true);
    await server.close();
    assert.equal(await closed, true);
  }

  assert.deepEqual(stdout, []);
});

test("stdio observability dashboard sidecar serializes a real empty aggregator snapshot", async () => {
  const emptySnapshot = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS).getSnapshot("empty-repo");
  assert.deepEqual(emptySnapshot.toolOutput, EXPECTED_EMPTY_TOOL_OUTPUT);
  const observabilityService = {
    getSnapshot(repoId: string) {
      assert.equal(repoId, "empty-repo");
      return emptySnapshot;
    },
  } as unknown as NonNullable<
    NonNullable<Parameters<typeof setupObservabilityDashboardSidecar>[1]>["observabilityService"]
  >;
  const server = await setupObservabilityDashboardSidecar(
    0,
    { observabilityService },
    { enabled: true, token: "test-token" },
    async () => true,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/observability/snapshot?repoId=empty-repo`,
      {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.deepEqual(body.toolOutput, EXPECTED_EMPTY_TOOL_OUTPUT);
  } finally {
    await server.close();
  }
});

test("stdio observability dashboard sidecar keeps static UI available when observability is disabled", async () => {
  const server = await setupObservabilityDashboardSidecar(
    0,
    {},
    { enabled: true, token: "test-token" },
    async () => true,
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const html = await fetch(`${baseUrl}/ui/observability`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(html.status, 200);

    const snapshot = await fetch(
      `${baseUrl}/api/observability/snapshot?repoId=test-repo`,
      {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(snapshot.status, 503);
    assert.equal((await readJson(snapshot)).error, "observability_disabled");
  } finally {
    await server.close();
  }
});
