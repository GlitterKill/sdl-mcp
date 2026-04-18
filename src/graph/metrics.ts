import { createHash } from "crypto";
import { execFile } from "child_process";
import { readFile } from "node:fs/promises";
import { join } from "path";
import { promisify } from "util";
import { globSync } from "node:fs";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type {
  EdgeLite,
  MetricsRow,
  SymbolLiteRow,
} from "../db/ladybug-queries.js";
import type { RepoConfig } from "../config/types.js";
import type { CanonicalTest, StalenessTiers } from "../domain/types.js";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { safeJsonParse, ConfigObjectSchema } from "../util/safeJson.js";

const execFileAsync = promisify(execFile);

// Avoid flakiness when multiple updates happen within the same millisecond.
// Some environments (and our unit tests) assume `updatedAt` changes on each update.
let lastMetricsUpdateMs = 0;
function monotonicIsoNow(): string {
  const nowMs = Date.now();
  const ms = nowMs <= lastMetricsUpdateMs ? lastMetricsUpdateMs + 1 : nowMs;
  lastMetricsUpdateMs = ms;
  return new Date(ms).toISOString();
}

interface FanMetrics {
  fanIn: number;
  fanOut: number;
}

interface ChurnCache {
  repoRoot: string;
  lastCommitHash: string;
  churnMap: Map<string, number>;
  cachedAt: number;
  lastHeadCheckedAt: number;
}

const CHURN_CACHE_TTL_MS = 5 * 60 * 1000;
const CHURN_HEAD_RECHECK_MS = 30 * 1000;
const MAX_METRICS_CACHED_REPOS = 5;
const churnCacheByRepo = new Map<string, ChurnCache>();

interface MetricsGitTestHooks {
  now?: () => number;
  getCurrentCommitHash?: (repoRoot: string) => Promise<string>;
  getChurnByFile?: (repoRoot: string) => Promise<Map<string, number>>;
}

let metricsGitTestHooks: MetricsGitTestHooks | null = null;

interface TestRefCache {
  repoRoot: string;
  fileHashes: Map<string, string>;
  testRefs: Map<string, Set<string>>;
  cachedAt: number;
}

const testRefCacheByRepo = new Map<string, TestRefCache>();

function calculateFanMetrics(
  edges: EdgeLite[],
  symbols: Set<string>,
): Map<string, FanMetrics> {
  const metrics = new Map<string, FanMetrics>();

  for (const edge of edges) {
    if (!symbols.has(edge.fromSymbolId) || !symbols.has(edge.toSymbolId)) {
      continue;
    }
    const from = metrics.get(edge.fromSymbolId) ?? { fanIn: 0, fanOut: 0 };
    from.fanOut += 1;
    metrics.set(edge.fromSymbolId, from);

    const to = metrics.get(edge.toSymbolId) ?? { fanIn: 0, fanOut: 0 };
    to.fanIn += 1;
    metrics.set(edge.toSymbolId, to);
  }

  return metrics;
}

async function getCurrentCommitHash(repoRoot: string): Promise<string> {
  if (metricsGitTestHooks?.getCurrentCommitHash) {
    return await metricsGitTestHooks.getCurrentCommitHash(repoRoot);
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
    });
    return stdout.trim();
  } catch (err) {
    logger.warn("Failed to get current commit hash", { error: String(err) });
    return "";
  }
}

async function getChurnByFile(repoRoot: string): Promise<Map<string, number>> {
  if (metricsGitTestHooks?.getChurnByFile) {
    return await metricsGitTestHooks.getChurnByFile(repoRoot);
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--since=30.days", "--name-only", "--pretty=format:"],
      {
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const churn = new Map<string, number>();
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const relPath = normalizePath(trimmed);
      churn.set(relPath, (churn.get(relPath) ?? 0) + 1);
    }
    return churn;
  } catch (err) {
    logger.warn("Failed to compute file churn", { error: String(err) });
    return new Map();
  }
}

