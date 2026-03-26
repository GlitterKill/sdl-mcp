import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

describe("real-world benchmark script", () => {
  it("runs the matrix smoke entrypoint without parse or helper reference errors", () => {
    const outDir = mkdtempSync(resolve(tmpdir(), "sdl-mcp-benchmark-smoke-"));
    const result = spawnSync(process.execPath, [
      "scripts/real-world-benchmark-matrix.ts",
      "--",
      "--matrix",
      "benchmarks/real-world/matrix.json",
      "--config",
      "benchmarks/real-world/benchmark.config.json",
      "--out-dir",
      outDir,
      "--limit-runs",
      "1",
      "--skip-index",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.doesNotMatch(output, /ERR_INVALID_TYPESCRIPT_SYNTAX/);
    assert.doesNotMatch(output, /Expected ',', got ';'/);
    assert.doesNotMatch(output, /ReferenceError: ignore is not defined/);
  });
});
