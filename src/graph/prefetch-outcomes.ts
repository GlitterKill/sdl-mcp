import { createHash, randomUUID } from "node:crypto";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

export type PrefetchPolicyMode = "observe" | "safe";
export type PrefetchOutcomeKind =
  | "offered"
  | "used"
  | "accepted"
  | "wasted"
  | "suppressed";
export type PrefetchResourceKind = "card" | "slice" | "window" | "tool";

export interface PrefetchOutcomeKey {
  repoId: string;
  taskType: string;
  clientKey: string;
  strategy: string;
  resourceKind: PrefetchResourceKind;
}

export interface PrefetchOutcomeEvent extends PrefetchOutcomeKey {
  prefetchId?: string;
  resourceKey: string;
  outcome: PrefetchOutcomeKind;
  latencySavedMs?: number;
  tokensSavedEstimate?: number;
  plannedCost?: number;
  createdAt?: string;
  outcomeId?: string;
  persist?: boolean;
}

export interface PrefetchPolicyConfig {
  enabled: boolean;
  mode: PrefetchPolicyMode;
  minSamples: number;
  suppressionWasteRate: number;
  boostHitRate: number;
  retentionDays: number;
  maxPriorityBoost: number;
  maxBudgetTrimPercent: number;
}

export interface PrefetchPolicyAggregate extends PrefetchOutcomeKey {
  aggregateKey: string;
  offered: number;
  used: number;
  accepted: number;
  wasted: number;
  suppressed: number;
  latencySavedMs: number;
  tokensSavedEstimate: number;
  score: number;
  scoreEwma: number;
  hitRateEwma: number;
  acceptedRateEwma: number;
  wasteRateEwma: number;
  ewmaSamples: number;
  lastOutcomeAt: string;
  updatedAt: string;
}

export interface PrefetchPolicyDecision {
  allowed: boolean;
  priorityBoost: number;
  budgetMultiplier: number;
  reason: string;
  aggregate?: PrefetchPolicyAggregate;
}

export interface PrefetchStrategySummary {
  repoId: string;
  taskType: string;
  clientKey: string;
  strategy: string;
  resourceKind: PrefetchResourceKind;
  samples: number;
  hitRate: number;
  acceptedRate: number;
  wasteRate: number;
  score: number;
  suppressed: number;
  latencySavedMs: number;
  tokensSavedEstimate: number;
}

export type PublicPrefetchStrategySummary = Omit<
  PrefetchStrategySummary,
  "repoId" | "taskType" | "clientKey"
>;

const DEFAULT_PREFETCH_POLICY_CONFIG: PrefetchPolicyConfig = {
  enabled: true,
  mode: "safe",
  minSamples: 20,
  suppressionWasteRate: 0.8,
  boostHitRate: 0.35,
  retentionDays: 14,
  maxPriorityBoost: 25,
  maxBudgetTrimPercent: 50,
};

const OUTCOME_EWMA_ALPHA = 0.5;

let policyConfig: PrefetchPolicyConfig = { ...DEFAULT_PREFETCH_POLICY_CONFIG };
const aggregates = new Map<string, PrefetchPolicyAggregate>();
const outcomeResourceKeys = new Set<string>();
let lastRetentionSweepMs = 0;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizePart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function normalizePrefetchOutcomeKey(
  key: Partial<PrefetchOutcomeKey> & { repoId: string; strategy: string },
): PrefetchOutcomeKey {
  return {
    repoId: normalizePart(key.repoId, "unknown"),
    taskType: normalizePart(key.taskType, "unknown"),
    clientKey: normalizePart(key.clientKey, "stdio"),
    strategy: normalizePart(key.strategy, "unknown"),
    resourceKind: key.resourceKind ?? "card",
  };
}

export function buildPrefetchAggregateKey(key: PrefetchOutcomeKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        key.repoId,
        key.taskType,
        key.clientKey,
        key.strategy,
        key.resourceKind,
      ]),
    )
    .digest("hex");
}

function buildOutcomeResourceKey(event: PrefetchOutcomeEvent): string {
  const aggregateKey = buildPrefetchAggregateKey(normalizePrefetchOutcomeKey(event));
  if (event.prefetchId) {
    return `${aggregateKey}:prefetch:${event.prefetchId}:${event.outcome}`;
  }
  if (event.outcomeId) {
    return `${aggregateKey}:event:${event.outcomeId}`;
  }
  return `${aggregateKey}:legacy:${event.resourceKey}:${event.outcome}`;
}