async function getChurnByFileCached(
  repoRoot: string,
): Promise<Map<string, number>> {
  const cached = churnCacheByRepo.get(repoRoot);
  const now = metricsGitTestHooks?.now?.() ?? Date.now();

  // Churn is commit-history-based and intentionally approximate, so repeated
  // refreshes can safely skip `git rev-parse HEAD` for a short hot window.
  if (cached && now - cached.lastHeadCheckedAt < CHURN_HEAD_RECHECK_MS) {
    logger.debug(`Churn cache HOT HIT for repo ${repoRoot}`);
    return cached.churnMap;
  }

  const currentHead = await getCurrentCommitHash(repoRoot);

  if (
    cached &&
    cached.lastCommitHash === currentHead &&
    now - cached.cachedAt < CHURN_CACHE_TTL_MS
  ) {
    logger.debug(
      `Churn cache HIT for repo ${repoRoot} (commit: ${currentHead})`,
    );
    cached.lastHeadCheckedAt = now;
    return cached.churnMap;
  }

  logger.debug(
    `Churn cache MISS for repo ${repoRoot} (commit: ${currentHead})`,
  );
  const churnMap = await getChurnByFile(repoRoot);
  churnCacheByRepo.set(repoRoot, {
    repoRoot,
    lastCommitHash: currentHead,
    churnMap,
    cachedAt: now,
    lastHeadCheckedAt: now,
  });
  if (churnCacheByRepo.size > MAX_METRICS_CACHED_REPOS) {
    const firstKey = churnCacheByRepo.keys().next().value;
    if (firstKey !== undefined) churnCacheByRepo.delete(firstKey);
  }
  return churnMap;
}

function computeFileHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

