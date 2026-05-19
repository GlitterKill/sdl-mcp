import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  toNumber,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";

export interface PrefetchOutcomeRow {
  outcomeId: string;
  prefetchId: string;
  aggregateKey: string;
  repoId: string;
  taskType: string;
  clientKey: string;
  strategy: string;
  resourceKind: string;
  resourceKey: string;
  outcome: string;
  latencySavedMs: number;
  tokensSavedEstimate: number;
  plannedCost: number;
  createdAt: string;
}

export interface PrefetchPolicyAggregateRow {
  aggregateKey: string;
  repoId: string;
  taskType: string;
  clientKey: string;
  strategy: string;
  resourceKind: string;
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

export async function upsertPrefetchOutcome(
  conn: Connection,
  row: PrefetchOutcomeRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (p:PrefetchOutcome {outcomeId: $outcomeId})
     SET p.aggregateKey = $aggregateKey,
         p.prefetchId = $prefetchId,
         p.repoId = $repoId,
         p.taskType = $taskType,
         p.clientKey = $clientKey,
         p.strategy = $strategy,
         p.resourceKind = $resourceKind,
         p.resourceKey = $resourceKey,
         p.outcome = $outcome,
         p.latencySavedMs = $latencySavedMs,
         p.tokensSavedEstimate = $tokensSavedEstimate,
         p.plannedCost = $plannedCost,
         p.createdAt = $createdAt`,
    row as unknown as Record<string, unknown>,
  );
}

export async function upsertPrefetchPolicyAggregate(
  conn: Connection,
  row: PrefetchPolicyAggregateRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (p:PrefetchPolicyAggregate {aggregateKey: $aggregateKey})
     SET p.repoId = $repoId,
         p.taskType = $taskType,
         p.clientKey = $clientKey,
         p.strategy = $strategy,
         p.resourceKind = $resourceKind,
         p.offered = $offered,
         p.used = $used,
         p.accepted = $accepted,
         p.wasted = $wasted,
         p.suppressed = $suppressed,
         p.latencySavedMs = $latencySavedMs,
         p.tokensSavedEstimate = $tokensSavedEstimate,
         p.score = $score,
         p.scoreEwma = $scoreEwma,
         p.hitRateEwma = $hitRateEwma,
         p.acceptedRateEwma = $acceptedRateEwma,
         p.wasteRateEwma = $wasteRateEwma,
         p.ewmaSamples = $ewmaSamples,
         p.lastOutcomeAt = $lastOutcomeAt,
         p.updatedAt = $updatedAt`,
    row as unknown as Record<string, unknown>,
  );
}

export async function upsertPrefetchOutcomeAndAggregate(
  conn: Connection,
  outcome: PrefetchOutcomeRow,
  aggregate: PrefetchPolicyAggregateRow,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    await upsertPrefetchOutcome(txConn, outcome);
    await upsertPrefetchPolicyAggregate(txConn, aggregate);
  });
}

export async function getPrefetchPolicyAggregates(
  conn: Connection,
  repoId?: string,
  limit = 1000,
): Promise<PrefetchPolicyAggregateRow[]> {
  assertSafeInt(limit, "limit");
  const safeLimit = Math.min(Math.max(1, limit), 10000);
  const where = repoId ? "WHERE p.repoId = $repoId" : "";
  const rows = await queryAll<PrefetchPolicyAggregateRow>(
    conn,
    `MATCH (p:PrefetchPolicyAggregate)
     ${where}
     RETURN p.aggregateKey AS aggregateKey,
            p.repoId AS repoId,
            p.taskType AS taskType,
            p.clientKey AS clientKey,
            p.strategy AS strategy,
            p.resourceKind AS resourceKind,
            p.offered AS offered,
            p.used AS used,
            p.accepted AS accepted,
            p.wasted AS wasted,
            p.suppressed AS suppressed,
            p.latencySavedMs AS latencySavedMs,
            p.tokensSavedEstimate AS tokensSavedEstimate,
            p.score AS score,
            p.scoreEwma AS scoreEwma,
            p.hitRateEwma AS hitRateEwma,
            p.acceptedRateEwma AS acceptedRateEwma,
            p.wasteRateEwma AS wasteRateEwma,
            p.ewmaSamples AS ewmaSamples,
            p.lastOutcomeAt AS lastOutcomeAt,
            p.updatedAt AS updatedAt
     ORDER BY p.updatedAt DESC
     LIMIT $limit`,
    repoId ? { repoId, limit: safeLimit } : { limit: safeLimit },
  );
  return rows.map((row) => ({
    ...row,
    offered: toNumber(row.offered),
    used: toNumber(row.used),
    accepted: toNumber(row.accepted),
    wasted: toNumber(row.wasted),
    suppressed: toNumber(row.suppressed),
    latencySavedMs: Number(row.latencySavedMs) || 0,
    tokensSavedEstimate: toNumber(row.tokensSavedEstimate),
    score: Number(row.score) || 0,
    scoreEwma: Number(row.scoreEwma) || 0,
    hitRateEwma: Number(row.hitRateEwma) || 0,
    acceptedRateEwma: Number(row.acceptedRateEwma) || 0,
    wasteRateEwma: Number(row.wasteRateEwma) || 0,
    ewmaSamples: toNumber(row.ewmaSamples),
  }));
}

export async function deleteOldPrefetchOutcomes(
  conn: Connection,
  cutoffIso: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (p:PrefetchOutcome)
     WHERE p.createdAt < $cutoffIso
     DELETE p`,
    { cutoffIso },
  );
}

export async function deleteOldPrefetchPolicyAggregates(
  conn: Connection,
  cutoffIso: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (p:PrefetchPolicyAggregate)
     WHERE p.lastOutcomeAt < $cutoffIso OR p.updatedAt < $cutoffIso
     DELETE p`,
    { cutoffIso },
  );
}

export async function deletePrefetchOutcomeStateByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(conn, `MATCH (p:PrefetchOutcome {repoId: $repoId}) DELETE p`, {
    repoId,
  });
  await exec(
    conn,
    `MATCH (p:PrefetchPolicyAggregate {repoId: $repoId}) DELETE p`,
    { repoId },
  );
}
