import { randomUUID } from "node:crypto";
import { cpus, loadavg, platform } from "os";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import { estimateTokens } from "../util/tokenize.js";
import {
  predictNextToolFromRecent,
  computePriorityBoost,
  recordStrategyMetrics,
  recordWastedPrefetch,
  getAllStrategyMetrics,
  getCurrentModel,
  getGatingConfig,
  type StrategyMetrics,
} from "./prefetch-model.js";
import {
  getPrefetchOutcomeSampleCount,
  getPrefetchPolicyConfig,
  getPrefetchPolicyDecision,
  getTopPrefetchStrategySummaries,
  recordPrefetchOutcome,
  invalidateRepoPrefetchOutcomeState,
  type PrefetchResourceKind,
  type PublicPrefetchStrategySummary,
} from "./prefetch-outcomes.js";

type PrefetchTaskType =
  | "slice-frontier"
  | "search-cards"
  | "file-open"
  | "delta-blast"
  | "startup-warm";

export interface PrefetchRequestContext {
  taskType?: string;
  clientKey?: string;
}

interface ResolvedPrefetchContext {
  taskType: string;
  clientKey: string;
}

interface PrefetchTask {
  repoId: string;
  key: string;
  priority: number;
  type: PrefetchTaskType;
  resourceKind: PrefetchResourceKind;
  context: ResolvedPrefetchContext;
  run: () => Promise<void>;
  modelBoosted?: boolean;
  policyApplied?: boolean;
}

interface PrefetchEntry {
  prefetchId: string;
  key: string;
  strategy: PrefetchTaskType | string;
  resourceKind: PrefetchResourceKind;
  resourceKey: string;
  createdAt: number;
  expiresAt: number;
  taskType: string;
  clientKey: string;
  plannedCost: number;
}

export interface ConsumePrefetchOutcome {
  hit: boolean;
  outcome: "hit" | "miss";
  key: string;
  strategy: string;
  resourceKind: PrefetchResourceKind;
  latencyReductionMs: number;
}

export interface PrefetchStats {
  enabled: boolean;
  queueDepth: number;
  running: boolean;
  completed: number;
  cancelled: number;
  cacheHits: number;
  cacheMisses: number;
  wastedPrefetch: number;
  hitRate: number;
  wasteRate: number;
  avgLatencyReductionMs: number;
  lastRunAt: string | null;
  modelEnabled: boolean;
  strategyMetrics: StrategyMetrics[];
  deterministicFallback: boolean;
  policyMode: "disabled" | "observe" | "safe";
  outcomeSamples: number;
  suppressedPrefetch: number;
  acceptedPrefetch: number;
  topStrategies: PublicPrefetchStrategySummary[];
}

const queue: PrefetchTask[] = [];
const MAX_PREFETCH_QUEUE_SIZE = 200;
const MAX_PREFETCH_ENTRIES_PER_REPO = 500;
const PREFETCH_STALE_MS = 5 * 60_000;
const DEFAULT_LATENCY_REDUCTION_MS = 35;
const PREFETCH_ENTRY_KEY_SEPARATOR = "\u0000";
const BASE_PLANNED_TOKENS_BY_KIND: Record<PrefetchResourceKind, number> = {
  card: 220,
  slice: 900,
  window: 1200,
  tool: 500,
};
const prefetchedKeysByRepo = new Map<string, Map<string, PrefetchEntry>>();
const statsByRepo = new Map<string, PrefetchStats>();
let running = false;
let enabled = false;
let maxBudgetPercent = 20;
let loadSheddingEnabled = true;

function resolveContext(
  context?: PrefetchRequestContext,
): ResolvedPrefetchContext {
  return {
    taskType: context?.taskType?.trim() || "unknown",
    clientKey: context?.clientKey?.trim() || "stdio",
  };
}

function inferResourceKind(key: string): PrefetchResourceKind {
  if (key.startsWith("slice:")) return "slice";
  if (key.startsWith("window:")) return "window";
  if (key.startsWith("blast:") || key.startsWith("tool:")) return "tool";
  return "card";
}

