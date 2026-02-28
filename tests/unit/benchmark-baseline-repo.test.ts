import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { loadBaselineMetrics } from "../../dist/benchmark/threshold.js";

const tempDir = resolve(process.cwd(), ".tmp", "benchmark-baseline-tests");
const baselinePath = resolve(tempDir, "baseline.json");

function writeBaseline(repoId: string): void {
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        repoId,
        metrics: {
          indexTimePerFile: 200,
          indexTimePerSymbol: 10,
          sliceBuildTimeMs: 150,
          avgSkeletonTimeMs: 0.7,
          symbolsPerFile: 18,
          edgesPerSymbol: 14,
          graphConnectivity: 0.92,
          exportedSymbolRatio: 0.67,
          avgCardTokens: 181,
          avgSkeletonTokens: 26,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("loadBaselineMetrics repo validation", () => {
  it("returns undefined when the baseline repoId does not match the requested repo", () => {
    writeBaseline("my-repo");

    const metrics = loadBaselineMetrics(baselinePath, "zod-oss");

    assert.strictEqual(metrics, undefined);
  });

  it("loads metrics when the baseline repoId matches the requested repo", () => {
    writeBaseline("zod-oss");

    const metrics = loadBaselineMetrics(baselinePath, "zod-oss");

    assert.deepStrictEqual(metrics, {
      indexTimePerFile: 200,
      indexTimePerSymbol: 11.11111111111111,
      sliceBuildTimeMs: 150,
      avgSkeletonTimeMs: 0.7,
      symbolsPerFile: 18,
      edgesPerSymbol: 14,
      graphConnectivity: 0.92,
      exportedSymbolRatio: 0.67,
      avgCardTokens: 181,
      avgSkeletonTokens: 26,
    });
  });
});
