import { createHash } from "crypto";
import { execFile } from "child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "util";
import { globSync } from "node:fs";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type {
  EdgeLite,
  MetricsRow,
  SymbolLiteRow,
} from "../db/ladybug-queries.js";
import type { AlgorithmRefreshConfig, RepoConfig } from "../config/types.js";
import type { CanonicalTest, StalenessTiers } from "../domain/types.js";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { safeJsonParse, ConfigObjectSchema } from "../util/safeJson.js";
import {
  CentralityWorkerTimeoutError,
  runCentralityWorker,
} from "./centrality-worker-runner.js";

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

interface MetricsPayloadFingerprint {
  metricsHash: string;
  rowCount: number;
}

interface MetricsPayloadFingerprintOptions {
  assumeCanonicalJson?: boolean;
}

export type FoldedCentralityResult =
  | {
      status: "succeeded";
      symbolCount: number;
      callEdgeCount: number;
      pageRankCount: number;
      kCoreCount: number;
    }
  | {
      status: "failed";
      symbolCount: number;
      callEdgeCount: number;
      reason: string;
      timedOut: boolean;
    };

interface FoldedCentralityValues {
  result: FoldedCentralityResult;
  bySymbolId: Map<string, { pageRank: number; kCore: number }>;
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

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalizeJsonValue);
    const allScalar = items.every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    );
    if (allScalar) {
      return [...items].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    }
    return items;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeJsonValue(record[key]);
    }
    return sorted;
  }

  return value;
}

function canonicalizeMetricsJson(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(canonicalizeJsonValue(JSON.parse(value)));
  } catch {
    return value;
  }
}

function buildMetricsPayloadFingerprint(
  rows: readonly MetricsRow[],
  options: MetricsPayloadFingerprintOptions = {},
): MetricsPayloadFingerprint {
  const hash = createHash("sha256");
  const sortedRows = [...rows].sort((a, b) =>
    a.symbolId.localeCompare(b.symbolId),
  );
  const stableJson = (value: string | null | undefined): string =>
    options.assumeCanonicalJson
      ? (value ?? "")
      : canonicalizeMetricsJson(value);
  for (const row of sortedRows) {
    hash.update(row.symbolId);
    hash.update("\0");
    hash.update(String(row.fanIn));
    hash.update("\0");
    hash.update(String(row.fanOut));
    hash.update("\0");
    hash.update(String(row.churn30d));
    hash.update("\0");
    hash.update(stableJson(row.testRefsJson));
    hash.update("\0");
    hash.update(stableJson(row.canonicalTestJson));
    hash.update("\0");
    hash.update(String(row.pageRank ?? 0));
    hash.update("\0");
    hash.update(String(row.kCore ?? 0));
    hash.update("\0");
  }
  return {
    metricsHash: hash.digest("hex"),
    rowCount: rows.length,
  };
}

function canonicalTestToJson(canonicalTest: CanonicalTest): string {
  return JSON.stringify({
    distance: canonicalTest.distance,
    file: canonicalTest.file,
    proximity: canonicalTest.proximity,
    symbolId: canonicalTest.symbolId,
  });
}

interface TestRefCache {
  repoRoot: string;
  fileHashes: Map<string, string>;
  fileStats: Map<string, TestRefFileStat>;
  testRefs: Map<string, Set<string>>;
  cachedAt: number;
}

interface TestRefFileStat {
  size: number;
  mtimeMs: number;
}

interface SerializedTestRefCache {
  version: number;
  repoRootKey: string;
  fileHashes: Record<string, string>;
  fileStats: Record<string, TestRefFileStat>;
  testRefs: Record<string, string[]>;
  cachedAt: number;
}

const TEST_REF_CACHE_VERSION = 1;
const MAX_TEST_REF_SYMBOL_IDS_PER_NAME = 200;
const testRefCacheByRepo = new Map<string, TestRefCache>();

interface TestRefSymbolLookup {
  nameToSymbolIds: Map<string, string[]>;
  symbolNames: Set<string>;
}

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
  return createHash("sha256").update(content).digest("hex");
}

function testRefRepoCacheKey(repoRoot: string): string {
  const normalized = normalizePath(repoRoot);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function testRefCachePath(repoRoot: string): string {
  const keyHash = createHash("sha256")
    .update(testRefRepoCacheKey(repoRoot))
    .digest("hex")
    .slice(0, 32);
  return join(tmpdir(), "sdl-mcp", "test-ref-cache", `${keyHash}.json`);
}

export function _getTestRefCachePathForTesting(repoRoot: string): string {
  return testRefCachePath(repoRoot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deserializeStringMap(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!isRecord(value)) return result;
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      result.set(key, rawValue);
    }
  }
  return result;
}

