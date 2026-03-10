import { createHash } from "crypto";
import { exec } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import fg from "fast-glob";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { EdgeRow, MetricsRow, SymbolRow } from "../db/ladybug-queries.js";
import type { RepoConfig } from "../config/types.js";
import type { CanonicalTest, StalenessTiers } from "../domain/types.js";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";

const execAsync = promisify(exec);

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
}

const CHURN_CACHE_TTL_MS = 5 * 60 * 1000;
const churnCacheByRepo = new Map<string, ChurnCache>();

interface TestRefCache {
  repoRoot: string;
  fileHashes: Map<string, string>;
  testRefs: Map<string, Set<string>>;
  cachedAt: number;
}

const testRefCacheByRepo = new Map<string, TestRefCache>();

function calculateFanMetrics(
  edges: EdgeRow[],
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
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", {
      cwd: repoRoot,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getChurnByFile(repoRoot: string): Promise<Map<string, number>> {
  try {
    const { stdout } = await execAsync(
      "git log --since=30.days --name-only --pretty=format:",
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
  } catch {
    return new Map();
  }
}

async function getChurnByFileCached(
  repoRoot: string,
): Promise<Map<string, number>> {
  const cached = churnCacheByRepo.get(repoRoot);
  const currentHead = await getCurrentCommitHash(repoRoot);

  if (
    cached &&
    cached.lastCommitHash === currentHead &&
    Date.now() - cached.cachedAt < CHURN_CACHE_TTL_MS
  ) {
    logger.debug(
      `Churn cache HIT for repo ${repoRoot} (commit: ${currentHead})`,
    );
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
    cachedAt: Date.now(),
  });
  return churnMap;
}

function computeFileHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function collectTestRefs(
  repoRoot: string,
  symbols: Array<{ symbolId: string; name: string }>,
  config: RepoConfig,
  _changedTestFiles?: Set<string>,
): Map<string, Set<string>> {
  const extGroup = config.languages.join(",");
  const patterns = [
    `**/*.test.{${extGroup}}`,
    `**/*.spec.{${extGroup}}`,
    `**/__tests__/**/*.${extGroup}`,
    `**/tests/**/*.${extGroup}`,
  ];

  const testFiles = fg.sync(patterns, {
    cwd: repoRoot,
    ignore: config.ignore,
    dot: false,
  });

  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbol of symbols) {
    const existing = nameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    nameToSymbolIds.set(symbol.name, existing);
  }

  const symbolNames = new Set(symbols.map((s) => s.name));

  const cached = testRefCacheByRepo.get(repoRoot);
  const fileHashes = cached?.fileHashes || new Map<string, string>();
  const newTestRefs = new Map<string, Set<string>>();

  const testRefs = new Map<string, Set<string>>();

  for (const file of testFiles) {
    let content = "";
    try {
      content = readFileSync(join(repoRoot, file), "utf-8");
    } catch {
      continue;
    }

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

  testRefCacheByRepo.set(repoRoot, {
    repoRoot,
    fileHashes,
    testRefs: newTestRefs,
    cachedAt: Date.now(),
  });

  return testRefs;
}

export function clearTestRefCache(repoRoot?: string): void {
  if (repoRoot) {
    testRefCacheByRepo.delete(repoRoot);
  } else {
    testRefCacheByRepo.clear();
  }
}

export { collectTestRefs };

const MAX_BFS_DEPTH = 6;
const MAX_BFS_VISITED = 500;

/**
 * Returns true if the given relative file path matches known test file patterns.
 */
function isTestFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
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
    return true;
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
 * Caps: max BFS depth 6, max visited nodes 500.
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

    if (depth >= MAX_BFS_DEPTH) {
      continue;
    }

    // Forward edges (outgoing)
    const outgoing = graph.adjacencyOut.get(current) ?? [];
    for (const edge of outgoing) {
      const neighbor = edge.toSymbolId;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const neighborPath = getRelPath(neighbor);
      if (neighborPath && isTestFile(neighborPath)) {
        candidates.push({
          symbolId: neighbor,
          file: neighborPath,
          distance: depth + 1,
        });
      }
      queue.push([neighbor, depth + 1]);
    }

    // Backward edges (incoming)
    const incoming = graph.adjacencyIn.get(current) ?? [];
    for (const edge of incoming) {
      const neighbor = edge.fromSymbolId;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const neighborPath = getRelPath(neighbor);
      if (neighborPath && isTestFile(neighborPath)) {
        candidates.push({
          symbolId: neighbor,
          file: neighborPath,
          distance: depth + 1,
        });
      }
      queue.push([neighbor, depth + 1]);
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
    const {
      symbolId: current,
      distance,
      testSymbolId,
      testFile,
    } = queue[queueHead++];

    if (distance >= MAX_BFS_DEPTH) {
      continue;
    }

    // Traverse outgoing edges (forward)
    for (const edge of graph.adjacencyOut.get(current) ?? []) {
      const neighbor = edge.toSymbolId;
      if (!nearest.has(neighbor)) {
        nearest.set(neighbor, {
          file: testFile,
          symbolId: testSymbolId,
          distance: distance + 1,
        });
        queue.push({
          symbolId: neighbor,
          distance: distance + 1,
          testSymbolId,
          testFile,
        });
      }
    }

    // Traverse incoming edges (backward)
    for (const edge of graph.adjacencyIn.get(current) ?? []) {
      const neighbor = edge.fromSymbolId;
      if (!nearest.has(neighbor)) {
        nearest.set(neighbor, {
          file: testFile,
          symbolId: testSymbolId,
          distance: distance + 1,
        });
        queue.push({
          symbolId: neighbor,
          distance: distance + 1,
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
): Promise<void> {
  const conn = await getLadybugConn();

  const [edges, repo] = await Promise.all([
    ladybugDb.getEdgesByRepo(conn, repoId),
    ladybugDb.getRepo(conn, repoId),
  ]);
  if (!repo) {
    return;
  }
  const config: RepoConfig = JSON.parse(repo.configJson);
  const [files, allSymbols] = await Promise.all([
    ladybugDb.getFilesByRepo(conn, repoId),
    ladybugDb.getSymbolsByRepo(conn, repoId),
  ]);
  const fileById = new Map(files.map((file) => [file.fileId, file.relPath]));
  const symbolIds = new Set(allSymbols.map((symbol) => symbol.symbolId));

  let symbols = allSymbols;

  // If an empty set is explicitly passed, it means no files changed - nothing to update
  if (changedFileIds && changedFileIds.size === 0) {
    logger.debug("Empty changedFileIds provided - no updates needed");
    return;
  }

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

  const fanMetrics = calculateFanMetrics(edges, symbolIds);
  const churnByFile = await getChurnByFileCached(repo.rootPath);
  const testRefs = collectTestRefs(repo.rootPath, allSymbols, config);

  // Build a lightweight Graph for canonicalTest BFS
  const symbolMap = new Map(allSymbols.map((s) => [s.symbolId, s]));
  const adjacencyOut = new Map<string, EdgeRow[]>();
  const adjacencyIn = new Map<string, EdgeRow[]>();
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
  const batchCanonical = batchComputeCanonicalTests(graph, fileById);

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

  await withWriteConn(async (wConn) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await ladybugDb.upsertMetricsBatch(wConn, chunk);
    }
  });
}

export interface Graph {
  repoId: string;
  symbols: Map<string, SymbolRow>;
  edges: EdgeRow[];
  adjacencyIn: Map<string, EdgeRow[]>;
  adjacencyOut: Map<string, EdgeRow[]>;
}
