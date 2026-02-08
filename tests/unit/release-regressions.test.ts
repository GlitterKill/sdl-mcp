import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("release regression guards", () => {
  it("parses card URI symbol segment correctly", () => {
    const source = readSource("src/mcp/resources.ts");

    assert.match(
      source,
      /const\s*\[\s*,\s*,\s*symbolId,\s*versionId\s*\]\s*=\s*match;/,
      "card URI parser should skip repoId capture and read symbolId from group 2",
    );
  });

  it("updates code policy engine from merged repo+app policy before evaluation", () => {
    const source = readSource("src/mcp/tools/code.ts");

    assert.match(
      source,
      /policyEngine\.updateConfig\(\{\s*maxWindowLines:\s*validatedPolicy\.maxWindowLines,\s*maxWindowTokens:\s*validatedPolicy\.maxWindowTokens,\s*requireIdentifiers:\s*validatedPolicy\.requireIdentifiers,\s*allowBreakGlass:\s*validatedPolicy\.allowBreakGlass,/s,
      "code handler should push merged policy values into PolicyEngine",
    );

    const updateIdx = source.indexOf("policyEngine.updateConfig({");
    const evaluateIdx = source.indexOf("policyEngine.evaluate(policyContext)");
    assert.ok(
      updateIdx !== -1 && evaluateIdx !== -1 && updateIdx < evaluateIdx,
      "policy engine should be configured before evaluation",
    );
  });

  it("uses absolute end line for code window truncation resume cursor", () => {
    const source = readSource("src/mcp/tools/code.ts");

    assert.match(
      source,
      /howToResume:\s*\{\s*type:\s*"cursor"\s+as\s+const,\s*value:\s*windowResult\.actualRange\.endLine,\s*\}/s,
      "code truncation cursor should use absolute line numbers",
    );
  });

  it("merges repo policy overrides in slice policy evaluation", () => {
    const source = readSource("src/mcp/tools/slice.ts");

    assert.match(
      source,
      /const mergedPolicy = PolicyConfigSchema\.parse\(\{\s*\.\.\.config\.policy,\s*\.\.\.\(repoConfig\.policy \?\? \{\}\),\s*}\);/s,
      "slice handler should merge app policy with repo overrides",
    );

    assert.match(
      source,
      /policyEngine\.updateConfig\(\{\s*maxWindowLines:\s*mergedPolicy\.maxWindowLines,\s*maxWindowTokens:\s*mergedPolicy\.maxWindowTokens,\s*requireIdentifiers:\s*mergedPolicy\.requireIdentifiers,\s*allowBreakGlass:\s*mergedPolicy\.allowBreakGlass,/s,
      "slice handler should evaluate using merged policy values",
    );
  });

  it("policy get/set merges with app policy without clobbering overrides", () => {
    const source = readSource("src/mcp/tools/policy.ts");

    assert.match(
      source,
      /PolicyConfigSchema\.parse\(\{\s*\.\.\.appConfig\.policy,\s*\.\.\.repoPolicy,\s*}\);/s,
      "policy.get should return effective app+repo policy",
    );

    assert.match(
      source,
      /const mergedOverrides = \{ \.\.\.existingPolicyOverrides, \.\.\.policyPatch \};/,
      "policy.set should only merge patch into existing repo overrides",
    );

    assert.match(
      source,
      /PolicyConfigSchema\.parse\(\{\s*\.\.\.appConfig\.policy,\s*\.\.\.mergedOverrides,\s*}\);/s,
      "policy.set should validate against effective app+repo policy",
    );

    assert.match(
      source,
      /configJson\.policy = mergedOverrides;/,
      "policy.set should persist only repo overrides",
    );
  });
});