function deserializeFileStats(value: unknown): Map<string, TestRefFileStat> {
  const result = new Map<string, TestRefFileStat>();
  if (!isRecord(value)) return result;
  for (const [key, rawValue] of Object.entries(value)) {
    if (!isRecord(rawValue)) continue;
    const size = rawValue.size;
    const mtimeMs = rawValue.mtimeMs;
    if (typeof size === "number" && typeof mtimeMs === "number") {
      result.set(key, { size, mtimeMs });
    }
  }
  return result;
}

function deserializeTestRefs(value: unknown): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (!isRecord(value)) return result;
  for (const [key, rawValue] of Object.entries(value)) {
    if (!Array.isArray(rawValue)) continue;
    const refs = rawValue.filter((ref): ref is string => typeof ref === "string");
    result.set(key, new Set(refs));
  }
  return result;
}

async function loadPersistedTestRefCache(
  repoRoot: string,
): Promise<TestRefCache | null> {
  try {
    const raw = JSON.parse(
      await readFile(testRefCachePath(repoRoot), "utf8"),
    ) as unknown;
    if (!isRecord(raw)) return null;
    if (raw.version !== TEST_REF_CACHE_VERSION) return null;
    if (raw.repoRootKey !== testRefRepoCacheKey(repoRoot)) return null;
    const cachedAt = typeof raw.cachedAt === "number" ? raw.cachedAt : 0;
    return {
      repoRoot,
      fileHashes: deserializeStringMap(raw.fileHashes),
      fileStats: deserializeFileStats(raw.fileStats),
      testRefs: deserializeTestRefs(raw.testRefs),
      cachedAt,
    };
  } catch {
    return null;
  }
}

