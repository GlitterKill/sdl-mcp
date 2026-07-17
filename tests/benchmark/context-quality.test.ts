import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const ARTIFACT_PATH = resolve(
  process.env.SDL_CONTEXT_QUALITY_OUTPUT_PATH ??
    ".benchmark/context-quality-results.json",
);

const SEMANTIC_AGGREGATE_RECALL_MIN = 85;
const NOISE_RATE_MAX = 10;
const SCOPED_PRECISE_P95_MAX_MS = 250;
const REPORT_CASE_IDS = new Set([
  "review-precise-tool-qa-tests",
  "review-broad-sdl-tool-functionality",
]);

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
  actionsTaken?: Array<{
    type: string;
  }>;
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
  caseResults: CaseMetrics[];
}

interface CaseMetrics {
  id: string;
  success: boolean;
  answerPresent: boolean;
  usefulHits: number;
  usefulTotal: number;
  noiseHits: number;
  evidenceCount: number;
  durationMs: number;
  missingUsefulSymbols: string[];
  selectedPaths: string[];
  selectedPathsByPosition: Array<string | null>;
  selectedSymbols: string[];
  selectedActions: string[];
  selectedReferences: string[];
  unresolvedPathReferences: string[];
  evidenceSummaries: string[];
}

type LadybugModule = typeof import("../../dist/db/ladybug.js");
type LadybugConnection = Awaited<
  ReturnType<LadybugModule["getLadybugConn"]>
>;
type LadybugQueries = typeof import("../../dist/db/ladybug-queries.js");
type PathsModule = typeof import("../../dist/util/paths.js");
type BenchmarkOutputModule =
  typeof import("../../dist/benchmark/output-file.js");

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
let writeBenchmarkOutput: BenchmarkOutputModule["writeUtf8Output"] | undefined;

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