function buildPrefetchEntryKey(
  resourceKey: string,
  context: ResolvedPrefetchContext,
): string {
  return [
    resourceKey,
    context.taskType,
    context.clientKey,
  ].join(PREFETCH_ENTRY_KEY_SEPARATOR);
}

function hasAttributionContext(context?: PrefetchRequestContext): boolean {
  return Boolean(context?.taskType?.trim() || context?.clientKey?.trim());
}

function estimatePlannedTokenCost(
  resourceKind: PrefetchResourceKind,
  resourceKey: string,
): number {
  // Prefetches cache structured cards/slices/tool results, not just the key.
  // These conservative baselines keep policy telemetry useful before exact
  // payload sizes are available at prefetch registration time.
  return BASE_PLANNED_TOKENS_BY_KIND[resourceKind] + estimateTokens(resourceKey);
}

function findPrefetchEntry(
  map: Map<string, PrefetchEntry> | undefined,
  key: string,
  context?: PrefetchRequestContext,
): { mapKey: string; entry: PrefetchEntry } | null {
  if (!map) return null;

  if (hasAttributionContext(context)) {
    const exactKey = buildPrefetchEntryKey(key, resolveContext(context));
    const exact = map.get(exactKey);
    return exact ? { mapKey: exactKey, entry: exact } : null;
  }

  const legacy = map.get(key);
  if (legacy) return { mapKey: key, entry: legacy };

  for (const [mapKey, entry] of map.entries()) {
    if (entry.resourceKey === key) {
      return { mapKey, entry };
    }
  }
  return null;
}

function getOrCreateStats(repoId: string): PrefetchStats {
  const existing = statsByRepo.get(repoId);
  if (existing) {
    return existing;
  }
  const gating = getGatingConfig();
  const policy = getPrefetchPolicyConfig();
  const initial: PrefetchStats = {
    enabled,
    queueDepth: 0,
    running: false,
    completed: 0,
    cancelled: 0,
    cacheHits: 0,
    cacheMisses: 0,
    wastedPrefetch: 0,
    hitRate: 0,
    wasteRate: 0,
    avgLatencyReductionMs: 0,
    lastRunAt: null,
    modelEnabled: gating.enabled,
    strategyMetrics: [],
    deterministicFallback: !gating.enabled || getCurrentModel() === null,
    policyMode: policy.enabled ? policy.mode : "disabled",
    outcomeSamples: 0,
    suppressedPrefetch: 0,
    acceptedPrefetch: 0,
    topStrategies: [],
  };
  statsByRepo.set(repoId, initial);
  return initial;
}

function updateRates(stats: PrefetchStats): void {
  const total = stats.cacheHits + stats.cacheMisses;
  stats.hitRate = total > 0 ? stats.cacheHits / total : 0;
  const consumedOrExpired = stats.cacheHits + stats.wastedPrefetch;
  stats.wasteRate =
    consumedOrExpired > 0 ? stats.wastedPrefetch / consumedOrExpired : 0;
}

function refreshPolicyStats(repoId: string, stats: PrefetchStats): void {
  const policy = getPrefetchPolicyConfig();
  stats.policyMode = policy.enabled ? policy.mode : "disabled";
  stats.outcomeSamples = getPrefetchOutcomeSampleCount(repoId);
  stats.topStrategies = getTopPrefetchStrategySummaries(repoId, 5).map(
    ({ repoId: _repoId, taskType: _taskType, clientKey: _clientKey, ...safe }) =>
      safe,
  );
}

function currentCpuLoadRatio(): number {
  if (platform() === "win32") {
    return 0;
  }
  const avg = loadavg()[0] || 0;
  const cpuCount = Math.max(1, cpus().length);
  return avg / cpuCount;
}

function shouldYieldForLoad(): boolean {
  return loadSheddingEnabled && currentCpuLoadRatio() > 0.8;
}

function policyKeyForTask(task: PrefetchTask): {
  repoId: string;
  taskType: string;
  clientKey: string;
  strategy: string;
  resourceKind: PrefetchResourceKind;
} {
  return {
    repoId: task.repoId,
    taskType: task.context.taskType,
    clientKey: task.context.clientKey,
    strategy: task.type,
    resourceKind: task.resourceKind,
  };
}

