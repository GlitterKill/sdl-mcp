import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Context quality benchmark suite.
 *
 * Run:
 *   node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
 *
 * Requires a built dist/ and an indexed "sdl-mcp" repository in the graph DB.
 * Set SDL_CONTEXT_QUALITY_REQUIRE_INDEX=1 to fail instead of skipping when the
 * live benchmark index is unavailable.
 */

const REPO_ID = "sdl-mcp";
const REQUIRE_LIVE_INDEX = process.env.SDL_CONTEXT_QUALITY_REQUIRE_INDEX === "1";
const RUN_SEMANTIC_ONLY =
  process.env.SDL_CONTEXT_QUALITY_VARIANT === "semantic";
const CASE_DETAIL_MODE = process.env.SDL_CONTEXT_QUALITY_CASE_DETAILS;
const INCLUDE_CASE_DETAILS =
  CASE_DETAIL_MODE === "1" || CASE_DETAIL_MODE === "missing";
const INCLUDE_EVIDENCE_DETAILS = CASE_DETAIL_MODE === "1";
const SELECTED_CASE_ID = process.env.SDL_CONTEXT_QUALITY_CASE_ID;

const SEMANTIC_AGGREGATE_RECALL_MIN = 85;
const NOISE_RATE_MAX = 10;
const SCOPED_PRECISE_P95_MAX_MS = 250;

interface BenchmarkCase {
  id: string;
  taskType: "debug" | "explain" | "review" | "implement";
  contextMode: "precise" | "broad";
  taskText: string;
  focusPaths: string[];
  includeTests: boolean;
  requireAnswer: boolean;
  expectedUsefulSymbols: string[];
  unexpectedSymbols: string[];
}

interface Evidence {
  type: string;
  reference: string;
  summary: string;
  timestamp: number;
}

interface ContextResult {
  finalEvidence?: Evidence[];
  success: boolean;
  answer?: string;
}

interface ContextEngineLike {
  buildContext: (task: unknown) => Promise<ContextResult>;
}

interface Variant {
  name: "lexical" | "default" | "semantic";
  semantic?: boolean;
}

interface VariantMetrics {
  name: string;
  cases: number;
  failures: number;
  expectedTotal: number;
  usefulHits: number;
  preciseExpectedTotal: number;
  preciseUsefulHits: number;
  broadExpectedTotal: number;
  broadUsefulHits: number;
  totalEvidenceItems: number;
  noiseHits: number;
  durationsMs: number[];
  caseResults: Array<{
    id: string;
    success: boolean;
    usefulHits: number;
    usefulTotal: number;
    noiseHits: number;
    evidenceCount: number;
    durationMs: number;
    missingUsefulSymbols: string[];
    evidenceSummaries: string[];
  }>;
}

type LadybugModule = typeof import("../../dist/db/ladybug.js");
type LadybugConnection = Awaited<
  ReturnType<LadybugModule["getLadybugConn"]>
>;
type LadybugQueries = typeof import("../../dist/db/ladybug-queries.js");
type PathsModule = typeof import("../../dist/util/paths.js");

const variants: Variant[] = [
  { name: "lexical", semantic: false },
  { name: "default" },
  { name: "semantic", semantic: true },
];

const metrics = {
  totalCases: 0,
  repoAvailable: false,
  availabilityReason: "not checked",
  variants: new Map<string, VariantMetrics>(),
  scopedPrecise: createMetrics("scoped-precise"),
};

let cases: BenchmarkCase[] = [];
let contextEngine: ContextEngineLike | undefined;
let closeLadybugDb: (() => Promise<void>) | undefined;
let ladybugConn: LadybugConnection | undefined;
let ladybugQueries:
  | Pick<
      LadybugQueries,
      "getSymbolsByIds" | "getFilesByIds" | "getFileIdsByRepoPaths"
    >
  | undefined;
let normalizeEvidencePath: PathsModule["normalizePath"] | undefined;

function createMetrics(name: string): VariantMetrics {
  return {
    name,
    cases: 0,
    failures: 0,
    expectedTotal: 0,
    usefulHits: 0,
    preciseExpectedTotal: 0,
    preciseUsefulHits: 0,
    broadExpectedTotal: 0,
    broadUsefulHits: 0,
    totalEvidenceItems: 0,
    noiseHits: 0,
    durationsMs: [],
    caseResults: [],
  };
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[index] ?? 0;
}

function evidenceText(result: ContextResult): string {
  return (result.finalEvidence ?? [])
    .map((e) => `${e.summary ?? ""} ${e.reference ?? ""}`)
    .join(" ");
}

