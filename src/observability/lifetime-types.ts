import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_REPO_ID_LENGTH } from "../config/constants.js";

export const SECTION_IDS = [
  "cache", "retrieval", "beam", "delta", "indexing",
  "tokenEfficiency", "predictiveContext", "health", "latency",
  "pool", "scip", "packed", "ppr", "auditBuffer",
  "postIndex", "toolOutput", "resources",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];
export type PersistenceState = "ready" | "degraded" | "readOnly" | "capacityExceeded";
export type RecoveryReason =
  | "unknownSchema"
  | "corruptCandidates"
  | "indeterminatePublication";

export const LIFETIME_SCHEMA_VERSION = 1 as const;
export const MIN_SAMPLE_INTERVAL_MS = 250;
export const MAX_SAMPLE_INTERVAL_MS = 60_000;
export const MAX_STORE_BYTES = 2 * 1024 * 1024;
export const MAX_REPOSITORIES = 32;
export const OVERFLOW_KEY = "__other__";

const MAX_DYNAMIC_KEYS = 32;
const MAX_LARGE_DYNAMIC_KEYS = 128;
const RESET_CONFIRMATION_PREFIX = "RESET REPOSITORY LIFETIME: ";

export type Counter = number;

export interface SampleTotal {
  count: Counter;
  sum: number;
  max: number;
}

export type CounterMap = Record<string, Counter>;
export type SampleMap = Record<string, SampleTotal>;

export interface CacheLifetimeSection {
  hits: Counter;
  misses: Counter;
  lookupMs: SampleTotal;
  perSource: Record<string, {
    hits: Counter;
    misses: Counter;
    lookupMs: SampleTotal;
  }>;
}

export interface RetrievalLifetimeSection {
  calls: Counter;
  emptyResults: Counter;
  latencyMs: SampleTotal;
  byMode: CounterMap;
  byType: CounterMap;
  candidatesBySource: CounterMap;
  phaseLatencyMs: SampleMap;
}

export interface BeamLifetimeSection {
  builds: Counter;
  buildMs: SampleTotal;
  accepted: Counter;
  evicted: Counter;
  rejected: Counter;
  frontierMax: SampleTotal;
  retainedHandlesPeak: Counter;
}

export interface DeltaLifetimeSection {
  computations: Counter;
  blastRadiusMs: SampleTotal;
  dbRoundTrips: SampleTotal;
  pathExplanationMs: SampleTotal;
  fallbackPathQueries: Counter;
}

export interface IndexingLifetimeSection {
  events: Counter;
  pass1Ms: SampleTotal;
  pass2Ms: SampleTotal;
  failures: Counter;
  phaseCounts: CounterMap;
  languageMs: SampleMap;
  engineDispatch: CounterMap;
  derivedLagMs: SampleTotal;
}

export interface CompressionSourceLifetime {
  events: Counter;
  realizedEvents: Counter;
  estimatedTokensAvoided: Counter;
  originalTokens: Counter;
  returnedTokens: Counter;
  savedTokens: Counter;
  opportunities: Counter;
  hits: Counter;
  storedBytes: Counter;
}

export interface TokenEfficiencyLifetimeSection {
  calls: Counter;
  usedTokens: Counter;
  savedTokens: Counter;
  compressionBySource: Record<string, CompressionSourceLifetime>;
}

export interface PredictiveStrategyLifetime {
  samples: Counter;
  hits: Counter;
  wasted: Counter;
  accepted: Counter;
  suppressed: Counter;
  latencyReductionMs: SampleTotal;
}

export interface PredictiveContextLifetimeSection {
  outcomeSamples: Counter;
  hitOutcomes: Counter;
  wasteOutcomes: Counter;
  accepted: Counter;
  suppressed: Counter;
  latencyReductionMs: SampleTotal;
  byStrategy: Record<string, PredictiveStrategyLifetime>;
}

export interface HealthLifetimeSection {
  watcherErrors: Counter;
  watcherRestarts: Counter;
  watchmanWarnings: Counter;
  watchmanRecrawls: Counter;
  watchmanFreshInstances: Counter;
}

export interface CountSampleErrors {
  calls: Counter;
  errors: Counter;
  durationMs: SampleTotal;
}

export interface LatencyLifetimeSection extends CountSampleErrors {
  perTool: Record<string, CountSampleErrors>;
}

export interface ScipLifetimeSection {
  ingests: Counter;
  successes: Counter;
  failures: Counter;
  edgesCreated: Counter;
  edgesUpgraded: Counter;
  ingestMs: SampleTotal;
}