async function persistTestRefCache(cache: TestRefCache): Promise<void> {
  const fileHashes = Object.fromEntries(cache.fileHashes.entries());
  const fileStats = Object.fromEntries(cache.fileStats.entries());
  const testRefs = Object.fromEntries(
    Array.from(cache.testRefs.entries(), ([file, refs]) => [
      file,
      Array.from(refs).sort(),
    ]),
  );
  const serialized: SerializedTestRefCache = {
    version: TEST_REF_CACHE_VERSION,
    repoRootKey: testRefRepoCacheKey(cache.repoRoot),
    fileHashes,
    fileStats,
    testRefs,
    cachedAt: cache.cachedAt,
  };
  const cacheFile = testRefCachePath(cache.repoRoot);
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(serialized)}\n`, "utf8");
}

function sameTestRefFileStat(
  expected: TestRefFileStat | undefined,
  actual: TestRefFileStat,
): boolean {
  return (
    expected !== undefined &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function buildTestRefSymbolLookup(
  symbols: Array<{ symbolId: string; name: string }>,
  candidateNames: ReadonlySet<string>,
): TestRefSymbolLookup {
  const nameCounts = new Map<string, number>();
  for (const symbol of symbols) {
    if (!candidateNames.has(symbol.name)) continue;
    nameCounts.set(symbol.name, (nameCounts.get(symbol.name) ?? 0) + 1);
  }

  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (!candidateNames.has(symbol.name)) continue;
    const count = nameCounts.get(symbol.name) ?? 0;
    if (count > MAX_TEST_REF_SYMBOL_IDS_PER_NAME) continue;
    const existing = nameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    nameToSymbolIds.set(symbol.name, existing);
  }

  return {
    nameToSymbolIds,
    symbolNames: new Set(nameToSymbolIds.keys()),
  };
}

function isExcludedTestRefPath(normalizedPath: string): boolean {
  return (
    normalizedPath.includes("/fixtures/") ||
    normalizedPath.includes("/__fixtures__/") ||
    normalizedPath.includes("/testdata/") ||
    normalizedPath.includes("/test-data/") ||
    normalizedPath.includes("/mock-data/")
  );
}

function hasConfiguredTestRefExtension(
  normalizedPath: string,
  languageExts: ReadonlySet<string>,
): boolean {
  for (const ext of languageExts) {
    if (normalizedPath.endsWith(`.${ext}`)) return true;
  }
  return false;
}

function isTestRefCandidateFile(
  relPath: string,
  languageExts: ReadonlySet<string>,
): boolean {
  const normalizedPath = normalizePath(relPath);
  const lowerPath = normalizedPath.toLowerCase();
  if (isExcludedTestRefPath(lowerPath)) return false;

  for (const ext of languageExts) {
    if (
      lowerPath.endsWith(`.test.${ext}`) ||
      lowerPath.endsWith(`.spec.${ext}`)
    ) {
      return true;
    }
  }

  return (
    (lowerPath.includes("/tests/") ||
      lowerPath.startsWith("tests/") ||
      lowerPath.includes("/__tests__/") ||
      lowerPath.startsWith("__tests__/")) &&
    hasConfiguredTestRefExtension(lowerPath, languageExts)
  );
}

async function collectTestRefs(
  repoRoot: string,
  symbols: Array<{ symbolId: string; name: string }>,
  config: RepoConfig,
  changedTestFilePaths?: Set<string>,
  indexedRepoFiles?: readonly string[],
  indexedFileContentHashes?: ReadonlyMap<string, string>,
): Promise<Map<string, Set<string>>> {
  const languageExts = new Set(
    config.languages.map((language) => language.toLowerCase()),
  );
  const testFiles = indexedRepoFiles
    ? Array.from(
        new Set(
          indexedRepoFiles
            .map((file) => normalizePath(file))
            .filter((file) => isTestRefCandidateFile(file, languageExts)),
        ),
      )
    : (() => {
        const extGroup = config.languages.join(",");
        const patterns = [
          `**/*.test.{${extGroup}}`,
          `**/*.spec.{${extGroup}}`,
          `**/__tests__/**/*.${extGroup}`,
          `**/tests/**/*.${extGroup}`,
        ];

        const bracePattern =
          patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
        return globSync(bracePattern, {
          cwd: repoRoot,
          exclude: [
            ...(config.ignore ?? []),
            "**/fixtures/**",
            "**/__fixtures__/**",
            "**/testdata/**",
            "**/test-data/**",
            "**/mock-data/**",
          ],
        }).map((file) => normalizePath(file));
      })();

  let cached = testRefCacheByRepo.get(repoRoot);
  if (!cached) {
    const persistedCache = await loadPersistedTestRefCache(repoRoot);
    if (persistedCache) {
      cached = persistedCache;
      testRefCacheByRepo.set(repoRoot, persistedCache);
    }
  }
  const fileHashes = cached?.fileHashes ?? new Map<string, string>();
  const fileStats = cached?.fileStats ?? new Map<string, TestRefFileStat>();
  const normalizedIndexedFileContentHashes = indexedFileContentHashes
    ? new Map(
        Array.from(indexedFileContentHashes.entries(), ([file, hash]) => [
          normalizePath(file),
          hash,
        ]),
      )
    : null;
  const CONCURRENCY_LIMIT = 10;
  const testRefs = new Map<string, Set<string>>();
  const newTestRefs = new Map<string, Set<string>>();
  const newFileHashes = new Map<string, string>();
  const newFileStats = new Map<string, TestRefFileStat>();
  const candidateNames = new Set<string>();
  const pendingCachedFiles: Array<{
    file: string;
    cachedFileRefs: Set<string>;
    currentStat?: TestRefFileStat;
  }> = [];
  const pendingTokenFiles: Array<{
    file: string;
    tokens: Set<string>;
    hash: string;
    currentStat: TestRefFileStat;
  }> = [];

  const queueCachedFileRefs = (
    file: string,
    cachedFileRefs: Set<string>,
    currentStat?: TestRefFileStat,
  ): void => {
    pendingCachedFiles.push({ file, cachedFileRefs, currentStat });
    for (const ref of cachedFileRefs) {
      candidateNames.add(ref);
    }
  };

  const hydrateCachedFileRefs = (
    file: string,
    cachedFileRefs: Set<string>,
    lookup: TestRefSymbolLookup,
    currentStat?: TestRefFileStat,
  ): void => {
    const retainedRefs = new Set<string>();
    for (const ref of cachedFileRefs) {
      const symbolIds = lookup.nameToSymbolIds.get(ref);
      if (!symbolIds) continue;
      retainedRefs.add(ref);
      for (const symbolId of symbolIds) {
        const existing = testRefs.get(symbolId) ?? new Set<string>();
        existing.add(normalizePath(file));
        testRefs.set(symbolId, existing);
      }
    }
    const hash = fileHashes.get(file);
    const fileStat = currentStat ?? fileStats.get(file);
    if (hash) {
      newFileHashes.set(file, hash);
    }
    if (fileStat) {
      newFileStats.set(file, fileStat);
    }
    newTestRefs.set(file, retainedRefs);
  };

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
      queueCachedFileRefs(file, cachedFileRefs);
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
          const absolutePath = join(repoRoot, file);
          const forceRead =
            normalizedChangedPaths?.has(normalizePath(file)) ?? false;
          const cachedFileRefs = cached?.testRefs.get(file);
          const indexedHash = normalizedIndexedFileContentHashes?.get(
            normalizePath(file),
          );
          if (
            !forceRead &&
            cachedFileRefs &&
            indexedHash &&
            cached?.fileHashes.get(file) === indexedHash
          ) {
            return {
              file,
              cachedFileRefs,
              currentStat: fileStats.get(file),
              content: null,
            };
          }
          const fileStat = await stat(absolutePath);
          const currentStat = {
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
          };
          if (
            !forceRead &&
            cachedFileRefs &&
            sameTestRefFileStat(fileStats.get(file), currentStat)
          ) {
            return {
              file,
              cachedFileRefs,
              currentStat,
              content: null,
            };
          }
          const content = await readFile(absolutePath, "utf-8");
          return { file, content, currentStat, cachedFileRefs: null };
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
      const { file, content, currentStat } = result;

      if (result.cachedFileRefs) {
        queueCachedFileRefs(file, result.cachedFileRefs, currentStat);
        continue;
      }

      if (content === null) continue;

      const hash = computeFileHash(content);

      if (cached && cached.fileHashes.get(file) === hash) {
        const cachedFileRefs = cached.testRefs.get(file);
        if (cachedFileRefs) {
          queueCachedFileRefs(file, cachedFileRefs, currentStat);
          continue;
        }
      }

      const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        candidateNames.add(token);
      }
      pendingTokenFiles.push({ file, tokens: uniqueTokens, hash, currentStat });
    }
  }

  const lookup = buildTestRefSymbolLookup(symbols, candidateNames);

  for (const { file, cachedFileRefs, currentStat } of pendingCachedFiles) {
    hydrateCachedFileRefs(file, cachedFileRefs, lookup, currentStat);
  }

  for (const { file, tokens, hash, currentStat } of pendingTokenFiles) {
    newFileHashes.set(file, hash);
    newFileStats.set(file, currentStat);
    const matchedSymbols = new Set<string>();

    for (const token of tokens) {
      if (!lookup.symbolNames.has(token)) continue;
      matchedSymbols.add(token);
      const symbolIds = lookup.nameToSymbolIds.get(token);
      if (!symbolIds) continue;
      for (const symbolId of symbolIds) {
        const existing = testRefs.get(symbolId) ?? new Set<string>();
        existing.add(normalizePath(file));
        testRefs.set(symbolId, existing);
      }
    }
    newTestRefs.set(file, matchedSymbols);
  }

  const nextCache = {
    repoRoot,
    fileHashes: newFileHashes,
    fileStats: newFileStats,
    testRefs: newTestRefs,
    cachedAt: Date.now(),
  };
  testRefCacheByRepo.set(repoRoot, nextCache);
  if (testRefCacheByRepo.size > MAX_METRICS_CACHED_REPOS) {
    const firstKey = testRefCacheByRepo.keys().next().value;
    if (firstKey !== undefined) testRefCacheByRepo.delete(firstKey);
  }
  try {
    await persistTestRefCache(nextCache);
  } catch (err) {
    logger.debug("Failed to persist test reference cache", {
      repoRoot,
      error: String(err),
    });
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

export function _buildTestRefSymbolLookupForTesting(
  symbols: Array<{ symbolId: string; name: string }>,
  candidateNames: ReadonlySet<string>,
): TestRefSymbolLookup {
  return buildTestRefSymbolLookup(symbols, candidateNames);
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
  const normalized = normalizePath(relPath);

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

async function maybeComputeFoldedCentrality(params: {
  metricsRowsCoverAllSymbols: boolean;
  algorithmRefresh: AlgorithmRefreshConfig | undefined;
  symbolIds: string[];
  callEdges: Array<{ callerId: string; calleeId: string }>;
  measureSubphase: <T>(phaseName: string, fn: () => Promise<T>) => Promise<T>;
}): Promise<FoldedCentralityValues | undefined> {
  const algorithmRefresh = params.algorithmRefresh;
  if (!algorithmRefresh) {
    return undefined;
  }
  const enabled = algorithmRefresh.enabled;
  const pageRankEnabled = algorithmRefresh.pageRank.enabled;
  const kCoreEnabled = algorithmRefresh.kCore.enabled;
  if (
    !params.metricsRowsCoverAllSymbols ||
    !enabled ||
    (!pageRankEnabled && !kCoreEnabled) ||
    params.callEdges.length === 0 ||
    params.symbolIds.length === 0
  ) {
    return undefined;
  }

  try {
    const result = await params.measureSubphase("centralityFold", () =>
      runCentralityWorker(
        {
          symbolIds: params.symbolIds,
          callEdges: params.callEdges,
          pageRankEnabled,
          kCoreEnabled,
        },
        algorithmRefresh?.workerTimeoutMs ?? 120_000,
      ),
    );
    const bySymbolId = new Map<string, { pageRank: number; kCore: number }>();
    for (const symbolId of params.symbolIds) {
      bySymbolId.set(symbolId, { pageRank: 0, kCore: 0 });
    }
    for (const row of result.pageRank) {
      const entry = bySymbolId.get(row.symbolId);
      if (entry) entry.pageRank = row.score;
    }
    for (const row of result.kCore) {
      const entry = bySymbolId.get(row.symbolId);
      if (entry) entry.kCore = row.coreness;
    }
    return {
      result: {
        status: "succeeded",
        symbolCount: params.symbolIds.length,
        callEdgeCount: params.callEdges.length,
        pageRankCount: result.pageRank.length,
        kCoreCount: result.kCore.length,
      },
      bySymbolId,
    };
  } catch (error) {
    const timedOut = error instanceof CentralityWorkerTimeoutError;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      result: {
        status: "failed",
        symbolCount: params.symbolIds.length,
        callEdgeCount: params.callEdges.length,
        reason,
        timedOut,
      },
      bySymbolId: new Map(),
    };
  }
}

export async function updateMetricsForRepo(
  repoId: string,
  changedFileIds?: Set<string>,
  options?: {
    includeTimings?: boolean;
    changedTestFilePaths?: Set<string>;
    algorithmRefresh?: AlgorithmRefreshConfig;
  },
): Promise<{
  timings?: Record<string, number>;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
  /**
   * Set of symbol IDs affected by `changedFileIds` (direct + 1-hop edge
   * neighbours). Undefined for full-repo runs (when `changedFileIds` is
   * undefined or empty). Downstream consumers (semantic embedding refresh)
   * use this to scope per-symbol work to <100 IDs on incremental runs
   * instead of paying the full ~8k pre-pass cost.
   */
  affectedSymbolIds?: Set<string>;
  foldedCentrality?: FoldedCentralityResult;
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
  const recordSubphase = (phaseName: string, durationMs: number): void => {
    if (timings) {
      timings[phaseName] = durationMs;
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
  const fullRepoMetricsRefresh = changedFileIds === undefined;
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
  let affectedSymbolIds: Set<string> | undefined;

  if (changedFileIds && changedFileIds.size > 0) {
    affectedSymbolIds = new Set<string>();

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

    const affected = affectedSymbolIds;
    symbols = allSymbols.filter((s) => affected.has(s.symbolId));
    logger.debug(
      `Incremental metrics: updating ${symbols.length} of ${allSymbols.length} symbols for ${changedFileIds.size} changed files`,
    );
  }
  const metricsRowsCoverAllSymbols = symbols.length === allSymbols.length;

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
      files.map((file) => file.relPath),
      new Map(files.map((file) => [file.relPath, file.contentHash])),
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
  // Build the shared call graph before Metrics row materialization so full
  // refreshes can fold centrality into the same Metrics write.
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

  // Batch-compute all canonical tests in a single BFS pass (O(edges)) rather
  // than running a separate per-symbol BFS (O(symbols × MAX_BFS_VISITED)).
  const batchCanonical = await measureSubphase("canonicalTests", async () =>
    batchComputeCanonicalTests(graph, fileById),
  );

  const now = monotonicIsoNow();
  const foldedCentrality = await maybeComputeFoldedCentrality({
    metricsRowsCoverAllSymbols,
    algorithmRefresh: options?.algorithmRefresh,
    symbolIds: [...symbolIds].sort(),
    callEdges: sharedCallEdges,
    measureSubphase,
  });
  const centralityBySymbolId =
    foldedCentrality?.result.status === "succeeded"
      ? foldedCentrality.bySymbolId
      : new Map<string, { pageRank: number; kCore: number }>();

  // Build all metrics rows, then hand the complete set to the DB helper. The
  // helper owns internal statement chunking inside one transaction; splitting
  // here would multiply transaction overhead during full-index finalization.
  const BATCH_SIZE = 200;
  const rows: MetricsRow[] = [];
  for (const symbol of symbols) {
    const metric = fanMetrics.get(symbol.symbolId) ?? { fanIn: 0, fanOut: 0 };
    const relPath = fileById.get(symbol.fileId);
    const churn = relPath ? (churnByFile.get(relPath) ?? 0) : 0;
    const refs = Array.from(testRefs.get(symbol.symbolId) ?? []).sort();
    const canonicalTest = batchCanonical.get(symbol.symbolId) ?? null;
    const centrality = centralityBySymbolId.get(symbol.symbolId);
    rows.push({
      symbolId: symbol.symbolId,
      fanIn: metric.fanIn,
      fanOut: metric.fanOut,
      churn30d: churn,
      testRefsJson: JSON.stringify(refs),
      canonicalTestJson: canonicalTest
        ? canonicalTestToJson(canonicalTest)
        : null,
      pageRank: centrality?.pageRank ?? 0,
      kCore: centrality?.kCore ?? 0,
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
      const canonicalTestJson = ct ? canonicalTestToJson(ct) : null;
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

  const metricsPayloadFingerprint =
    fullRepoMetricsRefresh && rows.length > 0
      ? await measureSubphase("metricsFingerprint", async () => {
          const next = buildMetricsPayloadFingerprint(rows, {
            assumeCanonicalJson: true,
          });
          const previous = await ladybugDb.getMetricsFingerprint(conn, repoId);
          return {
            next,
            unchanged:
              previous?.metricsHash === next.metricsHash &&
              previous.rowCount === next.rowCount,
          };
        })
      : null;

  if (rows.length > 0) {
    if (metricsPayloadFingerprint?.unchanged) {
      recordSubphase("writeMetrics", 0);
      recordSubphase("writeRows", 0);
      recordSubphase("writeWait", 0);
    } else {
      await measureSubphase("writeMetrics", async () => {
        await withWriteConn(async (wConn) => {
          await measureSubphase("writeRows", () =>
            fullRepoMetricsRefresh
              ? ladybugDb.replaceMetricsForRepoCopy(wConn, repoId, rows, {
                  measurePhase: (phaseName, fn) =>
                    measureSubphase(`writeRows.${phaseName}`, fn),
                })
              : ladybugDb.upsertMetricsBatch(wConn, rows, {
                  measurePhase: (phaseName, fn) =>
                    measureSubphase(`writeRows.${phaseName}`, async () =>
                      await fn(),
                    ),
                }),
          );
          if (metricsPayloadFingerprint) {
            await measureSubphase("writeFingerprint", () =>
              ladybugDb.upsertMetricsFingerprint(wConn, {
                repoId,
                metricsHash: metricsPayloadFingerprint.next.metricsHash,
                rowCount: metricsPayloadFingerprint.next.rowCount,
                updatedAt: now,
              }),
            );
          }
        });
      });
      if (timings) {
        recordSubphase(
          "writeWait",
          Math.max(
            0,
            (timings.writeMetrics ?? 0) -
              (timings.writeRows ?? 0) -
              (timings.writeFingerprint ?? 0),
          ),
        );
      }
    }
  } else {
    recordSubphase("writeMetrics", 0);
    recordSubphase("writeWait", 0);
    recordSubphase("writeRows", 0);
  }

  return {
    timings,
    sharedGraph: {
      callEdges: sharedCallEdges,
      clusterEdges: sharedClusterEdges,
    },
    affectedSymbolIds,
    foldedCentrality: foldedCentrality?.result,
  };
}

export const _buildMetricsPayloadFingerprintForTesting =
  buildMetricsPayloadFingerprint;

interface Graph {
  repoId: string;
  symbols: Map<string, Pick<SymbolLiteRow, "symbolId" | "fileId">>;
  edges: EdgeLite[];
  adjacencyIn: Map<string, EdgeLite[]>;
  adjacencyOut: Map<string, EdgeLite[]>;
}
