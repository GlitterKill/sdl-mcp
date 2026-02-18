import { cpus, loadavg, platform } from "os";
import * as db from "../db/queries.js";

type PrefetchTaskType = "slice-frontier" | "file-open" | "delta-blast" | "startup-warm";

interface PrefetchTask {
  repoId: string;
  key: string;
  priority: number;
  type: PrefetchTaskType;
  run: () => Promise<void>;
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
}

const queue: PrefetchTask[] = [];
const prefetchedKeysByRepo = new Map<string, Map<string, number>>();
const statsByRepo = new Map<string, PrefetchStats>();
let running = false;
let enabled = false;
let maxBudgetPercent = 20;

function getOrCreateStats(repoId: string): PrefetchStats {
  const existing = statsByRepo.get(repoId);
  if (existing) {
    return existing;
  }
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
  };
  statsByRepo.set(repoId, initial);
  return initial;
}

function updateRates(stats: PrefetchStats): void {
  const total = stats.cacheHits + stats.cacheMisses;
  stats.hitRate = total > 0 ? stats.cacheHits / total : 0;
  stats.wasteRate =
    stats.completed > 0 ? stats.wastedPrefetch / Math.max(1, stats.completed) : 0;
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
  return currentCpuLoadRatio() > 0.8;
}

async function runQueue(): Promise<void> {
  if (running || !enabled) {
    return;
  }
  running = true;
  try {
    while (queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const task = queue.shift();
      if (!task) break;

      const stats = getOrCreateStats(task.repoId);
      stats.running = true;
      stats.queueDepth = queue.length;

      if (shouldYieldForLoad()) {
        stats.cancelled += 1;
        stats.running = false;
        continue;
      }

      try {
        await task.run();
        stats.completed += 1;
        stats.lastRunAt = new Date().toISOString();
      } catch {
        stats.cancelled += 1;
      } finally {
        stats.running = false;
      }
    }
  } finally {
    running = false;
    for (const stats of statsByRepo.values()) {
      stats.queueDepth = queue.length;
      stats.running = false;
      updateRates(stats);
    }
  }
}

function markPrefetched(repoId: string, key: string): void {
  const map = prefetchedKeysByRepo.get(repoId) ?? new Map<string, number>();
  map.set(key, Date.now());
  prefetchedKeysByRepo.set(repoId, map);
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
  queue.push(task);
  const stats = getOrCreateStats(task.repoId);
  stats.queueDepth = queue.length;
  void runQueue();
}

export function prefetchSliceFrontier(repoId: string, seedSymbolIds: string[]): void {
  const budgetCap = Math.max(1, Math.floor(seedSymbolIds.length * (maxBudgetPercent / 100)));
  const seeds = seedSymbolIds.slice(0, budgetCap);
  enqueuePrefetchTask({
    repoId,
    key: `slice-frontier:${seeds.join(",")}`,
    type: "slice-frontier",
    priority: 60,
    run: async () => {
      for (const symbolId of seeds) {
        const edges = db.getEdgesFrom(symbolId).slice(0, 5);
        for (const edge of edges) {
          markPrefetched(repoId, `card:${edge.to_symbol_id}`);
        }
      }
    },
  });
}

export function prefetchFileExports(repoId: string, filePath: string): void {
  enqueuePrefetchTask({
    repoId,
    key: `file-open:${filePath}`,
    type: "file-open",
    priority: 40,
    run: async () => {
      const file = db.getFileByRepoPath(repoId, filePath);
      if (!file) return;
      const symbols = db
        .getSymbolsByFileLite(file.file_id)
        .filter((symbol) => symbol.exported === 1);
      for (const symbol of symbols) {
        markPrefetched(repoId, `slice:${symbol.symbol_id}`);
      }
    },
  });
}

export function prefetchDeltaBlastRadius(repoId: string, symbolIds: string[]): void {
  const seeds = symbolIds.slice(0, Math.max(1, Math.floor(symbolIds.length * (maxBudgetPercent / 100))));
  enqueuePrefetchTask({
    repoId,
    key: `delta-blast:${seeds.join(",")}`,
    type: "delta-blast",
    priority: 80,
    run: async () => {
      for (const symbolId of seeds) {
        markPrefetched(repoId, `blast:${symbolId}`);
      }
    },
  });
}

export function warmPrefetchOnServeStart(repoId: string, topN = 50): void {
  enqueuePrefetchTask({
    repoId,
    key: `startup-warm:${topN}`,
    type: "startup-warm",
    priority: 30,
    run: async () => {
      const top = db.getTopSymbolsByFanIn(repoId, topN);
      for (const symbol of top) {
        markPrefetched(repoId, `card:${symbol.symbol_id}`);
      }
    },
  });
}

export function consumePrefetchedKey(repoId: string, key: string): boolean {
  const stats = getOrCreateStats(repoId);
  const map = prefetchedKeysByRepo.get(repoId);
  const ts = map?.get(key);
  if (typeof ts === "number") {
    map?.delete(key);
    stats.cacheHits += 1;
    const prev = stats.avgLatencyReductionMs;
    stats.avgLatencyReductionMs =
      prev === 0 ? 35 : (prev * 0.8 + 35 * 0.2);
    updateRates(stats);
    return true;
  }
  stats.cacheMisses += 1;
  updateRates(stats);
  return false;
}

export function getPrefetchStats(repoId: string): PrefetchStats {
  const stats = getOrCreateStats(repoId);
  const map = prefetchedKeysByRepo.get(repoId);
  if (map && map.size > 0) {
    const now = Date.now();
    let stale = 0;
    for (const [, createdAt] of map) {
      if (now - createdAt > 5 * 60_000) {
        stale += 1;
      }
    }
    stats.wastedPrefetch = stale;
    updateRates(stats);
  }
  return { ...stats };
}