export interface PackedEncoderLifetime {
  decisions: Counter;
  packed: Counter;
  fallback: Counter;
  packedBytes: Counter;
  baselineBytes: Counter;
  packedTokens: Counter;
  baselineTokens: Counter;
}

export interface PackedLifetimeSection extends PackedEncoderLifetime {
  axisHits: CounterMap;
  byEncoder: Record<string, PackedEncoderLifetime>;
}

export interface PprLifetimeSection {
  runs: Counter;
  native: Counter;
  javascript: Counter;
  fallback: Counter;
  computeMs: SampleTotal;
  touched: SampleTotal;
  seeds: SampleTotal;
}

export interface PostIndexLifetimeSection {
  sessions: Counter;
  durationMs: SampleTotal;
  timeouts: Counter;
}

export interface ToolOutputLifetimeCounters {
  calls: Counter;
  errors: Counter;
  rawBytes: Counter;
  projectedBytes: Counter;
  rawTokens: Counter;
  projectedTokens: Counter;
  removedFields: Counter;
  handled: Counter;
  truncated: Counter;
  recoveryEmitted: Counter;
  invalidRecovery: Counter;
  projectedBytesMax: Counter;
  projectedTokensMax: Counter;
  detailCounts: CounterMap;
  profileCounts: CounterMap;
}

export interface ToolOutputLifetimeSection extends ToolOutputLifetimeCounters {
  perTool: Record<string, ToolOutputLifetimeCounters>;
}

export interface DurableLifetimeSections {
  cache: CacheLifetimeSection | null;
  retrieval: RetrievalLifetimeSection | null;
  beam: BeamLifetimeSection | null;
  delta: DeltaLifetimeSection | null;
  indexing: IndexingLifetimeSection | null;
  tokenEfficiency: TokenEfficiencyLifetimeSection | null;
  predictiveContext: PredictiveContextLifetimeSection | null;
  health: HealthLifetimeSection | null;
  latency: LatencyLifetimeSection | null;
  pool: null;
  scip: ScipLifetimeSection | null;
  packed: PackedLifetimeSection | null;
  ppr: PprLifetimeSection | null;
  auditBuffer: null;
  postIndex: PostIndexLifetimeSection | null;
  toolOutput: ToolOutputLifetimeSection | null;
  resources: null;
}

export interface ProcessPeaks {
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  eventLoopLagMs: number;
}

export interface DurableLifetimeRepository {
  epoch: Counter;
  resetAt: string | null;
  lastCheckpointAt: string | null;
  sessionCount: Counter;
  saturated: boolean;
  sections: DurableLifetimeSections;
}

export interface DurableLifetimeRoot {
  schemaVersion: typeof LIFETIME_SCHEMA_VERSION;
  generation: Counter;
  updatedAt: string;
  processPeaks: ProcessPeaks | null;
  repositories: Record<string, DurableLifetimeRepository>;
}

export type LifetimeFreshness = Record<SectionId, string | null>;

export interface LifetimeReadyV1 {
  schemaVersion: typeof LIFETIME_SCHEMA_VERSION;
  sampleIntervalMs: number;
  generatedAt: string;
  repoId: string;
  epoch: Counter;
  resetAt: string | null;
  lastCheckpointAt: string | null;
  persistenceState: PersistenceState;
  sessionCount: Counter;
  saturated: boolean;
  sections: DurableLifetimeSections;
  freshness: LifetimeFreshness;
  processPeaks: ProcessPeaks | null;
}

export interface LifetimeRecoveryV1 {
  schemaVersion: typeof LIFETIME_SCHEMA_VERSION;
  sampleIntervalMs: number;
  generatedAt: string;
  repoId: string;
  persistenceState: "recoveryRequired";
  recoveryReason: RecoveryReason;
}

export type LifetimeEnvelopeV1 = LifetimeReadyV1 | LifetimeRecoveryV1;

export interface LifetimeResetRequest {
  repoId: string;
  confirmation: string;
}

export interface LifetimeResetSuccessV1 {
  schemaVersion: typeof LIFETIME_SCHEMA_VERSION;
  repoId: string;
  epoch: Counter;
  resetAt: string;
  lastCheckpointAt: string;
  persistenceState: "ready";
}

export type LifetimeRouteErrorCode =
  | "invalid_query"
  | "invalid_json"
  | "invalid_body"
  | "repository_not_found"
  | "read_only"
  | "lifetime_capacity_exceeded"
  | "recovery_required"
  | "body_too_large"
  | "unsupported_media_type"
  | "confirmation_mismatch"
  | "persistence_failed"
  | "persistence_indeterminate";