function createCaseMetrics(overrides: Partial<CaseMetrics> = {}): CaseMetrics {
  return {
    id: "selected-case",
    success: true,
    answerPresent: true,
    usefulHits: 0,
    usefulTotal: 0,
    noiseHits: 0,
    evidenceCount: 0,
    durationMs: 1,
    missingUsefulSymbols: [],
    selectedPaths: [],
    selectedPathsByPosition: [],
    selectedSymbols: [],
    selectedActions: [],
    selectedReferences: [],
    unresolvedPathReferences: [],
    evidenceSummaries: [],
    ...overrides,
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

function shouldScopeCase(c: BenchmarkCase, selectedCase: boolean): boolean {
  return (
    selectedCase && c.contextMode === "precise" && c.focusPaths.length > 0
  );
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

function hasRequiredAnswer(c: BenchmarkCase, result: ContextResult): boolean {
  if (!c.requireAnswer) return true;
  const answer = result.answer?.trim();
  return Boolean(answer && !/\[answer (?:removed|truncated)/i.test(answer));
}

function selectedSymbolIds(evidence: Evidence[]): string[] {
  const selected = evidence.flatMap(({ reference }) => {
    const match = /^(?:symbol|hotpath):(.+)$/.exec(reference);
    return match?.[1] ? [match[1]] : [];
  });
  return [...new Set(selected)];
}

function recordCaseTotals(target: VariantMetrics, c: BenchmarkCase): void {
  target.cases++;
  target.expectedTotal += c.expectedUsefulSymbols.length;
  if (c.contextMode === "precise") {
    target.preciseExpectedTotal += c.expectedUsefulSymbols.length;
  } else {
    target.broadExpectedTotal += c.expectedUsefulSymbols.length;
  }
}

async function runCase(
  c: BenchmarkCase,
  variant: Variant,
  scoped: boolean,
  target: VariantMetrics,
): Promise<void> {
  assert.ok(contextEngine, "ContextEngine must be initialized before benchmarking");
  const startedAt = performance.now();
  recordCaseTotals(target, c);
  let result: ContextResult;
  try {
    result = await contextEngine.buildContext(buildTask(c, variant, scoped));
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    target.failures++;
    target.durationsMs.push(durationMs);
    target.caseResults.push({
      id: c.id,
      success: false,
      answerPresent: !c.requireAnswer,
      usefulHits: 0,
      usefulTotal: c.expectedUsefulSymbols.length,
      noiseHits: 0,
      evidenceCount: 0,
      durationMs,
      missingUsefulSymbols: [...c.expectedUsefulSymbols],
      selectedPaths: [],
      selectedPathsByPosition: [],
      selectedSymbols: [],
      selectedActions: [],
      selectedReferences: [],
      unresolvedPathReferences: [],
      evidenceSummaries: [
        `error | ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
    return;
  }

  const durationMs = performance.now() - startedAt;
  const evidence = result.finalEvidence ?? [];
  const text = evidenceText(result);
  let usefulHits = 0;
  let noiseHits = 0;

  for (const sym of c.expectedUsefulSymbols) {
    if (text.includes(sym)) usefulHits++;
  }
  for (const sym of c.unexpectedSymbols) {
    if (text.includes(sym)) noiseHits++;
  }

  const evidenceCount = evidence.length;
  const answerPresent = hasRequiredAnswer(c, result);
  if (!result.success || !answerPresent) target.failures++;
  target.usefulHits += usefulHits;
  if (c.contextMode === "precise") {
    target.preciseUsefulHits += usefulHits;
  } else {
    target.broadUsefulHits += usefulHits;
  }
  target.totalEvidenceItems += evidenceCount;
  target.noiseHits += noiseHits;
  target.durationsMs.push(durationMs);
  const resolvedByPosition =
    INCLUDE_EVIDENCE_DETAILS && REPORT_CASE_IDS.has(c.id)
      ? await resolveEvidencePaths(evidence)
      : [];
  const selectedPaths = resolvedByPosition.filter(
    (path): path is string => path !== undefined,
  );
  target.caseResults.push({
    id: c.id,
    success: result.success,
    answerPresent,
    usefulHits,
    usefulTotal: c.expectedUsefulSymbols.length,
    noiseHits,
    evidenceCount,
    durationMs,
    missingUsefulSymbols: c.expectedUsefulSymbols.filter(
      (symbol) => !text.includes(symbol),
    ),
    selectedPaths,
    selectedPathsByPosition: resolvedByPosition.map((path) => path ?? null),
    selectedSymbols: selectedSymbolIds(evidence),
    selectedActions: (result.actionsTaken ?? []).map(({ type }) => type),
    selectedReferences: evidence.map(({ reference }) => reference),
    unresolvedPathReferences: INCLUDE_EVIDENCE_DETAILS
      ? evidence.flatMap((item, index) =>
          hasResolvablePathReference(item) &&
          resolvedByPosition[index] === undefined
            ? [item.reference]
            : [],
        )
      : [],
    evidenceSummaries: evidence.map(
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

function assertSemanticQuality(
  semantic: VariantMetrics,
  selectedCase: boolean,
): void {
  assert.equal(semantic.failures, 0, "semantic variant should not fail cases");

  if (selectedCase) {
    assert.equal(
      semantic.caseResults.length,
      1,
      "selected semantic run should produce exactly one case result",
    );
    const result = semantic.caseResults[0];
    assert.ok(result, "selected semantic case result should exist");
    assert.deepEqual(
      result.missingUsefulSymbols,
      [],
      `selected case ${result.id} missing expected evidence: ${result.missingUsefulSymbols.join(", ")}`,
    );
    assert.equal(
      result.noiseHits,
      0,
      `selected case ${result.id} returned configured noise`,
    );
    assert.equal(
      result.answerPresent,
      true,
      `selected case ${result.id} did not preserve its required answer`,
    );
    return;
  }

  assert.ok(
    recall(semantic) >= SEMANTIC_AGGREGATE_RECALL_MIN,
    `semantic aggregate recall ${recall(semantic).toFixed(1)}% below ${SEMANTIC_AGGREGATE_RECALL_MIN}%`,
  );
  assert.ok(
    noiseRate(semantic) <= NOISE_RATE_MAX,
    `semantic configured-noise rate ${noiseRate(semantic).toFixed(1)}% above ${NOISE_RATE_MAX}%`,
  );
}

function assertSelectedReportCase(result: CaseMetrics): void {
  if (result.id === "review-precise-tool-qa-tests") {
    assert.deepEqual(
      result.unresolvedPathReferences,
      [],
      "Scoped tool-QA path references should all resolve",
    );
    assert.ok(
      result.selectedPaths.length > 0,
      "Scoped tool-QA evidence should resolve paths",
    );
    assert.ok(
      result.selectedPaths.every((path) => path.startsWith("tests/")),
      `Scoped tool-QA evidence escaped tests/: ${result.selectedPaths.join(", ")}`,
    );
    for (const area of [
      /workflow/i,
      /usage/i,
      /search-edit/i,
      /delta/i,
      /determinism/i,
    ]) {
      assert.ok(
        result.selectedPaths.some((path) => area.test(path)),
        `Scoped tool-QA evidence missed ${area}: ${result.selectedPaths.join(", ")}`,
      );
    }
    assert.ok(
      result.selectedPaths.filter((path) => path.startsWith("tests/benchmark/"))
        .length <= result.selectedPaths.length / 2,
      `Benchmark tests dominate scoped tool-QA evidence: ${result.selectedPaths.join(", ")}`,
    );
    return;
  }

  if (result.id === "review-broad-sdl-tool-functionality") {
    assert.ok(
      result.selectedPaths.some(
        (path) =>
          path === "src/server.ts" ||
          path.startsWith("src/mcp/") ||
          path.startsWith("src/gateway/"),
      ),
      `Broad tool-QA evidence missed SDL tool implementation: ${result.selectedPaths.join(", ")}`,
    );
    const topFivePaths = result.selectedPathsByPosition
      .slice(0, 5)
      .filter((path): path is string => path !== null);
    assert.ok(
      !topFivePaths.includes("scripts/evaluate-seed-resolution.ts") &&
        !result.selectedReferences
          .slice(0, 5)
          .includes("file:scripts/evaluate-seed-resolution.ts"),
      `Seed evaluation script ranked in the top 5: ${topFivePaths.join(", ")}`,
    );
  }
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

function caseMetricsForArtifact(result: CaseMetrics): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: result.id,
    success: result.success,
    answerPresent: result.answerPresent,
    usefulHits: result.usefulHits,
    usefulTotal: result.usefulTotal,
    noiseHits: result.noiseHits,
    evidenceCount: result.evidenceCount,
    durationMs: result.durationMs,
    missingUsefulSymbols: result.missingUsefulSymbols,
  };
  if (INCLUDE_EVIDENCE_DETAILS) {
    base.selectedPaths = result.selectedPaths;
    base.selectedPathsByPosition = result.selectedPathsByPosition;
    base.selectedSymbols = result.selectedSymbols;
    base.selectedActions = result.selectedActions;
    base.selectedReferences = result.selectedReferences;
    base.unresolvedPathReferences = result.unresolvedPathReferences;
    base.evidenceSummaries = result.evidenceSummaries;
  }
  return base;
}

function variantMetricsForArtifact(m: VariantMetrics): Record<string, unknown> {
  return {
    name: m.name,
    cases: m.cases,
    failures: m.failures,
    expectedTotal: m.expectedTotal,
    usefulHits: m.usefulHits,
    recallPercent: recall(m),
    preciseRecallPercent: preciseRecall(m),
    broadRecallPercent: broadRecall(m),
    totalEvidenceItems: m.totalEvidenceItems,
    noiseHits: m.noiseHits,
    noiseRatePercent: noiseRate(m),
    latencyMs: {
      p50: percentile(m.durationsMs, 50),
      p95: percentile(m.durationsMs, 95),
      max: Math.max(0, ...m.durationsMs),
      total: m.durationsMs.reduce((sum, durationMs) => sum + durationMs, 0),
    },
    caseResults: m.caseResults.map(caseMetricsForArtifact),
  };
}

function persistBenchmarkArtifact(): void {
  if (!writeBenchmarkOutput || !shouldPersistBenchmarkArtifact()) return;
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  const artifact = {
    schemaVersion: 1,
    benchmark: "context-quality",
    repoId: REPO_ID,
    corpusCaseCount: metrics.totalCases,
    selectedCaseId: SELECTED_CASE_ID ?? null,
    requestedVariant: RUN_SEMANTIC_ONLY ? "semantic" : "all",
    detailMode: INCLUDE_EVIDENCE_DETAILS
      ? "evidence"
      : INCLUDE_CASE_DETAILS
        ? "missing"
        : "none",
    repoAvailable: metrics.repoAvailable,
    availabilityReason: metrics.availabilityReason,
    thresholds: {
      semanticAggregateRecallMinPercent: SEMANTIC_AGGREGATE_RECALL_MIN,
      semanticNoiseRateMaxPercent: NOISE_RATE_MAX,
      scopedPreciseP95MaxMs: SCOPED_PRECISE_P95_MAX_MS,
    },
    variants: [...metrics.variants.values()].map(variantMetricsForArtifact),
    scopedPrecise:
      metrics.scopedPrecise.cases > 0
        ? variantMetricsForArtifact(metrics.scopedPrecise)
        : null,
  };
  writeBenchmarkOutput(
    ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "overwrite",
  );
  console.log(`[context-quality] artifact: ${ARTIFACT_PATH}`);
}

function shouldPersistBenchmarkArtifact(
  repoAvailable = metrics.repoAvailable,
): boolean {
  return repoAvailable;
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
        benchmarkOutput,
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
          import("../../dist/benchmark/output-file.js"),
        ]);
      writeBenchmarkOutput = benchmarkOutput.writeUtf8Output;
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
    try {
      persistBenchmarkArtifact();
    } finally {
      await closeLadybugDb?.();
    }
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

    it("keeps the broad and precise tool-QA report cases stable", () => {
      const precise = cases.find(
        ({ id }) => id === "review-precise-tool-qa-tests",
      );
      const broad = cases.find(
        ({ id }) => id === "review-broad-sdl-tool-functionality",
      );

      assert.deepEqual(precise?.focusPaths, ["tests"]);
      assert.equal(precise?.contextMode, "precise");
      assert.equal(precise?.includeTests, true);
      assert.deepEqual(broad?.focusPaths, []);
      assert.equal(broad?.contextMode, "broad");
      assert.equal(broad?.requireAnswer, true);
    });
  });

  describe("semantic gate selection", () => {
    it("uses one selected case's own expectations instead of aggregate recall", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.expectedTotal = 10;
      semantic.usefulHits = 0;
      semantic.caseResults.push(createCaseMetrics({
        usefulTotal: 10,
        evidenceCount: 1,
      }));

      assert.doesNotThrow(() => assertSemanticQuality(semantic, true));
    });

    it("rejects a selected case that misses its own expected evidence", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.caseResults.push(createCaseMetrics({
        usefulTotal: 1,
        missingUsefulSymbols: ["requiredSymbol"],
      }));

      assert.throws(
        () => assertSemanticQuality(semantic, true),
        /missing expected evidence.*requiredSymbol/i,
      );
    });

    it("rejects a selected case that loses a required answer", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.caseResults.push(createCaseMetrics({
        answerPresent: false,
        usefulHits: 1,
        usefulTotal: 1,
        evidenceCount: 1,
      }));

      assert.throws(
        () => assertSemanticQuality(semantic, true),
        /did not preserve its required answer/i,
      );
    });

    it("retains aggregate recall gates for the full suite", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 26;
      semantic.expectedTotal = 100;
      semantic.usefulHits = 84;

      assert.throws(
        () => assertSemanticQuality(semantic, false),
        /aggregate recall 84\.0% below 85%/i,
      );
    });

    it("scopes only selected precise cases with explicit focus paths", () => {
      const precise = cases.find(
        ({ id }) => id === "review-precise-tool-qa-tests",
      );
      const broad = cases.find(
        ({ id }) => id === "review-broad-sdl-tool-functionality",
      );
      assert.ok(precise);
      assert.ok(broad);

      assert.equal(shouldScopeCase(precise, true), true);
      assert.equal(shouldScopeCase(precise, false), false);
      assert.equal(shouldScopeCase(broad, true), false);
    });

    it("validates the same detailed precise result written to the artifact", () => {
      const selectedPaths = [
        "tests/workflow-tool.test.ts",
        "tests/usage-stats.test.ts",
        "tests/search-edit-tool.test.ts",
        "tests/delta-signature.test.ts",
        "tests/determinism.test.ts",
      ];
      const result = createCaseMetrics({
        id: "review-precise-tool-qa-tests",
        selectedPaths,
        selectedPathsByPosition: selectedPaths,
      });

      assert.doesNotThrow(() => assertSelectedReportCase(result));
    });

    it("does not persist skip-only benchmark results", () => {
      assert.equal(shouldPersistBenchmarkArtifact(false), false);
      assert.equal(shouldPersistBenchmarkArtifact(true), true);
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
        const scopedSelectedCase = shouldScopeCase(
          c,
          SELECTED_CASE_ID !== undefined,
        );
        await runCase(c, variant, scopedSelectedCase, target);
      }
    }

    const semantic = metrics.variants.get("semantic");
    assert.ok(semantic, "semantic variant should have metrics");
    assertSemanticQuality(semantic, SELECTED_CASE_ID !== undefined);
    if (
      SELECTED_CASE_ID &&
      INCLUDE_EVIDENCE_DETAILS &&
      REPORT_CASE_IDS.has(SELECTED_CASE_ID)
    ) {
      const selectedResult = semantic.caseResults[0];
      assert.ok(selectedResult, "selected report case result should exist");
      assertSelectedReportCase(selectedResult);
    }
  });

  it("keeps scoped precise lookups below the latency target", async (t) => {
    if (RUN_SEMANTIC_ONLY || SELECTED_CASE_ID) {
      t.skip(
        "semantic-only and selected-case measurements exclude the default scoped gate",
      );
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

  it("keeps scoped tool-QA evidence inside tests", async (t) => {
    if (RUN_SEMANTIC_ONLY || SELECTED_CASE_ID) {
      t.skip(
        "semantic-only and selected-case runs validate the primary invocation",
      );
      return;
    }
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
    if (INCLUDE_CASE_DETAILS) {
      console.log(
        `[context-quality] Case A resolved paths: ${resolvedPaths.join(", ")}`,
      );
    }

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

  it("ranks SDL tool implementation ahead of seed evaluation scripts", async (t) => {
    if (RUN_SEMANTIC_ONLY || SELECTED_CASE_ID) {
      t.skip(
        "semantic-only and selected-case runs validate the primary invocation",
      );
      return;
    }
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
    if (INCLUDE_CASE_DETAILS) {
      console.log(
        `[context-quality] Case B resolved top 5: ${topFive.join(", ")}`,
      );
    }

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
