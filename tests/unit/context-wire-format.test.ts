/**
 * sdl.context wire-format gate tests. Mirrors symbol/slice tests:
 * gate decisions for json/packed/auto on small + large responses,
 * tap publish for both decisions, packed payload round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeContextForWireFormat } from "../../dist/mcp/tools/context-wire-format.js";
import { decodePacked } from "../../dist/mcp/wire/packed/decoder.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PackedWireTapEvent,
} from "../../dist/observability/event-tap.js";

const SMALL_RESPONSE: Record<string, unknown> = {
  taskType: "explain",
  taskId: "t1",
  actionsTaken: [],
  finalEvidence: [],
  path: { rungs: ["card"], estimatedTokens: 50, estimatedDurationMs: 10, reasoning: "" },
  metrics: { totalTokens: 50 },
};

const LARGE_RESPONSE: Record<string, unknown> = {
  taskType: "debug",
  taskId: "t2",
  actionsTaken: Array.from({ length: 10 }, (_, i) => ({
    id: `action-${i}-${"x".repeat(40)}`,
    type: "getCard",
    status: "completed",
    input: { context: ["file:src/foo.ts"] },
    output: { cardsProcessed: 5 },
    timestamp: 1234567890,
    durationMs: 50,
    evidence: [],
  })),
  finalEvidence: Array.from({ length: 20 }, (_, i) => ({
    type: "symbolCard",
    reference: `symbol:${"a".repeat(48)}-${i}`,
    summary: `function someFunctionName${i} | src/some/long/path/module-${i}.ts | does some work`,
  })),
  path: { rungs: ["card", "skeleton"], estimatedTokens: 1500, estimatedDurationMs: 200, reasoning: "precise debug" },
  metrics: { totalTokens: 1500 },
  summary: "Long task summary with multiple findings across the codebase.",
  success: true,
};

function captureTap(): {
  events: PackedWireTapEvent[];
  uninstall: () => void;
} {
  const events: PackedWireTapEvent[] = [];
  const noop = () => {};
  const tap: ObservabilityTap = {
    toolCall: noop,
    indexEvent: noop,
    semanticSearch: noop,
    policyDecision: noop,
    prefetch: noop,
    watcherHealth: noop,
    edgeResolution: noop,
    runtimeExecution: noop,
    setupPipeline: noop,
    summaryGeneration: noop,
    summaryQuality: noop,
    pprResult: noop,
    scipIngest: noop,
    packedWire: (event) => events.push(event),
    poolSample: noop,
    resourceSample: noop,
    indexPhase: noop,
    cacheLookup: noop,
    sliceBuild: noop,
  };
  installObservabilityTap(tap);
  return { events, uninstall: () => resetObservabilityTap() };
}

test("wireFormat=undefined returns json passthrough (no gate)", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(SMALL_RESPONSE, undefined);
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, undefined);
});

test("wireFormat=packed publishes tap with ctx1 encoder", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeContextForWireFormat(LARGE_RESPONSE, "packed", {
    packedThreshold: 0.05,
  });

  assert.ok(result.gateDecision !== undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].encoderId, "ctx1");
  assert.equal(events[0].decision, result.gateDecision);

  uninstall();
});

test("wireFormat=auto: large input → packed wins, payload is string", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(LARGE_RESPONSE, "auto", {
    packedThreshold: 0.05,
  });
  if (result.gateDecision === "packed") {
    assert.equal(result.format, "packed");
    assert.equal(typeof result.payload, "string");
    assert.equal(result.encoderId, "ctx1");
  }
});

test("wireFormat=auto: small input falls back to json", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(SMALL_RESPONSE, "auto", {
    packedThreshold: 0.5,
  });
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, "fallback");
});

test("packed payload round-trips via decodePacked", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(LARGE_RESPONSE, "packed", {
    packedThreshold: 0.0,
  });
  if (result.format !== "packed") {
    return;
  }
  const decoded = decodePacked(result.payload as string);
  assert.equal(decoded.encoderId, "ctx1");
  assert.ok(decoded.data);
});

test("fallback path also publishes tap", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeContextForWireFormat(SMALL_RESPONSE, "auto", {
    packedThreshold: 0.99,
    packedTokenThreshold: 0.99,
  });

  assert.equal(result.gateDecision, "fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "fallback");
  assert.equal(events[0].encoderId, "ctx1");

  uninstall();
});
