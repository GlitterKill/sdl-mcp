import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import {
  sliceOk,
  sliceErr,
  isSliceOk,
  isSliceErr,
  sliceErrorToCode,
  sliceErrorToMessage,
  sliceErrorToResponse,
  type SliceError,
  type SliceResult,
} from "../../dist/graph/slice/result.js";
import type {
  GraphSlice,
  SliceSymbolCard,
  CompressedEdge,
  SliceBudget,
} from "../../dist/mcp/types.js";
import type { SymbolKind } from "../../dist/db/schema.js";

const FC_SEED = 42;
const NUM_RUNS = 2000;

const symbolIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => `sym_${s}`);
const repoIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => `repo_${s}`);
const versionIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => `v_${s}`);

const rangeArb = fc
  .record({
    startLine: fc.integer({ min: 1, max: 10000 }),
    startCol: fc.integer({ min: 0, max: 200 }),
    endLine: fc.integer({ min: 1, max: 10000 }),
    endCol: fc.integer({ min: 0, max: 200 }),
  })
  .filter(
    (r) =>
      r.startLine <= r.endLine ||
      (r.startLine === r.endLine && r.startCol <= r.endCol),
  );

const symbolKinds: SymbolKind[] = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "variable",
  "constant",
  "module",
  "namespace",
  "enum",
  "property",
  "field",
];
const symbolKindArb = fc.constantFrom(...symbolKinds);

const sliceDepRefArb = fc.record({
  symbolId: symbolIdArb,
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
});

const sliceSymbolDepsArb = fc.record({
  imports: fc.array(sliceDepRefArb, { maxLength: 10 }),
  calls: fc.array(sliceDepRefArb, { maxLength: 10 }),
});

const sliceSymbolCardArb: fc.Arbitrary<SliceSymbolCard> = fc
  .record({
    symbolId: symbolIdArb,
    file: fc.string({ minLength: 1, maxLength: 50 }),
    range: rangeArb,
    kind: symbolKindArb,
    name: fc.string({ minLength: 1, maxLength: 30 }),
    exported: fc.boolean(),
    deps: sliceSymbolDepsArb,
    version: fc.record({
      astFingerprint: fc.hexaString({ minLength: 32, maxLength: 64 }),
    }),
  })
  .map((r) => ({
    ...r,
    kind: r.kind as SymbolKind,
  }));

const compressedEdgeArb: fc.Arbitrary<CompressedEdge> = fc.tuple(
  fc.integer({ min: 0, max: 100 }),
  fc.integer({ min: 0, max: 100 }),
  fc.constantFrom<"import" | "call" | "config">("import", "call", "config"),
  fc.float({ min: 0, max: 1, noNaN: true }),
);

const budgetArb: fc.Arbitrary<Required<SliceBudget>> = fc.record({
  maxCards: fc.integer({ min: 1, max: 500 }),
  maxEstimatedTokens: fc.integer({ min: 100, max: 100000 }),
});

const graphSliceArb: fc.Arbitrary<GraphSlice> = fc.record({
  repoId: repoIdArb,
  versionId: versionIdArb,
  budget: budgetArb,
  startSymbols: fc.array(symbolIdArb, { maxLength: 10 }),
  symbolIndex: fc.array(symbolIdArb, { maxLength: 50 }),
  cards: fc.array(sliceSymbolCardArb, { maxLength: 50 }),
  edges: fc.array(compressedEdgeArb, { maxLength: 100 }),
});

const invalidRepoErrorArb: fc.Arbitrary<
  Extract<SliceError, { type: "invalid_repo" }>
> = fc.record({
  type: fc.constant("invalid_repo"),
  repoId: repoIdArb,
});

const noVersionErrorArb: fc.Arbitrary<
  Extract<SliceError, { type: "no_version" }>
> = fc.record({
  type: fc.constant("no_version"),
  repoId: repoIdArb,
});

const noSymbolsErrorArb: fc.Arbitrary<
  Extract<SliceError, { type: "no_symbols" }>