export interface LifetimeRouteErrorV1 {
  schemaVersion: typeof LIFETIME_SCHEMA_VERSION;
  error: {
    code: LifetimeRouteErrorCode;
    message: string;
    retryable: boolean;
  };
}

const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const FiniteTotalSchema = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const IsoTimestampSchema = z.string().max(64).refine(
  (value) => Number.isFinite(Date.parse(value)) && /T/.test(value),
  "Expected an ISO timestamp",
);
const NullableIsoTimestampSchema = IsoTimestampSchema.nullable();
const RepoIdSchema = z.string().min(1).max(MAX_REPO_ID_LENGTH);
const DynamicMapKeySchema = z.string().regex(
  /^(?:__other__|k:[A-Za-z0-9._:-]{1,64})$/,
);
const RepositoryStorageKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const SampleTotalSchema = z.object({
  count: CounterSchema,
  sum: FiniteTotalSchema,
  max: FiniteTotalSchema,
}).strict();

function orderedMap<T extends z.ZodType>(valueSchema: T, maximumKeys: number) {
  return z.record(DynamicMapKeySchema, valueSchema)
    .refine((value) => Object.keys(value).length <= maximumKeys, "Too many map entries")
    .transform((value) => {
      const ordered: Record<string, z.output<T>> = {};
      for (const key of Object.keys(value).sort()) {
        ordered[key] = value[key] as z.output<T>;
      }
      return ordered;
    });
}

const CounterMapSchema = orderedMap(CounterSchema, MAX_DYNAMIC_KEYS);
const SampleMapSchema = orderedMap(SampleTotalSchema, MAX_DYNAMIC_KEYS);

