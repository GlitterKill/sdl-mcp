// Phase 1 Task 1.12 — Verify that the per-language Pass-1 engine telemetry
// counters on `Pass1Accumulator` flow into the `index.refresh.complete`
// audit-event payload via the `derivePass1EngineTelemetry` helper exported
// from the indexer.
//
// Scope of this unit test:
//   1. Stub a Pass1Accumulator with known engine counter values.
//   2. Feed it through `derivePass1EngineTelemetry` and assert the shape
//      (rustFiles / tsFiles / rustFallbackFiles / perLanguageFallback)
//      matches the inputs exactly — catches accidental field renames or
//      missing Map-to-object conversions.
//   3. Construct an `IndexStats` literal containing a `pass1Engine` block
//      and hand it to `logIndexEvent` to prove the type accepts the new
//      optional field and the call does not throw.
//
// No Rust addon, no filesystem, no database — pure data in/out.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Pass1Accumulator } from "../../dist/indexer/indexer-init.js";
import { derivePass1EngineTelemetry } from "../../dist/indexer/indexer.js";
import { logIndexEvent, type IndexEvent } from "../../dist/mcp/telemetry.js";

function makeStubAccumulator(overrides: Partial<Pass1Accumulator> = {}): Pass1Accumulator {
  return {
    filesProcessed: 0,
    changedFiles: 0,
    totalSymbolsIndexed: 0,
    totalEdgesCreated: 0,
    allConfigEdges: [],
    changedFileIds: new Set(),
    changedPass2FilePaths: new Set(),
    symbolMapFileUpdates: new Map(),
    rustFilesProcessed: 0,
    tsFilesProcessed: 0,
    rustFallbackFiles: 0,
    rustFallbackByLanguage: new Map(),
    ...overrides,
  };
}

describe("Pass-1 engine telemetry surfaces on index.refresh.complete (Task 1.12)", () => {
  it("derives a zero-valued pass1Engine block from a fresh accumulator", () => {
    const acc = makeStubAccumulator();
    const telemetry = derivePass1EngineTelemetry(acc);

    assert.deepEqual(telemetry, {
      rustFiles: 0,
      tsFiles: 0,
      rustFallbackFiles: 0,
      perLanguageFallback: {},
    });
  });

  it("mirrors rust/ts counters and per-language fallback histogram", () => {
    // Simulate a mixed-language run: 7 files via Rust, 3 via the TS engine,
    // where 2 of the TS files came from a Rust fallback (1 Kotlin, 1 PHP).
    const acc = makeStubAccumulator({
      rustFilesProcessed: 7,
      tsFilesProcessed: 3,
      rustFallbackFiles: 2,
      rustFallbackByLanguage: new Map([
        ["kt", 1],
        ["php", 1],
      ]),
    });

    const telemetry = derivePass1EngineTelemetry(acc);

    assert.equal(telemetry.rustFiles, 7);
    assert.equal(telemetry.tsFiles, 3);
    assert.equal(telemetry.rustFallbackFiles, 2);
    assert.deepEqual(telemetry.perLanguageFallback, { kt: 1, php: 1 });
    // Sanity: fallback files must never exceed total Rust-engine input.
    assert.ok(
      telemetry.rustFallbackFiles <= telemetry.rustFiles + telemetry.tsFiles,
    );
  });

  it("aggregates per-language fallback counts across many extensions", () => {
    const acc = makeStubAccumulator({
      rustFilesProcessed: 10,
      tsFilesProcessed: 5,
      rustFallbackFiles: 5,
      rustFallbackByLanguage: new Map([
        ["kt", 2],
        ["php", 2],
        ["sh", 1],
      ]),
    });

    const telemetry = derivePass1EngineTelemetry(acc);
    const total = Object.values(telemetry.perLanguageFallback).reduce<number>(
      (a, b) => a + b,
      0,
    );

    assert.equal(total, telemetry.rustFallbackFiles);
    assert.equal(Object.keys(telemetry.perLanguageFallback).length, 3);
  });

  it("logIndexEvent accepts an IndexStats carrying pass1Engine (type + runtime)", () => {
    const acc = makeStubAccumulator({
      rustFilesProcessed: 4,
      tsFilesProcessed: 1,
      rustFallbackFiles: 1,
      rustFallbackByLanguage: new Map([["kt", 1]]),
    });

    const event: IndexEvent = {
      repoId: "test-repo-1.12",
      versionId: "v-1.12-telemetry",
      stats: {
        filesScanned: 5,
        symbolsExtracted: 42,
        edgesExtracted: 7,
        durationMs: 123,
        errors: 0,
        pass1Engine: derivePass1EngineTelemetry(acc),
      },
    };

    assert.equal(event.stats.pass1Engine?.rustFiles, 4);
    assert.equal(event.stats.pass1Engine?.tsFiles, 1);
    assert.equal(event.stats.pass1Engine?.rustFallbackFiles, 1);
    assert.deepEqual(event.stats.pass1Engine?.perLanguageFallback, { kt: 1 });

    // logIndexEvent is fire-and-forget; the best we can assert here is that
    // the call does not synchronously throw for a well-formed event.
    assert.doesNotThrow(() => logIndexEvent(event));
  });
});
