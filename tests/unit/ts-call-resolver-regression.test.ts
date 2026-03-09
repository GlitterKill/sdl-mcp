/**
 * Golden snapshot regression test for TsCallResolver (T3-B).
 *
 * Verifies that the resolver's output for the `calls.ts` fixture does not
 * regress: any call that was previously resolved (had a targetSymbolId) must
 * continue to resolve on every subsequent run.
 *
 * Regenerate the golden snapshot by running:
 *   UPDATE_GOLDENS=1 npm test -- --filter ts-resolver-regression
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createTsCallResolver } from "../../src/indexer/ts/tsParser.js";
import type { ResolvedCall } from "../../src/indexer/ts/tsParser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/typescript");
const GOLDEN_PATH = path.resolve(
  __dirname,
  "../fixtures/ts-resolver-golden.json",
);

/** Shape stored in the golden file. */
interface GoldenEntry {
  callLine: number;
  callCol: number;
  calleeName: string;
  calleeFile: string;
  calleeKind: string;
  confidence: number | null;
}

/**
 * Map a ResolvedCall to a stable, serialisable golden entry.
 * We use startLine/startCol as the call-site identifier.
 */
function toGoldenEntry(call: ResolvedCall): GoldenEntry {
  return {
    callLine: call.caller.startLine,
    callCol: call.caller.startCol,
    calleeName: call.callee.name,
    calleeFile: call.callee.filePath,
    calleeKind: call.callee.kind,
    confidence: call.confidence ?? null,
  };
}

function sortEntries(entries: GoldenEntry[]): GoldenEntry[] {
  return [...entries].sort((a, b) => {
    if (a.callLine !== b.callLine) return a.callLine - b.callLine;
    return a.callCol - b.callCol;
  });
}

const ALL_FILES = [
  { path: "utils.ts", size: 0, mtime: 0 },
  { path: "calls.ts", size: 0, mtime: 0 },
];

describe("TsCallResolver – T3-B golden snapshot regression", () => {
  let calls: ResolvedCall[] = [];

  before(() => {
    const resolver = createTsCallResolver(FIXTURE_ROOT, ALL_FILES, {
      includeNodeModulesTypes: false,
    });
    assert.ok(
      resolver !== null,
      "Expected a non-null TsCallResolver for fixture directory",
    );
    calls = resolver.getResolvedCalls("calls.ts");
  });

  it("resolves at least one call in calls.ts", () => {
    assert.ok(
      calls.length > 0,
      `Expected resolved calls in calls.ts, got ${calls.length}`,
    );
  });

  it("resolution ratio >= 0.75 (T3-A quality floor)", () => {
    // All calls returned by getResolvedCalls are resolved (they have a callee).
    // Unresolved calls are simply not emitted. We validate against the source
    // to count total call sites.
    //
    // calls.ts has 4 call sites: bar(1) [runtime destructure, unresolvable],
    // foo(2), foo(3), foo(4) [all statically resolvable via named import].
    // After T3-A improvements we expect at least 3/4 = 0.75 to resolve.
    const EXPECTED_CALL_SITES = 4;
    const resolved = calls.length;
    const ratio = resolved / EXPECTED_CALL_SITES;

    assert.ok(
      ratio >= 0.75,
      `Expected resolution ratio >= 0.75, got ${resolved}/${EXPECTED_CALL_SITES} = ${ratio.toFixed(2)}`,
    );
  });

  it("golden snapshot: no previously-resolved call regresses to unresolved", () => {
    const current = sortEntries(calls.map(toGoldenEntry));

    if (process.env.UPDATE_GOLDENS === "1") {
      fs.writeFileSync(
        GOLDEN_PATH,
        JSON.stringify(current, null, 2) + "\n",
        "utf8",
      );
      console.log(
        `[ts-resolver-regression] Golden snapshot written to ${GOLDEN_PATH}`,
      );
      // Pass when regenerating.
      return;
    }

    if (!fs.existsSync(GOLDEN_PATH)) {
      // First run: write the golden file and pass.
      fs.writeFileSync(
        GOLDEN_PATH,
        JSON.stringify(current, null, 2) + "\n",
        "utf8",
      );
      console.log(
        `[ts-resolver-regression] Golden snapshot initialised at ${GOLDEN_PATH}`,
      );
      return;
    }

    const goldenRaw = fs.readFileSync(GOLDEN_PATH, "utf8");
    const golden = JSON.parse(goldenRaw) as GoldenEntry[];

    // Build a lookup key for current resolved calls.
    const currentKeys = new Set(
      current.map(
        (e) => `${e.callLine}:${e.callCol}:${e.calleeName}:${e.calleeFile}`,
      ),
    );

    const regressions: GoldenEntry[] = [];
    for (const expected of golden) {
      const key = `${expected.callLine}:${expected.callCol}:${expected.calleeName}:${expected.calleeFile}`;
      if (!currentKeys.has(key)) {
        regressions.push(expected);
      }
    }

    assert.strictEqual(
      regressions.length,
      0,
      `The following previously-resolved calls are now unresolved (regression!):\n` +
        regressions
          .map((r) => `  line ${r.callLine}: ${r.calleeName} @ ${r.calleeFile}`)
          .join("\n") +
        `\n\nTo reset the golden baseline run:\n  UPDATE_GOLDENS=1 npm test -- --filter ts-resolver-regression`,
    );
  });
});
