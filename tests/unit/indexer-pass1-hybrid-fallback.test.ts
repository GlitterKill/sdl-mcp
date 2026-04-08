// Phase 1 Task 1.1 / 1.12 — Verify Pass1Accumulator carries the engine
// telemetry fields and that a newly-created accumulator initialises them to
// zero / empty.  The full end-to-end hybrid-fallback scenario (Rust engine
// handing Kotlin files to the TS engine mid-run) is covered by the
// integration test in tests/integration/kotlin-via-fallback.test.ts.
//
// Scope of this unit test:
//   1. Type-level assertion that the new fields exist on Pass1Accumulator.
//   2. Runtime assertion that each field has its expected initial shape.
//   3. Runtime assertion that bumping the fields behaves like a counter /
//      per-language histogram, catching accidental type drift (e.g. someone
//      turning the Map into a plain object without updating the consumers).
//
// The accumulator itself is a plain data interface with no behaviour, so this
// test is intentionally a smoke-check, not a behavioural test.  Behavioural
// coverage lives in the Task 1.11 Kotlin integration test once the fallback
// round-trip can be driven end-to-end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Pass1Accumulator } from "../../dist/indexer/indexer-init.js";

describe("Pass1Accumulator engine telemetry (Task 1.1)", () => {
  it("exposes rustFilesProcessed / tsFilesProcessed / rustFallbackFiles / rustFallbackByLanguage", () => {
    // Constructing an accumulator literal is the cheapest way to assert the
    // interface shape at runtime while also catching accidental optional-ness
    // changes at compile time.
    const acc: Pass1Accumulator = {
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
    };

    assert.equal(acc.rustFilesProcessed, 0);
    assert.equal(acc.tsFilesProcessed, 0);
    assert.equal(acc.rustFallbackFiles, 0);
    assert.ok(
      acc.rustFallbackByLanguage instanceof Map,
      "rustFallbackByLanguage must be a Map<string, number>",
    );
    assert.equal(acc.rustFallbackByLanguage.size, 0);
  });

  it("supports the increment pattern used by runPass1WithRustEngine", () => {
    const acc: Pass1Accumulator = {
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
    };

    // Simulate a mixed-language batch: 3 .ts files via Rust, 2 .kt files via
    // TS fallback, 1 .py file via Rust.
    for (let i = 0; i < 3; i++) acc.rustFilesProcessed++;

    for (let i = 0; i < 2; i++) {
      acc.rustFallbackFiles++;
      acc.rustFallbackByLanguage.set(
        "kt",
        (acc.rustFallbackByLanguage.get("kt") ?? 0) + 1,
      );
      acc.tsFilesProcessed++;
    }

    acc.rustFilesProcessed++;

    assert.equal(acc.rustFilesProcessed, 4);
    assert.equal(acc.tsFilesProcessed, 2);
    assert.equal(acc.rustFallbackFiles, 2);
    assert.equal(acc.rustFallbackByLanguage.get("kt"), 2);
    assert.equal(acc.rustFallbackByLanguage.get("py"), undefined);
  });

  it("tracks multiple fallback languages independently", () => {
    const acc: Pass1Accumulator = {
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
    };

    const bump = (ext: string): void => {
      acc.rustFallbackFiles++;
      acc.rustFallbackByLanguage.set(
        ext,
        (acc.rustFallbackByLanguage.get(ext) ?? 0) + 1,
      );
    };

    bump("kt");
    bump("kt");
    bump("kts");
    bump("swift"); // hypothetical future unsupported language

    assert.equal(acc.rustFallbackFiles, 4);
    assert.equal(acc.rustFallbackByLanguage.size, 3);
    assert.equal(acc.rustFallbackByLanguage.get("kt"), 2);
    assert.equal(acc.rustFallbackByLanguage.get("kts"), 1);
    assert.equal(acc.rustFallbackByLanguage.get("swift"), 1);
  });
});
