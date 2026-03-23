import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";

/**
 * Property test: Symbol diff operations should produce complementary results
 * when A->B and B->A are computed.
 *
 * If diff(A, B) says symbol X was "added", then diff(B, A) should say X was "removed".
 */
describe("Diff Symmetry Properties", () => {
  // Simplified symbol representation for property testing
  interface SimpleSymbol {
    id: string;
    name: string;
    signature: string;
  }

  const symbolArb = fc.record({
    id: fc.string({ minLength: 8, maxLength: 8 }),
    name: fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/),
    signature: fc.stringMatching(/^[a-z]+\([a-z, ]*\): [a-z]+$/),
  });

  function computeDiff(
    before: SimpleSymbol[],
    after: SimpleSymbol[],
  ): { added: string[]; removed: string[]; modified: string[] } {
    const beforeMap = new Map(before.map((s) => [s.id, s]));
    const afterMap = new Map(after.map((s) => [s.id, s]));

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];

    for (const [id, sym] of afterMap) {
      if (!beforeMap.has(id)) {
        added.push(id);
      } else if (beforeMap.get(id)!.signature !== sym.signature) {
        modified.push(id);
      }
    }

    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        removed.push(id);
      }
    }

    return { added, removed, modified };
  }

  it("added in A->B should be removed in B->A", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArb, { minLength: 0, maxLength: 20 }),
        fc.array(symbolArb, { minLength: 0, maxLength: 20 }),
        (before, after) => {
          const forward = computeDiff(before, after);
          const reverse = computeDiff(after, before);

          // Every symbol added in forward should be removed in reverse
          for (const id of forward.added) {
            assert.ok(
              reverse.removed.includes(id),
              `Symbol ${id} added in A->B should be removed in B->A`,
            );
          }

          // Every symbol removed in forward should be added in reverse
          for (const id of forward.removed) {
            assert.ok(
              reverse.added.includes(id),
              `Symbol ${id} removed in A->B should be added in B->A`,
            );
          }

          // Modified should be the same in both directions
          assert.deepStrictEqual(
            forward.modified.sort(),
            reverse.modified.sort(),
            "Modified symbols should be the same in both directions",
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("diff with itself should produce no changes", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArb, { minLength: 0, maxLength: 20 }),
        (symbols) => {
          const diff = computeDiff(symbols, symbols);
          assert.strictEqual(diff.added.length, 0, "No additions");
          assert.strictEqual(diff.removed.length, 0, "No removals");
          assert.strictEqual(diff.modified.length, 0, "No modifications");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("diff counts should be consistent", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArb, { minLength: 0, maxLength: 20 }),
        fc.array(symbolArb, { minLength: 0, maxLength: 20 }),
        (before, after) => {
          const diff = computeDiff(before, after);
          const beforeIds = new Set(before.map((s) => s.id));
          const afterIds = new Set(after.map((s) => s.id));

          // Added count should equal symbols in after but not in before
          const expectedAdded = [...afterIds].filter(
            (id) => !beforeIds.has(id),
          ).length;
          assert.strictEqual(
            diff.added.length,
            expectedAdded,
            "Added count mismatch",
          );

          // Removed count should equal symbols in before but not in after
          const expectedRemoved = [...beforeIds].filter(
            (id) => !afterIds.has(id),
          ).length;
          assert.strictEqual(
            diff.removed.length,
            expectedRemoved,
            "Removed count mismatch",
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
