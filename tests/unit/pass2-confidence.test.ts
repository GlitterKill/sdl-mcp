import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

import {
  CallConfidence,
  confidenceFor,
  confidenceForBoth,
  getConfidenceTablesForTesting,
  isNewConfidenceRubricEnabled,
  resetConfidenceRubricCacheForTests,
  telemetryBucketFor,
  type CallResolutionStrategy,
} from "../../src/indexer/pass2/confidence.ts";

const ALL_STRATEGIES: CallResolutionStrategy[] = [
  "compiler-resolved",
  "import-direct",
  "import-aliased",
  "import-barrel",
  "same-file-lexical",
  "cross-file-name-unique",
  "cross-file-name-ambiguous",
  "receiver-this",
  "receiver-self",
  "receiver-type",
  "namespace-qualified",
  "module-qualified",
  "package-qualified",
  "header-pair",
  "psr4-autoload",
  "extension-method",
  "trait-default",
  "inheritance-method",
  "function-pointer",
  "global-preferred",
  "global-fallback",
  "builtin-or-global",
  "heuristic-only",
  "disambiguated",
];

describe("Phase 2: confidence rubric (Task 2.0.1)", () => {
  let savedFlag: string | undefined;

  before(() => {
    savedFlag = process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    resetConfidenceRubricCacheForTests();
  });

  after(() => {
    if (savedFlag === undefined) {
      delete process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    } else {
      process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC = savedFlag;
    }
    resetConfidenceRubricCacheForTests();
  });

  it("every strategy has a value in [0, 1] in both tables", () => {
    const { legacy, next } = getConfidenceTablesForTesting();
    for (const strategy of ALL_STRATEGIES) {
      const l = legacy[strategy];
      const n = next[strategy];
      assert.ok(typeof l === "number", `legacy missing ${strategy}`);
      assert.ok(typeof n === "number", `next missing ${strategy}`);
      assert.ok(l >= 0 && l <= 1, `legacy[${strategy}]=${l} out of range`);
      assert.ok(n >= 0 && n <= 1, `next[${strategy}]=${n} out of range`);
    }
  });

  it("with env flag UNSET, confidenceFor() returns legacy values", () => {
    delete process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    resetConfidenceRubricCacheForTests();
    assert.equal(isNewConfidenceRubricEnabled(), false);
    const { legacy } = getConfidenceTablesForTesting();
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(
        confidenceFor(strategy),
        legacy[strategy],
        `legacy mismatch for ${strategy}`,
      );
    }
  });

  it("with env flag SET to '1', confidenceFor() returns new rubric values", () => {
    process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC = "1";
    resetConfidenceRubricCacheForTests();
    assert.equal(isNewConfidenceRubricEnabled(), true);
    const { next } = getConfidenceTablesForTesting();
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(
        confidenceFor(strategy),
        next[strategy],
        `new rubric mismatch for ${strategy}`,
      );
    }
  });

  it("with env flag SET to 'true', confidenceFor() returns new rubric values", () => {
    process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC = "true";
    resetConfidenceRubricCacheForTests();
    assert.equal(isNewConfidenceRubricEnabled(), true);
    assert.equal(
      confidenceFor("compiler-resolved"),
      CallConfidence.COMPILER_RESOLVED,
    );
  });

  it("confidenceForBoth() emits both legacy and next values regardless of flag", () => {
    delete process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    resetConfidenceRubricCacheForTests();
    const both = confidenceForBoth("import-direct");
    assert.equal(typeof both.legacy, "number");
    assert.equal(typeof both.next, "number");
    assert.equal(both.active, both.legacy);

    process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC = "1";
    resetConfidenceRubricCacheForTests();
    const bothNew = confidenceForBoth("import-direct");
    assert.equal(bothNew.active, bothNew.next);
  });

  it("telemetryBucketFor() maps every strategy to a bucket", () => {
    for (const strategy of ALL_STRATEGIES) {
      const bucket = telemetryBucketFor(strategy);
      assert.ok(
        [
          "compiler",
          "import",
          "lexical",
          "ambiguous",
          "global",
          "heuristic",
        ].includes(bucket),
        `unknown bucket ${bucket} for ${strategy}`,
      );
    }
  });

  it("regression guard: legacy values match the pre-Phase-2 snapshot", () => {
    // This snapshot encodes the literal confidence values from the
    // pre-Phase-2 resolvers. If you intentionally change the legacy
    // table, update this snapshot in the same PR. With the env flag
    // unset, edge weights must remain byte-for-byte identical to the
    // pre-Phase-2 codebase.
    delete process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    resetConfidenceRubricCacheForTests();
    const expected: Record<CallResolutionStrategy, number> = {
      "compiler-resolved": 0.95,
      "import-direct": 0.9,
      "import-aliased": 0.88,
      "import-barrel": 0.85,
      "same-file-lexical": 0.9,
      "cross-file-name-unique": 0.78,
      "cross-file-name-ambiguous": 0.45,
      "receiver-this": 0.92,
      "receiver-self": 0.92,
      "receiver-type": 0.85,
      "namespace-qualified": 0.88,
      "module-qualified": 0.88,
      "package-qualified": 0.93,
      "header-pair": 0.82,
      "psr4-autoload": 0.93,
      "extension-method": 0.78,
      "trait-default": 0.78,
      "inheritance-method": 0.78,
      "function-pointer": 0.45,
      "global-preferred": 0.95,
      "global-fallback": 0.8,
      "builtin-or-global": 0.3,
      "heuristic-only": 0.35,
      "disambiguated": 0.55,
    };
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(
        confidenceFor(strategy),
        expected[strategy],
        `legacy regression for ${strategy}`,
      );
    }
  });
});