function buildTask(c: BenchmarkCase, variant: Variant, scoped: boolean): unknown {
  const options: Record<string, unknown> = {
    contextMode: c.contextMode,
    includeTests: c.includeTests,
    includeRetrievalEvidence: true,
  };
  if (variant.semantic !== undefined) {
    options.semantic = variant.semantic;
  }
  if (scoped) {
    options.focusPaths = c.focusPaths;
  }
  return {
    taskType: c.taskType,
    taskText: c.taskText,
    repoId: REPO_ID,
    options,
  };
}

async function resolveEvidencePaths(
  evidence: Evidence[],
): Promise<Array<string | undefined>> {
  assert.ok(ladybugConn, "LadybugDB connection must be initialized");
  assert.ok(ladybugQueries, "LadybugDB queries must be initialized");
  assert.ok(normalizeEvidencePath, "Path normalizer must be initialized");

  const references = evidence.map(({ reference }) => {
    if (reference.startsWith("symbol:")) {
      return { symbolId: reference.slice("symbol:".length) };
    }
    if (reference.startsWith("hotpath:")) {
      return { symbolId: reference.slice("hotpath:".length) };
    }
    if (reference.startsWith("file:")) {
      // Skeleton evidence historically used this prefix for a file ID, a
      // repository-relative path, or a symbol ID. Resolve all three shapes in
      // batches so benchmark assertions reflect evidence positions faithfully.
      return { fileReference: reference.slice("file:".length) };
    }
    return {};
  });
  const symbolIds = [
    ...new Set(
      references.flatMap(({ symbolId, fileReference }) =>
        symbolId ? [symbolId] : fileReference ? [fileReference] : [],
      ),
    ),
  ];
  const symbols = await ladybugQueries.getSymbolsByIds(ladybugConn, symbolIds);
  const fileReferences = [
    ...new Set(
      references.flatMap(({ fileReference }) =>
        fileReference ? [fileReference] : [],
      ),
    ),
  ];
  const fileIdsByPath = await ladybugQueries.getFileIdsByRepoPaths(
    ladybugConn,
    REPO_ID,
    fileReferences,
  );
  const fileIds = new Set(fileReferences);
  for (const symbol of symbols.values()) {
    fileIds.add(symbol.fileId);
  }
  for (const fileId of fileIdsByPath.values()) {
    fileIds.add(fileId);
  }
  const files = await ladybugQueries.getFilesByIds(ladybugConn, [...fileIds]);

  return references.map(({ symbolId, fileReference }) => {
    const resolvedFileId = symbolId
      ? symbols.get(symbolId)?.fileId
      : fileReference
        ? files.has(fileReference)
          ? fileReference
          : (symbols.get(fileReference)?.fileId ??
            fileIdsByPath.get(normalizeEvidencePath(fileReference)))
        : undefined;
    const file = resolvedFileId ? files.get(resolvedFileId) : undefined;
    return file ? normalizeEvidencePath(file.relPath) : undefined;
  });
}

function hasResolvablePathReference(evidence: Evidence): boolean {
  return /^(?:symbol|hotpath|file):/.test(evidence.reference);
}

async function runCase(
  c: BenchmarkCase,
  variant: Variant,
  scoped: boolean,
  target: VariantMetrics,
): Promise<void> {
  assert.ok(contextEngine, "ContextEngine must be initialized before benchmarking");
  const startedAt = performance.now();
  let result: ContextResult;
  try {
    result = await contextEngine.buildContext(buildTask(c, variant, scoped));
  } catch {
    target.failures++;
    return;
  }

  const durationMs = performance.now() - startedAt;
  const text = evidenceText(result);
  let usefulHits = 0;
  let noiseHits = 0;

  for (const sym of c.expectedUsefulSymbols) {
    if (text.includes(sym)) usefulHits++;
  }
  for (const sym of c.unexpectedSymbols) {
    if (text.includes(sym)) noiseHits++;
  }

  const evidenceCount = result.finalEvidence?.length ?? 0;
  target.cases++;
  if (!result.success) target.failures++;
  target.expectedTotal += c.expectedUsefulSymbols.length;
  target.usefulHits += usefulHits;
  if (c.contextMode === "precise") {
    target.preciseExpectedTotal += c.expectedUsefulSymbols.length;
    target.preciseUsefulHits += usefulHits;
  } else {
    target.broadExpectedTotal += c.expectedUsefulSymbols.length;
    target.broadUsefulHits += usefulHits;
  }
  target.totalEvidenceItems += evidenceCount;
  target.noiseHits += noiseHits;
  target.durationsMs.push(durationMs);
  target.caseResults.push({
    id: c.id,
    success: result.success,
    usefulHits,
    usefulTotal: c.expectedUsefulSymbols.length,
    noiseHits,
    evidenceCount,
    durationMs,
    missingUsefulSymbols: c.expectedUsefulSymbols.filter(
      (symbol) => !text.includes(symbol),
    ),
    evidenceSummaries: (result.finalEvidence ?? []).map(
      ({ reference, summary }) => `${reference} | ${summary}`,
    ),
  });
}