const CacheSourceSchema = z.object({
  hits: CounterSchema,
  misses: CounterSchema,
  lookupMs: SampleTotalSchema,
}).strict();
const CacheSectionSchema = z.object({
  hits: CounterSchema,
  misses: CounterSchema,
  lookupMs: SampleTotalSchema,
  perSource: orderedMap(CacheSourceSchema, MAX_DYNAMIC_KEYS),
}).strict();
const RetrievalSectionSchema = z.object({
  calls: CounterSchema,
  emptyResults: CounterSchema,
  latencyMs: SampleTotalSchema,
  byMode: CounterMapSchema,
  byType: CounterMapSchema,
  candidatesBySource: CounterMapSchema,
  phaseLatencyMs: SampleMapSchema,
}).strict();
const BeamSectionSchema = z.object({
  builds: CounterSchema,
  buildMs: SampleTotalSchema,
  accepted: CounterSchema,
  evicted: CounterSchema,
  rejected: CounterSchema,
  frontierMax: SampleTotalSchema,
  retainedHandlesPeak: CounterSchema,
}).strict();
const DeltaSectionSchema = z.object({
  computations: CounterSchema,
  blastRadiusMs: SampleTotalSchema,
  dbRoundTrips: SampleTotalSchema,
  pathExplanationMs: SampleTotalSchema,
  fallbackPathQueries: CounterSchema,
}).strict();
const IndexingSectionSchema = z.object({
  events: CounterSchema,
  pass1Ms: SampleTotalSchema,
  pass2Ms: SampleTotalSchema,
  failures: CounterSchema,
  phaseCounts: CounterMapSchema,
  languageMs: SampleMapSchema,
  engineDispatch: CounterMapSchema,
  derivedLagMs: SampleTotalSchema,
}).strict();
const CompressionSourceSchema = z.object({
  events: CounterSchema,
  realizedEvents: CounterSchema,
  estimatedTokensAvoided: CounterSchema,
  originalTokens: CounterSchema,
  returnedTokens: CounterSchema,
  savedTokens: CounterSchema,
  opportunities: CounterSchema,
  hits: CounterSchema,
  storedBytes: CounterSchema,
}).strict();
const TokenEfficiencySectionSchema = z.object({
  calls: CounterSchema,
  usedTokens: CounterSchema,
  savedTokens: CounterSchema,
  compressionBySource: orderedMap(CompressionSourceSchema, MAX_DYNAMIC_KEYS),
}).strict();
const PredictiveStrategySchema = z.object({
  samples: CounterSchema,
  hits: CounterSchema,
  wasted: CounterSchema,
  accepted: CounterSchema,
  suppressed: CounterSchema,
  latencyReductionMs: SampleTotalSchema,
}).strict();
const PredictiveContextSectionSchema = z.object({
  outcomeSamples: CounterSchema,
  hitOutcomes: CounterSchema,
  wasteOutcomes: CounterSchema,
  accepted: CounterSchema,
  suppressed: CounterSchema,
  latencyReductionMs: SampleTotalSchema,
  byStrategy: orderedMap(PredictiveStrategySchema, MAX_DYNAMIC_KEYS),
}).strict();
const HealthSectionSchema = z.object({
  watcherErrors: CounterSchema,
  watcherRestarts: CounterSchema,
  watchmanWarnings: CounterSchema,
  watchmanRecrawls: CounterSchema,
  watchmanFreshInstances: CounterSchema,
}).strict();
const CountSampleErrorsSchema = z.object({
  calls: CounterSchema,
  errors: CounterSchema,
  durationMs: SampleTotalSchema,
}).strict();
const LatencySectionSchema = z.object({
  calls: CounterSchema,
  errors: CounterSchema,
  durationMs: SampleTotalSchema,
  perTool: orderedMap(CountSampleErrorsSchema, MAX_LARGE_DYNAMIC_KEYS),
}).strict();
const ScipSectionSchema = z.object({
  ingests: CounterSchema,
  successes: CounterSchema,
  failures: CounterSchema,
  edgesCreated: CounterSchema,
  edgesUpgraded: CounterSchema,
  ingestMs: SampleTotalSchema,
}).strict();
const PackedEncoderSchema = z.object({
  decisions: CounterSchema,
  packed: CounterSchema,
  fallback: CounterSchema,
  packedBytes: CounterSchema,
  baselineBytes: CounterSchema,
  packedTokens: CounterSchema,
  baselineTokens: CounterSchema,
}).strict();
const PackedSectionSchema = z.object({
  decisions: CounterSchema,
  packed: CounterSchema,
  fallback: CounterSchema,
  packedBytes: CounterSchema,
  baselineBytes: CounterSchema,
  packedTokens: CounterSchema,
  baselineTokens: CounterSchema,
  axisHits: CounterMapSchema,
  byEncoder: orderedMap(PackedEncoderSchema, MAX_LARGE_DYNAMIC_KEYS),
}).strict();
const PprSectionSchema = z.object({
  runs: CounterSchema,
  native: CounterSchema,
  javascript: CounterSchema,
  fallback: CounterSchema,
  computeMs: SampleTotalSchema,
  touched: SampleTotalSchema,
  seeds: SampleTotalSchema,
}).strict();
const PostIndexSectionSchema = z.object({
  sessions: CounterSchema,
  durationMs: SampleTotalSchema,
  timeouts: CounterSchema,
}).strict();
const ToolOutputCountersShape = {
  calls: CounterSchema,
  errors: CounterSchema,
  rawBytes: CounterSchema,
  projectedBytes: CounterSchema,
  rawTokens: CounterSchema,
  projectedTokens: CounterSchema,
  removedFields: CounterSchema,
  handled: CounterSchema,
  truncated: CounterSchema,
  recoveryEmitted: CounterSchema,
  invalidRecovery: CounterSchema,
  projectedBytesMax: CounterSchema,
  projectedTokensMax: CounterSchema,
  detailCounts: CounterMapSchema,
  profileCounts: CounterMapSchema,
};
const ToolOutputCountersSchema = z.object(ToolOutputCountersShape).strict();
const ToolOutputSectionSchema = z.object({
  ...ToolOutputCountersShape,
  perTool: orderedMap(ToolOutputCountersSchema, MAX_LARGE_DYNAMIC_KEYS),
}).strict();

const DurableSectionsSchema = z.object({
  cache: CacheSectionSchema.nullable(),
  retrieval: RetrievalSectionSchema.nullable(),
  beam: BeamSectionSchema.nullable(),
  delta: DeltaSectionSchema.nullable(),
  indexing: IndexingSectionSchema.nullable(),
  tokenEfficiency: TokenEfficiencySectionSchema.nullable(),
  predictiveContext: PredictiveContextSectionSchema.nullable(),
  health: HealthSectionSchema.nullable(),
  latency: LatencySectionSchema.nullable(),
  pool: z.null(),
  scip: ScipSectionSchema.nullable(),
  packed: PackedSectionSchema.nullable(),
  ppr: PprSectionSchema.nullable(),
  auditBuffer: z.null(),
  postIndex: PostIndexSectionSchema.nullable(),
  toolOutput: ToolOutputSectionSchema.nullable(),
  resources: z.null(),
}).strict();

const ProcessPeaksSchema = z.object({
  cpuPct: FiniteTotalSchema,
  rssMb: FiniteTotalSchema,
  heapUsedMb: FiniteTotalSchema,
  heapTotalMb: FiniteTotalSchema,
  eventLoopLagMs: FiniteTotalSchema,
}).strict();

