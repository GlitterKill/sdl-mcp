import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigSchema } from "../../dist/config/types.js";
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BENCHMARK_SCOPE_IGNORE_PATTERNS,
  mergeBenchmarkIgnorePatterns,
} from "../../dist/cli/commands/benchmark.js";

describe("benchmark scope ignore patterns", () => {
  it("adds required benchmark scope excludes and keeps order stable", () => {
    const merged = mergeBenchmarkIgnorePatterns(["**/node_modules/**"]);

    assert.deepStrictEqual(merged, [
      "**/node_modules/**",
      ...BENCHMARK_SCOPE_IGNORE_PATTERNS,
    ]);
  });

  it("deduplicates required patterns when already present", () => {
    const merged = mergeBenchmarkIgnorePatterns([
      "**/node_modules/**",
      "**/tests/**",
      "**/*.test.ts",
    ]);

    assert.strictEqual(
      merged.filter((pattern) => pattern === "**/tests/**").length,
      1,
    );
    assert.strictEqual(
      merged.filter((pattern) => pattern === "**/*.test.ts").length,
      1,
    );
    assert.ok(merged.includes("**/dist-tests/**"));
    assert.ok(merged.includes("**/*.spec.ts"));
  });
});

it("CI structural benchmark isolates semantic readiness without changing other settings", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.split("- name: Run Benchmark CI Guardrails (locked OSS repo)")[1].split("- name:")[0];
  assert.match(step, /SDL_CONFIG:.*runner\.temp.*benchmark-structural\.config\.json/);
  const script = step.match(/node --input-type=module <<'BENCHMARK_CONFIG'\r?\n([\s\S]*?)\r?\n\s*BENCHMARK_CONFIG/);
  assert.ok(script, "CI must prepare its isolated config before benchmarking");
  const dir = mkdtempSync(join(tmpdir(), "sdl-benchmark-config-"));
  try {
    const target = join(dir, "config.json");
    const child = spawnSync(process.execPath, ["--input-type=module"], {
      input: script[1],
      env: { ...process.env, SDL_CONFIG: target },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const base = JSON.parse(readFileSync("config/sdlmcp.config.json", "utf8"));
    const isolated = JSON.parse(readFileSync(target, "utf8"));
    assert.deepStrictEqual(isolated, {
      ...base,
      semantic: { ...base.semantic, enabled: false },
    });
    assert.equal(AppConfigSchema.parse(isolated).semantic.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