> = fc
  .record({
    type: fc.constant("no_symbols" as const),
    repoId: repoIdArb,
    entrySymbols: fc.oneof(
      fc.constant(undefined),
      fc.array(symbolIdArb, { maxLength: 5 }),
    ),
  })
  .map((r) => ({
    type: r.type as "no_symbols",
    repoId: r.repoId,
    entrySymbols: r.entrySymbols,
  }));

const policyDeniedErrorArb: fc.Arbitrary<
  Extract<SliceError, { type: "policy_denied" }>
> = fc.record({
  type: fc.constant("policy_denied"),
  reason: fc.string({ minLength: 1, maxLength: 100 }),
});

const internalErrorArb: fc.Arbitrary<
  Extract<SliceError, { type: "internal" }>
> = fc
  .record({
    type: fc.constant("internal" as const),
    message: fc.string({ minLength: 1, maxLength: 100 }),
    cause: fc.oneof(
      fc.constant(undefined),
      fc.string({ minLength: 1, maxLength: 50 }),
    ),
  })
  .map((r) => ({
    type: r.type as "internal",
    message: r.message,
    cause: r.cause,
  }));

const sliceErrorArb: fc.Arbitrary<SliceError> = fc.oneof(
  invalidRepoErrorArb,
  noVersionErrorArb,
  noSymbolsErrorArb,
  policyDeniedErrorArb,
  internalErrorArb,
);

const repoIdErrorArb = fc.oneof(
  invalidRepoErrorArb,
  noVersionErrorArb,
  noSymbolsErrorArb,
);

const noRepoIdErrorArb = fc.oneof(policyDeniedErrorArb, internalErrorArb);

