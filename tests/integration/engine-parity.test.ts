// Engine parity integration test (Task 1.13).
//
// Walks every fixture under tests/fixtures/<lang>/ with a supported indexed
// source extension and asserts that the TypeScript Pass-1 engine and the
// Rust Pass-1 engine produce identical ExtractedSymbol[] / ExtractedImport[] /
// ExtractedCall[] arrays under the allowlist documented in
// tests/harness/engine-parity-runner.ts.
//
// Skips cleanly when the native addon is unavailable (e.g. CI set
// SDL_MCP_DISABLE_NATIVE_ADDON=1).
//
// Baseline mode: set SDL_PARITY_HARNESS_BASELINE=1 to log diffs without
// failing. This is intended for use during the Tasks 1.8–1.10 rollout,
// when parity is being actively improved and failing the suite would block
// unrelated work.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isRustEngineAvailable } from "../../dist/indexer/rustIndexer.js";
import {
  runEngineParityCheck,
  type ParityResult,
} from "../harness/engine-parity-runner.ts";

// Indexed source extensions supported by the SDL Pass-1 engine. Must match
// the registry in src/indexer/adapter/registry.ts; kept in sync manually.
const INDEXED_EXTENSIONS = new Set<string>([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw",
  "go",
  "java",
  "cs",
  "c", "h", "cpp", "hpp", "cc", "cxx", "hxx",
  "php",
  "rs",
  "sh", "bash",
]);

// Skip large / synthetic fixture trees that aren't meant to be parsed as
// standalone single-file inputs (they depend on sibling files, package.json,
// node_modules, etc.).
const SKIP_DIRS = new Set<string>([
  "clustered-repo",
  "native-addon",
]);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures");
const BASELINE_MODE = /^(1|true)$/i.test(process.env.SDL_PARITY_HARNESS_BASELINE ?? "");

function collectFixtures(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFixtures(abs, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
    if (!INDEXED_EXTENSIONS.has(ext)) continue;
    acc.push(abs);
  }
  return acc;
}

function totalDiffs(result: ParityResult): number {
  return result.symbolDiffs.length + result.importDiffs.length + result.callDiffs.length;
}

describe("Engine parity: TS Pass-1 vs Rust Pass-1 (Task 1.13)", () => {
  if (!isRustEngineAvailable()) {
    it("skipped - native addon unavailable", () => {
      assert.ok(true);
    });
    return;
  }

  let fixtures: string[];
  try {
    const stat = statSync(FIXTURES_ROOT);
    if (!stat.isDirectory()) {
      it("skipped - fixtures root is not a directory", () => assert.ok(true));
      return;
    }
    fixtures = collectFixtures(FIXTURES_ROOT).sort();
  } catch (err) {
    it("skipped - fixtures root missing", () => {
      assert.ok(true, String(err));
    });
    return;
  }

  if (fixtures.length === 0) {
    it("skipped - no fixtures discovered", () => assert.ok(true));
    return;
  }

  for (const fixture of fixtures) {
    const label = fixture.slice(REPO_ROOT.length + 1).split(/[\\/]/).join("/");
    it(`${label}`, async () => {
      const result = await runEngineParityCheck(fixture, REPO_ROOT);
      if (result.skipped) {
        // Parity is skipped for this fixture (unsupported language, parse
        // error, etc.). Not a failure.
        return;
      }
      const diffCount = totalDiffs(result);
      if (diffCount === 0) return;
      if (BASELINE_MODE) {
        console.warn(
          `[parity-baseline] ${label}: ${diffCount} diff(s)`,
          JSON.stringify(
            {
              symbolDiffs: result.symbolDiffs.slice(0, 3),
              importDiffs: result.importDiffs.slice(0, 3),
              callDiffs: result.callDiffs.slice(0, 3),
            },
            null,
            2,
          ),
        );
        return;
      }
      assert.deepEqual(
        {
          symbolDiffs: result.symbolDiffs,
          importDiffs: result.importDiffs,
          callDiffs: result.callDiffs,
        },
        { symbolDiffs: [], importDiffs: [], callDiffs: [] },
        `Engine parity mismatch for ${label} (${diffCount} diff(s)). Set SDL_PARITY_HARNESS_BASELINE=1 to log without failing.`,
      );
    });
  }
});
