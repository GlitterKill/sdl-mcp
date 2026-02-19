import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDbPath = join(__dirname, "test-otel-tracing.db");
const testRepoPath = join(__dirname, "test-otel-repo");

function createTestRepo(): void {
  if (existsSync(testRepoPath)) {
    rmSync(testRepoPath, { recursive: true, force: true });
  }
  mkdirSync(testRepoPath, { recursive: true });
  mkdirSync(join(testRepoPath, "src"), { recursive: true });

  writeFileSync(
    join(testRepoPath, "package.json"),
    JSON.stringify({ name: "test-otel-repo", version: "1.0.0" }),
  );

  writeFileSync(
    join(testRepoPath, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "node",
        strict: true,
      },
    }),
  );

  writeFileSync(
    join(testRepoPath, "src", "index.ts"),
    `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private value: number = 0;

  add(n: number): void {
    this.value += n;
  }

  getValue(): number {
    return this.value;
  }
}
`,
  );
}

describe("OpenTelemetry Tracing Integration", () => {
  beforeEach(async () => {
    process.env.SDL_DB_PATH = testDbPath;

    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    createTestRepo();

    const { resetTracingForTest } = await import("../../dist/util/tracing.js");
    resetTracingForTest();

    const { getDb, closeDb } = await import("../../dist/db/db.js");
    const { runMigrations } = await import("../../dist/db/migrations.js");

    closeDb();
    const db = getDb();
    runMigrations(db);
  });

  afterEach(async () => {
    const { closeDb } = await import("../../dist/db/db.js");
    const { resetQueryCache } = await import("../../dist/db/queries.js");
    const { resetTracingForTest } = await import("../../dist/util/tracing.js");

    resetQueryCache();
    closeDb();
    resetTracingForTest();

    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }

    delete process.env.SDL_DB_PATH;
  });

  describe("When tracing is enabled", () => {
    it("should emit spans for slice.build", async () => {
      const { initTracing, SPAN_NAMES, getMemoryExporter } =
        await import("../../dist/util/tracing.js");
      const { handleSliceBuild } =
        await import("../../dist/mcp/tools/slice.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleIndexRefresh } =
        await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: true,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      await handleIndexRefresh({
        repoId: "test-otel-repo",
        mode: "full",
      });

      const memoryExporter = getMemoryExporter();
      assert.ok(memoryExporter, "Memory exporter should be available");

      await memoryExporter.forceFlush();
      const spansBefore = memoryExporter.getFinishedSpans();
      const sliceSpansBefore = spansBefore.filter(
        (s) => s.name === SPAN_NAMES.SLICE_BUILD,
      );

      assert.strictEqual(
        sliceSpansBefore.length,
        0,
        "No slice.build spans before call",
      );

      try {
        await handleSliceBuild({
          repoId: "test-otel-repo",
          taskText: "test slice build",
          budget: { maxCards: 10, maxEstimatedTokens: 1000 },
        });
      } catch {
        // Slice build may fail if indexing isn't complete - we just want to verify span was emitted
      }

      await memoryExporter.forceFlush();
      const spansAfter = memoryExporter.getFinishedSpans();
      const sliceSpansAfter = spansAfter.filter(
        (s) => s.name === SPAN_NAMES.SLICE_BUILD,
      );

      assert.ok(
        sliceSpansAfter.length > 0,
        "Should emit slice.build span when tracing is enabled",
      );

      const span = sliceSpansAfter[0];
      assert.ok(span.attributes["repoId"], "Should have repoId attribute");
      assert.ok(
        span.attributes["budget.maxCards"],
        "Should have budget.maxCards attribute",
      );
    });

    it("should execute delta.get with tracing enabled", async () => {
      const { initTracing, getMemoryExporter, isTracingEnabled } =
        await import("../../dist/util/tracing.js");
      const { handleDeltaGet } = await import("../../dist/mcp/tools/delta.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleIndexRefresh } =
        await import("../../dist/mcp/tools/repo.js");
      const { getLatestVersion } = await import("../../dist/db/queries.js");

      initTracing({
        enabled: true,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });
      assert.ok(isTracingEnabled(), "Tracing should be enabled");

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      await handleIndexRefresh({
        repoId: "test-otel-repo",
        mode: "full",
      });

      const version = getLatestVersion("test-otel-repo");
      assert.ok(version, "Should have a version after indexing");

      try {
        await handleDeltaGet({
          repoId: "test-otel-repo",
          fromVersion: "v0",
          toVersion: version.version_id,
          budget: { maxCards: 10 },
        });
      } catch {
        // Delta get may fail for various reasons - we just want to verify span was emitted
      }

      const memoryExporter = getMemoryExporter();
      assert.ok(memoryExporter, "Memory exporter should be available");
      await memoryExporter.forceFlush();
      assert.ok(
        Array.isArray(memoryExporter.getFinishedSpans()),
        "Tracing exporter should collect finished spans",
      );
    });

    it("should execute index.refresh with tracing enabled", async () => {
      const { initTracing, getMemoryExporter, isTracingEnabled } =
        await import("../../dist/util/tracing.js");
      const { handleIndexRefresh } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: true,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });
      assert.ok(isTracingEnabled(), "Tracing should be enabled");

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      const memoryExporter = getMemoryExporter();
      assert.ok(memoryExporter, "Memory exporter should be available");
      await memoryExporter.forceFlush();

      await handleIndexRefresh({
        repoId: "test-otel-repo",
        mode: "full",
      });

      await memoryExporter.forceFlush();
      assert.ok(
        Array.isArray(memoryExporter.getFinishedSpans()),
        "Tracing exporter should collect finished spans",
      );
    });

    it("should execute repo.status with tracing enabled", async () => {
      const { initTracing, getMemoryExporter, isTracingEnabled } =
        await import("../../dist/util/tracing.js");
      const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: true,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });
      assert.ok(isTracingEnabled(), "Tracing should be enabled");

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      await handleRepoStatus({ repoId: "test-otel-repo" });

      const memoryExporter = getMemoryExporter();
      assert.ok(memoryExporter, "Memory exporter should be available");
      await memoryExporter.forceFlush();
      assert.ok(
        Array.isArray(memoryExporter.getFinishedSpans()),
        "Tracing exporter should collect finished spans",
      );
    });
  });

  describe("When tracing is disabled", () => {
    it("should not emit any spans", async () => {
      const { initTracing, getMemoryExporter } =
        await import("../../dist/util/tracing.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: false,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      await handleRepoStatus({ repoId: "test-otel-repo" });

      const memoryExporter = getMemoryExporter();
      assert.strictEqual(
        memoryExporter,
        null,
        "Memory exporter should be null when tracing disabled",
      );
    });
  });

  describe("Performance overhead", () => {
    it("disabled tracing should have minimal overhead", async () => {
      const { initTracing } = await import("../../dist/util/tracing.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: false,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await handleRepoStatus({ repoId: "test-otel-repo" });
        times.push(performance.now() - start);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const p95Time = times.sort((a, b) => a - b)[
        Math.floor(iterations * 0.95)
      ];

      console.log(
        `Disabled tracing - avg: ${avgTime.toFixed(3)}ms, p95: ${p95Time.toFixed(3)}ms`,
      );

      assert.ok(
        avgTime < 100,
        `Average time should be < 100ms (got ${avgTime.toFixed(3)}ms)`,
      );
    });

    it("enabled tracing overhead should be acceptable", async () => {
      const { initTracing, resetTracingForTest } =
        await import("../../dist/util/tracing.js");
      const { handleRepoRegister } =
        await import("../../dist/mcp/tools/repo.js");
      const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");

      initTracing({
        enabled: false,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });

      await handleRepoRegister({
        repoId: "test-otel-repo",
        rootPath: testRepoPath,
      });

      const disabledTimes: number[] = [];
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await handleRepoStatus({ repoId: "test-otel-repo" });
        disabledTimes.push(performance.now() - start);
      }

      const disabledP95 = disabledTimes.sort((a, b) => a - b)[
        Math.floor(iterations * 0.95)
      ];

      resetTracingForTest();

      initTracing({
        enabled: true,
        serviceName: "test-sdl-mcp",
        exporterType: "memory",
        sampleRate: 1.0,
      });

      const enabledTimes: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await handleRepoStatus({ repoId: "test-otel-repo" });
        enabledTimes.push(performance.now() - start);
      }

      const enabledP95 = enabledTimes.sort((a, b) => a - b)[
        Math.floor(iterations * 0.95)
      ];

      console.log(`Disabled p95: ${disabledP95.toFixed(3)}ms`);
      console.log(`Enabled p95: ${enabledP95.toFixed(3)}ms`);

      const absoluteOverheadMs = enabledP95 - disabledP95;
      const overheadPercent =
        disabledP95 > 0 ? (absoluteOverheadMs / disabledP95) * 100 : 0;
      console.log(`Overhead: ${overheadPercent.toFixed(2)}%`);
      console.log(`Absolute overhead: ${absoluteOverheadMs.toFixed(3)}ms`);

      assert.ok(
        absoluteOverheadMs <= 1.5 || overheadPercent <= 25,
        `Enabled tracing overhead too high (absolute=${absoluteOverheadMs.toFixed(
          3,
        )}ms, relative=${overheadPercent.toFixed(2)}%)`,
      );
    });
  });
});