function recordSuppressedTask(task: PrefetchTask): void {
  const stats = getOrCreateStats(task.repoId);
  stats.suppressedPrefetch += 1;
  recordPrefetchOutcome({
    ...policyKeyForTask(task),
    prefetchId: randomUUID(),
    resourceKey: task.key,
    outcome: "suppressed",
  });
  refreshPolicyStats(task.repoId, stats);
}

function applyPolicyToTask(task: PrefetchTask): boolean {
  if (task.policyApplied) return true;
  const decision = getPrefetchPolicyDecision(policyKeyForTask(task));
  task.policyApplied = true;
  if (!decision.allowed) {
    recordSuppressedTask(task);
    return false;
  }
  if (decision.priorityBoost > 0) {
    task.priority += decision.priorityBoost;
    task.modelBoosted = true;
  }
  return true;
}

function decisionForStrategy(
  repoId: string,
  strategy: PrefetchTaskType,
  resourceKind: PrefetchResourceKind,
  context: ResolvedPrefetchContext,
): ReturnType<typeof getPrefetchPolicyDecision> {
  return getPrefetchPolicyDecision({
    repoId,
    strategy,
    resourceKind,
    taskType: context.taskType,
    clientKey: context.clientKey,
  });
}

function boundedLimit(
  requested: number,
  max: number,
  budgetMultiplier: number,
): number {
  if (requested <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(requested, Math.floor(max * budgetMultiplier)));
}

async function runQueue(): Promise<void> {
  if (running || !enabled) {
    return;
  }
  running = true;
  try {
    const predictedTool = predictNextToolFromRecent();
    while (queue.length > 0) {
      for (const task of queue) {
        const boost = computePriorityBoost(task.type, predictedTool);
        if (boost > 0 && !task.modelBoosted) {
          task.priority += boost;
          task.modelBoosted = true;
        }
      }
      queue.sort((a, b) => b.priority - a.priority);
      const task = queue.shift();
      if (!task) break;

      const stats = getOrCreateStats(task.repoId);
      stats.running = true;
      stats.queueDepth = queue.length;

      if (shouldYieldForLoad()) {
        stats.cancelled += 1;
        recordWastedPrefetch(task.type);
        stats.running = false;
        continue;
      }

      try {
        await task.run();
        stats.completed += 1;
        stats.lastRunAt = new Date().toISOString();
      } catch (error) {
        logger.debug("Prefetch task execution failed", {
          repoId: task.repoId,
          taskType: task.type,
          key: task.key,
          error: error instanceof Error ? error.message : String(error),
        });
        stats.cancelled += 1;
        recordWastedPrefetch(task.type);
      } finally {
        stats.running = false;
      }
    }
  } finally {
    running = false;
    for (const [repoId, stats] of statsByRepo.entries()) {
      stats.queueDepth = queue.length;
      stats.running = false;
      updateRates(stats);
      stats.strategyMetrics = getAllStrategyMetrics();
      const gating = getGatingConfig();
      stats.modelEnabled = gating.enabled;
      stats.deterministicFallback =
        !gating.enabled || getCurrentModel() === null;
      refreshPolicyStats(repoId, stats);
    }
  }
}

function recordWastedEntry(repoId: string, entry: PrefetchEntry): void {
  const stats = getOrCreateStats(repoId);
  stats.wastedPrefetch += 1;
  recordWastedPrefetch(entry.strategy);
  recordPrefetchOutcome({
    repoId,
    prefetchId: entry.prefetchId,
    taskType: entry.taskType,
    clientKey: entry.clientKey,
    strategy: entry.strategy,
    resourceKind: entry.resourceKind,
    resourceKey: entry.resourceKey,
    outcome: "wasted",
    plannedCost: entry.plannedCost,
  });
  updateRates(stats);
  refreshPolicyStats(repoId, stats);
}

function expireStalePrefetches(repoId: string, now = Date.now()): void {
  const map = prefetchedKeysByRepo.get(repoId);
  if (!map) return;
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt <= now) {
      map.delete(key);
      recordWastedEntry(repoId, entry);
    }
  }
}