function emptyAggregate(key: PrefetchOutcomeKey, nowIso: string): PrefetchPolicyAggregate {
  return {
    ...key,
    aggregateKey: buildPrefetchAggregateKey(key),
    offered: 0,
    used: 0,
    accepted: 0,
    wasted: 0,
    suppressed: 0,
    latencySavedMs: 0,
    tokensSavedEstimate: 0,
    score: 0,
    scoreEwma: 0,
    hitRateEwma: 0,
    acceptedRateEwma: 0,
    wasteRateEwma: 0,
    ewmaSamples: 0,
    lastOutcomeAt: nowIso,
    updatedAt: nowIso,
  };
}

function recomputeScore(aggregate: PrefetchPolicyAggregate): void {
  const samples = Math.max(1, aggregate.offered);
  const hitRate = aggregate.used / samples;
  const acceptedRate = aggregate.accepted / samples;
  const wasteRate = aggregate.wasted / samples;
  const suppressedRate = aggregate.suppressed / samples;
  const latencyScore = clamp(aggregate.latencySavedMs / (samples * 100), 0, 1);
  aggregate.score = clamp(
    hitRate * 0.45 +
      acceptedRate * 0.25 +
      latencyScore * 0.2 -
      wasteRate * 0.5 -
      suppressedRate * 0.1,
    -1,
    1,
  );
}

function updateEwma(current: number, sample: number, seenSamples: number): number {
  if (seenSamples <= 0) return sample;
  return current * (1 - OUTCOME_EWMA_ALPHA) + sample * OUTCOME_EWMA_ALPHA;
}

function retentionCutoffIso(now = Date.now()): string {
  return new Date(
    now - policyConfig.retentionDays * 24 * 60 * 60_000,
  ).toISOString();
}

function isAggregateExpired(
  aggregate: PrefetchPolicyAggregate,
  cutoffIso = retentionCutoffIso(),
): boolean {
  const lastOutcomeAt = aggregate.lastOutcomeAt || aggregate.updatedAt;
  return Boolean(lastOutcomeAt && lastOutcomeAt < cutoffIso);
}

function updateOutcomeEwma(
  aggregate: PrefetchPolicyAggregate,
  event: PrefetchOutcomeEvent,
): void {
  const priorSamples = aggregate.ewmaSamples;
  const latencyScore = clamp((event.latencySavedMs ?? 0) / 100, 0, 1);
  let scoreSignal: number | null = null;

  switch (event.outcome) {
    case "used":
      aggregate.hitRateEwma = updateEwma(aggregate.hitRateEwma, 1, priorSamples);
      aggregate.wasteRateEwma = updateEwma(
        aggregate.wasteRateEwma,
        0,
        priorSamples,
      );
      scoreSignal = 0.7 + latencyScore * 0.3;
      break;
    case "accepted":
      aggregate.acceptedRateEwma = updateEwma(
        aggregate.acceptedRateEwma,
        1,
        priorSamples,
      );
      scoreSignal = 0.5;
      break;
    case "wasted":
      aggregate.hitRateEwma = updateEwma(aggregate.hitRateEwma, 0, priorSamples);
      aggregate.acceptedRateEwma = updateEwma(
        aggregate.acceptedRateEwma,
        0,
        priorSamples,
      );
      aggregate.wasteRateEwma = updateEwma(
        aggregate.wasteRateEwma,
        1,
        priorSamples,
      );
      scoreSignal = -1;
      break;
    case "suppressed":
      scoreSignal = -0.2;
      break;
    case "offered":
      return;
  }

  if (scoreSignal === null) return;
  aggregate.scoreEwma = updateEwma(
    aggregate.scoreEwma,
    clamp(scoreSignal, -1, 1),
    priorSamples,
  );
  aggregate.ewmaSamples += 1;
}

