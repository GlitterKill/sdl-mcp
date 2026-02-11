import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("real-world benchmark emits normalized task tags in output payload", () => {
  const repoRoot = resolve(".");
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-benchmark-tags-"));

  try {
    const configPath = join(tempDir, "config.json");
    const tasksPath = join(tempDir, "tasks.json");
    const outPath = join(tempDir, "result.json");
    const dbPath = join(tempDir, "benchmark.sqlite");

    const baseConfig = JSON.parse(
      readFileSync(resolve("config", "sdlmcp.config.json"), "utf-8"),
    ) as {
      repos: Array<Record<string, unknown>>;
      policy: Record<string, unknown>;
      redaction?: Record<string, unknown>;
      indexing?: Record<string, unknown>;
      slice?: Record<string, unknown>;
    };

    const configPayload = {
      repos: baseConfig.repos,
      dbPath,
      policy: baseConfig.policy,
      redaction: baseConfig.redaction,
      indexing: baseConfig.indexing,
      slice: baseConfig.slice,
    };

    const tasksPayload = {
      version: 3,
      tasks: [
        {
          id: "tags-smoke",
          category: "understanding",
          title: "Tag output smoke",
          description: "Ensure tags propagate to result output.",
          tags: [
            "security",
            "security",
            " incident-debugging ",
            "",
            "  ",
          ],
          contextTargets: {
            files: [],
            symbols: [],
          },
          workflow: [],
        },
      ],
    };

    writeFileSync(configPath, JSON.stringify(configPayload, null, 2), "utf-8");
    writeFileSync(tasksPath, JSON.stringify(tasksPayload, null, 2), "utf-8");

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/real-world-benchmark.ts",
        "--config",
        configPath,
        "--tasks",
        tasksPath,
        "--skip-index",
        "--out",
        outPath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
      },
    );

    assert.strictEqual(
      run.status,
      0,
      `benchmark command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    const payload = JSON.parse(readFileSync(outPath, "utf-8")) as {
      tasks: Array<{ id: string; tags?: string[] }>;
    };

    assert.strictEqual(payload.tasks.length, 1);
    assert.strictEqual(payload.tasks[0].id, "tags-smoke");
    assert.deepStrictEqual(payload.tasks[0].tags, [
      "security",
      "incident-debugging",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