function evictOldestPrefetch(
  repoId: string,
  map: Map<string, PrefetchEntry>,
): void {
  let oldestKey: string | null = null;
  let oldestCreatedAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of map.entries()) {
    if (entry.createdAt < oldestCreatedAt) {
      oldestCreatedAt = entry.createdAt;
      oldestKey = key;
    }
  }
  if (!oldestKey) return;
  const entry = map.get(oldestKey);
  map.delete(oldestKey);
  if (entry) recordWastedEntry(repoId, entry);
}

function markPrefetched(
  repoId: string,
  key: string,
  metadata: {
    strategy: PrefetchTaskType;
    resourceKind?: PrefetchResourceKind;
    context: ResolvedPrefetchContext;
    plannedCost?: number;
  },
): void {
  const map = prefetchedKeysByRepo.get(repoId) ?? new Map<string, PrefetchEntry>();
  prefetchedKeysByRepo.set(repoId, map);
  const now = Date.now();
  expireStalePrefetches(repoId, now);
  const resourceKind = metadata.resourceKind ?? inferResourceKind(key);
  const entryKey = buildPrefetchEntryKey(key, metadata.context);
  const existing = map.get(entryKey);
  if (existing) {
    map.delete(entryKey);
    recordWastedEntry(repoId, existing);
  }
  const entry: PrefetchEntry = {
    prefetchId: randomUUID(),
    key,
    strategy: metadata.strategy,
    resourceKind,
    resourceKey: key,
    createdAt: now,
    expiresAt: now + PREFETCH_STALE_MS,
    taskType: metadata.context.taskType,
    clientKey: metadata.context.clientKey,
    plannedCost:
      metadata.plannedCost ?? estimatePlannedTokenCost(resourceKind, key),
  };
  map.set(entryKey, entry);
  recordPrefetchOutcome({
    repoId,
    prefetchId: entry.prefetchId,
    taskType: entry.taskType,
    clientKey: entry.clientKey,
    strategy: entry.strategy,
    resourceKind: entry.resourceKind,
    resourceKey: entry.resourceKey,
    outcome: "offered",
    plannedCost: entry.plannedCost,
  });
  if (map.size > MAX_PREFETCH_ENTRIES_PER_REPO) {
    expireStalePrefetches(repoId, now);
  }
  while (map.size > MAX_PREFETCH_ENTRIES_PER_REPO) {
    evictOldestPrefetch(repoId, map);
  }
}

export function configurePrefetch(options: {
  enabled: boolean;
  maxBudgetPercent: number;
}): void {
  enabled = options.enabled;
  maxBudgetPercent = Math.max(1, Math.min(100, options.maxBudgetPercent));
  for (const stats of statsByRepo.values()) {
    stats.enabled = enabled;
  }
}

export function enqueuePrefetchTask(task: PrefetchTask): void {
  if (!enabled) {
    return;
  }
  if (!applyPolicyToTask(task)) {
    return;
  }
  if (queue.length >= MAX_PREFETCH_QUEUE_SIZE) {
    queue.sort((a, b) => b.priority - a.priority);
    const lowestPriorityTask = queue[queue.length - 1];
    if (lowestPriorityTask && task.priority <= lowestPriorityTask.priority) {
      return;
    }
    const dropped = queue.pop();
    if (dropped) {
      logger.debug("[prefetch] Queue full, dropped lowest-priority task", {
        droppedKey: dropped.key,
        droppedPriority: dropped.priority,
        newTaskKey: task.key,
        newTaskPriority: task.priority,
      });
    }
  }
  queue.push(task);
  const stats = getOrCreateStats(task.repoId);
  stats.queueDepth = queue.length;
  void runQueue();
}

