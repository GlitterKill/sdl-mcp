import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRustEngineAvailable,
  parseFilesRust,
} from "../../dist/indexer/rustIndexer.js";

/**
 * Task 1.6 acceptance test: same-file call resolution hints on the Rust
 * Pass-1 path.
 *
 * The TS Pass-1 extractor stamps `isResolved = true` / `calleeSymbolId`
 * inline when a call target name matches exactly one same-file symbol.
 * The Rust extractor emits raw calls with `isResolved = false`, and the
 * TS wrapper in `src/indexer/parser/rust-process-file.ts` walks the calls
 * after `buildSymbolIndexMaps` to reproduce that pass.
 *
 * This test replicates the exact resolution loop from rust-process-file.ts
 * (lines 232–249) in-memory against a fixture that exercises the three
 * branches: unique-match (resolved), ambiguous-match (candidateCount only),
 * and bare-name extraction from `obj.method`-style calls.
 */
describe("rustIndexer — same-file call resolution hints", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-mcp-same-file-res-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves three unambiguous intra-file calls and stamps calleeSymbolId", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/calls.ts";
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, relPath),
      [
        "function helperOne(): number { return 1; }",
        "function helperTwo(): number { return 2; }",
        "function helperThree(): number { return 3; }",
        "",
        "export function main(): number {",
        "  return helperOne() + helperTwo() + helperThree();",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);

    // Build nameToSymbolIds exactly as buildSymbolIndexMaps does.
    const nameToSymbolIds = new Map<string, string[]>();
    for (const sym of parsed.symbols) {
      const existing = nameToSymbolIds.get(sym.name) ?? [];
      existing.push(sym.symbolId);
      nameToSymbolIds.set(sym.name, existing);
    }

    // Clone calls so we can mutate them (simulates what
    // processFileFromRustResult does on the live array).
    const calls = parsed.calls.map((c) => ({ ...c }));

    // Replicate the exact same-file resolution loop from
    // src/indexer/parser/rust-process-file.ts:232–249.
    for (const call of calls) {
      if (call.isResolved) continue;
      if (!call.calleeIdentifier) continue;
      const dotIdx = call.calleeIdentifier.lastIndexOf(".");
      const bareName =
        dotIdx >= 0
          ? call.calleeIdentifier.slice(dotIdx + 1)
          : call.calleeIdentifier;
      if (!bareName) continue;
      const candidates = nameToSymbolIds.get(bareName);
      if (!candidates || candidates.length === 0) continue;
      if (candidates.length === 1) {
        call.isResolved = true;
        call.calleeSymbolId = candidates[0];
      } else {
        call.candidateCount = candidates.length;
      }
    }

    // All three helper calls must resolve to unique same-file symbols.
    const helperCalls = calls.filter((c) =>
      /^helper(One|Two|Three)$/.test(c.calleeIdentifier ?? ""),
    );
    assert.strictEqual(
      helperCalls.length,
      3,
      `expected three helper calls, got ${helperCalls.length}: ${JSON.stringify(
        calls.map((c) => c.calleeIdentifier),
      )}`,
    );

    for (const call of helperCalls) {
      assert.strictEqual(
        call.isResolved,
        true,
        `call to ${call.calleeIdentifier} should be resolved (same-file unique match)`,
      );
      assert.ok(
        call.calleeSymbolId,
        `call to ${call.calleeIdentifier} should have calleeSymbolId set`,
      );
      // The stamped calleeSymbolId must exist in the symbols table.
      const targetSymbol = parsed.symbols.find(
        (s) => s.symbolId === call.calleeSymbolId,
      );
      assert.ok(
        targetSymbol,
        `calleeSymbolId ${call.calleeSymbolId} must point at a real same-file symbol`,
      );
      assert.strictEqual(targetSymbol!.name, call.calleeIdentifier);
    }
  });

  it("leaves ambiguous same-name calls unresolved and records candidateCount", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/ambiguous.ts";
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, relPath),
      [
        "class A { work(): number { return 1; } }",
        "class B { work(): number { return 2; } }",
        "export function runAll(a: A, b: B): number {",
        "  return a.work() + b.work();",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);

    const nameToSymbolIds = new Map<string, string[]>();
    for (const sym of parsed.symbols) {
      const existing = nameToSymbolIds.get(sym.name) ?? [];
      existing.push(sym.symbolId);
      nameToSymbolIds.set(sym.name, existing);
    }
    // `work` should have two candidates.
    assert.strictEqual(nameToSymbolIds.get("work")?.length, 2);

    const calls = parsed.calls.map((c) => ({ ...c }));
    for (const call of calls) {
      if (call.isResolved) continue;
      if (!call.calleeIdentifier) continue;
      const dotIdx = call.calleeIdentifier.lastIndexOf(".");
      const bareName =
        dotIdx >= 0
          ? call.calleeIdentifier.slice(dotIdx + 1)
          : call.calleeIdentifier;
      if (!bareName) continue;
      const candidates = nameToSymbolIds.get(bareName);
      if (!candidates || candidates.length === 0) continue;
      if (candidates.length === 1) {
        call.isResolved = true;
        call.calleeSymbolId = candidates[0];
      } else {
        call.candidateCount = candidates.length;
      }
    }

    const workCalls = calls.filter((c) => c.calleeIdentifier?.endsWith("work"));
    assert.ok(workCalls.length >= 2, `expected ≥ 2 work() calls, got ${workCalls.length}`);
    for (const call of workCalls) {
      assert.strictEqual(
        call.isResolved,
        false,
        "ambiguous same-name call should stay unresolved",
      );
      assert.strictEqual(
        call.candidateCount,
        2,
        "candidateCount should record the ambiguity count",
      );
      assert.strictEqual(
        call.calleeSymbolId,
        undefined,
        "calleeSymbolId must not be set when ambiguous",
      );
    }
  });
});
