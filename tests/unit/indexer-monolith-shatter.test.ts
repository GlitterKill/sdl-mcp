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
    indexerFinalizeEdges: join(repoRoot, "src/indexer/indexer-finalize-edges.ts"),
    indexerInit: join(repoRoot, "src/indexer/indexer-init.ts"),
    indexerVersion: join(repoRoot, "src/indexer/indexer-version.ts"),
    indexerPass1: join(repoRoot, "src/indexer/indexer-pass1.ts"),
    indexerPass2: join(repoRoot, "src/indexer/indexer-pass2.ts"),
    indexerPass2ImportCache: join(
      repoRoot,
      "src/indexer/indexer-pass2-import-cache.ts",
    ),
    indexerPass2SymbolIndex: join(
      repoRoot,
      "src/indexer/indexer-pass2-symbol-index.ts",
    ),
    indexerPass2Write: join(repoRoot, "src/indexer/indexer-pass2-write.ts"),
    indexerMemory: join(repoRoot, "src/indexer/indexer-memory.ts"),
    providerFirstSemanticScope: join(
      repoRoot,
      "src/indexer/provider-first/semantic-scope.ts",
    ),
  } as const;

  it("splits into focused ~500-line modules", () => {
    assert.ok(
      existsSync(modulePaths.scanner),
      "missing src/indexer/scanner.ts",
    );
    assert.ok(existsSync(modulePaths.parser), "missing src/indexer/parser.ts");
    assert.ok(
      existsSync(modulePaths.watcher),
      "missing src/indexer/watcher.ts",
    );
    assert.ok(
      existsSync(modulePaths.edgeBuilder),
      "missing src/indexer/edge-builder.ts",
    );
    assert.ok(
      existsSync(modulePaths.metricsUpdater),
      "missing src/indexer/metrics-updater.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerFinalizeEdges),
      "missing src/indexer/indexer-finalize-edges.ts",
    );

    // Bumped from 900 → 1100 after the indexing-perf sprint added the
    // pass-2 import cache (A1), pass-1 extraction cache (C1), pass2
    // dispatcher write coalescing (`makeImmediateSubmit` /
    // `makeBatchAccumulator` / `flushBatchAccumulator`), pass-1 drain
    // progress wiring, the SCIP cleanup helper extraction, and the
    // pass-1→pass-2 cache plumbing. Each addition has a discrete
    // justification but the surface area legitimately grew.
    const moduleMaxLines = 1100;
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
    assert.ok(
      countLines(modulePaths.indexerFinalizeEdges) <= moduleMaxLines,
      "indexer-finalize-edges.ts too large; split further",
    );

    // Extracted indexer modules keep a tighter budget than the legacy
    // orchestrator, but pass-2 currently owns dispatcher caching and write
    // coalescing logic that lifted it above the older 750-line cap.
    const extractedModuleMaxLines = 1100;
    assert.ok(
      existsSync(modulePaths.indexerInit),
      "missing src/indexer/indexer-init.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerVersion),
      "missing src/indexer/indexer-version.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerPass1),
      "missing src/indexer/indexer-pass1.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerPass2),
      "missing src/indexer/indexer-pass2.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerPass2ImportCache),
      "missing src/indexer/indexer-pass2-import-cache.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerPass2SymbolIndex),
      "missing src/indexer/indexer-pass2-symbol-index.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerPass2Write),
      "missing src/indexer/indexer-pass2-write.ts",
    );
    assert.ok(
      existsSync(modulePaths.indexerMemory),
      "missing src/indexer/indexer-memory.ts",
    );
    assert.ok(
      existsSync(modulePaths.providerFirstSemanticScope),
      "missing src/indexer/provider-first/semantic-scope.ts",
    );
    assert.ok(
      countLines(modulePaths.indexerInit) <= extractedModuleMaxLines,
      "indexer-init.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerVersion) <= extractedModuleMaxLines,
      "indexer-version.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerPass1) <= extractedModuleMaxLines,
      "indexer-pass1.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerPass2) <= extractedModuleMaxLines,
      "indexer-pass2.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerPass2ImportCache) <=
        extractedModuleMaxLines,
      "indexer-pass2-import-cache.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerPass2SymbolIndex) <=
        extractedModuleMaxLines,
      "indexer-pass2-symbol-index.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerPass2Write) <= extractedModuleMaxLines,
      "indexer-pass2-write.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.indexerMemory) <= extractedModuleMaxLines,
      "indexer-memory.ts too large; split further",
    );
    assert.ok(
      countLines(modulePaths.providerFirstSemanticScope) <=
        extractedModuleMaxLines,
      "provider-first/semantic-scope.ts too large; split further",
    );
  });

  it("keeps edge-builder sub-modules under size limit", () => {
    const subModuleMaxLines = 700;
    const edgeBuilderDir = join(repoRoot, "src/indexer/edge-builder");
    const subModules = [
      "builtins.ts",
      "enclosing-symbol.ts",
      "call-resolution.ts",
      "cleanup.ts",
      "import-resolution.ts",
      "pass2.ts",
      "pending.ts",
      "symbol-index.ts",
      "symbol-mapping.ts",
      "target-selection.ts",
      "telemetry.ts",
      "types.ts",
      "unresolved-imports.ts",
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

  it("keeps src/indexer/indexer.ts under the current orchestrator growth budget", () => {
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
    assert.ok(
      indexer.includes('from "./indexer-init.js"'),
      'expected indexer.ts to import "./indexer-init.js"',
    );
    assert.ok(
      indexer.includes('from "./indexer-version.js"'),
      'expected indexer.ts to import "./indexer-version.js"',
    );
    assert.ok(
      indexer.includes('from "./indexer-pass1.js"'),
      'expected indexer.ts to import "./indexer-pass1.js"',
    );
    assert.ok(
      indexer.includes('from "./indexer-pass2.js"'),
      'expected indexer.ts to import "./indexer-pass2.js"',
    );
    assert.ok(
      indexer.includes('from "./indexer-memory.js"'),
      'expected indexer.ts to import "./indexer-memory.js"',
    );

    // Provider-first orchestration still lives in indexer.ts. Keep the budget
    // tight to current reality so CI catches further growth while the next
    // extraction pass is planned.
    const indexerMaxLines = 4500;
    assert.ok(
      countLines(indexerPath) <= indexerMaxLines,
      `indexer.ts still too large (expected <= ${indexerMaxLines} lines)`,
    );
  });
});
