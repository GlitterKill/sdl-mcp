import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

type BenchmarkCorpus = "sdl-mcp" | "neutral";

class BenchmarkProvenanceError extends Error {}

function parseBenchmarkCorpus(value: string | undefined): BenchmarkCorpus {
  const corpus = value ?? "sdl-mcp";
  if (corpus !== "sdl-mcp" && corpus !== "neutral") {
    throw new BenchmarkProvenanceError(
      `Unknown context quality corpus: ${corpus}`,
    );
  }
  return corpus;
}

function verifyPinnedCheckoutSha(
  repoRoot: string,
  expectedSha: string,
): string {
  let actualSha: string;
  try {
    actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
      .trim()
      .toLowerCase();
  } catch (error) {
    throw new BenchmarkProvenanceError(
      `Unable to resolve context benchmark checkout HEAD for ${repoRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const normalizedExpectedSha = expectedSha.toLowerCase();
  if (actualSha !== normalizedExpectedSha) {
    throw new BenchmarkProvenanceError(
      `Context benchmark checkout HEAD mismatch for ${repoRoot}: expected ${normalizedExpectedSha}, actual ${actualSha}`,
    );
  }
  return actualSha;
}

const CORPUS = parseBenchmarkCorpus(process.env.SDL_CONTEXT_QUALITY_CORPUS);
const REPO_ID = process.env.SDL_CONTEXT_QUALITY_REPO_ID ?? "sdl-mcp";
const REQUIRE_LIVE_INDEX =
  process.env.SDL_CONTEXT_QUALITY_REQUIRE_INDEX === "1";
const REQUIRE_PROVIDER_CONTEXT_CARD_INVARIANT =
  process.env.SDL_CONTEXT_QUALITY_REQUIRE_PROVIDER_INVARIANT === "1";
const RUN_SEMANTIC_ONLY =
  process.env.SDL_CONTEXT_QUALITY_VARIANT === "semantic";
const RUN_V2_SHADOW = process.env.SDL_CONTEXT_QUALITY_V2_SHADOW === "1";
const CANONICAL_V2_PROBE_OUTPUT_PATH = process.env
  .SDL_CONTEXT_QUALITY_CANONICAL_V2_PROBE_OUTPUT
  ? resolve(process.env.SDL_CONTEXT_QUALITY_CANONICAL_V2_PROBE_OUTPUT)
  : undefined;
const CASE_DETAIL_MODE = process.env.SDL_CONTEXT_QUALITY_CASE_DETAILS;
const INCLUDE_CASE_DETAILS =
  CASE_DETAIL_MODE === "1" || CASE_DETAIL_MODE === "missing";
const INCLUDE_EVIDENCE_DETAILS = CASE_DETAIL_MODE === "1";
const SELECTED_CASE_ID = process.env.SDL_CONTEXT_QUALITY_CASE_ID;
const RECORD_BASELINE = process.env.SDL_CONTEXT_QUALITY_RECORD_BASELINE === "1";
const ARTIFACT_PATH = resolve(
  process.env.SDL_CONTEXT_QUALITY_OUTPUT_PATH ??
    ".benchmark/context-quality-results.json",
);

const PINNED_REPO_SHA =
  process.env.SDL_CONTEXT_QUALITY_REPO_SHA ??
  "fcf4f2e11c5a1bb9b301a245af42b28556414b8e";

const SEMANTIC_AGGREGATE_RECALL_MIN = 85;
const NOISE_RATE_MAX = 10;
const SCOPED_PRECISE_P95_MAX_MS = 250;
const PAIRED_LATENCY_WARMUP_RUNS = 1;
const PAIRED_LATENCY_SAMPLE_RUNS = 3;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 50_000;
const REPORT_CASE_IDS = new Set([
  "review-precise-tool-qa-tests",
  "review-broad-sdl-tool-functionality",
  "review-broad-tool-contract-relevance",
]);

interface BenchmarkCase {
  id: string;
  corpus?: BenchmarkCorpus;
  budgetTokens?: number;
  chatMentions?: string[];
  sourcePlanCitations?: string[];
  primarySymbol?: string;
  requiredSymbols?: string[];
  usefulSymbols?: string[];
  negativeSymbols?: string[];
  negativePaths?: string[];
  v2HardFloor?: V2HardFloorLabels;
  taskType: "debug" | "explain" | "review" | "implement";
  contextMode: "precise" | "broad";
  taskText: string;
  focusPaths: string[];
  includeTests: boolean;
  requireAnswer: boolean;
  expectedUsefulSymbols?: string[];
  unexpectedSymbols?: string[];
}

interface V2HardFloorLabels {
  prioritySymbols: string[];
  unrelatedSymbols: string[];
  codeBearingSymbols: string[];
}

function assertBenchmarkCasesSelected(
  corpus: BenchmarkCorpus,
  selectedCases: readonly BenchmarkCase[],
): void {
  if (selectedCases.length === 0) {
    throw new BenchmarkProvenanceError(
      `No context quality cases selected for corpus ${corpus}`,
    );
  }
}

interface Evidence {
  type: string;
  reference: string;
  path?: string;
  summary: string;
  timestamp: number;
}

interface ContextResult {
  finalEvidence?: Evidence[];
  evidence?: unknown[];
  benchmarkEvidence?: unknown[];
  success: boolean;
  pureEvidence?: boolean;
  answer?: string;
  actionsTaken?: Array<{
    type: string;
  }>;
}

interface NormalizedCaseMetrics {
  requiredHits: number;
  requiredSymbolRecallPercent: number;
  primarySymbolReciprocalRank: number;
  evidenceTokens: number;
  explicitNoiseTokens: number;
  explicitNoiseTokenRatio: number;
  evidenceTokensPerRequiredHit: number | null;
  rankedSymbols: string[];
  codeBearingSymbols: string[];
}

interface RelevanceCaseMetrics extends NormalizedCaseMetrics {
  budgetTokens: number;
  sourcePlanCitations: string[];
  primarySymbol: string;
  requiredSymbols: string[];
  usefulSymbols: string[];
  negativeSymbols: string[];
  negativePaths: string[];
  v2HardFloor: V2HardFloorLabels | null;
}

interface ContextEngineLike {
  buildContext: (task: unknown) => Promise<ContextResult>;
}

type ContextV2Request = import("../../dist/context/types.js").ContextV2Request;
type ContextEngineV2Result =
  import("../../dist/context/types.js").ContextEngineV2Result;
type ContextPayload = import("../../dist/context/types.js").ContextPayload;
type ContextCandidate = import("../../dist/context/types.js").ContextCandidate;
type RetrievalCapabilities =
  import("../../dist/retrieval/types.js").RetrievalCapabilities;
type RetrievalLaneOutcome =
  import("../../dist/retrieval/types.js").RetrievalLaneOutcome;

interface ContextEngineV2Like {
  buildContext: (request: ContextV2Request) => Promise<ContextEngineV2Result>;
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
  relevance?: RelevanceCaseMetrics;
}

interface ProviderContextCardInvariantMetrics {
  requested: boolean;
  status: "not_requested" | "pending" | "passed";
  graphIntegrityState: string | null;
  graphIntegrityVersionId: string | null;
  graphIntegrityDigest: string | null;
  checkedSymbolIds: string[];
  providerBackedSymbolIds: string[];
}

type LadybugModule = typeof import("../../dist/db/ladybug.js");
type LadybugConnection = Awaited<ReturnType<LadybugModule["getLadybugConn"]>>;
type LadybugQueries = typeof import("../../dist/db/ladybug-queries.js");
type PathsModule = typeof import("../../dist/util/paths.js");
type BenchmarkOutputModule =
  typeof import("../../dist/benchmark/output-file.js");
type ContextToolsModule = typeof import("../../dist/mcp/tools/context.js");
type SymbolToolsModule = typeof import("../../dist/mcp/tools/symbol.js");
type DerivedStateModule =
  typeof import("../../dist/db/ladybug-derived-state.js");

const variants: Variant[] = [{ name: "semantic" }];

const metrics = {
  manifest: undefined as ReturnType<typeof buildBenchmarkManifest> | undefined,
  totalCases: 0,
  repoAvailable: false,
  availabilityReason: "not checked",
  variants: new Map<string, VariantMetrics>(),
  v2Shadow: createMetrics("v2-shadow"),
  pairedLatency: undefined as
    | Awaited<ReturnType<typeof measureV2LatencyAgainstCommittedBaseline>>
    | undefined,
  scopedPrecise: createMetrics("scoped-precise"),
  providerContextCardInvariant: {
    requested: REQUIRE_PROVIDER_CONTEXT_CARD_INVARIANT,
    status: REQUIRE_PROVIDER_CONTEXT_CARD_INVARIANT
      ? "pending"
      : "not_requested",
    graphIntegrityState: null,
    graphIntegrityVersionId: null,
    graphIntegrityDigest: null,
    checkedSymbolIds: [],
    providerBackedSymbolIds: [],
  } satisfies ProviderContextCardInvariantMetrics,
};

let allCases: BenchmarkCase[] = [];
let cases: BenchmarkCase[] = [];
let contextEngine: ContextEngineLike | undefined;
let rawContextEngineV2: ContextEngineV2Like | undefined;
type CloseLadybugDb = (options?: { strict?: boolean }) => Promise<void>;

let closeLadybugDb: CloseLadybugDb | undefined;
let ladybugClosedBeforeArtifact = false;
let ladybugConn: LadybugConnection | undefined;
let ladybugQueries:
  | Pick<
      LadybugQueries,
      | "getSymbolsByIds"
      | "getFilesByIds"
      | "getFileIdsByRepoPaths"
      | "getLatestVersion"
    >
  | undefined;
let normalizeEvidencePath: PathsModule["normalizePath"] | undefined;
let writeBenchmarkOutput: BenchmarkOutputModule["writeUtf8Output"] | undefined;
let handleAgentContext: ContextToolsModule["handleAgentContext"] | undefined;
let handleSymbolGetCard: SymbolToolsModule["handleSymbolGetCard"] | undefined;
let getDerivedState: DerivedStateModule["getDerivedState"] | undefined;

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

function expectedSymbols(c: BenchmarkCase): string[] {
  return c.expectedUsefulSymbols ?? c.requiredSymbols ?? c.usefulSymbols ?? [];
}

function noiseSymbols(c: BenchmarkCase): string[] {
  return c.unexpectedSymbols ?? c.negativeSymbols ?? [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface CommittedV1Baseline {
  relevance: {
    requiredSymbolRecallPercent: number;
    primarySymbolMrr: number;
    explicitNoiseTokenRatio: number;
    evidenceTokensPerRequiredHit: number | null;
  };
  latencyP50Ms: number;
  latencyP95Ms: number;
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BenchmarkProvenanceError(
      `Committed V1 baseline is missing ${label}.${key}`,
    );
  }
  return value;
}

function loadCommittedV1Baseline(
  corpus: BenchmarkCorpus,
): CommittedV1Baseline {
  const path = resolve(
    import.meta.dirname,
    "../../devdocs/benchmarks/context-quality-v1-baseline.json",
  );
  const root = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(root) || root.engine !== "v1" || !isRecord(root.corpora)) {
    throw new BenchmarkProvenanceError("Invalid committed V1 baseline artifact");
  }
  const artifact = root.corpora[corpus];
  if (!isRecord(artifact) || !Array.isArray(artifact.variants)) {
    throw new BenchmarkProvenanceError(
      `Committed V1 baseline has no ${corpus} corpus`,
    );
  }
  const semantic = artifact.variants.find(
    (variant) => isRecord(variant) && variant.name === "semantic",
  );
  if (!isRecord(semantic) || !isRecord(semantic.relevance)) {
    throw new BenchmarkProvenanceError(
      `Committed V1 baseline has no ${corpus} semantic relevance metrics`,
    );
  }
  const pairedLatency = artifact.pairedLatency;
  if (
    !isRecord(pairedLatency) ||
    !isRecord(pairedLatency.baseline)
  ) {
    throw new BenchmarkProvenanceError(
      `Committed V1 baseline has no ${corpus} latency metrics`,
    );
  }
  const evidenceTokensPerRequiredHit =
    semantic.relevance.evidenceTokensPerRequiredHit;
  if (
    evidenceTokensPerRequiredHit !== null &&
    typeof evidenceTokensPerRequiredHit !== "number"
  ) {
    throw new BenchmarkProvenanceError(
      `Committed V1 baseline has invalid ${corpus} evidenceTokensPerRequiredHit`,
    );
  }
  return {
    relevance: {
      requiredSymbolRecallPercent: requiredNumber(
        semantic.relevance,
        "requiredSymbolRecallPercent",
        `${corpus}.semantic.relevance`,
      ),
      primarySymbolMrr: requiredNumber(
        semantic.relevance,
        "primarySymbolMrr",
        `${corpus}.semantic.relevance`,
      ),
      explicitNoiseTokenRatio: requiredNumber(
        semantic.relevance,
        "explicitNoiseTokenRatio",
        `${corpus}.semantic.relevance`,
      ),
      evidenceTokensPerRequiredHit,
    },
    latencyP50Ms: requiredNumber(
      pairedLatency.baseline,
      "p50Ms",
      `${corpus}.pairedLatency.baseline`,
    ),
    latencyP95Ms: requiredNumber(
      pairedLatency.baseline,
      "p95Ms",
      `${corpus}.pairedLatency.baseline`,
    ),
  };
}

const committedV1Baseline = loadCommittedV1Baseline(CORPUS);

const SUCCESSFUL_CONTEXT_RETRIEVAL_LEVELS = [
  "hybrid",
  "hybrid-partial",
  "lexical",
  "graph-only",
] as const satisfies readonly ContextPayload["retrieval"]["level"][];

function isContextPayload(
  result: ContextEngineV2Result,
): result is ContextPayload {
  return !("isError" in result);
}

function stableBenchmarkJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    isRecord(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

async function assertCanonicalV2PayloadDeterminism(
  engine: ContextEngineV2Like,
  benchmarkCase: BenchmarkCase,
): Promise<Record<string, string>> {
  const request: ContextV2Request = {
    repoId: REPO_ID,
    taskType: benchmarkCase.taskType,
    taskText: benchmarkCase.taskText,
    budget: {
      maxTokens: benchmarkCase.budgetTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    },
    focusPaths: benchmarkCase.focusPaths,
    chatMentions: benchmarkCase.chatMentions,
    includeTests: benchmarkCase.includeTests,
  };
  const first = await engine.buildContext(request);
  const second = await engine.buildContext(request);
  assert.ok(
    isContextPayload(first),
    "first V2 determinism result must be a payload",
  );
  assert.ok(
    isContextPayload(second),
    "second V2 determinism result must be a payload",
  );

  const { serializeContextPayload } =
    await import("../../dist/context/serialize.js");
  const firstBytes = serializeContextPayload(first);
  const secondBytes = serializeContextPayload(second);
  assert.equal(
    secondBytes,
    firstBytes,
    `canonical V2 bytes changed across repeated live ${first.retrieval.level} retrieval`,
  );
  return {
    live: firstBytes,
    ...(await serializeControlledV2DegradationResults(request)),
  };
}

async function serializeControlledV2DegradationResults(
  request: ContextV2Request,
): Promise<Record<string, string>> {
  const { ContextEngineV2, buildRetrievalState } =
    await import("../../dist/context/engine.js");
  const { serializeContextPayload } =
    await import("../../dist/context/serialize.js");
  const noCapabilities: RetrievalCapabilities = {
    fts: false,
    fileSummaryFts: false,
    vectorNomic: false,
    vectorJinaCode: false,
    coveragePermille: {
      symbolVector: 0,
      fileSummaryVector: 0,
    },
  };
  const hybridCapabilities: RetrievalCapabilities = {
    ...noCapabilities,
    fts: true,
    vectorNomic: true,
    coveragePermille: {
      symbolVector: 1000,
      fileSummaryVector: 0,
    },
  };
  const succeeded: RetrievalLaneOutcome = {
    available: true,
    attempted: true,
    succeeded: true,
    failed: false,
  };
  const failed: RetrievalLaneOutcome = {
    available: true,
    attempted: true,
    succeeded: false,
    failed: true,
  };
  const exactCandidate: ContextCandidate = {
    symbolId: "controlled-exact",
    path: "src/controlled-exact.ts",
    rank: 1,
    tier: 0,
    lanes: ["exactIdentifier"],
    estimates: { card: 10, skeleton: 20, hotPath: 30 },
  };
  const scenarios = [
    {
      level: "hybrid",
      capabilities: hybridCapabilities,
      candidates: [],
      outcomes: new Map<string, RetrievalLaneOutcome>([
        ["symbol:fts", succeeded],
        ["symbol:vector:nomic", succeeded],
      ]),
    },
    {
      level: "hybrid-partial",
      capabilities: hybridCapabilities,
      candidates: [],
      outcomes: new Map<string, RetrievalLaneOutcome>([
        ["symbol:fts", succeeded],
        ["symbol:vector:nomic", failed],
      ]),
    },
    {
      level: "lexical",
      capabilities: { ...noCapabilities, fts: true },
      candidates: [],
      outcomes: new Map<string, RetrievalLaneOutcome>([
        ["symbol:fts", succeeded],
      ]),
    },
    {
      level: "graph-only",
      capabilities: noCapabilities,
      candidates: [exactCandidate],
      outcomes: new Map<string, RetrievalLaneOutcome>(),
    },
    {
      level: "insufficient",
      capabilities: { ...noCapabilities, fts: true },
      candidates: [],
      outcomes: new Map<string, RetrievalLaneOutcome>([
        ["symbol:fts", failed],
      ]),
    },
  ] as const;
  const serialized: Record<string, string> = {};

  for (const scenario of scenarios) {
    const controlledEngine = new ContextEngineV2({
      runReadSnapshot: async (_repoId, fn) => fn({}),
      retrieve: async (_request, profile, runtime) => {
        const retrieval = buildRetrievalState(
          scenario.capabilities,
          scenario.candidates,
          scenario.outcomes,
          profile,
        );
        assert.equal(retrieval.level, scenario.level);
        return {
          ...retrieval,
          candidates: [...scenario.candidates],
          runtime,
        };
      },
      expand: async ({ candidates }) => [...candidates],
      prepareHydration: async ({ selected }) => ({
        selected: Object.freeze([...selected]),
        cards: Object.freeze([]),
        durableEdges: new Map(),
        skeletons: new Map(),
        hotPaths: new Map(),
        overlaySnapshot: {
          repoId: request.repoId,
          touchedFileIds: new Set(),
          symbolsById: new Map(),
          filesById: new Map(),
          outgoingEdgesBySymbolId: new Map(),
        },
      }),
      hydrate: async ({ selected }) => ({
        evidence: selected.flatMap(({ candidate, rungs }) =>
          rungs.map((rung) => ({
            rung,
            symbolId: candidate.symbolId,
            path: candidate.path,
            rank: candidate.rank,
            tier: candidate.tier,
            lanes: candidate.lanes,
            content: `controlled ${rung}`,
          })),
        ),
        edges: [],
        unavailable: [],
      }),
    });
    const first = await controlledEngine.buildContext(request);
    const second = await controlledEngine.buildContext(request);
    let firstBytes: string;
    let secondBytes: string;

    if (scenario.level === "insufficient") {
      assert.equal(isContextPayload(first), false);
      assert.equal(isContextPayload(second), false);
      if (isContextPayload(first) || isContextPayload(second)) {
        throw new Error("insufficient retrieval returned a successful payload");
      }
      assert.equal(first.error.code, "CONTEXT_RETRIEVAL_BACKEND_FAILED");
      assert.equal(second.error.code, "CONTEXT_RETRIEVAL_BACKEND_FAILED");
      firstBytes = stableBenchmarkJson(first);
      secondBytes = stableBenchmarkJson(second);
    } else {
      assert.ok(isContextPayload(first));
      assert.ok(isContextPayload(second));
      assert.equal(first.retrieval.level, scenario.level);
      assert.equal(second.retrieval.level, scenario.level);
      firstBytes = serializeContextPayload(first);
      secondBytes = serializeContextPayload(second);
    }
    assert.equal(
      secondBytes,
      firstBytes,
      `canonical V2 bytes changed across repeated ${scenario.level} retrieval`,
    );
    serialized[scenario.level] = firstBytes;
  }
  return serialized;
}

function createV2BenchmarkAdapter(
  engine: ContextEngineV2Like,
): ContextEngineLike {
  return {
    buildContext: async (task) => {
      if (!isRecord(task))
        throw new TypeError("benchmark task must be an object");
      const budget = isRecord(task.budget) ? task.budget : {};
      if (
        typeof task.repoId !== "string" ||
        typeof task.taskText !== "string" ||
        !["debug", "explain", "review", "implement"].includes(
          String(task.taskType),
        )
      ) {
        throw new TypeError(
          "benchmark task is missing required context fields",
        );
      }
      const stringArray = (value: unknown): string[] | undefined =>
        Array.isArray(value) && value.every((item) => typeof item === "string")
          ? value
          : undefined;
      const request: ContextV2Request = {
        repoId: task.repoId,
        taskType: task.taskType as ContextV2Request["taskType"],
        taskText: task.taskText,
        budget: {
          maxTokens:
            typeof budget.maxTokens === "number"
              ? budget.maxTokens
              : DEFAULT_CONTEXT_TOKEN_BUDGET,
        },
        ...(stringArray(task.focusPaths)
          ? { focusPaths: stringArray(task.focusPaths) }
          : {}),
        ...(stringArray(task.focusSymbols)
          ? { focusSymbols: stringArray(task.focusSymbols) }
          : {}),
        ...(stringArray(task.chatMentions)
          ? { chatMentions: stringArray(task.chatMentions) }
          : {}),
        ...(typeof task.includeTests === "boolean"
          ? { includeTests: task.includeTests }
          : {}),
      };
      const v2Result = await engine.buildContext(request);
      const resultRecord = isRecord(v2Result) ? v2Result : {};
      const rawEvidence = Array.isArray(resultRecord.evidence)
        ? resultRecord.evidence
        : [];
      const finalEvidence = rawEvidence.flatMap((raw): Evidence[] => {
        if (!isRecord(raw) || typeof raw.symbolId !== "string") return [];
        const rung = typeof raw.rung === "string" ? raw.rung : "card";
        return [
          {
            type: rung,
            reference: `${rung === "hotPath" ? "hotpath" : "symbol"}:${raw.symbolId}`,
            ...(typeof raw.path === "string" ? { path: raw.path } : {}),
            summary: JSON.stringify(raw.content) ?? "",
            timestamp: 0,
          },
        ];
      });
      const errorRecord = isRecord(resultRecord.error)
        ? resultRecord.error
        : {};
      const rawActions =
        resultRecord.isError === true
          ? Array.isArray(errorRecord.recovery)
            ? errorRecord.recovery
            : []
          : Array.isArray(resultRecord.nextActions)
            ? resultRecord.nextActions
            : [];
      const actionsTaken = rawActions.flatMap(
        (raw): Array<{ type: string }> =>
          isRecord(raw) && typeof raw.id === "string" ? [{ type: raw.id }] : [],
      );
      return {
        success: resultRecord.isError !== true,
        pureEvidence: true,
        evidence: rawEvidence,
        benchmarkEvidence: rawEvidence,
        finalEvidence,
        actionsTaken,
      };
    },
  };
}

let estimateBenchmarkTokens = (text: string): number =>
  Math.ceil(text.length / 4);

function benchmarkEvidenceItems(input: unknown): Record<string, unknown>[] {
  const result = isRecord(input) ? input : {};
  const evidence = Array.isArray(result.benchmarkEvidence)
    ? result.benchmarkEvidence
    : Array.isArray(result.finalEvidence)
      ? result.finalEvidence
      : Array.isArray(result.evidence)
        ? result.evidence
        : [];
  return evidence.map((item) => (isRecord(item) ? item : {}));
}

function benchmarkEvidenceSymbolIds(input: unknown): string[] {
  return [
    ...new Set(
      benchmarkEvidenceItems(input).flatMap((item) => {
        if (typeof item.symbolId === "string") return [item.symbolId];
        const reference =
          typeof item.reference === "string" ? item.reference : "";
        const id = /^(?:symbol|hotpath):(.+)$/.exec(reference)?.[1];
        return id ? [id] : [];
      }),
    ),
  ];
}

function normalizeBenchmarkResult(
  input: unknown,
  symbolNames: ReadonlyMap<string, string>,
  resolvedPaths: readonly (string | undefined)[],
) {
  const rawEvidence = benchmarkEvidenceItems(input);
  const evidence = rawEvidence.map((raw, index) => {
    const item = isRecord(raw) ? raw : {};
    const reference = typeof item.reference === "string" ? item.reference : "";
    const referenceId = /^(?:symbol|hotpath|file):(.+)$/.exec(reference)?.[1];
    const candidateId =
      typeof item.symbolId === "string" ? item.symbolId : referenceId;
    const symbolId =
      candidateId && symbolNames.has(candidateId) ? candidateId : null;
    const rung =
      typeof item.rung === "string"
        ? item.rung
        : typeof item.type === "string"
          ? item.type
          : reference.startsWith("hotpath:")
            ? "hotPath"
            : null;
    return {
      symbolName: symbolId ? (symbolNames.get(symbolId) ?? null) : null,
      rung,
      path:
        typeof item.path === "string"
          ? item.path
          : (resolvedPaths[index] ??
            (reference.startsWith("file:") ? referenceId : null) ??
            null),
      tokens: estimateBenchmarkTokens(JSON.stringify(item)),
    };
  });
  return {
    evidence,
    distinctSymbols: [
      ...new Set(
        evidence.flatMap(({ symbolName }) => (symbolName ? [symbolName] : [])),
      ),
    ],
  };
}

async function resolveNormalizedBenchmarkResult(
  input: unknown,
  resolveSymbolNames: (
    symbolIds: string[],
  ) => Promise<ReadonlyMap<string, string>>,
  resolvePaths: (
    evidence: Array<Pick<Evidence, "path" | "reference">>,
  ) => Promise<Array<string | undefined>>,
) {
  const evidence = benchmarkEvidenceItems(input);
  return normalizeBenchmarkResult(
    input,
    await resolveSymbolNames(benchmarkEvidenceSymbolIds(input)),
    await resolvePaths(
      evidence.map((item) => ({
        reference: typeof item.reference === "string" ? item.reference : "",
        ...(typeof item.path === "string" ? { path: item.path } : {}),
      })),
    ),
  );
}

function measureNormalizedCase(
  labels: Pick<
    BenchmarkCase,
    "primarySymbol" | "requiredSymbols" | "negativeSymbols" | "negativePaths"
  >,
  result: ReturnType<typeof normalizeBenchmarkResult>,
): NormalizedCaseMetrics {
  const required = labels.requiredSymbols ?? [];
  const requiredHits = required.filter((name) =>
    result.distinctSymbols.includes(name),
  ).length;
  const primaryRank = labels.primarySymbol
    ? result.distinctSymbols.indexOf(labels.primarySymbol) + 1
    : 0;
  const negativeNames = new Set(labels.negativeSymbols ?? []);
  const negativePaths = labels.negativePaths ?? [];
  let evidenceTokens = 0;
  let explicitNoiseTokens = 0;
  for (const item of result.evidence) {
    evidenceTokens += item.tokens;
    if (
      negativeNames.has(item.symbolName ?? "") ||
      negativePaths.some(
        (path) => item.path === path || item.path?.startsWith(path),
      )
    ) {
      explicitNoiseTokens += item.tokens;
    }
  }
  return {
    requiredHits,
    requiredSymbolRecallPercent: percentage(requiredHits, required.length),
    primarySymbolReciprocalRank: primaryRank > 0 ? 1 / primaryRank : 0,
    evidenceTokens,
    explicitNoiseTokens,
    explicitNoiseTokenRatio: explicitNoiseTokens / Math.max(1, evidenceTokens),
    evidenceTokensPerRequiredHit:
      requiredHits > 0 ? evidenceTokens / requiredHits : null,
    rankedSymbols: result.distinctSymbols,
    codeBearingSymbols: [
      ...new Set(
        result.evidence.flatMap(({ rung, symbolName }) =>
          symbolName && (rung === "skeleton" || rung === "hotPath")
            ? [symbolName]
            : [],
        ),
      ),
    ],
  };
}

function buildBenchmarkManifest(input: {
  corpus: BenchmarkCorpus;
  repoSha: string;
  configText: string;
  schemaVersion: number;
  symbolEmbeddingModels: string[];
  fileSummaryEmbeddingModels: string[];
  graphVersionId: string;
  graphIntegrityState: string;
  graphIntegrityVersionId: string | null;
  graphIntegrityDigest: string | null;
}) {
  assert.equal(
    input.graphIntegrityState,
    "verified",
    "Context benchmark requires verified graph integrity",
  );
  assert.equal(
    input.graphIntegrityVersionId,
    input.graphVersionId,
    "Context benchmark manifest must match the indexed graph version",
  );
  assert.match(
    input.graphIntegrityDigest ?? "",
    /^[a-f0-9]{64}$/,
    "Context benchmark requires a graph integrity digest",
  );
  const activeEmbeddingModels = {
    symbol: input.symbolEmbeddingModels,
    fileSummary: input.fileSummaryEmbeddingModels,
  };
  const modelDigest = createHash("sha256")
    .update(JSON.stringify(activeEmbeddingModels))
    .digest("hex")
    .slice(0, 12);
  const configDigest = createHash("sha256")
    .update(input.configText)
    .digest("hex");
  const corpusDigest = createHash("sha256")
    .update(
      JSON.stringify({
        corpus: input.corpus,
        repoSha: input.repoSha,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    corpus: input.corpus,
    repoSha: input.repoSha,
    configDigest,
    schemaVersion: input.schemaVersion,
    activeEmbeddingModels,
    graphVersionId: input.graphVersionId,
    graphIntegrityState: "verified" as const,
    graphIntegrityVersionId: input.graphIntegrityVersionId,
    graphIntegrityDigest: input.graphIntegrityDigest,
    cacheKey: `${process.platform}-${process.arch}-schema${input.schemaVersion}-models-${modelDigest}-corpus-${corpusDigest}`,
  };
}

async function measurePairedLatency(
  benchmarkCases: readonly BenchmarkCase[],
  baseline: ContextEngineLike,
  control: ContextEngineLike,
  options: {
    warmupRuns: number;
    sampleRuns: number;
    now?: () => number;
  },
) {
  const now = options.now ?? performance.now.bind(performance);
  const samples = { baseline: [] as number[], control: [] as number[] };
  const issues: Array<{
    lane: "baseline" | "control";
    caseId: string;
    iteration: number;
    kind: "failure" | "timeout";
    message: string;
  }> = [];
  const forward = [
    ["baseline", baseline],
    ["control", control],
  ] as const;
  for (
    let iteration = -options.warmupRuns;
    iteration < options.sampleRuns;
    iteration++
  ) {
    const order =
      iteration < 0 || iteration % 2 === 0 ? forward : [...forward].reverse();
    for (const [name, engine] of order) {
      for (const c of benchmarkCases) {
        const startedAt = now();
        try {
          const result = await engine.buildContext(
            buildTask(c, { name: "default" }, c.focusPaths.length > 0),
          );
          if (!result.success) {
            issues.push({
              lane: name,
              caseId: c.id,
              iteration,
              kind: "failure",
              message: "context result reported success=false",
            });
          } else if (iteration >= 0) {
            samples[name].push(now() - startedAt);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          issues.push({
            lane: name,
            caseId: c.id,
            iteration,
            kind: "failure",
            message,
          });
        }
      }
    }
  }
  const summarize = (values: number[]) => ({
    samplesMs: values,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  });
  return {
    protocol: {
      warmupRuns: options.warmupRuns,
      sampleRuns: options.sampleRuns,
      interleave: "alternating-lane-first" as const,
      laneLabels: ["baseline", "control"] as const,
      casesPerLanePerSample: benchmarkCases.length,
    },
    failures: issues.filter(({ kind }) => kind === "failure").length,
    timeouts: issues.filter(({ kind }) => kind === "timeout").length,
    issues,
    baseline: summarize(samples.baseline),
    control: summarize(samples.control),
  };
}

async function measureV2LatencyAgainstCommittedBaseline(
  benchmarkCases: readonly BenchmarkCase[],
  control: ContextEngineLike,
  baseline: CommittedV1Baseline,
  options: {
    warmupRuns: number;
    sampleRuns: number;
    now?: () => number;
  },
) {
  const now = options.now ?? performance.now.bind(performance);
  const samples: number[] = [];
  const issues: Array<{
    lane: "control";
    caseId: string;
    iteration: number;
    kind: "failure" | "timeout";
    message: string;
  }> = [];
  for (
    let iteration = -options.warmupRuns;
    iteration < options.sampleRuns;
    iteration++
  ) {
    for (const c of benchmarkCases) {
      const startedAt = now();
      try {
        const result = await control.buildContext(
          buildTask(c, { name: "default" }, c.focusPaths.length > 0),
        );
        if (!result.success) {
          issues.push({
            lane: "control",
            caseId: c.id,
            iteration,
            kind: "failure",
            message: "context result reported success=false",
          });
        } else if (iteration >= 0) {
          samples.push(now() - startedAt);
        }
      } catch (error) {
        issues.push({
          lane: "control",
          caseId: c.id,
          iteration,
          kind: "failure",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    protocol: {
      warmupRuns: options.warmupRuns,
      sampleRuns: options.sampleRuns,
      interleave: "current-v2-against-committed-v1" as const,
      laneLabels: ["baseline", "control"] as const,
      casesPerLanePerSample: benchmarkCases.length,
    },
    failures: issues.filter(({ kind }) => kind === "failure").length,
    timeouts: issues.filter(({ kind }) => kind === "timeout").length,
    issues,
    baseline: {
      samplesMs: [] as number[],
      p50Ms: baseline.latencyP50Ms,
      p95Ms: baseline.latencyP95Ms,
    },
    control: {
      samplesMs: samples,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
    },
  };
}

function evidenceText(result: ContextResult, limit?: number): string {
  return (result.finalEvidence ?? [])
    .slice(0, limit)
    .map((e) => `${e.summary ?? ""} ${e.reference ?? ""}`)
    .join(" ");
}

function buildTask(
  c: BenchmarkCase,
  _variant: Variant,
  scoped: boolean,
): unknown {
  return {
    taskType: c.taskType,
    taskText: c.taskText,
    repoId: REPO_ID,
    budget: {
      maxTokens: c.budgetTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    },
    includeTests: c.includeTests,
    ...(c.chatMentions?.length ? { chatMentions: c.chatMentions } : {}),
    ...((scoped || c.sourcePlanCitations) && c.focusPaths.length > 0
      ? { focusPaths: c.focusPaths }
      : {}),
  };
}

function shouldScopeCase(c: BenchmarkCase, selectedCase: boolean): boolean {
  return selectedCase && c.contextMode === "precise" && c.focusPaths.length > 0;
}

async function resolveEvidencePaths(
  evidence: Array<Pick<Evidence, "path" | "reference">>,
): Promise<Array<string | undefined>> {
  assert.ok(ladybugConn, "LadybugDB connection must be initialized");
  assert.ok(ladybugQueries, "LadybugDB queries must be initialized");
  assert.ok(normalizeEvidencePath, "Path normalizer must be initialized");

  const references: Array<{
    directPath?: string;
    fileReference?: string;
    symbolId?: string;
  }> = evidence.map(({ path, reference }) => {
    if (path) {
      return { directPath: normalizeEvidencePath(path) };
    }
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

  return references.map(({ directPath, symbolId, fileReference }) => {
    if (directPath) return directPath;
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
  if (result.pureEvidence) return true;
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

async function measureCaseRelevance(
  c: BenchmarkCase,
  result?: ContextResult,
): Promise<RelevanceCaseMetrics | undefined> {
  if (!c.primarySymbol) return undefined;
  let normalized: ReturnType<typeof normalizeBenchmarkResult> = {
    evidence: [],
    distinctSymbols: [],
  };
  if (result) {
    assert.ok(ladybugConn && ladybugQueries);
    normalized = await resolveNormalizedBenchmarkResult(
      result,
      async (symbolIds) => {
        const symbols = await ladybugQueries.getSymbolsByIds(
          ladybugConn,
          symbolIds,
        );
        return new Map([...symbols].map(([id, symbol]) => [id, symbol.name]));
      },
      resolveEvidencePaths,
    );
  }
  return {
    budgetTokens: c.budgetTokens ?? 0,
    sourcePlanCitations: c.sourcePlanCitations ?? [],
    primarySymbol: c.primarySymbol,
    requiredSymbols: c.requiredSymbols ?? [],
    usefulSymbols: c.usefulSymbols ?? [],
    negativeSymbols: c.negativeSymbols ?? [],
    negativePaths: c.negativePaths ?? [],
    v2HardFloor: c.v2HardFloor ?? null,
    ...measureNormalizedCase(c, normalized),
  };
}

function recordCaseTotals(target: VariantMetrics, c: BenchmarkCase): void {
  const total = expectedSymbols(c).length;
  target.cases++;
  target.expectedTotal += total;
  if (c.contextMode === "precise") target.preciseExpectedTotal += total;
  else target.broadExpectedTotal += total;
}

async function runCase(
  c: BenchmarkCase,
  variant: Variant,
  scoped: boolean,
  target: VariantMetrics,
  engine: ContextEngineLike | undefined = contextEngine,
): Promise<void> {
  assert.ok(engine, "ContextEngine must be initialized before benchmarking");
  const startedAt = performance.now();
  recordCaseTotals(target, c);
  let result: ContextResult;
  try {
    result = await engine.buildContext(buildTask(c, variant, scoped));
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    target.failures++;
    target.durationsMs.push(durationMs);
    const relevance = await measureCaseRelevance(c);
    target.caseResults.push(
      createCaseMetrics({
        id: c.id,
        success: false,
        answerPresent: !c.requireAnswer,
        usefulTotal: expectedSymbols(c).length,
        durationMs,
        missingUsefulSymbols: [...expectedSymbols(c)],

        evidenceSummaries: [
          `error | ${error instanceof Error ? error.message : String(error)}`,
        ],
        relevance,
      }),
    );
    return;
  }

  const durationMs = performance.now() - startedAt;
  const evidence = result.finalEvidence ?? [];
  const text = evidenceText(
    result,
    c.id === "review-broad-tool-contract-relevance" ? 10 : undefined,
  );
  let usefulHits = 0;
  let noiseHits = 0;

  for (const sym of expectedSymbols(c)) {
    if (text.includes(sym)) usefulHits++;
  }
  for (const sym of noiseSymbols(c)) {
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
  const relevance = await measureCaseRelevance(c, result);
  const shouldResolveReferences =
    INCLUDE_EVIDENCE_DETAILS && REPORT_CASE_IDS.has(c.id);
  const resolvedByPosition = shouldResolveReferences
    ? await resolveEvidencePaths(evidence)
    : evidence.map(({ path }) =>
        path && normalizeEvidencePath ? normalizeEvidencePath(path) : undefined,
      );
  const selectedPaths = resolvedByPosition.filter(
    (path): path is string => path !== undefined,
  );
  target.caseResults.push(
    createCaseMetrics({
      id: c.id,
      success: result.success,
      answerPresent,
      usefulHits,
      usefulTotal: expectedSymbols(c).length,
      noiseHits,
      evidenceCount,
      durationMs,
      missingUsefulSymbols: expectedSymbols(c).filter(
        (symbol) => !text.includes(symbol),
      ),
      selectedPaths,
      selectedPathsByPosition: resolvedByPosition.map((path) => path ?? null),
      selectedSymbols: selectedSymbolIds(evidence),
      selectedActions: (result.actionsTaken ?? []).map(({ type }) => type),
      selectedReferences: evidence.map(({ reference }) => reference),
      unresolvedPathReferences: shouldResolveReferences
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
      relevance,
    }),
  );
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

function shouldRunOrdinaryQualityGates(
  recordBaseline: boolean,
  runSemanticOnly: boolean,
  selectedCaseId: string | undefined,
): boolean {
  return !recordBaseline && !runSemanticOnly && selectedCaseId === undefined;
}

function assertSemanticQuality(
  semantic: VariantMetrics,
  selectedCase: boolean,
  recordBaseline: boolean = false,
): void {
  assert.equal(semantic.failures, 0, "semantic variant should not fail cases");

  // A v1 baseline records relevance misses for later paired comparison.
  if (recordBaseline) return;

  if (selectedCase) {
    assert.equal(
      semantic.caseResults.length,
      1,
      "selected semantic run should produce exactly one case result",
    );
    const result = semantic.caseResults[0];
    assert.ok(result, "selected semantic case result should exist");
    if (result.id !== "review-broad-tool-contract-relevance") {
      assert.deepEqual(
        result.missingUsefulSymbols,
        [],
        `selected case ${result.id} missing expected evidence: ${result.missingUsefulSymbols.join(", ")}`,
      );
    }
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
  if (result.id === "review-broad-tool-contract-relevance") {
    assert.ok(
      result.usefulHits >= 4,
      `selected case ${result.id} returned ${result.usefulHits}/${result.usefulTotal} expected symbols in the top ten`,
    );
    assert.equal(
      result.noiseHits,
      0,
      "selected case returned unexpected top-ten symbols",
    );
    return;
  }

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
        .length <=
        result.selectedPaths.length / 2,
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

function skipOrFail(
  reason: string,
  requireLiveIndex = REQUIRE_LIVE_INDEX,
  recordBaseline = RECORD_BASELINE,
): boolean {
  if (requireLiveIndex || recordBaseline) {
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
  if (result.relevance) base.relevance = result.relevance;
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
  const relevance = aggregateRelevanceMetrics(m);
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
    relevance,
    latencyMs: {
      p50: percentile(m.durationsMs, 50),
      p95: percentile(m.durationsMs, 95),
      max: Math.max(0, ...m.durationsMs),
      total: m.durationsMs.reduce((sum, durationMs) => sum + durationMs, 0),
    },
    caseResults: m.caseResults.map(caseMetricsForArtifact),
  };
}

function aggregateRelevanceMetrics(m: VariantMetrics) {
  const labeled = m.caseResults.flatMap(({ relevance }) =>
    relevance ? [relevance] : [],
  );
  let requiredSymbols = 0;
  let requiredHits = 0;
  let evidenceTokens = 0;
  let noiseTokens = 0;
  let primaryRankTotal = 0;
  for (const result of labeled) {
    requiredSymbols += result.requiredSymbols.length;
    requiredHits += result.requiredHits;
    evidenceTokens += result.evidenceTokens;
    noiseTokens += result.explicitNoiseTokens;
    primaryRankTotal += result.primarySymbolReciprocalRank;
  }
  return {
    labeledCases: labeled.length,
    requiredSymbols,
    requiredHits,
    requiredSymbolRecallPercent: percentage(requiredHits, requiredSymbols),
    primarySymbolMrr: primaryRankTotal / Math.max(1, labeled.length),
    evidenceTokens,
    explicitNoiseTokens: noiseTokens,
    explicitNoiseTokenRatio: noiseTokens / Math.max(1, evidenceTokens),
    evidenceTokensPerRequiredHit:
      requiredHits > 0 ? evidenceTokens / requiredHits : null,
  };
}

function assertV2ShadowQuality(
  baseline: CommittedV1Baseline,
  shadow: VariantMetrics,
  pairedLatency: Awaited<
    ReturnType<typeof measureV2LatencyAgainstCommittedBaseline>
  >,
): void {
  assert.equal(shadow.failures, 0, "V2 shadow should not fail benchmark cases");
  assert.equal(
    pairedLatency.failures,
    0,
    `V2 paired latency recorded failures: ${JSON.stringify(pairedLatency.issues)}`,
  );
  assert.equal(
    pairedLatency.timeouts,
    0,
    `V2 paired latency recorded timeouts: ${JSON.stringify(pairedLatency.issues)}`,
  );
  for (const result of shadow.caseResults) {
    const v2HardFloor = result.relevance?.v2HardFloor;
    if (v2HardFloor) {
      for (const prioritySymbol of v2HardFloor.prioritySymbols) {
        const priorityRank =
          result.relevance?.rankedSymbols.indexOf(prioritySymbol) ?? -1;
        assert.ok(
          priorityRank >= 0,
          `V2 hard-floor case ${result.id} omitted priority symbol ${prioritySymbol}`,
        );
        for (const unrelatedSymbol of v2HardFloor.unrelatedSymbols) {
          const unrelatedRank =
            result.relevance?.rankedSymbols.indexOf(unrelatedSymbol) ?? -1;
          assert.ok(
            unrelatedRank < 0 || priorityRank < unrelatedRank,
            `V2 hard-floor case ${result.id} ranked ${prioritySymbol} behind ${unrelatedSymbol}`,
          );
        }
      }
      for (const codeBearingSymbol of v2HardFloor.codeBearingSymbols) {
        assert.ok(
          result.relevance?.codeBearingSymbols.includes(codeBearingSymbol),
          `V2 hard-floor case ${result.id} omitted code-bearing evidence for ${codeBearingSymbol}`,
        );
      }
    }
    if (!result.relevance?.sourcePlanCitations.length) continue;
    assert.equal(
      result.relevance.requiredHits,
      result.relevance.requiredSymbols.length,
      `V2 hard-floor case ${result.id} missed required symbols`,
    );
  }

  const v1 = baseline.relevance;
  const v2 = aggregateRelevanceMetrics(shadow);
  assert.ok(
    v2.requiredSymbolRecallPercent >= v1.requiredSymbolRecallPercent,
    `V2 required-symbol recall ${v2.requiredSymbolRecallPercent.toFixed(1)}% regressed below V1 ${v1.requiredSymbolRecallPercent.toFixed(1)}%`,
  );
  assert.ok(
    v2.primarySymbolMrr >= v1.primarySymbolMrr,
    `V2 primary-symbol MRR ${v2.primarySymbolMrr.toFixed(3)} regressed below V1 ${v1.primarySymbolMrr.toFixed(3)}`,
  );
  assert.ok(
    v2.explicitNoiseTokenRatio <= v1.explicitNoiseTokenRatio,
    `V2 explicit-noise token ratio ${v2.explicitNoiseTokenRatio.toFixed(3)} exceeded V1 ${v1.explicitNoiseTokenRatio.toFixed(3)}`,
  );
  assert.ok(
    v1.evidenceTokensPerRequiredHit === null ||
      (v2.evidenceTokensPerRequiredHit !== null &&
        v2.evidenceTokensPerRequiredHit <= v1.evidenceTokensPerRequiredHit),
    `V2 evidence tokens per required hit ${String(v2.evidenceTokensPerRequiredHit)} exceeded V1 ${String(v1.evidenceTokensPerRequiredHit)}`,
  );
  assert.ok(
    pairedLatency.control.p95Ms <= pairedLatency.baseline.p95Ms * 1.25,
    `V2 paired p95 ${pairedLatency.control.p95Ms.toFixed(1)}ms exceeded 1.25x V1 ${pairedLatency.baseline.p95Ms.toFixed(1)}ms`,
  );
}

function persistBenchmarkArtifact(): void {
  if (!writeBenchmarkOutput || !shouldPersistBenchmarkArtifact()) return;
  if (RUN_V2_SHADOW && metrics.v2Shadow.cases === 0) {
    throw new Error(
      "V2 shadow was requested but no V2 benchmark cases completed",
    );
  }
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  const artifact = {
    schemaVersion: 2,
    benchmark: "context-quality",
    corpus: CORPUS,
    repoId: REPO_ID,
    manifest: metrics.manifest,
    ladybugClosedBeforeArtifact,
    seedResolutionDiagnostics: {
      command: "npm run benchmark:seed-resolution",
      artifact: "docs/benchmarks/seed-resolution-evaluation-v2.json",
    },
    corpusCaseCount: metrics.totalCases,
    selectedCaseId: SELECTED_CASE_ID ?? null,
    baselineRecording: RECORD_BASELINE,
    v2ShadowEnabled: RUN_V2_SHADOW,
    pairedLatency: metrics.pairedLatency ?? null,
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
    v2Shadow: RUN_V2_SHADOW
      ? variantMetricsForArtifact(metrics.v2Shadow)
      : null,
    scopedPrecise:
      metrics.scopedPrecise.cases > 0
        ? variantMetricsForArtifact(metrics.scopedPrecise)
        : null,
    providerContextCardInvariant: metrics.providerContextCardInvariant,
  };
  writeBenchmarkOutput(
    ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "overwrite",
  );
  console.log(`[context-quality] artifact: ${ARTIFACT_PATH}`);
}

async function closeLadybugThenPersistArtifact(
  close: CloseLadybugDb | undefined = closeLadybugDb,
  persist: () => void = persistBenchmarkArtifact,
): Promise<void> {
  await close?.({ strict: true });
  ladybugClosedBeforeArtifact = true;
  persist();
}

function shouldPersistBenchmarkArtifact(
  repoAvailable = metrics.repoAvailable,
  manifest = metrics.manifest,
  closed = ladybugClosedBeforeArtifact,
): boolean {
  return repoAvailable && Boolean(manifest) && closed;
}

describe("context quality benchmarks", () => {
  before(async () => {
    const casesPath = join(import.meta.dirname, "context-quality-cases.json");
    allCases = JSON.parse(readFileSync(casesPath, "utf-8")) as BenchmarkCase[];
    cases = allCases.filter((c) => (c.corpus ?? "sdl-mcp") === CORPUS);
    assertBenchmarkCasesSelected(CORPUS, cases);
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
        contextV2,
        benchmarkOutput,
        contextTools,
        symbolTools,
        derivedState,
        semanticModelPlan,
        schema,
        tokenize,
      ] = await Promise.all([
        import("../../dist/config/configPath.js"),
        import("../../dist/config/loadConfig.js"),
        import("../../dist/db/initGraphDb.js"),
        import("../../dist/db/ladybug.js"),
        import("../../dist/db/ladybug-core.js"),
        import("../../dist/db/ladybug-queries.js"),
        import("../../dist/util/paths.js"),
        import("../../dist/context/engine.js"),
        import("../../dist/benchmark/output-file.js"),
        import("../../dist/mcp/tools/context.js"),
        import("../../dist/mcp/tools/symbol.js"),
        import("../../dist/db/ladybug-derived-state.js"),
        import("../../dist/config/semantic-embedding-model-plan.js"),
        import("../../dist/db/ladybug-schema.js"),
        import("../../dist/util/tokenize.js"),
      ]);
      writeBenchmarkOutput = benchmarkOutput.writeUtf8Output;
      estimateBenchmarkTokens = tokenize.estimateTokens;
      const configPath = activateCliConfigPath(process.env.SDL_CONFIG);
      const config = loadConfig(configPath);
      const repoConfig = config.repos.find(({ repoId }) => repoId === REPO_ID);
      if (!repoConfig) {
        throw new Error(
          `Context benchmark config does not contain repo ${REPO_ID}`,
        );
      }
      // Pin checkout provenance before LadybugDB opens or restores graph state.
      const checkoutRepoSha = verifyPinnedCheckoutSha(
        repoConfig.rootPath,
        PINNED_REPO_SHA,
      );
      await initGraphDb(config, configPath);
      closeLadybugDb = ladybug.closeLadybugDb;
      rawContextEngineV2 = new contextV2.ContextEngineV2();
      contextEngine = createV2BenchmarkAdapter(rawContextEngineV2);
      ladybugQueries = queries;
      normalizeEvidencePath = paths.normalizePath;
      handleAgentContext = contextTools.handleAgentContext;
      handleSymbolGetCard = symbolTools.handleSymbolGetCard;
      getDerivedState = derivedState.getDerivedState;

      const conn = await ladybug.getLadybugConn();
      ladybugConn = conn;
      const [rows, latestVersion, currentDerivedState, schemaVersion] =
        await Promise.all([
          core.queryAll(
            conn,
            "MATCH (r:Repo {repoId: $repoId}) RETURN count(r) AS n",
            { repoId: REPO_ID },
          ),
          queries.getLatestVersion(conn, REPO_ID),
          derivedState.getDerivedState(REPO_ID),
          schema.getSchemaVersion(conn),
        ]);
      if (Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0) === 0) {
        throw new Error(`repo ${REPO_ID} is not indexed in the selected graph`);
      }
      assert.ok(latestVersion, "benchmark graph must have a current version");
      assert.ok(currentDerivedState, "benchmark graph must have derived state");
      assert.notEqual(
        schemaVersion,
        null,
        "benchmark graph must have a schema version",
      );
      const embeddingPlan = semanticModelPlan.resolveSemanticEmbeddingModelPlan(
        config.semantic,
      );
      metrics.manifest = buildBenchmarkManifest({
        corpus: CORPUS,
        repoSha: checkoutRepoSha,
        configText: readFileSync(
          process.env.SDL_CONTEXT_QUALITY_MANIFEST_CONFIG_PATH ?? configPath,
          "utf8",
        ),
        schemaVersion,
        symbolEmbeddingModels: embeddingPlan.symbolEmbeddingModels,
        fileSummaryEmbeddingModels: embeddingPlan.fileSummaryEmbeddingModels,
        graphVersionId: latestVersion.versionId,
        graphIntegrityState: currentDerivedState.graphIntegrityState,
        graphIntegrityVersionId: currentDerivedState.graphIntegrityVersionId,
        graphIntegrityDigest: currentDerivedState.graphIntegrityDigest,
      });
      metrics.repoAvailable = true;
      metrics.availabilityReason = `using verified graph for repo ${REPO_ID}`;
    } catch (err) {
      if (err instanceof BenchmarkProvenanceError) throw err;
      metrics.repoAvailable = false;
      metrics.availabilityReason =
        err instanceof Error ? err.message : String(err);
    }
  });

  after(async () => {
    await closeLadybugThenPersistArtifact();
  });

  describe("case structure validation", () => {
    it("does not publish when strict Ladybug close fails", async () => {
      let published = false;
      await assert.rejects(
        () =>
          closeLadybugThenPersistArtifact(
            async (options) => {
              assert.equal(options?.strict, true);
              throw new Error("injected close failure");
            },
            () => {
              published = true;
            },
          ),
        /injected close failure/u,
      );
      assert.equal(published, false);
    });

    it("executes every V2 degradation level through the real engine", async () => {
      const serialized = await serializeControlledV2DegradationResults({
        repoId: "controlled",
        taskType: "explain",
        taskText: "verify deterministic degradation responses",
        budget: { maxTokens: DEFAULT_CONTEXT_TOKEN_BUDGET },
      });
      assert.deepEqual(Object.keys(serialized), [
        ...SUCCESSFUL_CONTEXT_RETRIEVAL_LEVELS,
        "insufficient",
      ]);
    });

    it("parses only supported corpus identifiers", () => {
      assert.equal(parseBenchmarkCorpus(undefined), "sdl-mcp");
      assert.equal(parseBenchmarkCorpus("neutral"), "neutral");
      assert.throws(
        () => parseBenchmarkCorpus("invalid"),
        /unknown context quality corpus: invalid/i,
      );
    });

    it("rejects an empty corpus selection", () => {
      assert.throws(
        () => assertBenchmarkCasesSelected("neutral", []),
        /no context quality cases selected for corpus neutral/i,
      );
    });

    it("preserves 27 legacy cases and adds the QA and neutral corpora", () => {
      assert.equal(
        allCases.filter(({ id }) => !/^(?:qa|neutral)-/.test(id)).length,
        27,
        "Expected all 27 legacy benchmark cases",
      );
      assert.equal(allCases.filter(({ id }) => id.startsWith("qa-")).length, 4);
      assert.equal(
        allCases.filter(({ id }) => id.startsWith("neutral-")).length,
        2,
      );
    });

    it("has correct task type distribution", () => {
      const byType = new Map<string, number>();
      const legacyCases = allCases.filter(
        ({ id }) => !/^(?:qa|neutral)-/.test(id),
      );
      for (const c of legacyCases) {
        byType.set(c.taskType, (byType.get(c.taskType) ?? 0) + 1);
      }
      assert.equal(byType.get("debug"), 8, "Expected 8 debug cases");
      assert.equal(byType.get("explain"), 6, "Expected 6 explain cases");
      assert.equal(byType.get("review"), 9, "Expected 9 review cases");
      assert.equal(byType.get("implement"), 4, "Expected 4 implement cases");
    });

    it("has correct context mode distribution", () => {
      assert.equal(
        allCases.filter(
          (c) => !/^(?:qa|neutral)-/.test(c.id) && c.contextMode === "precise",
        ).length,
        13,
        "Expected 13 precise cases",
      );
      assert.equal(
        allCases.filter(
          (c) => !/^(?:qa|neutral)-/.test(c.id) && c.contextMode === "broad",
        ).length,
        14,
        "Expected 14 broad cases",
      );
    });

    it("all cases have valid structure", () => {
      for (const c of allCases) {
        assert.ok(c.id, "Case missing id");
        assert.ok(c.taskText, `Case ${c.id} missing taskText`);
        assert.ok(
          REPORT_CASE_IDS.has(c.id) ||
            /^(?:qa|neutral)-/.test(c.id) ||
            c.focusPaths.length > 0,
          `Case ${c.id} needs focusPaths`,
        );
        assert.ok(
          expectedSymbols(c).length > 0,
          `Case ${c.id} needs expectedUsefulSymbols`,
        );
        assert.ok(
          noiseSymbols(c).length > 0,
          `Case ${c.id} needs unexpectedSymbols`,
        );
      }
    });

    it("keeps the broad and precise tool-QA report cases stable", () => {
      const precise = allCases.find(
        ({ id }) => id === "review-precise-tool-qa-tests",
      );
      const broad = allCases.find(
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

  describe("engine-neutral relevance metrics", () => {
    const names = new Map([
      ["noise-id", "NoiseSymbol"],
      ["primary-id", "PrimarySymbol"],
    ]);
    const paths = ["src/noise.ts", "src/noise.ts", "src/primary.ts"];
    const labels = {
      primarySymbol: "PrimarySymbol",
      requiredSymbols: ["PrimarySymbol", "RequiredHelper"],
      negativeSymbols: ["NoiseSymbol"],
      negativePaths: ["src/noise.ts"],
    };

    it("keeps V1 final evidence authoritative over raw engine evidence", () => {
      const finalEvidence = [
        {
          type: "symbolCard",
          reference: "symbol:final",
          summary: "final",
          timestamp: 0,
        },
      ];

      assert.deepEqual(
        benchmarkEvidenceItems({
          success: true,
          evidence: [{ symbolId: "raw" }],
          finalEvidence,
        }),
        finalEvidence,
      );
    });

    it("normalizes both engine shapes and measures labeled relevance", () => {
      const v1 = normalizeBenchmarkResult(
        {
          finalEvidence: [
            { reference: "symbol:noise-id" },
            { reference: "hotpath:noise-id" },
            { reference: "symbol:primary-id" },
          ],
        },
        names,
        paths,
      );
      const v2 = normalizeBenchmarkResult(
        {
          evidence: [
            { symbolId: "noise-id", path: paths[0] },
            { symbolId: "noise-id", path: paths[1] },
            { symbolId: "primary-id", path: paths[2] },
          ],
        },
        names,
        paths,
      );
      assert.deepEqual(v2.distinctSymbols, v1.distinctSymbols);
      const measured = measureNormalizedCase(labels, v2);
      assert.deepEqual(
        [
          measured.requiredSymbolRecallPercent,
          measured.primarySymbolReciprocalRank,
        ],
        [50, 0.5],
      );
      assert.equal(
        measured.explicitNoiseTokenRatio,
        measured.explicitNoiseTokens / measured.evidenceTokens,
      );
      assert.equal(
        measured.evidenceTokensPerRequiredHit,
        measured.evidenceTokens,
      );
    });

    it("resolves V2 evidence IDs through the normalized relevance view", async () => {
      const requestedIds: string[] = [];
      const normalized = await resolveNormalizedBenchmarkResult(
        {
          evidence: [
            { symbolId: "noise-id", path: paths[0] },
            { symbolId: "primary-id", path: paths[2] },
          ],
        },
        async (ids) => {
          requestedIds.push(...ids);
          return names;
        },
        async () => [],
      );
      assert.deepEqual(requestedIds, ["noise-id", "primary-id"]);
      assert.equal(
        measureNormalizedCase(labels, normalized).primarySymbolReciprocalRank,
        0.5,
      );
    });

    it("adapts the existing benchmark task and V2 payload without changing either contract", async () => {
      let capturedRequest: unknown;
      const payload = {
        status: "budgetLimited" as const,
        taskType: "debug" as const,
        retrieval: {
          level: "hybrid" as const,
          lanes: [],
        },
        evidence: [
          {
            rung: "card" as const,
            symbolId: "primary-id",
            path: "src/primary.ts",
            rank: 1,
            tier: 0 as const,
            lanes: ["exactIdentifier" as const],
            content: { signature: "PrimarySymbol()" },
          },
        ],
        edges: [],
        omitted: {
          total: 1,
          byReason: { budget: 1 },
          highestRanked: [],
        },
        nextActions: [
          {
            id: "codeNeedWindow",
            args: { symbolId: "primary-id" },
          },
        ],
      };
      const payloadBefore = JSON.stringify(payload);
      const adapter = createV2BenchmarkAdapter({
        buildContext: async (request: unknown) => {
          capturedRequest = request;
          return payload;
        },
      });

      const result = await adapter.buildContext({
        repoId: "fixture-repo",
        taskType: "debug",
        taskText: "debug PrimarySymbol",
        focusPaths: ["src/primary.ts"],
        chatMentions: ["PrimarySymbol"],
        includeTests: true,
      });

      assert.deepEqual(capturedRequest, {
        repoId: "fixture-repo",
        taskType: "debug",
        taskText: "debug PrimarySymbol",
        budget: { maxTokens: 50_000 },
        focusPaths: ["src/primary.ts"],
        chatMentions: ["PrimarySymbol"],
        includeTests: true,
      });
      assert.equal(result.success, true);
      assert.equal(result.pureEvidence, true);
      assert.deepEqual(result.evidence, payload.evidence);
      assert.deepEqual(result.benchmarkEvidence, payload.evidence);
      assert.deepEqual(result.finalEvidence, [
        {
          type: "card",
          reference: "symbol:primary-id",
          path: "src/primary.ts",
          summary: '{"signature":"PrimarySymbol()"}',
          timestamp: 0,
        },
      ]);
      assert.deepEqual(result.actionsTaken, [{ type: "codeNeedWindow" }]);
      assert.equal(JSON.stringify(payload), payloadBefore);
    });

    it("rejects unverified manifests and builds the cache key", () => {
      const input = {
        corpus: "sdl-mcp" as const,
        repoSha: "a".repeat(40),
        configText: "{}",
        schemaVersion: 3,
        symbolEmbeddingModels: ["symbol-model"],
        fileSummaryEmbeddingModels: ["file-model"],
        graphVersionId: "v1",
        graphIntegrityState: "verified",
        graphIntegrityVersionId: "v1",
        graphIntegrityDigest: "b".repeat(64),
      };
      const manifest = buildBenchmarkManifest(input);
      const relocatedManifest = buildBenchmarkManifest({
        ...input,
        configText:
          '{"graphDatabase":{"path":"D:/disposable-clone/graph.lbug"}}',
        graphIntegrityDigest: "c".repeat(64),
      });
      assert.match(manifest.configDigest, /^[a-f0-9]{64}$/);
      assert.equal(buildBenchmarkManifest(input).cacheKey, manifest.cacheKey);
      assert.notEqual(relocatedManifest.configDigest, manifest.configDigest);
      assert.equal(relocatedManifest.graphIntegrityDigest, "c".repeat(64));
      assert.equal(relocatedManifest.cacheKey, manifest.cacheKey);
      assert.notEqual(
        buildBenchmarkManifest({ ...input, corpus: "neutral" }).cacheKey,
        manifest.cacheKey,
      );
      assert.notEqual(
        buildBenchmarkManifest({ ...input, repoSha: "d".repeat(40) }).cacheKey,
        manifest.cacheKey,
      );
      assert.match(manifest.cacheKey, /corpus-[a-f0-9]{12}$/);
      assert.throws(
        () =>
          buildBenchmarkManifest({ ...input, graphIntegrityState: "failed" }),
        /verified graph integrity/i,
      );
    });

    it("rejects a checkout whose HEAD differs from the pinned SHA", () => {
      assert.throws(
        () => verifyPinnedCheckoutSha(process.cwd(), "0".repeat(40)),
        /checkout HEAD mismatch.*expected 0{40}.*actual [a-f0-9]{40}/i,
      );
    });

    it("warms and interleaves baseline/control latency samples", async () => {
      const calls: string[] = [];
      let now = 0;
      const engine = (name: string, durationMs: number): ContextEngineLike => ({
        buildContext: async () => {
          calls.push(name);
          now += durationMs;
          return { success: true, finalEvidence: [] };
        },
      });
      const c = allCases.find(
        ({ id }) => id === "qa-2026-07-25-runtime-query-broad",
      );
      assert.ok(c);
      const result = await measurePairedLatency(
        [c],
        engine("baseline", 10),
        engine("control", 20),
        { warmupRuns: 1, sampleRuns: 3, now: () => now },
      );
      assert.deepEqual(calls, [
        "baseline",
        "control",
        "baseline",
        "control",
        "control",
        "baseline",
        "baseline",
        "control",
      ]);
      assert.deepEqual(result.protocol, {
        warmupRuns: 1,
        sampleRuns: 3,
        interleave: "alternating-lane-first",
        laneLabels: ["baseline", "control"],
        casesPerLanePerSample: 1,
      });
      assert.deepEqual(result.baseline, {
        samplesMs: [10, 10, 10],
        p50Ms: 10,
        p95Ms: 10,
      });
      assert.deepEqual(result.control, {
        samplesMs: [20, 20, 20],
        p50Ms: 20,
        p95Ms: 20,
      });
    });
  });

  describe("semantic gate selection", () => {
    it("hard-fails baseline infrastructure while preserving ordinary local skips", () => {
      assert.throws(
        () => skipOrFail("baseline graph unavailable", false, true),
        /baseline graph unavailable/,
      );
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(skipOrFail("local graph unavailable", false, false), true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("uses one selected case's own expectations instead of aggregate recall", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.expectedTotal = 10;
      semantic.usefulHits = 0;
      semantic.caseResults.push(
        createCaseMetrics({
          usefulTotal: 10,
          evidenceCount: 1,
        }),
      );

      assert.doesNotThrow(() => assertSemanticQuality(semantic, true));
    });

    it("records baseline relevance without applying v1 quality floors", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.caseResults.push(
        createCaseMetrics({
          usefulTotal: 2,
          missingUsefulSymbols: ["requiredSymbol"],
          noiseHits: 1,
          evidenceCount: 2,
        }),
      );

      assert.doesNotThrow(() => assertSemanticQuality(semantic, true, true));
    });

    it("rejects a selected case that misses its own expected evidence", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.caseResults.push(
        createCaseMetrics({
          usefulTotal: 1,
          missingUsefulSymbols: ["requiredSymbol"],
        }),
      );

      assert.throws(
        () => assertSemanticQuality(semantic, true),
        /missing expected evidence.*requiredSymbol/i,
      );
    });

    it("rejects a selected case that loses a required answer", () => {
      const semantic = createMetrics("semantic");
      semantic.cases = 1;
      semantic.caseResults.push(
        createCaseMetrics({
          answerPresent: false,
          usefulHits: 1,
          usefulTotal: 1,
          evidenceCount: 1,
        }),
      );

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

    it("keeps ordinary latency and relevance gates active outside baseline recording", () => {
      assert.equal(
        shouldRunOrdinaryQualityGates(false, false, undefined),
        true,
      );
      assert.equal(
        shouldRunOrdinaryQualityGates(true, false, undefined),
        false,
      );
      assert.equal(
        shouldRunOrdinaryQualityGates(false, true, undefined),
        false,
      );
      assert.equal(
        shouldRunOrdinaryQualityGates(false, false, "selected"),
        false,
      );
    });

    it("scopes only selected precise cases with explicit focus paths", () => {
      const precise = allCases.find(
        ({ id }) => id === "review-precise-tool-qa-tests",
      );
      const broad = allCases.find(
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
      assert.equal(
        shouldPersistBenchmarkArtifact(
          true,
          {} as ReturnType<typeof buildBenchmarkManifest>,
          true,
        ),
        true,
      );
    });
  });

  it("emits canonical V2 determinism probe bytes", async (t) => {
    if (!CANONICAL_V2_PROBE_OUTPUT_PATH) {
      t.skip("canonical V2 probe output was not requested");
      return;
    }
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(rawContextEngineV2, "raw V2 context engine must be initialized");
    assert.ok(
      writeBenchmarkOutput,
      "benchmark output writer must be initialized",
    );
    const benchmarkCase = allCases.find(
      ({ id }) => id === "qa-2026-07-26-server-instructions-broad",
    );
    assert.ok(benchmarkCase, "canonical V2 probe case must be present");
    const serialized = await assertCanonicalV2PayloadDeterminism(
      rawContextEngineV2,
      benchmarkCase,
    );
    mkdirSync(dirname(CANONICAL_V2_PROBE_OUTPUT_PATH), { recursive: true });
    writeBenchmarkOutput(
      CANONICAL_V2_PROBE_OUTPUT_PATH,
      `${JSON.stringify(serialized, null, 2)}\n`,
      "overwrite",
    );
  });

  it("runs the current v2 retrieval benchmark", async () => {
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

    if (RUN_V2_SHADOW) {
      const current = metrics.variants.get("semantic");
      assert.ok(current, "Current V2 benchmark metrics must be available");
      metrics.v2Shadow = { ...current, name: "v2-shadow" };
    }

    if ((RECORD_BASELINE || RUN_V2_SHADOW) && !SELECTED_CASE_ID) {
      assert.ok(
        contextEngine,
        "ContextEngine must be initialized for paired latency",
      );
      metrics.pairedLatency = await measureV2LatencyAgainstCommittedBaseline(
        selectedCases,
        contextEngine,
        committedV1Baseline,
        {
          warmupRuns: PAIRED_LATENCY_WARMUP_RUNS,
          sampleRuns: PAIRED_LATENCY_SAMPLE_RUNS,
        },
      );
    }

    const semantic = metrics.variants.get("semantic");
    assert.ok(semantic, "semantic variant should have metrics");
    assertSemanticQuality(
      semantic,
      SELECTED_CASE_ID !== undefined,
      RECORD_BASELINE || RUN_V2_SHADOW,
    );
    if (RUN_V2_SHADOW && !SELECTED_CASE_ID) {
      assert.ok(metrics.pairedLatency);
      assertV2ShadowQuality(
        committedV1Baseline,
        metrics.v2Shadow,
        metrics.pairedLatency,
      );
    }
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

  it("dereferences clean provider-first context evidence through card lookup", async (t) => {
    if (!REQUIRE_PROVIDER_CONTEXT_CARD_INVARIANT) {
      t.skip(
        "set SDL_CONTEXT_QUALITY_REQUIRE_PROVIDER_INVARIANT=1 for the clean provider proof",
      );
      return;
    }
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(ladybugConn, "LadybugDB connection must be initialized");
    assert.ok(ladybugQueries, "LadybugDB queries must be initialized");
    assert.ok(normalizeEvidencePath, "Path normalizer must be initialized");
    assert.ok(handleAgentContext, "sdl.context handler must be initialized");
    assert.ok(
      handleSymbolGetCard,
      "symbol.getCard handler must be initialized",
    );
    assert.ok(getDerivedState, "derived-state reader must be initialized");

    const [derivedState, latestVersion] = await Promise.all([
      getDerivedState(REPO_ID),
      ladybugQueries.getLatestVersion(ladybugConn, REPO_ID),
    ]);
    assert.ok(derivedState, "Clean provider graph must have derived state");
    assert.ok(
      latestVersion,
      "Clean provider graph must have a current version",
    );
    assert.equal(derivedState.graphIntegrityState, "verified");
    assert.equal(
      derivedState.graphIntegrityVersionId,
      latestVersion.versionId,
      "Provider context/card proof must use the integrity-verified version",
    );
    assert.match(derivedState.graphIntegrityDigest ?? "", /^[a-f0-9]{64}$/);

    const session = { sessionId: "provider-context-card-invariant" };
    const context = await handleAgentContext(
      {
        repoId: REPO_ID,
        taskType: "review",
        taskText:
          "Review SDL MCP tool handlers, schemas, gateway routing, and response formatting",
        budget: { maxTokens: 12_000 },
        includeTests: false,
        responseMode: "inline",
        wireFormat: "json",
        refsMode: "off",
      },
      session,
    );
    assert.ok("evidence" in context);
    const symbolEvidence = context.evidence;
    assert.ok(
      symbolEvidence.length > 0,
      "Clean provider context must return dereferenceable symbol evidence",
    );

    const symbolIds = [
      ...new Set(
        symbolEvidence.map(({ symbolId }) => symbolId),
      ),
    ];
    const symbols = await ladybugQueries.getSymbolsByIds(
      ladybugConn,
      symbolIds,
    );
    const files = await ladybugQueries.getFilesByIds(ladybugConn, [
      ...new Set([...symbols.values()].map(({ fileId }) => fileId)),
    ]);
    const providerBackedSymbolIds = symbolIds.filter((symbolId) => {
      const symbol = symbols.get(symbolId);
      return (
        Boolean(symbol?.scipSymbol) ||
        symbol?.source === "scip" ||
        symbol?.source === "lsp"
      );
    });
    assert.ok(
      providerBackedSymbolIds.length > 0,
      "Invariant must exercise provider-first symbol rows",
    );

    for (const symbolId of symbolIds) {
      const symbol = symbols.get(symbolId);
      assert.ok(symbol, `Context returned missing provider symbol ${symbolId}`);
      const file = files.get(symbol.fileId);
      assert.ok(file, `Context symbol ${symbolId} has no owning file`);
      const relPath = normalizeEvidencePath(file.relPath);
      const signature = symbol.signatureJson
        ? (JSON.parse(symbol.signatureJson) as Record<string, unknown>)
        : undefined;

      const cardResponse = await handleSymbolGetCard(
        { repoId: REPO_ID, symbolId, refsMode: "off" },
        session,
      );
      assert.ok("card" in cardResponse);
      assert.equal(cardResponse.card.file, relPath);
      assert.deepEqual(cardResponse.card.range, {
        startLine: symbol.rangeStartLine,
        startCol: symbol.rangeStartCol,
        endLine: symbol.rangeEndLine,
        endCol: symbol.rangeEndCol,
      });
      assert.deepEqual(cardResponse.card.signature, signature);
    }

    metrics.providerContextCardInvariant = {
      requested: true,
      status: "passed",
      graphIntegrityState: derivedState.graphIntegrityState,
      graphIntegrityVersionId: derivedState.graphIntegrityVersionId,
      graphIntegrityDigest: derivedState.graphIntegrityDigest,
      checkedSymbolIds: symbolIds,
      providerBackedSymbolIds,
    };
  });

  // The newer sdl.info retrieval contract runs against its own versioned corpus
  // in info-contract.test.ts; this benchmark retains its original frozen corpus.

  it("keeps scoped precise lookups below the latency target", async (t) => {
    if (
      !shouldRunOrdinaryQualityGates(
        RECORD_BASELINE,
        RUN_SEMANTIC_ONLY,
        SELECTED_CASE_ID,
      )
    ) {
      t.skip(
        "baseline-recording, semantic-only, and selected-case runs exclude ordinary quality gates",
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
      percentile(metrics.scopedPrecise.durationsMs, 95) <=
        SCOPED_PRECISE_P95_MAX_MS,
      `scoped precise p95 ${percentile(metrics.scopedPrecise.durationsMs, 95).toFixed(0)}ms above ${SCOPED_PRECISE_P95_MAX_MS}ms`,
    );
  });

  it("keeps scoped tool-QA evidence inside tests", async (t) => {
    if (CORPUS !== "sdl-mcp") {
      t.skip("SDL-specific regression is outside the neutral corpus");
      return;
    }
    if (
      !shouldRunOrdinaryQualityGates(
        RECORD_BASELINE,
        RUN_SEMANTIC_ONLY,
        SELECTED_CASE_ID,
      )
    ) {
      t.skip(
        "baseline-recording, semantic-only, and selected-case runs exclude ordinary quality gates",
      );
      return;
    }
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(
      contextEngine,
      "ContextEngine must be initialized before benchmarking",
    );
    const c = cases.find(({ id }) => id === "review-precise-tool-qa-tests");
    assert.ok(c, "Scoped tool-QA benchmark case must exist");

    const result = await contextEngine.buildContext(
      buildTask(c, { name: "default" }, true),
    );
    const evidence = result.finalEvidence ?? [];
    const resolvedByPosition = await resolveEvidencePaths(evidence);
    const unresolvedPathReferences = evidence.filter(
      (item, index) =>
        hasResolvablePathReference(item) &&
        resolvedByPosition[index] === undefined,
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
    assert.ok(
      resolvedPaths.length > 0,
      "Scoped tool-QA evidence should resolve paths",
    );
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
      resolvedPaths.filter((path) => path.startsWith("tests/benchmark/"))
        .length <=
        resolvedPaths.length / 2,
      `Benchmark tests dominate scoped tool-QA evidence: ${resolvedPaths.join(", ")}`,
    );
  });

  it("ranks SDL tool implementation ahead of seed evaluation scripts", async (t) => {
    if (CORPUS !== "sdl-mcp") {
      t.skip("SDL-specific regression is outside the neutral corpus");
      return;
    }
    if (
      !shouldRunOrdinaryQualityGates(
        RECORD_BASELINE,
        RUN_SEMANTIC_ONLY,
        SELECTED_CASE_ID,
      )
    ) {
      t.skip(
        "baseline-recording, semantic-only, and selected-case runs exclude ordinary quality gates",
      );
      return;
    }
    if (!metrics.repoAvailable) {
      skipOrFail(metrics.availabilityReason);
      return;
    }
    assert.ok(
      contextEngine,
      "ContextEngine must be initialized before benchmarking",
    );
    const c = cases.find(
      ({ id }) => id === "review-broad-sdl-tool-functionality",
    );
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
    assert.equal(
      metrics.totalCases,
      cases.length,
      "Report should cover the selected corpus",
    );
  });
});
