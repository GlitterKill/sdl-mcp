import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { diagnosticsManager } from "../../dist/ts/diagnostics.js";

/**
 * Tests for src/ts/diagnostics.ts — TypeScript diagnostics manager.
 * Uses a small temp fixture project to exercise diagnostics.
 */

let tmpDir: string;

function createFixtureProject(files: Record<string, string>) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdl-ts-diag-test-"));

  // Create tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "node",
      strict: true,
      outDir: "dist",
      rootDir: "src",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  };
  fs.writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2),
  );

  // Create src directory and files
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(srcDir, name);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

function cleanupFixture() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  diagnosticsManager.clearCache();
}

describe("TypeScript diagnostics manager", () => {
  afterEach(() => {
    cleanupFixture();
  });

  describe("clearCache", () => {
    it("does not throw when called with no cached services", () => {
      assert.doesNotThrow(() => diagnosticsManager.clearCache());
    });

    it("does not throw when called with specific repoId", () => {
      assert.doesNotThrow(() => diagnosticsManager.clearCache("nonexistent"));
    });
  });

  describe("getDiagnostics with clean project", () => {
    it("returns no errors for valid TypeScript code", async () => {
      createFixtureProject({
        "index.ts": `
export function add(a: number, b: number): number {
  return a + b;
}

export const greeting: string = "hello";
`,
      });

      const repo = {
        repoId: "test-clean",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "workspace",
      });

      assert.strictEqual(result.summary.totalErrors, 0);
    });
  });

  describe("getDiagnostics with errors", () => {
    it("detects type errors in code", async () => {
      createFixtureProject({
        "bad.ts": `
export function greet(name: string): number {
  return name;
}
`,
      });

      const repo = {
        repoId: "test-errors",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "workspace",
      });

      assert.ok(
        result.summary.totalErrors > 0,
        "should detect at least one type error",
      );
      assert.ok(result.diagnostics.length > 0);
      assert.strictEqual(result.diagnostics[0]?.severity, "error");
    });

    it("returns diagnostics with correct line numbers", async () => {
      createFixtureProject({
        "lines.ts": `
const x: string = 42;
`,
      });

      const repo = {
        repoId: "test-lines",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "workspace",
      });

      assert.ok(result.diagnostics.length > 0);
      const diag = result.diagnostics[0]!;
      assert.strictEqual(diag.startLine, 2); // line 2 (1-indexed)
      assert.ok(diag.startCol > 0);
      assert.ok(diag.endLine >= diag.startLine);
    });
  });

  describe("getDiagnostics with changedFiles scope", () => {
    it("only checks specified files", async () => {
      createFixtureProject({
        "good.ts": `export const x: number = 1;`,
        "bad.ts": `export const y: string = 42;`,
      });

      const repo = {
        repoId: "test-changed",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "changedFiles",
        changedFiles: ["src/good.ts"],
      });

      // Only good.ts should be checked, which has no errors
      assert.strictEqual(result.summary.totalErrors, 0);
    });
  });

  describe("getDiagnostics respects maxErrors", () => {
    it("limits the number of errors returned", async () => {
      createFixtureProject({
        "many-errors.ts": `
const a: string = 1;
const b: string = 2;
const c: string = 3;
const d: string = 4;
const e: string = 5;
`,
      });

      const repo = {
        repoId: "test-maxerrors",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "workspace",
        maxErrors: 2,
      });

      const errors = result.diagnostics.filter((d) => d.severity === "error");
      assert.ok(errors.length <= 2, `Expected <= 2 errors, got ${errors.length}`);
    });
  });

  describe("getDiagnostics summary", () => {
    it("builds summary with topFiles", async () => {
      createFixtureProject({
        "file-a.ts": `const a: string = 1; const b: string = 2;`,
        "file-b.ts": `export const ok: number = 42;`,
      });

      const repo = {
        repoId: "test-summary",
        rootPath: tmpDir,
      };

      const result = await diagnosticsManager.getDiagnostics(repo as any, {
        scope: "workspace",
      });

      assert.ok(Array.isArray(result.summary.topFiles));
      if (result.summary.totalErrors > 0) {
        assert.ok(result.summary.topFiles.length > 0);
        assert.ok(result.summary.topFiles[0]?.errorCount > 0);
      }
    });
  });

  describe("getLanguageService", () => {
    it("throws when no tsconfig found", async () => {
      // Create temp dir without tsconfig.json
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdl-ts-noconfig-"));

      const repo = {
        repoId: "test-no-tsconfig",
        rootPath: tmpDir,
      };

      await assert.rejects(
        diagnosticsManager.getLanguageService(repo as any),
        /No tsconfig\.json found/,
      );
    });

    it("throws when specified tsconfigPath does not exist", async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdl-ts-badpath-"));

      const repo = {
        repoId: "test-bad-tsconfig",
        rootPath: tmpDir,
        tsconfigPath: "nonexistent/tsconfig.json",
      };

      await assert.rejects(
        diagnosticsManager.getLanguageService(repo as any),
        /Specified tsconfig not found/,
      );
    });
  });
});
