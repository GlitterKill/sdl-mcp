import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("provider-first incremental execution failure fallback", () => {
  it("keeps auto-mode provider-first incremental failures scoped to changed files", () => {
    const source = readFileSync("src/indexer/indexer.ts", "utf8");

    assert.match(
      source,
      /providerFirstExecutionFallback = providerFirstFallbackSummary\([\s\S]*?if \(providerFirstIncrementalActive\) \{[\s\S]*?providerFirstScan = providerExecutionScan;[\s\S]*?for \(const file of providerExecutionScan\.files\) \{[\s\S]*?providerFirstFallbackPaths\.add\(file\.path\);[\s\S]*?providerFirstLegacyFallbackStartedAt = Date\.now\(\);/,
    );
  });
});