function aggregateToRow(
  aggregate: PrefetchPolicyAggregate,
): ladybugDb.PrefetchPolicyAggregateRow {
  return {
    aggregateKey: aggregate.aggregateKey,
    repoId: aggregate.repoId,
    taskType: aggregate.taskType,
    clientKey: aggregate.clientKey,
    strategy: aggregate.strategy,
    resourceKind: aggregate.resourceKind,
    offered: aggregate.offered,
    used: aggregate.used,
    accepted: aggregate.accepted,
    wasted: aggregate.wasted,
    suppressed: aggregate.suppressed,
    latencySavedMs: aggregate.latencySavedMs,
    tokensSavedEstimate: aggregate.tokensSavedEstimate,
    score: aggregate.score,
    scoreEwma: aggregate.scoreEwma,
    hitRateEwma: aggregate.hitRateEwma,
    acceptedRateEwma: aggregate.acceptedRateEwma,
    wasteRateEwma: aggregate.wasteRateEwma,
    ewmaSamples: aggregate.ewmaSamples,
    lastOutcomeAt: aggregate.lastOutcomeAt,
    updatedAt: aggregate.updatedAt,
  };
}

async function persistOutcome(
  event: PrefetchOutcomeEvent,
  aggregate: PrefetchPolicyAggregate,
): Promise<void> {
  await withWriteConn(async (conn) => {
    const nowIso = event.createdAt ?? new Date().toISOString();
    await ladybugDb.upsertPrefetchOutcomeAndAggregate(
      conn,
      {
        outcomeId: event.outcomeId ?? randomUUID(),
        prefetchId: event.prefetchId ?? "",
        aggregateKey: aggregate.aggregateKey,
        repoId: aggregate.repoId,
        taskType: aggregate.taskType,
        clientKey: aggregate.clientKey,
        strategy: aggregate.strategy,
        resourceKind: aggregate.resourceKind,
        resourceKey: event.resourceKey,
        outcome: event.outcome,
        latencySavedMs: event.latencySavedMs ?? 0,
        tokensSavedEstimate: event.tokensSavedEstimate ?? 0,
        plannedCost: event.plannedCost ?? 0,
        createdAt: nowIso,
      },
      aggregateToRow(aggregate),
    );
  });
}

