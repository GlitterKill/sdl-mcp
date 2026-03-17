import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function countLines(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  return content.split(/\r?\n/).length;
}

describe("indexer.ts monolith shattering", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, "..", "..");

  const indexerPath = join(repoRoot, "src/indexer/indexer.ts");
  const modulePaths = {
    scanner: join(repoRoot, "src/indexer/scanner.ts"),
    parser: join(repoRoot, "src/indexer/parser.ts"),
    watcher: join(repoRoot, "src/indexer/watcher.ts"),
    edgeBuilder: join(repoRoot, "src/indexer/edge-builder.ts"),
    metricsUpdater: join(repoRoot, "src/indexer/metrics-updater.ts"),
  } as const;

  it("splits into focused ~500-line modules", () => {
    assert.ok(existsSync(modulePaths.scanner), "missing src/indexer/scanner.ts");
    assert.ok(existsSync(modulePaths.parser), "missing src/indexer/parser.ts");
    assert.ok(existsSync(modulePaths.watcher), "missing src/indexer/watcher.ts");
    assert.ok(
      existsSync(modulePaths.edgeBuilder),
      "missing src/indexer/edge-builder.ts",
    );
    assert.ok(
      existsSync(modulePaths.metricsUpdater),
      "missing src/indexer/metrics-updater.ts",
    );

    const moduleMaxLines = 900;
    assert.ok(
      countLines(modulePaths.scanner) <= moduleMaxLines,
      "scanner.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.parser) <= moduleMaxLines,
      "parser.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.watcher) <= moduleMaxLines,
      "watcher.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.edgeBuilder) <= moduleMaxLines,
      "edge-builder.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.metricsUpdater) <= moduleMaxLines,
      "metrics-updater.ts too large; split further",
    );
  });

  it("keeps edge-builder sub-modules under size limit", () => {
    const subModuleMaxLines = 700;
    const edgeBuilderDir = join(repoRoot, "src/indexer/edge-builder");
    const subModules = [
      "builtins.ts",
      "call-resolution.ts",
      "cleanup.ts",
      "import-resolution.ts",
      "pass2.ts",
      "pending.ts",
      "symbol-index.ts",
      "telemetry.ts",
      "types.ts",
    ];
    for (const mod of subModules) {
      const modPath = join(edgeBuilderDir, mod);
      assert.ok(existsSync(modPath), `missing edge-builder/${mod}`);
      const lines = countLines(modPath);
      assert.ok(
        lines <= subModuleMaxLines,
        `edge-builder/${mod} too large (${lines} lines, max ${subModuleMaxLines}); split further`,
      );
    }
  });

  it("keeps parser sub-modules under size limit", () => {
    const subModuleMaxLines = 700;
    const parserDir = join(repoRoot, "src/indexer/parser");
    const subModules = [
      "helpers.ts",
      "process-file.ts",
      "rust-process-file.ts",
    ];
    for (const mod of subModules) {
      const modPath = join(parserDir, mod);
      assert.ok(existsSync(modPath), `missing parser/${mod}`);
      const lines = countLines(modPath);
      assert.ok(
        lines <= subModuleMaxLines,
        `parser/${mod} too large (${lines} lines, max ${subModuleMaxLines}); split further`,
      );
    }
  });

  it("keeps src/indexer/indexer.ts as a thin orchestrator", () => {
    const indexer = readFileSync(indexerPath, "utf-8");

    // Ensure it actually delegates to extracted modules (avoid empty placeholder files).
    assert.ok(
      indexer.includes('from "./scanner.js"'),
      'expected indexer.ts to import "./scanner.js"',
    );
    assert.ok(
      indexer.includes('from "./parser.js"'),
      'expected indexer.ts to import "./parser.js"',
    );
    assert.ok(
      indexer.includes('from "./watcher.js"'),
      'expected indexer.ts to import "./watcher.js"',
    );
    assert.ok(
      indexer.includes('from "./edge-builder.js"'),
      'expected indexer.ts to import "./edge-builder.js"',
    );
    assert.ok(
      indexer.includes('from "./metrics-updater.js"'),
      'expected indexer.ts to import "./metrics-updater.js"',
    );

    const indexerMaxLines = 1150;
    assert.ok(
      countLines(indexerPath) <= indexerMaxLines,
      `indexer.ts still too large (expected <= ${indexerMaxLines} lines)`,
    );
  });
});

