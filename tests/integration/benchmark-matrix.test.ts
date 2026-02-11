import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("benchmark matrix runner executes runs and writes aggregate metrics", () => {
  const repoRoot = resolve(".");
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-benchmark-matrix-"));

  try {
    const configPath = join(tempDir, "config.json");
    const matrixPath = join(tempDir, "matrix.json");
    const tasksAPath = join(tempDir, "tasks-a.json");
    const tasksBPath = join(tempDir, "tasks-b.json");
    const outDir = join(tempDir, "out");

    const baseConfig = JSON.parse(
      readFileSync(resolve("config", "sdlmcp.config.json"), "utf-8"),
    ) as {
      repos: Array<Record<string, unknown>>;
      policy: Record<string, unknown>;
      redaction?: Record<string, unknown>;
      indexing?: Record<string, unknown>;
      slice?: Record<string, unknown>;
      cache?: Record<string, unknown>;
    };

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: baseConfig.repos,
          dbPath: join(tempDir, "matrix.sqlite"),
          policy: baseConfig.policy,
          redaction: baseConfig.redaction,
          indexing: baseConfig.indexing,
          slice: baseConfig.slice,
          cache: baseConfig.cache,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tinyTask = (id: string, family: string) => ({
      version: 3,
      tasks: [
        {
          id,
          repoId: "my-repo",
          category: "understanding",
          difficulty: "easy",
          title: `${family} smoke`,
          description: `${family} smoke scenario`,
          tags: [family],
          contextTargets: {
            files: [],
            symbols: [],
          },
          workflow: [],
        },
      ],
    });

    writeFileSync(tasksAPath, JSON.stringify(tinyTask("tiny-a", "family-a"), null, 2));
    writeFileSync(tasksBPath, JSON.stringify(tinyTask("tiny-b", "family-b"), null, 2));

    writeFileSync(
      matrixPath,
      JSON.stringify(
        {
          version: 1,
          runs: [
            {
              id: "run-a",
              family: "family-a",
              repoId: "my-repo",
              tasks: "./tasks-a.json",
            },
            {
              id: "run-b",
              family: "family-b",
              repoId: "my-repo",
              tasks: "./tasks-b.json",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/real-world-benchmark-matrix.ts",
        "--matrix",
        matrixPath,
        "--config",
        configPath,
        "--out-dir",
        outDir,
        "--skip-index",
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
      },
    );

    assert.strictEqual(
      run.status,
      0,
      `matrix command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    const aggregate = JSON.parse(
      readFileSync(resolve(outDir, "aggregate.json"), "utf-8"),
    ) as {
      runCount: number;
      taskCount: number;
      families: Array<{ family: string; p50TokenReductionPct: number }>;
      overall: { p50TokenReductionPct: number };
    };

    assert.strictEqual(aggregate.runCount, 2);
    assert.strictEqual(aggregate.taskCount, 2);
    assert.strictEqual(aggregate.families.length, 2);
    assert.ok(
      aggregate.families.some((family) => family.family === "family-a"),
      "missing family-a aggregate",
    );
    assert.ok(
      aggregate.families.some((family) => family.family === "family-b"),
      "missing family-b aggregate",
    );
    assert.strictEqual(typeof aggregate.overall.p50TokenReductionPct, "number");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
