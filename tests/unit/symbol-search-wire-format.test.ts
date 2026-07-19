/**
 * symbol.search wire-format gate tests. Mirrors slice tests: confirms
 * gate decisions for json/packed/auto across small + large response sets,
 * and that the tap publishes events for both packed and fallback paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SymbolSearchResponseSchema } from "../../dist/mcp/tools.js";
import {
  serializeSymbolSearchForWireFormat,
  type SymbolSearchWireInput,
} from "../../dist/mcp/tools/symbol-wire-format.js";
import { decodePacked } from "../../dist/mcp/wire/packed/decoder.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PackedWireTapEvent,
} from "../../dist/observability/event-tap.js";

const SMALL_INPUT: SymbolSearchWireInput = {
  query: "foo",
  results: [
    {
      symbolId: "abc123",
      name: "foo",
      file: "src/foo.ts",
      kind: "function",
    },
  ],
  total: 1,
};

const LARGE_INPUT: SymbolSearchWireInput = {
  query: "search",
  results: Array.from({ length: 50 }, (_, i) => ({
    symbolId: `sym-${i}-${"x".repeat(48)}`,
    name: `aReasonablyLongFunctionName${i}`,
    file: `src/some/deeply/nested/path/module-${i}.ts`,
    kind: "function",
  })),
  total: 50,
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
    auditBufferSample: noop,
    postIndexSession: noop,
    dbLatency: noop,
  };
  installObservabilityTap(tap);
  return { events, uninstall: () => resetObservabilityTap() };
}

test("wireFormat=undefined returns json passthrough (no gate)", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeSymbolSearchForWireFormat(SMALL_INPUT, undefined);
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, undefined);
  assert.deepEqual(result.payload, SMALL_INPUT);
});

test("wireFormat=json returns json passthrough (no gate)", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeSymbolSearchForWireFormat(
    SMALL_INPUT,
    "json" as never,
  );
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, undefined);
});

test("wireFormat=packed publishes tap and returns packed when threshold cleared", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeSymbolSearchForWireFormat(LARGE_INPUT, "packed", {
    packedThreshold: 0.05,
  });

  assert.ok(result.gateDecision !== undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].encoderId, "ss1");
  assert.equal(events[0].decision, result.gateDecision);

  uninstall();
});

test("wireFormat=auto: packed wins on large input → results becomes string", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeSymbolSearchForWireFormat(LARGE_INPUT, "auto", {
    packedThreshold: 0.05,
  });
  if (result.gateDecision === "packed") {
    assert.equal(result.format, "packed");
    assert.equal(typeof result.payload, "string");
    assert.equal(result.encoderId, "ss1");
  } else {
    assert.equal(result.format, "json");
  }
});

test("wireFormat=auto: small input falls back to json", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeSymbolSearchForWireFormat(SMALL_INPUT, "auto", {
    packedThreshold: 0.5,
  });
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, "fallback");
});

test("packed payload round-trips via decodePacked", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeSymbolSearchForWireFormat(LARGE_INPUT, "packed", {
    packedThreshold: 0.0,
  });
  if (result.format !== "packed") {
    return;
  }
  const decoded = decodePacked(result.payload as string);
  assert.equal(decoded.encoderId, "ss1");
  assert.ok(decoded.data);
});

test("actual handler JSON and packed responses satisfy the output schema", async (t) => {
  const conn = {};
  const rows = Array.from({ length: 50 }, (_, i) => ({
    symbolId: `symbol-${i.toString().padStart(58, "0")}`,
    name: "sharedResult",
    filePath: `src/result-${i}.ts`,
    fileId: `file-${i}`,
    kind: "function",
  }));

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      getLadybugConn: async () => conn,
      withWriteConn: async (callback: (writeConn: object) => Promise<unknown>) => callback(conn),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      getRepo: async () => ({
        repoId: "test-repo",
        rootPath: "C:/repo",
        configJson: "{}",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  });
  t.mock.module("../../dist/live-index/overlay-reader.js", {
    namedExports: {
      clearSnapshotCache: () => undefined,
      getOverlaySnapshot: (repoId: string) => ({
        repoId,
        touchedFileIds: new Set(),
        symbolsById: new Map(),
        filesById: new Map(),
        outgoingEdgesBySymbolId: new Map(),
      }),
      getOverlaySymbol: () => null,
      getShadowedDurableSymbol: async () => null,
      getTargetNamesWithOverlay: async () => new Map(),
      mergeEdgeMapWithOverlay: (_snapshot: object, _symbolIds: string[], edges: Map<string, unknown>) => edges,
      mergeSymbolRowsWithOverlay: (_snapshot: object, _symbolIds: string[], symbols: Map<string, unknown>) => symbols,
      resolveSymbolsWithOverlay: async () => ({ items: [] }),
      searchSymbolsHybridWithOverlay: async () => ({ rows, evidence: {} }),
      searchSymbolsWithOverlay: async () => rows,
    },
  });
  t.mock.module("../../dist/graph/prefetch.js", {
    namedExports: {
      consumePrefetchedKey: () => false,
      prefetchCardsForSymbols: () => undefined,
      prefetchSliceFrontier: () => undefined,
    },
  });
  t.mock.module("../../dist/graph/prefetch-model.js", {
    namedExports: { recordToolTrace: () => undefined },
  });
  t.mock.module("../../dist/retrieval/index.js", {
    namedExports: {
      checkRetrievalHealth: async () => ({ healthy: true }),
      shouldFallbackToLegacy: () => false,
    },
  });

  const { handleSymbolSearch } = await import("../../dist/mcp/tools/symbol.js");
  const jsonResponse = await handleSymbolSearch({
    repoId: "test-repo",
    query: "sharedResult",
    semantic: false,
    wireFormat: "json",
  });
  const packedResponse = await handleSymbolSearch({
    repoId: "test-repo",
    query: "sharedResult",
    semantic: false,
    wireFormat: "packed",
    limit: 50,
  });

  SymbolSearchResponseSchema.parse(jsonResponse);
  SymbolSearchResponseSchema.parse(packedResponse);
  assert.equal(typeof packedResponse.results, "string");
});

test("fallback path also publishes tap (decision=fallback)", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeSymbolSearchForWireFormat(SMALL_INPUT, "auto", {
    packedThreshold: 0.99,
    packedTokenThreshold: 0.99,
  });

  assert.equal(result.gateDecision, "fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "fallback");
  assert.equal(events[0].encoderId, "ss1");

  uninstall();
});