export function prefetchSliceFrontier(
  repoId: string,
  seedSymbolIds: string[],
  context?: PrefetchRequestContext,
): void {
  const resolved = resolveContext(context);
  const decision = decisionForStrategy(repoId, "slice-frontier", "card", resolved);
  if (!decision.allowed) {
    recordSuppressedTask({
      repoId,
      key: `slice-frontier:${seedSymbolIds.join(",")}`,
      type: "slice-frontier",
      resourceKind: "card",
      context: resolved,
      priority: 60,
      policyApplied: true,
      run: async () => {},
    });
    return;
  }
  const budgetCap = Math.max(
    1,
    Math.floor(seedSymbolIds.length * (maxBudgetPercent / 100)),
  );
  const seeds = seedSymbolIds.slice(
    0,
    boundedLimit(seedSymbolIds.length, budgetCap, decision.budgetMultiplier),
  );
  enqueuePrefetchTask({
    repoId,
    key: `slice-frontier:${seeds.join(",")}`,
    type: "slice-frontier",
    resourceKind: "card",
    context: resolved,
    priority: 60 + decision.priorityBoost,
    policyApplied: true,
    run: async () => {
      const conn = await getLadybugConn();
      for (const symbolId of seeds) {
        const edges = (await ladybugDb.getEdgesFrom(conn, symbolId)).slice(0, 5);
        for (const edge of edges) {
          markPrefetched(repoId, `card:${edge.toSymbolId}`, {
            strategy: "slice-frontier",
            resourceKind: "card",
            context: resolved,
          });
        }
      }
    },
  });
}

export function prefetchCardsForSymbols(
  repoId: string,
  symbolIds: string[],
  context?: PrefetchRequestContext,
): void {
  const resolved = resolveContext(context);
  const decision = decisionForStrategy(repoId, "search-cards", "card", resolved);
  if (!decision.allowed) {
    recordSuppressedTask({
      repoId,
      key: `search-cards:${symbolIds.join(",")}`,
      type: "search-cards",
      resourceKind: "card",
      context: resolved,
      priority: 70,
      policyApplied: true,
      run: async () => {},
    });
    return;
  }
  const top = symbolIds.slice(
    0,
    boundedLimit(symbolIds.length, 5, decision.budgetMultiplier),
  );
  if (top.length === 0) return;
  enqueuePrefetchTask({
    repoId,
    key: `search-cards:${top.join(",")}`,
    type: "search-cards",
    resourceKind: "card",
    context: resolved,
    priority: 70 + decision.priorityBoost,
    policyApplied: true,
    run: async () => {
      for (const symbolId of top) {
        markPrefetched(repoId, `card:${symbolId}`, {
          strategy: "search-cards",
          resourceKind: "card",
          context: resolved,
        });
      }
    },
  });
}

export function prefetchFileExports(
  repoId: string,
  filePath: string,
  context?: PrefetchRequestContext,
): void {
  const resolved = resolveContext(context);
  const decision = decisionForStrategy(repoId, "file-open", "slice", resolved);
  if (!decision.allowed) {
    recordSuppressedTask({
      repoId,
      key: `file-open:${filePath}`,
      type: "file-open",
      resourceKind: "slice",
      context: resolved,
      priority: 40,
      policyApplied: true,
      run: async () => {},
    });
    return;
  }
  enqueuePrefetchTask({
    repoId,
    key: `file-open:${filePath}`,
    type: "file-open",
    resourceKind: "slice",
    context: resolved,
    priority: 40 + decision.priorityBoost,
    policyApplied: true,
    run: async () => {
      const conn = await getLadybugConn();
      const file = await ladybugDb.getFileByRepoPath(conn, repoId, filePath);
      if (!file) return;
      const symbols = (await ladybugDb.getSymbolsByFile(conn, file.fileId)).filter(
        (symbol) => symbol.exported,
      );
      const limit = boundedLimit(
        symbols.length,
        symbols.length,
        decision.budgetMultiplier,
      );
      for (const symbol of symbols.slice(0, limit)) {
        markPrefetched(repoId, `slice:${symbol.symbolId}`, {
          strategy: "file-open",
          resourceKind: "slice",
          context: resolved,
        });
      }
    },
  });
}