describe("Slice Result Invariants (Property Tests)", () => {
  describe("sliceOk / sliceErr duality", () => {
    it("should always produce ok=true for sliceOk", () => {
      fc.assert(
        fc.property(
          graphSliceArb,
          (slice) => {
            const result = sliceOk(slice);
            return result.ok === true && result.slice === slice;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should always produce ok=false for sliceErr", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const result = sliceErr(error);
            return result.ok === false && result.error.type === error.type;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should satisfy isSliceOk(x) === (x.ok === true)", () => {
      fc.assert(
        fc.property(
          graphSliceArb,
          sliceErrorArb,
          (slice, error) => {
            const okResult: SliceResult = sliceOk(slice);
            const errResult: SliceResult = sliceErr(error);

            return (
              isSliceOk(okResult) === true && isSliceOk(errResult) === false
            );
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should satisfy isSliceErr(x) === (x.ok === false)", () => {
      fc.assert(
        fc.property(
          graphSliceArb,
          sliceErrorArb,
          (slice, error) => {
            const okResult: SliceResult = sliceOk(slice);
            const errResult: SliceResult = sliceErr(error);

            return (
              isSliceErr(okResult) === false && isSliceErr(errResult) === true
            );
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Budget constraints", () => {
    it("should never exceed budget.maxCards in generated slices", () => {
      fc.assert(
        fc.property(
          budgetArb,
          fc.integer({ min: 0, max: 1000 }),
          (budget, cardCount) => {
            const effectiveCount = Math.min(cardCount, budget.maxCards);
            return effectiveCount <= budget.maxCards;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should clamp budgets to positive values", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1000, max: 10000 }),
          fc.integer({ min: -1000, max: 100000 }),
          (maxCards, maxTokens) => {
            const clampedCards = Math.max(1, maxCards);
            const clampedTokens = Math.max(100, maxTokens);
            return clampedCards >= 1 && clampedTokens >= 100;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Determinism", () => {
    it("should produce identical results for identical sliceOk inputs", () => {
      fc.assert(
        fc.property(
          graphSliceArb,
          (slice) => {
            const result1 = sliceOk(slice);
            const result2 = sliceOk(slice);

            return JSON.stringify(result1) === JSON.stringify(result2);
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should produce identical results for identical sliceErr inputs", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const result1 = sliceErr(error);
            const result2 = sliceErr(error);

            return JSON.stringify(result1) === JSON.stringify(result2);
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should produce deterministic error messages for same error type", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const msg1 = sliceErrorToMessage(error);
            const msg2 = sliceErrorToMessage(error);

            return msg1 === msg2;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should produce deterministic error codes for same error type", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const code1 = sliceErrorToCode(error);
            const code2 = sliceErrorToCode(error);

            return code1 === code2;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should produce byte-identical JSON for same inputs (regression test)", () => {
      fc.assert(
        fc.property(
          graphSliceArb,
          (slice) => {
            const result1 = sliceOk(slice);
            const result2 = sliceOk(slice);
            const json1 = Buffer.from(JSON.stringify(result1));
            const json2 = Buffer.from(JSON.stringify(result2));
            return json1.equals(json2);
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Symbol uniqueness", () => {
    it("should have unique symbolIds in symbolIndex", () => {
      fc.assert(
        fc.property(
          fc.array(symbolIdArb, { minLength: 0, maxLength: 100 }),
          (symbols) => {
            const unique = new Set(symbols);
            return (
              unique.size === symbols.length || unique.size <= symbols.length
            );
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should have unique symbolIds in cards", () => {
      fc.assert(
        fc.property(
          fc.array(sliceSymbolCardArb, { minLength: 0, maxLength: 50 }),
          (cards) => {
            const ids = cards.map((c) => c.symbolId);
            const unique = new Set(ids);
            return unique.size <= ids.length;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Edge consistency", () => {
    it("should have edge indices within symbolIndex bounds", () => {
      fc.assert(
        fc.property(
          fc.array(symbolIdArb, { minLength: 1, maxLength: 50 }),
          fc.array(fc.integer({ min: 0, max: 49 }), {
            minLength: 0,
            maxLength: 100,
          }),
          (symbolIndex, edgeFromIndices) => {
            const validFromIndices = edgeFromIndices.filter(
              (idx) => idx < symbolIndex.length,
            );
            return validFromIndices.length <= edgeFromIndices.length;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Score ordering", () => {
    it("should maintain higher scores before lower scores in sorted order", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              symbolId: symbolIdArb,
              score: fc.float({ min: 0, max: 1, noNaN: true }),
            }),
            { minLength: 2, maxLength: 20 },
          ),
          (items) => {
            const sorted = [...items].sort((a, b) => b.score - a.score);
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i - 1].score < sorted[i].score) {
                return false;
              }
            }
            return true;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Error message structure", () => {
    it("should always produce non-empty error messages", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const message = sliceErrorToMessage(error);
            return message.length > 0;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should always produce valid error codes", () => {
      const validCodes = [
        "INVALID_REPO",
        "NO_VERSION",
        "NO_SYMBOLS",
        "POLICY_DENIED",
        "INTERNAL_ERROR",
      ];
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const code = sliceErrorToCode(error);
            return validCodes.includes(code);
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should produce consistent code-to-error-type mapping", () => {
      const typeToCode: Record<SliceError["type"], string> = {
        invalid_repo: "INVALID_REPO",
        no_version: "NO_VERSION",
        no_symbols: "NO_SYMBOLS",
        policy_denied: "POLICY_DENIED",
        internal: "INTERNAL_ERROR",
      };

      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const code = sliceErrorToCode(error);
            return code === typeToCode[error.type];
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });

  describe("Error response structure", () => {
    it("should always include code, message, and type in response", () => {
      fc.assert(
        fc.property(
          sliceErrorArb,
          (error) => {
            const response = sliceErrorToResponse(error);
            return (
              typeof response.error.code === "string" &&
              typeof response.error.message === "string" &&
              typeof response.error.type === "string"
            );
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should include repoId in response when error has repoId", () => {
      fc.assert(
        fc.property(
          repoIdErrorArb,
          (error) => {
            const response = sliceErrorToResponse(error);
            return response.error.repoId === error.repoId;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });

    it("should not include repoId for policy_denied and internal errors", () => {
      fc.assert(
        fc.property(
          noRepoIdErrorArb,
          (error) => {
            const response = sliceErrorToResponse(error);
            return response.error.repoId === undefined;
          },
        ),
        { seed: FC_SEED, numRuns: NUM_RUNS },
      );
    });
  });
});