function recall(m: VariantMetrics): number {
  return percentage(m.usefulHits, m.expectedTotal);
}

function preciseRecall(m: VariantMetrics): number {
  return percentage(m.preciseUsefulHits, m.preciseExpectedTotal);
}

function broadRecall(m: VariantMetrics): number {
  return percentage(m.broadUsefulHits, m.broadExpectedTotal);
}

function noiseRate(m: VariantMetrics): number {
  return percentage(m.noiseHits, m.totalEvidenceItems);
}

function skipOrFail(reason: string): boolean {
  if (REQUIRE_LIVE_INDEX) {
    assert.fail(reason);
  }
  console.warn(`[context-quality] skipped live gate: ${reason}`);
  return true;
}

function buildReport(): string {
  const lines = [
    "",
    "=== Context Quality Benchmark Report ===",
    "",
    `Total cases:       ${metrics.totalCases}`,
    `Repo available:    ${metrics.repoAvailable}`,
    `Availability note: ${metrics.availabilityReason}`,
    "",
  ];

  for (const m of metrics.variants.values()) {
    lines.push(
      `--- Variant: ${m.name} ---`,
      `Cases:       ${m.cases}`,
      `Failures:    ${m.failures}`,
      `Recall:      ${m.usefulHits}/${m.expectedTotal} (${recall(m).toFixed(1)}%)`,
      `Precise:     ${m.preciseUsefulHits}/${m.preciseExpectedTotal} (${preciseRecall(m).toFixed(1)}%)`,
      `Broad:       ${m.broadUsefulHits}/${m.broadExpectedTotal} (${broadRecall(m).toFixed(1)}%)`,
      `Configured noise: ${m.noiseHits}/${m.totalEvidenceItems} (${noiseRate(m).toFixed(1)}%)`,
      `Latency:     p50=${percentile(m.durationsMs, 50).toFixed(0)}ms p95=${percentile(m.durationsMs, 95).toFixed(0)}ms max=${Math.max(0, ...m.durationsMs).toFixed(0)}ms`,
      `Total wall:  ${m.durationsMs.reduce((sum, durationMs) => sum + durationMs, 0).toFixed(0)}ms`,
      "",
    );
    if (INCLUDE_CASE_DETAILS && m.name === "semantic") {
      for (const result of m.caseResults) {
        lines.push(
          `Case ${result.id}: ${result.usefulHits}/${result.usefulTotal}; missing=${result.missingUsefulSymbols.join(",") || "none"}; ${result.durationMs.toFixed(0)}ms`,
        );
        if (INCLUDE_EVIDENCE_DETAILS) {
          for (const evidence of result.evidenceSummaries) {
            lines.push(`  ${evidence}`);
          }
        }
      }
      lines.push("");
    }
  }

  const scoped = metrics.scopedPrecise;
  if (scoped.cases > 0) {
    lines.push(
      "--- Scoped Precise Latency ---",
      `Cases:       ${scoped.cases}`,
      `Failures:    ${scoped.failures}`,
      `Latency:     p50=${percentile(scoped.durationsMs, 50).toFixed(0)}ms p95=${percentile(scoped.durationsMs, 95).toFixed(0)}ms max=${Math.max(0, ...scoped.durationsMs).toFixed(0)}ms`,
      "",
    );
  }
  lines.push("=== End Report ===", "");
  return lines.join("\n");
}