export function prefetchDeltaBlastRadius(
  repoId: string,
  symbolIds: string[],
  context?: PrefetchRequestContext,
): void {
  const resolved = resolveContext(context);
  const decision = decisionForStrategy(repoId, "delta-blast", "tool", resolved);
  if (!decision.allowed) {
    recordSuppressedTask({
      repoId,
      key: `delta-blast:${symbolIds.join(",")}`,
      type: "delta-blast",
      resourceKind: "tool",
      context: resolved,
      priority: 80,
      policyApplied: true,
      run: async () => {},
    });
    return;
  }
  const budgetCap = Math.max(
    1,
    Math.floor(symbolIds.length * (maxBudgetPercent / 100)),
  );
  const seeds = symbolIds.slice(
    0,
    boundedLimit(symbolIds.length, budgetCap, decision.budgetMultiplier),
  );
  enqueuePrefetchTask({
    repoId,
    key: `delta-blast:${seeds.join(",")}`,
    type: "delta-blast",
    resourceKind: "tool",
    context: resolved,
    priority: 80 + decision.priorityBoost,
    policyApplied: true,
    run: async () => {
      for (const symbolId of seeds) {
        markPrefetched(repoId, `blast:${symbolId}`, {
          strategy: "delta-blast",
          resourceKind: "tool",
          context: resolved,
        });
      }
    },
  });
}

export function warmPrefetchOnServeStart(
  repoId: string,
  topN = 50,
  context?: PrefetchRequestContext,
): void {
  const resolved = resolveContext(context);
  const decision = decisionForStrategy(repoId, "startup-warm", "card", resolved);
  if (!decision.allowed) {
    recordSuppressedTask({
      repoId,
      key: `startup-warm:${topN}`,
      type: "startup-warm",
      resourceKind: "card",
      context: resolved,
      priority: 30,
      policyApplied: true,
      run: async () => {},
    });
    return;
  }
  enqueuePrefetchTask({
    repoId,
    key: `startup-warm:${topN}`,
    type: "startup-warm",
    resourceKind: "card",
    context: resolved,
    priority: 30 + decision.priorityBoost,
    policyApplied: true,
    run: async () => {
      const conn = await getLadybugConn();
      const limit = boundedLimit(topN, topN, decision.budgetMultiplier);
      const top = await ladybugDb.getTopSymbolsByFanIn(conn, repoId, limit);
      for (const symbol of top) {
        markPrefetched(repoId, `card:${symbol.symbolId}`, {
          strategy: "startup-warm",
          resourceKind: "card",
          context: resolved,
        });
      }
    },
  });
}

function consumePrefetchedKeyInternal(
  repoId: string,
  key: string,
  strategy?: string,
  context?: PrefetchRequestContext,
): ConsumePrefetchOutcome {
  expireStalePrefetches(repoId);
  const stats = getOrCreateStats(repoId);
  const map = prefetchedKeysByRepo.get(repoId);
  const match = findPrefetchEntry(map, key, context);
  const entry = match?.entry;
  const latencyReductionMs = DEFAULT_LATENCY_REDUCTION_MS;
  if (entry) {
    map?.delete(match.mapKey);
    stats.cacheHits += 1;
    stats.acceptedPrefetch += 1;
    const prev = stats.avgLatencyReductionMs;
    stats.avgLatencyReductionMs =
      prev === 0 ? latencyReductionMs : prev * 0.8 + latencyReductionMs * 0.2;
    updateRates(stats);
    recordStrategyMetrics(entry.strategy, true, latencyReductionMs);
    recordPrefetchOutcome({
      repoId,
      prefetchId: entry.prefetchId,
      taskType: entry.taskType,
      clientKey: entry.clientKey,
      strategy: entry.strategy,
      resourceKind: entry.resourceKind,
      resourceKey: entry.resourceKey,
      outcome: "used",
      latencySavedMs: latencyReductionMs,
      tokensSavedEstimate: entry.plannedCost,
      plannedCost: entry.plannedCost,
    });
    recordPrefetchOutcome({
      repoId,
      prefetchId: entry.prefetchId,
      taskType: entry.taskType,
      clientKey: entry.clientKey,
      strategy: entry.strategy,
      resourceKind: entry.resourceKind,
      resourceKey: entry.resourceKey,
      outcome: "accepted",
    });
    refreshPolicyStats(repoId, stats);
    return {
      hit: true,
      outcome: "hit",
      key,
      strategy: entry.strategy,
      resourceKind: entry.resourceKind,
      latencyReductionMs,
    };
  }
  const fallbackStrategy = strategy ?? "unknown";
  stats.cacheMisses += 1;
  updateRates(stats);
  if (strategy) {
    recordStrategyMetrics(strategy, false, 0);
  }
  refreshPolicyStats(repoId, stats);
  return {
    hit: false,
    outcome: "miss",
    key,
    strategy: fallbackStrategy,
    resourceKind: inferResourceKind(key),
    latencyReductionMs: 0,
  };
}

