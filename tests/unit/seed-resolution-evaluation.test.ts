import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const artifactPath = join(
  process.cwd(),
  "devdocs/benchmarks/seed-resolution-evaluation-v1.json",
);
const designPath = join(
  process.cwd(),
  "devdocs/design/seed-resolution-unification.md",
);

describe("Seed Resolution evaluation", () => {
  it("persists a reproducible three-stack evidence artifact", () => {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/evaluate-seed-resolution.ts", "--check"],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      cases: Array<Record<string, unknown>>;
      interfaces: Record<string, unknown>;
      recommendation: {
        option: number;
        implementationApproved: boolean;
        followUpPlan: string;
      };
    };
    assert.equal(artifact.cases.length, 4);
    assert.deepEqual(Object.keys(artifact.interfaces), [
      "contextAssembly",
      "sliceStartNodes",
      "autopilotExecution",
    ]);
    assert.equal(artifact.recommendation.option, 2);
    assert.equal(artifact.recommendation.implementationApproved, true);
    assert.equal(
      artifact.recommendation.followUpPlan,
      "devdocs/plans/2026-07-13-seed-resolution-option-2-implementation-plan.md",
    );
  });

  it("documents all options without creating the candidate module", () => {
    const design = readFileSync(designPath, "utf8");
    assert.match(design, /Option 1/);
    assert.match(design, /Option 2/);
    assert.match(design, /Option 3/);
    assert.equal(
      existsSync(join(process.cwd(), "src/retrieval/seed-resolution.ts")),
      false,
    );
  });
});