function maybePersistOutcome(
  event: PrefetchOutcomeEvent,
  aggregate: PrefetchPolicyAggregate,
): void {
  if (event.persist === false) return;
  void persistOutcome(event, aggregate).catch((error) => {
    logger.debug("[prefetch-policy] outcome persistence skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function pruneExpiredAggregates(cutoffIso: string, repoId?: string): void {
  for (const [key, aggregate] of aggregates.entries()) {
    if (repoId && aggregate.repoId !== repoId) continue;
    if (isAggregateExpired(aggregate, cutoffIso)) {
      aggregates.delete(key);
    }
  }
}

function maybeSweepRetention(): void {
  const now = Date.now();
  if (now - lastRetentionSweepMs < 60 * 60_000) return;
  lastRetentionSweepMs = now;
  const cutoff = retentionCutoffIso(now);
  pruneExpiredAggregates(cutoff);
  void withWriteConn(async (conn) => {
    await ladybugDb.deleteOldPrefetchOutcomes(conn, cutoff);
    await ladybugDb.deleteOldPrefetchPolicyAggregates(conn, cutoff);
  }).catch((error) => {
      logger.debug("[prefetch-policy] retention sweep skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function configurePrefetchPolicy(
  config: Partial<PrefetchPolicyConfig>,
): PrefetchPolicyConfig {
  policyConfig = {
    ...policyConfig,
    ...config,
    mode: config.mode ?? policyConfig.mode,
    minSamples: Math.max(1, Math.floor(config.minSamples ?? policyConfig.minSamples)),
    suppressionWasteRate: clamp(
      config.suppressionWasteRate ?? policyConfig.suppressionWasteRate,
      0,
      1,
    ),
    boostHitRate: clamp(config.boostHitRate ?? policyConfig.boostHitRate, 0, 1),
    retentionDays: Math.max(1, Math.floor(config.retentionDays ?? policyConfig.retentionDays)),
    maxPriorityBoost: Math.max(
      0,
      Math.floor(config.maxPriorityBoost ?? policyConfig.maxPriorityBoost),
    ),
    maxBudgetTrimPercent: clamp(
      config.maxBudgetTrimPercent ?? policyConfig.maxBudgetTrimPercent,
      0,
      90,
    ),
  };
  return getPrefetchPolicyConfig();
}

export function getPrefetchPolicyConfig(): PrefetchPolicyConfig {
  return { ...policyConfig };
}

export function recordPrefetchOutcome(
  event: PrefetchOutcomeEvent,
): PrefetchPolicyAggregate {
  const key = normalizePrefetchOutcomeKey(event);
  const aggregateKey = buildPrefetchAggregateKey(key);
  const nowIso = event.createdAt ?? new Date().toISOString();
  const existingAggregate = aggregates.get(aggregateKey);
  const aggregate =
    existingAggregate && !isAggregateExpired(existingAggregate)
      ? existingAggregate
      : emptyAggregate(key, nowIso);
  if (existingAggregate && existingAggregate !== aggregate) {
    aggregates.delete(aggregateKey);
  }
  const dedupeKey = buildOutcomeResourceKey(event);

  // Outcome rows are scoped to a concrete prefetch attempt when `prefetchId`
  // is available. That lets a hot card produce multiple useful samples while
  // still preventing repeated status polling from recounting the same stale
  // entry as wasted.
  const counted = !outcomeResourceKeys.has(dedupeKey);
  if (counted) {
    outcomeResourceKeys.add(dedupeKey);
    switch (event.outcome) {
      case "offered":
        aggregate.offered += 1;
        break;
      case "used":
        aggregate.used += 1;
        aggregate.latencySavedMs += Math.max(0, event.latencySavedMs ?? 0);
        aggregate.tokensSavedEstimate += Math.max(0, event.tokensSavedEstimate ?? 0);
        break;
      case "accepted":
        aggregate.accepted += 1;
        break;
      case "wasted":
        aggregate.wasted += 1;
        break;
      case "suppressed":
        aggregate.suppressed += 1;
        break;
    }
    updateOutcomeEwma(aggregate, event);
    aggregate.lastOutcomeAt = nowIso;
    aggregate.updatedAt = nowIso;
    recomputeScore(aggregate);
    aggregates.set(aggregateKey, aggregate);
    maybePersistOutcome(event, aggregate);
    maybeSweepRetention();
  }
  return { ...aggregate };
}

export function getPrefetchPolicyAggregate(
  key: Partial<PrefetchOutcomeKey> & { repoId: string; strategy: string },
): PrefetchPolicyAggregate | null {
  const normalized = normalizePrefetchOutcomeKey(key);
  const aggregateKey = buildPrefetchAggregateKey(normalized);
  const aggregate = aggregates.get(aggregateKey);
  if (aggregate && isAggregateExpired(aggregate)) {
    aggregates.delete(aggregateKey);
    return null;
  }
  return aggregate ? { ...aggregate } : null;
}

export function getPrefetchPolicyDecision(
  key: Partial<PrefetchOutcomeKey> & { repoId: string; strategy: string },
): PrefetchPolicyDecision {
  const normalized = normalizePrefetchOutcomeKey(key);
  const aggregateKey = buildPrefetchAggregateKey(normalized);
  let aggregate = aggregates.get(aggregateKey);
  if (aggregate && isAggregateExpired(aggregate)) {
    aggregates.delete(aggregateKey);
    aggregate = undefined;
  }
  if (!policyConfig.enabled) {
    return { allowed: true, priorityBoost: 0, budgetMultiplier: 1, reason: "policy-disabled" };
  }
  if (policyConfig.mode === "observe") {
    return { allowed: true, priorityBoost: 0, budgetMultiplier: 1, reason: "observe" };
  }
  if (!aggregate || aggregate.offered < policyConfig.minSamples) {
    return {
      allowed: true,
      priorityBoost: 0,
      budgetMultiplier: 1,
      reason: "insufficient-samples",
      aggregate,
    };
  }

  const cumulativeHitRate = aggregate.used / Math.max(1, aggregate.offered);
  const cumulativeWasteRate = aggregate.wasted / Math.max(1, aggregate.offered);
  const hasEwma = aggregate.ewmaSamples > 0;
  const hitRate = hasEwma ? aggregate.hitRateEwma : cumulativeHitRate;
  const wasteRate = hasEwma ? aggregate.wasteRateEwma : cumulativeWasteRate;
  if (wasteRate >= policyConfig.suppressionWasteRate && hitRate < policyConfig.boostHitRate) {
    return {
      allowed: false,
      priorityBoost: 0,
      budgetMultiplier: 0,
      reason: "suppressed-high-waste",
      aggregate: { ...aggregate },
    };
  }

  const positiveSignal = Math.max(
    0,
    hasEwma ? aggregate.scoreEwma : aggregate.score,
  );
  const priorityBoost =
    hitRate >= policyConfig.boostHitRate
      ? Math.round(policyConfig.maxPriorityBoost * Math.min(1, positiveSignal))
      : 0;
  const trimRatio =
    wasteRate > 0.5
      ? (Math.min(policyConfig.maxBudgetTrimPercent, 50) / 100) * wasteRate
      : 0;

  return {
    allowed: true,
    priorityBoost,
    budgetMultiplier: clamp(1 - trimRatio, 0.1, 1),
    reason: priorityBoost > 0 ? "boosted-positive-outcomes" : "allowed-neutral",
    aggregate: { ...aggregate },
  };
}

export function getTopPrefetchStrategySummaries(
  repoId?: string,
  limit = 5,
): PrefetchStrategySummary[] {
  const cutoffIso = retentionCutoffIso();
  const summaries = Array.from(aggregates.values())
    .filter(
      (aggregate) =>
        (!repoId || aggregate.repoId === repoId) &&
        !isAggregateExpired(aggregate, cutoffIso),
    )
    .map((aggregate) => {
      const samples = aggregate.offered;
      const denominator = Math.max(1, samples);
      return {
        repoId: aggregate.repoId,
        taskType: aggregate.taskType,
        clientKey: aggregate.clientKey,
        strategy: aggregate.strategy,
        resourceKind: aggregate.resourceKind,
        samples,
        hitRate: aggregate.used / denominator,
        acceptedRate: aggregate.accepted / denominator,
        wasteRate: aggregate.wasted / denominator,
        score: aggregate.score,
        suppressed: aggregate.suppressed,
        latencySavedMs: aggregate.latencySavedMs,
        tokensSavedEstimate: aggregate.tokensSavedEstimate,
      };
    })
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return summaries.slice(0, Math.max(0, limit));
}

export function getPrefetchOutcomeSampleCount(repoId?: string): number {
  const cutoffIso = retentionCutoffIso();
  return Array.from(aggregates.values())
    .filter(
      (aggregate) =>
        (!repoId || aggregate.repoId === repoId) &&
        !isAggregateExpired(aggregate, cutoffIso),
    )
    .reduce((sum, aggregate) => sum + aggregate.offered, 0);
}

export async function hydratePrefetchPolicyFromDb(repoId?: string): Promise<number> {
  try {
    const conn = await getLadybugConn();
    const rows = await ladybugDb.getPrefetchPolicyAggregates(conn, repoId, 10000);
    const cutoffIso = retentionCutoffIso();
    pruneExpiredAggregates(cutoffIso, repoId);
    let hydrated = 0;
    for (const row of rows) {
      const lastOutcomeAt = row.lastOutcomeAt || row.updatedAt;
      if (lastOutcomeAt && lastOutcomeAt < cutoffIso) continue;
      const aggregate: PrefetchPolicyAggregate = {
        aggregateKey: row.aggregateKey,
        repoId: row.repoId,
        taskType: row.taskType,
        clientKey: row.clientKey,
        strategy: row.strategy,
        resourceKind: row.resourceKind as PrefetchResourceKind,
        offered: row.offered,
        used: row.used,
        accepted: row.accepted,
        wasted: row.wasted,
        suppressed: row.suppressed,
        latencySavedMs: row.latencySavedMs,
        tokensSavedEstimate: row.tokensSavedEstimate,
        score: row.score,
        scoreEwma: row.scoreEwma ?? row.score,
        hitRateEwma: row.hitRateEwma ?? 0,
        acceptedRateEwma: row.acceptedRateEwma ?? 0,
        wasteRateEwma: row.wasteRateEwma ?? 0,
        ewmaSamples: row.ewmaSamples ?? 0,
        lastOutcomeAt: row.lastOutcomeAt,
        updatedAt: row.updatedAt,
      };
      aggregates.set(aggregate.aggregateKey, aggregate);
      hydrated += 1;
    }
    return hydrated;
  } catch (error) {
    logger.debug("[prefetch-policy] aggregate hydration skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export function resetPrefetchOutcomeStateForTests(): void {
  aggregates.clear();
  outcomeResourceKeys.clear();
  lastRetentionSweepMs = 0;
  policyConfig = { ...DEFAULT_PREFETCH_POLICY_CONFIG };
}