export function consumePrefetchedKeyWithOutcome(
  repoId: string,
  key: string,
  strategy?: string,
  context?: PrefetchRequestContext,
): ConsumePrefetchOutcome {
  return consumePrefetchedKeyInternal(repoId, key, strategy, context);
}

export function consumePrefetchedKey(
  repoId: string,
  key: string,
  strategy?: string,
  context?: PrefetchRequestContext,
): boolean {
  return consumePrefetchedKeyInternal(repoId, key, strategy, context).hit;
}

export function shutdownPrefetch(): void {
  enabled = false;
  queue.length = 0;
  for (const stats of statsByRepo.values()) {
    stats.enabled = false;
    stats.queueDepth = 0;
    stats.running = false;
  }
  logger.debug("[prefetch] Shutdown complete, queue cleared");
}

/** Remove queued, cached, and telemetry state for a deleted repository. */
export function invalidateRepoPrefetch(repoId: string): void {
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index]?.repoId === repoId) queue.splice(index, 1);
  }
  prefetchedKeysByRepo.delete(repoId);
  statsByRepo.delete(repoId);
  invalidateRepoPrefetchOutcomeState(repoId);
}

export function getPrefetchStats(repoId: string): PrefetchStats {
  expireStalePrefetches(repoId);
  const stats = getOrCreateStats(repoId);
  updateRates(stats);
  stats.strategyMetrics = getAllStrategyMetrics();
  const gating = getGatingConfig();
  stats.modelEnabled = gating.enabled;
  stats.deterministicFallback = !gating.enabled || getCurrentModel() === null;
  refreshPolicyStats(repoId, stats);
  return { ...stats, topStrategies: [...stats.topStrategies] };
}

export function _setPrefetchLoadSheddingForTesting(enabledForTest: boolean): void {
  loadSheddingEnabled = enabledForTest;
}

export function _setPrefetchEntryCreatedAtForTesting(
  repoId: string,
  key: string,
  createdAt: number,
): void {
  const map = prefetchedKeysByRepo.get(repoId) ?? new Map<string, PrefetchEntry>();
  prefetchedKeysByRepo.set(repoId, map);
  const existing = findPrefetchEntry(map, key)?.entry;
  const context = existing
    ? { taskType: existing.taskType, clientKey: existing.clientKey }
    : resolveContext();
  const resourceKind = existing?.resourceKind ?? inferResourceKind(key);
  const entry: PrefetchEntry = existing ?? {
    prefetchId: randomUUID(),
    key,
    strategy: "test",
    resourceKind,
    resourceKey: key,
    createdAt,
    expiresAt: createdAt + PREFETCH_STALE_MS,
    taskType: context.taskType,
    clientKey: context.clientKey,
    plannedCost: estimatePlannedTokenCost(resourceKind, key),
  };
  entry.createdAt = createdAt;
  entry.expiresAt = createdAt + PREFETCH_STALE_MS;
  map.set(buildPrefetchEntryKey(key, context), entry);
  if (!existing) {
    recordPrefetchOutcome({
      repoId,
      prefetchId: entry.prefetchId,
      taskType: entry.taskType,
      clientKey: entry.clientKey,
      strategy: entry.strategy,
      resourceKind: entry.resourceKind,
      resourceKey: entry.resourceKey,
      outcome: "offered",
      persist: false,
    });
  }
}