const DurableRepositorySchema = z.object({
  epoch: CounterSchema,
  resetAt: NullableIsoTimestampSchema,
  lastCheckpointAt: NullableIsoTimestampSchema,
  sessionCount: CounterSchema,
  saturated: z.boolean(),
  sections: DurableSectionsSchema,
}).strict();

const RepositoriesSchema = z.record(RepositoryStorageKeySchema, DurableRepositorySchema)
  .refine((value) => Object.keys(value).length <= MAX_REPOSITORIES, "Too many repositories")
  .transform((value) => {
    const ordered: Record<string, z.output<typeof DurableRepositorySchema>> = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = value[key];
    }
    return ordered;
  });

const DurableRootSchema = z.object({
  schemaVersion: z.literal(LIFETIME_SCHEMA_VERSION),
  generation: CounterSchema,
  updatedAt: IsoTimestampSchema,
  processPeaks: ProcessPeaksSchema.nullable(),
  repositories: RepositoriesSchema,
}).strict();

const SampleIntervalSchema = z.number().int()
  .min(MIN_SAMPLE_INTERVAL_MS)
  .max(MAX_SAMPLE_INTERVAL_MS);
const PersistenceStateSchema = z.enum(["ready", "degraded", "readOnly", "capacityExceeded"]);
const RecoveryReasonSchema = z.enum([
  "unknownSchema", "corruptCandidates", "indeterminatePublication",
]);
const FreshnessSchema = z.object({
  cache: NullableIsoTimestampSchema,
  retrieval: NullableIsoTimestampSchema,
  beam: NullableIsoTimestampSchema,
  delta: NullableIsoTimestampSchema,
  indexing: NullableIsoTimestampSchema,
  tokenEfficiency: NullableIsoTimestampSchema,
  predictiveContext: NullableIsoTimestampSchema,
  health: NullableIsoTimestampSchema,
  latency: NullableIsoTimestampSchema,
  pool: NullableIsoTimestampSchema,
  scip: NullableIsoTimestampSchema,
  packed: NullableIsoTimestampSchema,
  ppr: NullableIsoTimestampSchema,
  auditBuffer: NullableIsoTimestampSchema,
  postIndex: NullableIsoTimestampSchema,
  toolOutput: NullableIsoTimestampSchema,
  resources: NullableIsoTimestampSchema,
}).strict();
const LifetimeReadySchema = z.object({
  schemaVersion: z.literal(LIFETIME_SCHEMA_VERSION),
  sampleIntervalMs: SampleIntervalSchema,
  generatedAt: IsoTimestampSchema,
  repoId: RepoIdSchema,
  epoch: CounterSchema,
  resetAt: NullableIsoTimestampSchema,
  lastCheckpointAt: NullableIsoTimestampSchema,
  persistenceState: PersistenceStateSchema,
  sessionCount: CounterSchema,
  saturated: z.boolean(),
  sections: DurableSectionsSchema,
  freshness: FreshnessSchema,
  processPeaks: ProcessPeaksSchema.nullable(),
}).strict();
const LifetimeRecoverySchema = z.object({
  schemaVersion: z.literal(LIFETIME_SCHEMA_VERSION),
  sampleIntervalMs: SampleIntervalSchema,
  generatedAt: IsoTimestampSchema,
  repoId: RepoIdSchema,
  persistenceState: z.literal("recoveryRequired"),
  recoveryReason: RecoveryReasonSchema,
}).strict();
const LifetimeEnvelopeSchema = z.union([LifetimeReadySchema, LifetimeRecoverySchema]);
const ResetRequestSchema = z.object({
  repoId: RepoIdSchema,
  confirmation: z.string().min(1).max(RESET_CONFIRMATION_PREFIX.length + MAX_REPO_ID_LENGTH),
}).strict();

export function repositoryStorageKey(repoId: string): string {
  const validatedRepoId = RepoIdSchema.parse(repoId);
  return `sha256:${createHash("sha256").update(validatedRepoId, "utf8").digest("hex")}`;
}

export function parseDurableLifetimeRoot(value: unknown): DurableLifetimeRoot {
  return DurableRootSchema.parse(value) as DurableLifetimeRoot;
}

export function parseLifetimeEnvelope(value: unknown): LifetimeEnvelopeV1 {
  return LifetimeEnvelopeSchema.parse(value) as LifetimeEnvelopeV1;
}

export function parseResetRequest(value: unknown): LifetimeResetRequest {
  return ResetRequestSchema.parse(value);
}