async function collectTestRefs(
  repoRoot: string,
  symbols: Array<{ symbolId: string; name: string }>,
  config: RepoConfig,
  changedTestFilePaths?: Set<string>,
): Promise<Map<string, Set<string>>> {
  const extGroup = config.languages.join(",");
  const patterns = [
    `**/*.test.{${extGroup}}`,
    `**/*.spec.{${extGroup}}`,
    `**/__tests__/**/*.${extGroup}`,
    `**/tests/**/*.${extGroup}`,
  ];

  const bracePattern =
    patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
  const testFiles = [
    ...globSync(bracePattern, {
      cwd: repoRoot,
      exclude: [
        ...(config.ignore ?? []),
        "**/fixtures/**",
        "**/__fixtures__/**",
        "**/testdata/**",
        "**/test-data/**",
        "**/mock-data/**",
      ],
    }),
  ];

  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbol of symbols) {
    const existing = nameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    nameToSymbolIds.set(symbol.name, existing);
  }

  const symbolNames = new Set(symbols.map((s) => s.name));

  const cached = testRefCacheByRepo.get(repoRoot);
  const fileHashes = cached?.fileHashes || new Map<string, string>();
  const CONCURRENCY_LIMIT = 10;
  const testRefs = new Map<string, Set<string>>();
  const newTestRefs = new Map<string, Set<string>>();

  // Scoped incremental: if caller supplied the exact set of changed test file
  // paths AND we have a warm cache, trust cached entries for unchanged files
  // and only re-read the changed ones. Cold-cache entries must still be read.
  const normalizedChangedPaths = changedTestFilePaths
    ? new Set(Array.from(changedTestFilePaths, (p) => normalizePath(p)))
    : null;
  const filesToRead = normalizedChangedPaths
    ? testFiles.filter(
        (f) =>
          normalizedChangedPaths.has(normalizePath(f)) ||
          !cached?.testRefs.has(f),
      )
    : testFiles;
  const filesFromCache = normalizedChangedPaths
    ? testFiles.filter(
        (f) =>
          !normalizedChangedPaths.has(normalizePath(f)) &&
          cached?.testRefs.has(f),
      )
    : [];

  // Hydrate testRefs + newTestRefs for cached-only files without re-reading.
  if (cached) {
    for (const file of filesFromCache) {
      const cachedFileRefs = cached.testRefs.get(file);
      if (!cachedFileRefs) continue;
      for (const ref of cachedFileRefs) {
        const symbolIds = nameToSymbolIds.get(ref);
        if (!symbolIds) continue;
        for (const symbolId of symbolIds) {
          const existing = testRefs.get(symbolId) ?? new Set<string>();
          existing.add(normalizePath(file));
          testRefs.set(symbolId, existing);
        }
      }
      newTestRefs.set(file, cachedFileRefs);
    }
  }

  // Process test files in chunks to avoid blocking the event loop
  for (
    let chunkStart = 0;
    chunkStart < filesToRead.length;
    chunkStart += CONCURRENCY_LIMIT
  ) {
    const chunk = filesToRead.slice(chunkStart, chunkStart + CONCURRENCY_LIMIT);
    const results = await Promise.all(
      chunk.map(async (file) => {
        try {
          const content = await readFile(join(repoRoot, file), "utf-8");
          return { file, content };
        } catch (err) {
          logger.debug("Failed to read test file", {
            file,
            error: String(err),
          });
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { file, content } = result;

      const hash = computeFileHash(content);

      if (cached && cached.fileHashes.get(file) === hash) {
        const cachedFileRefs = cached.testRefs.get(file);
        if (cachedFileRefs) {
          for (const ref of cachedFileRefs) {
            const symbolIds = nameToSymbolIds.get(ref);
            if (symbolIds) {
              for (const symbolId of symbolIds) {
                const existing = testRefs.get(symbolId) ?? new Set<string>();
                existing.add(normalizePath(file));
                testRefs.set(symbolId, existing);
              }
            }
          }
          newTestRefs.set(file, cachedFileRefs);
          continue;
        }
      }

      fileHashes.set(file, hash);
      const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      const matchedSymbols = new Set<string>();

      for (const token of new Set(tokens)) {
        if (symbolNames.has(token)) {
          matchedSymbols.add(token);
          const symbolIds = nameToSymbolIds.get(token);
          if (symbolIds) {
            for (const symbolId of symbolIds) {
              const existing = testRefs.get(symbolId) ?? new Set<string>();
              existing.add(normalizePath(file));
              testRefs.set(symbolId, existing);
            }
          }
        }
      }
      newTestRefs.set(file, matchedSymbols);
    }
  }

  testRefCacheByRepo.set(repoRoot, {
    repoRoot,
    fileHashes,
    testRefs: newTestRefs,
    cachedAt: Date.now(),
  });
  if (testRefCacheByRepo.size > MAX_METRICS_CACHED_REPOS) {
    const firstKey = testRefCacheByRepo.keys().next().value;
    if (firstKey !== undefined) testRefCacheByRepo.delete(firstKey);
  }

  return testRefs;
}

export function clearTestRefCache(repoRoot?: string): void {
  if (repoRoot) {
    testRefCacheByRepo.delete(repoRoot);
  } else {
    testRefCacheByRepo.clear();
  }
}

/**
 * For testing only: override Git/time dependencies in metrics caching.
 * @internal
 */
export function _setMetricsGitHooksForTesting(
  hooks: MetricsGitTestHooks | null,
): void {
  metricsGitTestHooks = hooks;
}

export { collectTestRefs };

const MAX_BFS_COST = 12;
const MAX_BFS_VISITED = 500;
const MAX_BATCH_BFS_QUEUE = 50000;

/**
 * Edge-type cost for canonical test BFS.
 * Call edges indicate strong semantic relationships (cost 1).
 * Import edges are weaker file-level dependencies (cost 2).
 */
function edgeCost(edgeType: string): number {
  switch (edgeType) {
    case "call":
      return 1;
    case "config":
      return 1.5;
    case "import":
      return 2;
    default:
      return 2;
  }
}

/**
 * Returns true if the given relative file path matches known test file patterns.
 */
function isTestFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");

  // Exclude fixture/testdata directories — these are test inputs, not tests
  if (
    normalized.includes("/fixtures/") ||
    normalized.includes("/__fixtures__/") ||
    normalized.includes("/testdata/") ||
    normalized.includes("/test-data/") ||
    normalized.includes("/mocks/") ||
    normalized.includes("/stubs/")
  ) {
    return false;
  }

  if (
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  ) {
    return true;
  }
  if (
    normalized.includes("/tests/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    normalized.startsWith("__tests__/")
  ) {
    // Only count as test file if it has a test-like extension
    return (
      normalized.endsWith(".ts") ||
      normalized.endsWith(".js") ||
      normalized.endsWith(".tsx") ||
      normalized.endsWith(".jsx") ||
      normalized.endsWith(".mjs")
    );
  }
  return false;
}

interface BfsCandidate {
  symbolId: string;
  file: string;
  distance: number;
}

/**
 * Computes the canonical test for a symbol via BFS over the graph.
 *
 * Searches both forward (outgoing call/import edges) and backward (incoming edges)
 * from the given symbolId. Test nodes are identified by file path patterns.
 *
 * Caps: max BFS cost 12 (weighted: call=1, config=1.5, import=2), max visited nodes 500.
 * Note: uses FIFO queue (not priority queue), so may not find the cheapest path.
 * For optimal results, prefer batchComputeCanonicalTests which uses Dijkstra-style relaxation.
 * Returns null if no test node is reachable.
 */
export function computeCanonicalTest(
  symbolId: string,
  graph: Graph,
  fileById?: Map<string, string>,
): CanonicalTest | null {
  /**
   * Resolve a relative file path for a given symbolId in the graph.
   * Uses the fileById map when provided (for use in updateMetricsForRepo),
   * otherwise falls back to looking for rel_path on the SymbolRow if available,
   * or returns null if unresolvable.
   */
  function getRelPath(sid: string): string | null {
    const sym = graph.symbols.get(sid);
    if (!sym) return null;
    if (fileById) {
      return fileById.get(sym.fileId) ?? null;
    }
    // For pure unit tests the SymbolRow may carry rel_path/relPath as an extension
    const extended = sym as unknown as { rel_path?: string; relPath?: string };
    return extended.relPath ?? extended.rel_path ?? null;
  }

  const visited = new Set<string>();
  // Queue items: [symbolId, distance]
  // Use an index pointer instead of shift() to keep dequeues O(1).
  const queue: Array<[string, number]> = [[symbolId, 0]];
  let queueHead = 0;
  visited.add(symbolId);

  const candidates: BfsCandidate[] = [];

  // Check if the symbol itself is a test node
  const selfPath = getRelPath(symbolId);
  if (selfPath && isTestFile(selfPath)) {
    candidates.push({ symbolId, file: selfPath, distance: 0 });
  }

  while (queueHead < queue.length && visited.size < MAX_BFS_VISITED) {
    const [current, depth] = queue[queueHead++];

    if (depth >= MAX_BFS_COST) {
      continue;
    }

    // Forward edges (outgoing) — weighted by edge type
    const outgoing = graph.adjacencyOut.get(current) ?? [];
    for (const edge of outgoing) {
      const neighbor = edge.toSymbolId;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const cost = depth + edgeCost(edge.edgeType);
      const neighborPath = getRelPath(neighbor);
      if (neighborPath && isTestFile(neighborPath)) {
        candidates.push({
          symbolId: neighbor,
          file: neighborPath,
          distance: cost,
        });
      }
      queue.push([neighbor, cost]);
    }

    // Backward edges (incoming) — weighted by edge type
    const incoming = graph.adjacencyIn.get(current) ?? [];
    for (const edge of incoming) {
      const neighbor = edge.fromSymbolId;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const cost = depth + edgeCost(edge.edgeType);
      const neighborPath = getRelPath(neighbor);
      if (neighborPath && isTestFile(neighborPath)) {
        candidates.push({
          symbolId: neighbor,
          file: neighborPath,
          distance: cost,
        });
      }
      queue.push([neighbor, cost]);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Rank: ascending distance, then descending fanIn
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    // Higher fanIn = more tested = prefer
    const aFanIn = (graph.adjacencyIn.get(a.symbolId) ?? []).length;
    const bFanIn = (graph.adjacencyIn.get(b.symbolId) ?? []).length;
    return bFanIn - aFanIn;
  });

  const best = candidates[0];
  return {
    file: best.file,
    symbolId: best.symbolId,
    distance: best.distance,
    proximity: 1 / (1 + best.distance),
  };
}

/**
 * Batch-computes canonical tests for every symbol in the graph using a single
 * multi-source BFS seeded from all test-file nodes.
 *
 * Complexity: O(edges + symbols)  — vs O(symbols × MAX_BFS_VISITED) for the
 * per-symbol approach.  For a 4 000-symbol repo the speedup is ~35×.
 *
 * The nearest test node (by graph distance, bidirectional traversal) wins.
 * Tie-breaking between equidistant test nodes is seed-order dependent, which
 * is acceptable since the result is a heuristic regardless.
 */
function batchComputeCanonicalTests(
  graph: Graph,
  fileById: Map<string, string>,
): Map<string, CanonicalTest | null> {
  // Seed the BFS from every symbol that lives in a test file.
  interface QueueItem {
    symbolId: string;
    distance: number;
    testSymbolId: string;
    testFile: string;
  }

  const nearest = new Map<
    string,
    { file: string; symbolId: string; distance: number }
  >();
  const queue: QueueItem[] = [];
  let queueHead = 0;

  for (const [symId, sym] of graph.symbols) {
    const relPath = fileById.get(sym.fileId);
    if (relPath && isTestFile(relPath)) {
      if (!nearest.has(symId)) {
        nearest.set(symId, { file: relPath, symbolId: symId, distance: 0 });
        queue.push({
          symbolId: symId,
          distance: 0,
          testSymbolId: symId,
          testFile: relPath,
        });
      }
    }
  }

  if (queue.length === 0) {
    // No test nodes reachable — return null for every symbol.
    const results = new Map<string, CanonicalTest | null>();
    for (const symId of graph.symbols.keys()) {
      results.set(symId, null);
    }
    return results;
  }

  while (queueHead < queue.length) {
    if (queue.length > MAX_BATCH_BFS_QUEUE) {
      logger.warn("Batch BFS queue exceeded limit", {
        queueSize: queue.length,
        limit: MAX_BATCH_BFS_QUEUE,
      });
      break;
    }
    const {
      symbolId: current,
      distance,
      testSymbolId,
      testFile,
    } = queue[queueHead++];

    if (distance >= MAX_BFS_COST) {
      continue;
    }

    // Traverse outgoing edges (forward) — weighted by edge type
    for (const edge of graph.adjacencyOut.get(current) ?? []) {
      const neighbor = edge.toSymbolId;
      const cost = distance + edgeCost(edge.edgeType);
      const existing = nearest.get(neighbor);
      if (!existing || cost < existing.distance) {
        nearest.set(neighbor, {
          file: testFile,
          symbolId: testSymbolId,
          distance: cost,
        });
        queue.push({
          symbolId: neighbor,
          distance: cost,
          testSymbolId,
          testFile,
        });
      }
    }

    // Traverse incoming edges (backward) — weighted by edge type
    for (const edge of graph.adjacencyIn.get(current) ?? []) {
      const neighbor = edge.fromSymbolId;
      const cost = distance + edgeCost(edge.edgeType);
      const existing = nearest.get(neighbor);
      if (!existing || cost < existing.distance) {
        nearest.set(neighbor, {
          file: testFile,
          symbolId: testSymbolId,
          distance: cost,
        });
        queue.push({
          symbolId: neighbor,
          distance: cost,
          testSymbolId,
          testFile,
        });
      }
    }
  }

  // Build the final result map.
  const results = new Map<string, CanonicalTest | null>();
  for (const symId of graph.symbols.keys()) {
    const found = nearest.get(symId);
    if (!found) {
      results.set(symId, null);
    } else {
      results.set(symId, {
        file: found.file,
        symbolId: found.symbolId,
        distance: found.distance,
        proximity: 1 / (1 + found.distance),
      });
    }
  }
  return results;
}

export function calculateRiskScore(
  tiers: StalenessTiers,
  fanIn: number,
  fanOut: number,
  hasDiagnostics: boolean,
): number {
  let riskScore = tiers.riskScore;

  const fanInPenalty = Math.min(fanIn * 2, 20);
  const fanOutPenalty = Math.min(fanOut, 10);

  riskScore += fanInPenalty;
  riskScore += fanOutPenalty;

  if (hasDiagnostics) {
    riskScore += 15;
  }

  return Math.min(riskScore, 100);
}

export function calculateRiskScoresForSymbols(
  symbolTiers: Map<string, StalenessTiers>,
  diagnostics: Map<string, boolean>,
  metricsBySymbolId: Map<string, MetricsRow | null>,
): Map<string, number> {
  const riskScores = new Map<string, number>();

  for (const [symbolId, tiers] of symbolTiers) {
    const metrics = metricsBySymbolId.get(symbolId) ?? null;
    if (!metrics) continue;

    const hasDiagnostics = diagnostics.get(symbolId) ?? false;
    const riskScore = calculateRiskScore(
      tiers,
      metrics.fanIn,
      metrics.fanOut,
      hasDiagnostics,
    );

    riskScores.set(symbolId, riskScore);
  }

  return riskScores;
}

export async function updateMetricsForRepo(
  repoId: string,
  changedFileIds?: Set<string>,
  options?: {
    includeTimings?: boolean;
    changedTestFilePaths?: Set<string>;
  },
): Promise<{
  timings?: Record<string, number>;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
}> {
  const timings: Record<string, number> | undefined = options?.includeTimings
    ? {}
    : undefined;
  const measureSubphase = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startMs = Date.now();
    try {
      return await fn();
    } finally {
      if (timings) {
        timings[phaseName] = Date.now() - startMs;
      }
    }
  };

  // An explicitly empty set means the caller already knows there are no file
  // changes, so skip all DB and graph work up front.
  if (changedFileIds && changedFileIds.size === 0) {
    logger.debug("Empty changedFileIds provided - no updates needed");
    return { timings };
  }

  const conn = await getLadybugConn();

  const [edges, repo] = await measureSubphase("loadRepoState", async () => {
    const e = await ladybugDb.getEdgesByRepoLite(conn, repoId);
    const r = await ladybugDb.getRepo(conn, repoId);
    return [e, r] as const;
  });
  if (!repo) {
    return { timings };
  }
  const config = safeJsonParse(
    repo.configJson,
    ConfigObjectSchema,
    {},
  ) as RepoConfig;
  const [files, allSymbols] = await measureSubphase(
    "loadFilesAndSymbols",
    async () => {
      const f = await ladybugDb.getFilesByRepoLite(conn, repoId);
      const s = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
      return [f, s] as const;
    },
  );
  const fileById = new Map(files.map((file) => [file.fileId, file.relPath]));
  const symbolIds = new Set(allSymbols.map((symbol) => symbol.symbolId));

  let symbols = allSymbols;

  if (changedFileIds && changedFileIds.size > 0) {
    const affectedSymbolIds = new Set<string>();

    for (const symbol of allSymbols) {
      if (changedFileIds.has(symbol.fileId)) {
        affectedSymbolIds.add(symbol.symbolId);
      }
    }

    for (const edge of edges) {
      if (affectedSymbolIds.has(edge.fromSymbolId)) {
        affectedSymbolIds.add(edge.toSymbolId);
      }
      if (affectedSymbolIds.has(edge.toSymbolId)) {
        affectedSymbolIds.add(edge.fromSymbolId);
      }
    }

    symbols = allSymbols.filter((s) => affectedSymbolIds.has(s.symbolId));
    logger.debug(
      `Incremental metrics: updating ${symbols.length} of ${allSymbols.length} symbols for ${changedFileIds.size} changed files`,
    );
  }

  const fanMetrics = await measureSubphase("fanMetrics", async () =>
    calculateFanMetrics(edges, symbolIds),
  );
  const churnByFile = await measureSubphase("churn", () =>
    getChurnByFileCached(repo.rootPath),
  );
  const testRefs = await measureSubphase("testRefs", () =>
    collectTestRefs(
      repo.rootPath,
      allSymbols,
      config,
      options?.changedTestFilePaths,
    ),
  );

  // Build a lightweight Graph for canonicalTest BFS
  const symbolMap = new Map(allSymbols.map((s) => [s.symbolId, s]));
  const adjacencyOut = new Map<string, EdgeLite[]>();
  const adjacencyIn = new Map<string, EdgeLite[]>();
  for (const s of allSymbols) {
    adjacencyOut.set(s.symbolId, []);
    adjacencyIn.set(s.symbolId, []);
  }
  for (const edge of edges) {
    const outList = adjacencyOut.get(edge.fromSymbolId);
    if (outList) outList.push(edge);
    const inList = adjacencyIn.get(edge.toSymbolId);
    if (inList) inList.push(edge);
  }
  const graph: Graph = {
    repoId,
    symbols: symbolMap,
    edges,
    adjacencyIn,
    adjacencyOut,
  };

  // Batch-compute all canonical tests in a single BFS pass (O(edges)) rather
  // than running a separate per-symbol BFS (O(symbols × MAX_BFS_VISITED)).
  const batchCanonical = await measureSubphase("canonicalTests", async () =>
    batchComputeCanonicalTests(graph, fileById),
  );

  const now = monotonicIsoNow();

  // Build all metrics rows, then batch-write in chunks of 200 to reduce
  // per-row transaction overhead while keeping individual transactions small.
  const BATCH_SIZE = 200;
  const rows: MetricsRow[] = [];
  for (const symbol of symbols) {
    const metric = fanMetrics.get(symbol.symbolId) ?? { fanIn: 0, fanOut: 0 };
    const relPath = fileById.get(symbol.fileId);
    const churn = relPath ? (churnByFile.get(relPath) ?? 0) : 0;
    const refs = Array.from(testRefs.get(symbol.symbolId) ?? []);
    const canonicalTest = batchCanonical.get(symbol.symbolId) ?? null;
    rows.push({
      symbolId: symbol.symbolId,
      fanIn: metric.fanIn,
      fanOut: metric.fanOut,
      churn30d: churn,
      testRefsJson: JSON.stringify(refs),
      canonicalTestJson: canonicalTest ? JSON.stringify(canonicalTest) : null,
      updatedAt: now,
    });
  }

  // During incremental indexing, also update canonical tests for symbols
  // NOT in the changed set. The batch BFS computes results for all symbols
  // but the rows loop above only includes changed symbols. Without this,
  // stale canonical test data persists for unchanged symbols.
  if (changedFileIds && changedFileIds.size > 0) {
    const affectedSet = new Set(symbols.map((s) => s.symbolId));
    const unchangedSymbolIds = allSymbols
      .filter((symbol) => !affectedSet.has(symbol.symbolId))
      .map((symbol) => symbol.symbolId);
    const existingMetrics =
      unchangedSymbolIds.length > 0
        ? await measureSubphase("loadExistingCanonical", () =>
            ladybugDb.getMetricsBySymbolIds(conn, unchangedSymbolIds),
          )
        : new Map<string, MetricsRow | null>();
    const canonicalOnlyRows: Array<{
      symbolId: string;
      canonicalTestJson: string | null;
      updatedAt: string;
    }> = [];
    for (const symbol of allSymbols) {
      if (affectedSet.has(symbol.symbolId)) continue;
      const ct = batchCanonical.get(symbol.symbolId) ?? null;
      const canonicalTestJson = ct ? JSON.stringify(ct) : null;
      const previousCanonical =
        existingMetrics.get(symbol.symbolId)?.canonicalTestJson ?? null;
      if (previousCanonical === canonicalTestJson) {
        continue;
      }
      canonicalOnlyRows.push({
        symbolId: symbol.symbolId,
        canonicalTestJson,
        updatedAt: now,
      });
    }
    if (canonicalOnlyRows.length > 0) {
      await measureSubphase("writeCanonical", async () => {
        await withWriteConn(async (wConn) => {
          for (let i = 0; i < canonicalOnlyRows.length; i += BATCH_SIZE) {
            const chunk = canonicalOnlyRows.slice(i, i + BATCH_SIZE);
            await ladybugDb.upsertCanonicalTestBatch(wConn, chunk);
          }
        });
      });
    }
  }

  await measureSubphase("writeMetrics", async () => {
    await withWriteConn(async (wConn) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        await ladybugDb.upsertMetricsBatch(wConn, chunk);
      }
    });
  });

  // Produce a shared-graph handle so downstream consumers (cluster orchestrator)
  // can reuse the edge load instead of rescanning the repo.
  const sharedClusterEdges: Array<{
    fromSymbolId: string;
    toSymbolId: string;
  }> = [];
  const sharedCallEdges: Array<{ callerId: string; calleeId: string }> = [];
  for (const edge of edges) {
    if (edge.edgeType === "call") {
      sharedClusterEdges.push({
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
      });
      sharedCallEdges.push({
        callerId: edge.fromSymbolId,
        calleeId: edge.toSymbolId,
      });
    }
  }

  return {
    timings,
    sharedGraph: {
      callEdges: sharedCallEdges,
      clusterEdges: sharedClusterEdges,
    },
  };
}

interface Graph {
  repoId: string;
  symbols: Map<string, Pick<SymbolLiteRow, "symbolId" | "fileId">>;
  edges: EdgeLite[];
  adjacencyIn: Map<string, EdgeLite[]>;
  adjacencyOut: Map<string, EdgeLite[]>;
}