describe("context quality benchmarks", () => {
  before(async () => {
    const casesPath = join(import.meta.dirname, "context-quality-cases.json");
    cases = JSON.parse(readFileSync(casesPath, "utf-8")) as BenchmarkCase[];
    metrics.totalCases = cases.length;

    try {
      const [
        { activateCliConfigPath },
        { loadConfig },
        { initGraphDb },
        ladybug,
        core,
        queries,
        paths,
        engine,
      ] =
        await Promise.all([
          import("../../dist/config/configPath.js"),
          import("../../dist/config/loadConfig.js"),
          import("../../dist/db/initGraphDb.js"),
          import("../../dist/db/ladybug.js"),
          import("../../dist/db/ladybug-core.js"),
          import("../../dist/db/ladybug-queries.js"),
          import("../../dist/util/paths.js"),
          import("../../dist/agent/context-engine.js"),
        ]);
      const configPath = activateCliConfigPath(process.env.SDL_CONFIG);
      const config = loadConfig(configPath);
      const graphDbPath = await initGraphDb(config, configPath);
      closeLadybugDb = ladybug.closeLadybugDb;
      contextEngine = engine.contextEngine;
      ladybugQueries = queries;
      normalizeEvidencePath = paths.normalizePath;

      const conn = await ladybug.getLadybugConn();
      ladybugConn = conn;
      const rows = await core.queryAll(
        conn,
        "MATCH (r:Repo {repoId: $repoId}) RETURN count(r) AS n",
        { repoId: REPO_ID },
      );
      const repoCount = Number(rows[0]?.n ?? 0);
      metrics.repoAvailable = repoCount > 0;
      metrics.availabilityReason = metrics.repoAvailable
        ? `using ${graphDbPath}`
        : `repo ${REPO_ID} is not indexed in ${graphDbPath}`;
    } catch (err) {
      metrics.repoAvailable = false;
      metrics.availabilityReason = err instanceof Error ? err.message : String(err);
    }
  });

  after(async () => {
    await closeLadybugDb?.();
  });

  describe("case structure validation", () => {
    it("loads the expected number of cases", () => {
      assert.equal(cases.length, 26, "Expected 26 benchmark cases");
    });

    it("has correct task type distribution", () => {
      const byType = new Map<string, number>();
      for (const c of cases) {
        byType.set(c.taskType, (byType.get(c.taskType) ?? 0) + 1);
      }
      assert.equal(byType.get("debug"), 8, "Expected 8 debug cases");
      assert.equal(byType.get("explain"), 6, "Expected 6 explain cases");
      assert.equal(byType.get("review"), 8, "Expected 8 review cases");
      assert.equal(byType.get("implement"), 4, "Expected 4 implement cases");
    });

    it("has correct context mode distribution", () => {
      assert.equal(
        cases.filter((c) => c.contextMode === "precise").length,
        13,
        "Expected 13 precise cases",
      );
      assert.equal(
        cases.filter((c) => c.contextMode === "broad").length,
        13,
        "Expected 13 broad cases",
      );
    });

    it("all cases have valid structure", () => {
      for (const c of cases) {
        assert.ok(c.id, "Case missing id");
        assert.ok(c.taskText, `Case ${c.id} missing taskText`);
        assert.ok(
          c.id === "review-broad-sdl-tool-functionality" || c.focusPaths.length > 0,
          `Case ${c.id} needs focusPaths`,
        );
        assert.ok(
          c.expectedUsefulSymbols.length > 0,
          `Case ${c.id} needs expectedUsefulSymbols`,
        );
        assert.ok(
          c.unexpectedSymbols.length > 0,
          `Case ${c.id} needs unexpectedSymbols`,
        );
      }
    });
  });

  it("runs lexical, confidence-gated default, and semantic retrieval variants", async () => {
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }

    const selectedVariants = RUN_SEMANTIC_ONLY
      ? variants.filter(({ name }) => name === "semantic")
      : variants;
    const selectedCases = SELECTED_CASE_ID
      ? cases.filter(({ id }) => id === SELECTED_CASE_ID)
      : cases;
    assert.ok(
      !SELECTED_CASE_ID || selectedCases.length === 1,
      `unknown context quality case: ${SELECTED_CASE_ID}`,
    );
    for (const variant of selectedVariants) {
      const target = createMetrics(variant.name);
      metrics.variants.set(variant.name, target);
      for (const c of selectedCases) {
        await runCase(c, variant, false, target);
      }
    }

    const semantic = metrics.variants.get("semantic");
    assert.ok(semantic, "semantic variant should have metrics");
    assert.equal(semantic.failures, 0, "semantic variant should not fail cases");
    assert.ok(
      recall(semantic) >= SEMANTIC_AGGREGATE_RECALL_MIN,
      `semantic aggregate recall ${recall(semantic).toFixed(1)}% below ${SEMANTIC_AGGREGATE_RECALL_MIN}%`,
    );
    assert.ok(
      noiseRate(semantic) <= NOISE_RATE_MAX,
      `semantic configured-noise rate ${noiseRate(semantic).toFixed(1)}% above ${NOISE_RATE_MAX}%`,
    );
  });

  it("keeps scoped precise lookups below the latency target", async (t) => {
    if (RUN_SEMANTIC_ONLY) {
      t.skip("semantic-only measurement excludes the default scoped gate");
      return;
    }
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }

    const scopedCases = cases.filter((c) => c.contextMode === "precise");
    for (const c of scopedCases) {
      await runCase(c, { name: "default" }, true, metrics.scopedPrecise);
    }

    assert.equal(
      metrics.scopedPrecise.failures,
      0,
      "scoped precise lookups should not fail cases",
    );
    assert.ok(
      percentile(metrics.scopedPrecise.durationsMs, 95) <= SCOPED_PRECISE_P95_MAX_MS,
      `scoped precise p95 ${percentile(metrics.scopedPrecise.durationsMs, 95).toFixed(0)}ms above ${SCOPED_PRECISE_P95_MAX_MS}ms`,
    );
  });

  it("keeps scoped tool-QA evidence inside tests", async () => {
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(contextEngine, "ContextEngine must be initialized before benchmarking");
    const c = cases.find(({ id }) => id === "review-precise-tool-qa-tests");
    assert.ok(c, "Scoped tool-QA benchmark case must exist");

    const result = await contextEngine.buildContext(
      buildTask(c, { name: "default" }, true),
    );
    const evidence = result.finalEvidence ?? [];
    const resolvedByPosition = await resolveEvidencePaths(evidence);
    const unresolvedPathReferences = evidence.filter(
      (item, index) =>
        hasResolvablePathReference(item) && resolvedByPosition[index] === undefined,
    );
    const resolvedPaths = resolvedByPosition.filter(
      (path): path is string => path !== undefined,
    );
    console.log(`[context-quality] Case A resolved paths: ${resolvedPaths.join(", ")}`);

    assert.equal(result.success, true, "Scoped tool-QA lookup should succeed");
    assert.deepEqual(
      unresolvedPathReferences,
      [],
      "Scoped tool-QA path references should all resolve",
    );
    assert.ok(resolvedPaths.length > 0, "Scoped tool-QA evidence should resolve paths");
    assert.ok(
      resolvedPaths.every((path) => path.startsWith("tests/")),
      `Scoped tool-QA evidence escaped tests/: ${resolvedPaths.join(", ")}`,
    );
    for (const area of [
      /workflow/i,
      /usage/i,
      /search-edit/i,
      /delta/i,
      /determinism/i,
    ]) {
      assert.ok(
        resolvedPaths.some((path) => area.test(path)),
        `Scoped tool-QA evidence missed ${area}: ${resolvedPaths.join(", ")}`,
      );
    }
    assert.ok(
      resolvedPaths.filter((path) => path.startsWith("tests/benchmark/")).length <=
        resolvedPaths.length / 2,
      `Benchmark tests dominate scoped tool-QA evidence: ${resolvedPaths.join(", ")}`,
    );
  });

  it("ranks SDL tool implementation ahead of seed evaluation scripts", async () => {
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(contextEngine, "ContextEngine must be initialized before benchmarking");
    const c = cases.find(({ id }) => id === "review-broad-sdl-tool-functionality");
    assert.ok(c, "Broad tool-QA benchmark case must exist");

    const result = await contextEngine.buildContext(
      buildTask(c, { name: "default" }, false),
    );
    const evidence = result.finalEvidence ?? [];
    const resolvedByPosition = await resolveEvidencePaths(evidence);
    const resolvedPaths = resolvedByPosition.filter(
      (path): path is string => path !== undefined,
    );
    const topFiveEvidence = evidence.slice(0, 5);
    const topFive = resolvedByPosition
      .slice(0, 5)
      .filter((path): path is string => path !== undefined);
    console.log(`[context-quality] Case B resolved top 5: ${topFive.join(", ")}`);

    assert.equal(result.success, true, "Broad tool-QA lookup should succeed");
    assert.ok(
      resolvedPaths.some(
        (path) =>
          path === "src/server.ts" ||
          path.startsWith("src/mcp/") ||
          path.startsWith("src/gateway/"),
      ),
      `Broad tool-QA evidence missed SDL tool implementation: ${resolvedPaths.join(", ")}`,
    );
    assert.ok(
      !topFive.includes("scripts/evaluate-seed-resolution.ts") &&
        !topFiveEvidence.some(
          ({ reference }) =>
            reference === "file:scripts/evaluate-seed-resolution.ts",
        ),
      `Seed evaluation script ranked in the top 5: ${topFive.join(", ")}`,
    );
  });

  it("summary report", () => {
    console.log(buildReport());
    assert.equal(metrics.totalCases, 26, "Report should cover all 26 cases");
  });
});
