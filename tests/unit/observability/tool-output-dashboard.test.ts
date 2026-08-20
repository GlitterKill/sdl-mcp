import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildToolOutputViewModel } from "../../../dist/ui/observability-tool-output.js";
import {
  Aggregator,
  DEFAULT_AGGREGATOR_OPTIONS,
} from "../../../dist/observability/aggregator.js";

const metric = {
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
  detailCounts: { summary: 0, compact: 2, standard: 0, full: 1 },
  profileCounts: { standard: 3 },
  recoveryEmittedCount: 1,
  invalidRecoveryCount: 2,
  p50ProjectedBytes: 400,
  p95ProjectedBytes: 1000,
  maxProjectedBytes: 1000,
  p50ProjectedTokens: 160,
  p95ProjectedTokens: 400,
  maxProjectedTokens: 400,
};

const snapshot = {
  schemaVersion: 1,
  overall: {
    ...metric,
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
    detailCounts: { summary: 0, compact: 3, standard: 0, full: 2 },
    profileCounts: { standard: 3, usage: 2 },
    p50ProjectedBytes: 300,
    p95ProjectedBytes: 1000,
    p50ProjectedTokens: 120,
    p95ProjectedTokens: 400,
  },
  perTool: [
    {
      ...metric,
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
    { ...metric, tool: "sdl.context" },
  ],
};

describe("tool-output dashboard view model", () => {
  it("renders complete output health through an accessible native table", () => {
    const dashboard = readFileSync("src/ui/observability.js", "utf8");
    assert.match(dashboard, /function renderToolOutputTable/);
    assert.match(dashboard, /caption:\s*"Tool output health"/);
    assert.match(dashboard, /scope = "col"/);
    assert.match(dashboard, /scope = "row"/);
    for (const field of [
      "rawBytesTotal", "projectedBytesTotal", "rawTokensTotal", "projectedTokensTotal",
      "removedFieldTotal", "handledRate", "truncatedRate", "profileCounts",
      "p50ProjectedBytes", "p95ProjectedBytes", "maxProjectedBytes",
      "p50ProjectedTokens", "p95ProjectedTokens", "maxProjectedTokens",
    ]) assert.match(dashboard, new RegExp(`\\b${field}\\b`), field);
  });

  it("maps exact aggregate health and stable per-tool rows", () => {
    const view = buildToolOutputViewModel(snapshot);

    assert.deepEqual(view.summary, {
      calls: 5,
      errors: 1,
      reductionRatio: 2250 / 4100,
      handledCount: 2,
      truncatedCount: 2,
      detailCounts: { summary: 0, compact: 3, standard: 0, full: 2 },
      recoveryEmittedCount: 1,
      invalidRecoveryCount: 2,
      p50ProjectedTokens: 120,
      p95ProjectedTokens: 400,
    });
    assert.deepEqual(view.rows.map((row) => row.tool), [
      "sdl.context",
      "sdl.manual",
    ]);
    assert.deepEqual(view.rows[0], {
      tool: "sdl.context",
      calls: 3,
      errors: 1,
      reductionRatio: 1550 / 3000,
      handledCount: 2,
      truncatedCount: 1,
      detailCounts: { summary: 0, compact: 2, standard: 0, full: 1 },
      recoveryEmittedCount: 1,
      invalidRecoveryCount: 2,
      p50ProjectedTokens: 160,
      p95ProjectedTokens: 400,
    });
    assert.equal(view.hasData, true);
  });

  it("bounds rows and returns an explicit safe no-data state", () => {
    const manyTools = Array.from({ length: 20 }, (_, index) => ({
      ...metric,
      tool: `tool.${String(index).padStart(2, "0")}`,
    }));

    const view = buildToolOutputViewModel({
      ...snapshot,
      perTool: manyTools.reverse(),
    });
    assert.equal(view.rows.length, 12);
    assert.deepEqual(
      view.rows.map((row) => row.tool),
      Array.from({ length: 12 }, (_, index) =>
        `tool.${String(index).padStart(2, "0")}`,
      ),
    );

    assert.deepEqual(buildToolOutputViewModel(undefined), {
      hasData: false,
      summary: null,
      rows: [],
    });
    const emptyToolOutput = new Aggregator(
      DEFAULT_AGGREGATOR_OPTIONS,
    ).getSnapshot("empty-repo").toolOutput;
    assert.deepEqual(buildToolOutputViewModel(emptyToolOutput), {
      hasData: false,
      summary: null,
      rows: [],
    });
  });

  it("does not retain payloads, runtime output, response content, or paths", () => {
    const view = buildToolOutputViewModel({
      ...snapshot,
      request: { secret: "request-secret" },
      response: { secret: "response-secret" },
      source: "source-secret",
      stdout: "runtime-output-secret",
      content: "response-content-secret",
      path: "C:\\private\\repo\\source.ts",
      perTool: snapshot.perTool.map((row) => ({
        ...row,
        responseContent: "nested-response-secret",
      })),
    });
    const json = JSON.stringify(view);

    for (const forbidden of [
      "request-secret",
      "response-secret",
      "source-secret",
      "runtime-output-secret",
      "response-content-secret",
      "nested-response-secret",
      "C:\\\\private",
    ]) {
      assert.equal(json.includes(forbidden), false, forbidden);
    }
  });
});
