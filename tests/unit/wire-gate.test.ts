import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  gateWireFormat,
  type WireGateResult,
} from "../../dist/mcp/wire/gate.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PackedWireTapEvent,
} from "../../dist/observability/event-tap.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";

const SMALL_SYMBOL_SEARCH = {
  query: "foo",
  results: [
    {
      symbolId: "sym-1",
      name: "foo",
      file: "src/foo.ts",
      kind: "function",
    },
  ],
  total: 1,
};

const LARGE_SYMBOL_SEARCH = {
  query: "search",
  results: Array.from({ length: 50 }, (_, index) => ({
    symbolId: `sym-${index}-${"x".repeat(48)}`,
    name: `longFunctionName${index}`,
    file: `src/deep/module-${index}.ts`,
    kind: "function",
  })),
  total: 50,
};

function tapWithPackedWire(
  packedWire: (event: PackedWireTapEvent) => void,
): ObservabilityTap {
  const noop = () => {};
  return {
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
    packedWire,
    poolSample: noop,
    resourceSample: noop,
    indexPhase: noop,
    cacheLookup: noop,
    sliceBuild: noop,
    auditBufferSample: noop,
    postIndexSession: noop,
    dbLatency: noop,
  };
}

afterEach(() => {
  tokenAccumulator.reset();
  resetObservabilityTap();
});

describe("gateWireFormat", () => {
  it("returns JSON unchanged when packed gating was not requested", () => {
    const result = gateWireFormat(
      "symbol.search",
      SMALL_SYMBOL_SEARCH,
      undefined,
    );

    assert.deepEqual(result, {
      format: "json",
      payload: SMALL_SYMBOL_SEARCH,
    } satisfies WireGateResult);
  });

  it("returns a packed payload with byte and token statistics", () => {
    const result = gateWireFormat(
      "symbol.search",
      LARGE_SYMBOL_SEARCH,
      "packed",
      { packedThreshold: 0 },
    );

    assert.equal(result.format, "packed");
    assert.equal(typeof result.payload, "string");
    assert.equal(result.encoderId, "ss1");
    assert.equal(result.gateDecision, "packed");
    assert.ok((result.jsonBytes ?? 0) > 0);
    assert.ok((result.packedBytes ?? 0) > 0);
    assert.ok((result.jsonTokens ?? 0) > 0);
    assert.ok((result.packedTokens ?? 0) > 0);
  });

  it("falls back to JSON when the packed candidate misses both thresholds", () => {
    const result = gateWireFormat(
      "symbol.search",
      SMALL_SYMBOL_SEARCH,
      "auto",
      { packedThreshold: 0.99, packedTokenThreshold: 0.99 },
    );

    assert.equal(result.format, "json");
    assert.equal(result.payload, SMALL_SYMBOL_SEARCH);
    assert.equal(result.gateDecision, "fallback");
    assert.equal(result.encoderId, "ss1");
  });

  it("publishes both decisions and swallows observability tap failures", () => {
    const events: PackedWireTapEvent[] = [];
    installObservabilityTap(tapWithPackedWire((event) => events.push(event)));
    gateWireFormat("symbol.search", SMALL_SYMBOL_SEARCH, "auto", {
      packedThreshold: 0.99,
      packedTokenThreshold: 0.99,
    });
    assert.equal(events[0]?.decision, "fallback");

    installObservabilityTap(
      tapWithPackedWire(() => {
        throw new Error("tap unavailable");
      }),
    );
    assert.doesNotThrow(() =>
      gateWireFormat("symbol.search", LARGE_SYMBOL_SEARCH, "packed", {
        packedThreshold: 0,
      }),
    );
  });
});
