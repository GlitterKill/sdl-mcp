import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planReconcileWork } from "../../dist/live-index/reconcile-planner.js";

describe("planReconcileWork", () => {
  it("deduplicates file paths and detects derived-data refreshes", () => {
    const plan = planReconcileWork({
      repoId: "demo-repo",
      frontier: {
        touchedSymbolIds: ["sym-a"],
        dependentSymbolIds: ["sym-b"],
        dependentFilePaths: ["src/b.ts", "src/c.ts"],
        importedFilePaths: ["src/c.ts", "src/d.ts"],
        invalidations: ["metrics", "clusters"],
      },
    });

    assert.deepStrictEqual(plan.filePaths, ["src/b.ts", "src/c.ts", "src/d.ts"]);
    assert.strictEqual(plan.recomputeDerivedData, true);
    assert.deepStrictEqual(plan.touchedSymbolIds, ["sym-a"]);
  });
});
