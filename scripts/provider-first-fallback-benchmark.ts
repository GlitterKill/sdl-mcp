import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface Args {
  config: string;
  repoId?: string;
  sampleSize: number;
  seed: string;
  repeats: number;
  outDir: string;
  priorityFileList?: string;
  maxLegacyFallbackFiles?: number;
  pass2Concurrency?: number;
  checkpointThresholdBytes?: number;
  pass2CopyBufferMaxEdges?: number;
}

interface FileMetadata {
  path: string;
  size: number;
  mtime: number;
}

interface SelectionResult {
  files: FileMetadata[];
  providerCandidateFiles: number;
  providerSelectedFiles: number;
  providerTarget: number;
  priorityCandidateFiles: number;
  prioritySelectedFiles: number;
  priorityTarget: number;
}

interface BenchmarkRunMetrics {
  repeat: number;
  exitCode: number | null;
  wallTimeMs?: number;
  durationMs?: number;
  providerFirstTotalMs?: number;
  providerPrimaryFiles?: number;
  semanticEligibleFiles?: number;
  scannedFiles?: number;
  providerDocs?: number;
  fallbackFiles?: number;
  fallbackTotalMs?: number;
  fallbackEngine?: FallbackEngineMetric;
  legacyFallbackPhases?: LegacyFallbackPhaseMetrics;
  pass1DrainEdgeStats?: Pass1DrainEdgeStatsMetric;
  pass1DrainEdgePhaseStats?: Record<string, PhaseStatsMetric>;
  pass1ExtractionCacheStats?: Record<string, number>;
  pass2DispatchStats?: Pass2DispatchStatsMetric;
  pass2WriteStats?: Pass2WriteStatsMetric;
  pass2Resolvers?: Pass2ResolverBenchmarkMetric[];
  providerUnusableFiles?: number;
  warningCount: number;
  errorCount: number;
  stdoutPath: string;
  stderrPath: string;
  configPath: string;
  graphDbPath: string;
}

interface FallbackEngineMetric {
  engine: string;
  mode: string;
  concurrency: number;
  workers: number;
  batchPersist: boolean;
  autoDrain: boolean;
  nativeChunks: string;
  drainBetweenChunks: boolean;
}

interface LegacyFallbackPhaseMetrics {
  pass1Ms?: number;
  pass1DrainMs?: number;
  pass1DrainInsertEdgesMs?: number;
  pass1DrainInsertEdgesKnownEnsureMs?: number;
  pass1DrainInsertEdgesKnownEnsureProbeMs?: number;
  pass1DrainInsertEdgesKnownEnsureCopyMissingCsvMaterializeMs?: number;
  pass1DrainInsertEdgesKnownEnsureCopyMissingCopyFromMs?: number;
  pass1DrainInsertEdgesKnownEnsureMatchExistingMs?: number;
  pass1DrainInsertEdgesKnownEnsureMergeFallbackMs?: number;
  pass1DrainInsertEdgesKnownEnsureRepoLinkMs?: number;
  pass1DrainInsertEdgesKnownCopyMs?: number;
  pass1DrainInsertEdgesKnownCopyTxnBeginMs?: number;
  pass1DrainInsertEdgesKnownCopyTxnBodyMs?: number;
  pass1DrainInsertEdgesKnownCopyTxnCommitMs?: number;
  pass1DrainInsertEdgesKnownCopyCsvMaterializeMs?: number;
  pass1DrainInsertEdgesKnownCopyCopyFromMs?: number;
  pass1DrainInsertEdgesKnownCopyTempCleanupMs?: number;
  pass1DrainInsertEdgesRepairMs?: number;
  pass1DrainInsertEdgesRepairPrepareRowsMs?: number;
  pass1DrainInsertEdgesRepairEndpointMetadataMs?: number;
  pass1DrainInsertEdgesRepairTargetMetadataMs?: number;
  pass1DrainInsertEdgesRepairTargetRepoLinkMs?: number;
  pass1DrainInsertEdgesRepairRelationshipCreateMs?: number;
  pass2Ms?: number;
  finalizeMs?: number;
  pass2TargetSelectionMs?: number;
  pass2ImportCacheMs?: number;
  pass2ResolverWarmupMs?: number;
  pass2ResolverDispatchMs?: number;
  pass2WriteActiveMs?: number;
  pass2WriteQueueMs?: number;
  pass2WriteCopyEnsureMs?: number;
  pass2WriteCopyEnsureSymbolsMs?: number;
  pass2WriteCopyEnsureSymbolsProbeMs?: number;
  pass2WriteCopyEnsureSymbolsCopyMissingCsvMaterializeMs?: number;
  pass2WriteCopyEnsureSymbolsCopyMissingCopyFromMs?: number;
  pass2WriteCopyEnsureSymbolsMatchExistingMs?: number;
  pass2WriteCopyEnsureSymbolsMergeFallbackMs?: number;
  pass2WriteCopyEnsureRepoLinksMs?: number;
  pass2WriteCopyInsertMs?: number;
  pass2WriteCopyInsertTxnBeginMs?: number;
  pass2WriteCopyInsertTxnBodyMs?: number;
  pass2WriteCopyInsertTxnCommitMs?: number;
  pass2WriteCopyInsertCsvMaterializeMs?: number;
  pass2WriteCopyInsertCopyFromMs?: number;
  pass2WriteCopyInsertTempCleanupMs?: number;
  pass2WriteRepairInsertMs?: number;
  pass2WriteRepairInsertPrepareRowsMs?: number;
  pass2WriteRepairInsertSourceRepoLinkSymbolMetadataMs?: number;
  pass2WriteRepairInsertSourceRepoLinkRepoLinkMs?: number;
  pass2WriteRepairInsertEndpointMetadataMs?: number;
  pass2WriteRepairInsertTargetMetadataMs?: number;
  pass2WriteRepairInsertTargetRepoLinkMs?: number;
  pass2WriteRepairInsertRelationshipCreateMs?: number;
  pass2WriteRepairInsertRelationshipUpdateMs?: number;
  finalizeMetricsCentralityFoldMs?: number;
  finalizeMetricsWriteRowsCsvMaterializeMs?: number;
  finalizeMetricsWriteRowsDeleteExistingMs?: number;
  finalizeMetricsWriteRowsCopyFromMs?: number;
  finalizeMetricsWriteRowsPrepareRowsMs?: number;
  finalizeMetricsWriteRowsProbeExistingMs?: number;
  finalizeMetricsWriteRowsCopyMissingCsvMaterializeMs?: number;
  finalizeMetricsWriteRowsCopyMissingCopyFromMs?: number;
  finalizeMetricsWriteRowsCreateMissingMs?: number;
  finalizeMetricsWriteRowsMergeExistingMs?: number;
}

interface Pass1DrainEdgeStatsMetric {
  edgeStatsSchemaVersion?: number;
  splitCalls?: number;
  totalEdges?: number;
  knownEndpointEdges?: number;
  initialRepairEdges?: number;
  belowThresholdKnownEdges?: number;
  knownCopyFlushes?: number;
  knownCopyEdges?: number;
  repairCalls?: number;
  repairEdges?: number;
  repairCauseBelowThresholdKnown?: number;
  repairCauseUnresolvedSource?: number;
  repairCauseBothUnsafe?: number;
  repairCauseSourceUnsafeOnly?: number;
  repairCauseTargetUnsafeOnly?: number;
  repairCauseTargetRealNotKnown?: number;
  repairCauseTargetNonReal?: number;
  repairCauseOther?: number;
  repairCauseSum?: number;
  repairCauseDrift?: number;
  repairSourceKnown?: number;
  repairSourceUnknownOrUnsafe?: number;
  repairSourceKnownTargetOnly?: number;
  repairSourceKnownTargetRealNotKnown?: number;
  repairSourceKnownTargetUnsafe?: number;
  repairSourceKnownTargetNonReal?: number;
}

interface PhaseStatsMetric {
  count?: number;
  rows?: number;
  maxMs?: number;
}

interface Pass2WriteStatsMetric {
  flushes?: number;
  edges?: number;
  copyFlushes?: number;
  copyEdges?: number;
  copyPlaceholders?: number;
  copyPlaceholderRows?: number;
  copyEnsuredRows?: number;
  copySkippedRows?: number;
  copyUnresolvedRows?: number;
  copyExternalRows?: number;
  repairFlushes?: number;
  repairEdges?: number;
  repairPrimaryEdges?: number;
  repairUnresolvedSource?: number;
  repairUnsafeSource?: number;
  repairUnsafeTarget?: number;
  repairUnsafeBoth?: number;
  repairOther?: number;
  repairCauseSum?: number;
  repairCauseDrift?: number;
  effectiveRepairRows?: number;
  smallCopyFlushes?: number;
  smallCopyEdges?: number;
}

interface Pass2DispatchStatsMetric {
  skippedNoExistingSymbols?: number;
}

interface Pass2ResolverBenchmarkMetric {
  resolverId: string;
  targets: number;
  files: number;
  edges: number;
  cumulativeMs: number;
  unresolved: number;
  ambiguous: number;
  broken: number;
  phaseTimings?: Record<string, number>;
  metrics?: Record<string, number>;
  topFiles?: Record<string, Pass2ResolverTopFileMetric[]>;
}

interface Pass2ResolverTopFileMetric {
  filePath: string;
  elapsedMs: number;
  bytes?: number;
}

interface ChildRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: "config/sdlmcp.config.json",
    sampleSize: 8000,
    seed: "provider-first-fallback-v1",
    repeats: 1,
    outDir: join(
      "devdocs",
      "benchmarks",
      "provider-first-fallback",
      timestamp(),
    ),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--config":
        args.config = requireValue(arg, value);
        i++;
        break;
      case "--repo-id":
        args.repoId = requireValue(arg, value);
        i++;
        break;
      case "--sample-size":
        args.sampleSize = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      case "--seed":
        args.seed = requireValue(arg, value);
        i++;
        break;
      case "--repeats":
        args.repeats = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      case "--out-dir":
        args.outDir = requireValue(arg, value);
        i++;
        break;
      case "--priority-file-list":
        args.priorityFileList = requireValue(arg, value);
        i++;
        break;
      case "--max-legacy-fallback-files":
        args.maxLegacyFallbackFiles = Number.parseInt(
          requireValue(arg, value),
          10,
        );
        i++;
        break;
      case "--pass2-concurrency":
        args.pass2Concurrency = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      case "--checkpoint-threshold-bytes":
        args.checkpointThresholdBytes = Number.parseInt(
          requireValue(arg, value),
          10,
        );
        i++;
        break;
      case "--pass2-copy-buffer-max-edges":
        args.pass2CopyBufferMaxEdges = Number.parseInt(
          requireValue(arg, value),
          10,
        );
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.sampleSize) || args.sampleSize < 1) {
    throw new Error("--sample-size must be a positive integer");
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) {
    throw new Error("--repeats must be a positive integer");
  }
  if (
    args.pass2Concurrency !== undefined &&
    (!Number.isInteger(args.pass2Concurrency) || args.pass2Concurrency < 1)
  ) {
    throw new Error("--pass2-concurrency must be a positive integer");
  }
  if (
    args.checkpointThresholdBytes !== undefined &&
    (!Number.isInteger(args.checkpointThresholdBytes) ||
      args.checkpointThresholdBytes < 1)
  ) {
    throw new Error("--checkpoint-threshold-bytes must be a positive integer");
  }
  if (
    args.pass2CopyBufferMaxEdges !== undefined &&
    (!Number.isInteger(args.pass2CopyBufferMaxEdges) ||
      args.pass2CopyBufferMaxEdges < 512)
  ) {
    throw new Error("--pass2-copy-buffer-max-edges must be an integer >= 512");
  }
  return args;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function stableScore(seed: string, value: string): number {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(value)
    .digest()
    .readUInt32BE(0);
}

function groupKey(path: string): string {
  const normalized = normalizePath(path);
  const ext = normalized.includes(".")
    ? normalized.slice(normalized.lastIndexOf(".")).toLowerCase()
    : "<none>";
  const top = normalized.split("/")[0] ?? "<root>";
  const second = normalized.split("/")[1] ?? "<root>";
  return `${ext}:${top}/${second}`;
}

function selectRepresentativeFiles(
  files: readonly FileMetadata[],
  sampleSize: number,
  seed: string,
  priorityPaths: ReadonlySet<string>,
  providerPaths: ReadonlySet<string>,
): SelectionResult {
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]));
  const selected = new Map<string, FileMetadata>();
  const providerCandidateFiles = [...providerPaths].filter((path) =>
    byPath.has(normalizePath(path)),
  ).length;
  const priorityCandidateFiles = [...priorityPaths].filter((path) =>
    byPath.has(normalizePath(path)),
  ).length;
  const priorityTarget = Math.min(
    priorityCandidateFiles,
    Math.floor(sampleSize * 0.4),
  );
  const providerTarget =
    providerCandidateFiles > 0
      ? Math.min(
          providerCandidateFiles,
          Math.max(1, Math.floor(sampleSize * 0.4)),
        )
      : 0;

  const orderedPriorityPaths = [...priorityPaths].sort(
    (left, right) => stableScore(seed, left) - stableScore(seed, right),
  );
  for (const path of orderedPriorityPaths) {
    if (selected.size >= sampleSize || selected.size >= priorityTarget) {
      break;
    }
    const file = byPath.get(normalizePath(path));
    if (file) selected.set(file.path, file);
  }

  const orderedProviderPaths = [...providerPaths].sort(
    (left, right) => stableScore(seed, left) - stableScore(seed, right),
  );
  for (const path of orderedProviderPaths) {
    if (
      selected.size >= sampleSize ||
      countSelectedProviderFiles(selected, providerPaths) >= providerTarget
    ) {
      break;
    }
    const file = byPath.get(normalizePath(path));
    if (file) selected.set(file.path, file);
  }

  const remaining = files.filter((file) => !selected.has(file.path));
  const groups = new Map<string, FileMetadata[]>();
  for (const file of remaining) {
    const key = groupKey(file.path);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  const orderedGroups = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      group: group.sort(
        (left, right) =>
          stableScore(seed, left.path) - stableScore(seed, right.path),
      ),
      cursor: 0,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  while (selected.size < sampleSize && orderedGroups.length > 0) {
    let madeProgress = false;
    for (const entry of orderedGroups) {
      if (selected.size >= sampleSize) break;
      const next = entry.group[entry.cursor++];
      if (!next) continue;
      selected.set(next.path, next);
      madeProgress = true;
    }
    if (!madeProgress) break;
  }

  const selectedFiles = [...selected.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return {
    files: selectedFiles,
    providerCandidateFiles,
    providerSelectedFiles: selectedFiles.filter((file) =>
      providerPaths.has(normalizePath(file.path)),
    ).length,
    providerTarget,
    priorityCandidateFiles,
    prioritySelectedFiles: selectedFiles.filter((file) =>
      priorityPaths.has(normalizePath(file.path)),
    ).length,
    priorityTarget,
  };
}

function countSelectedProviderFiles(
  selected: ReadonlyMap<string, FileMetadata>,
  providerPaths: ReadonlySet<string>,
): number {
  let count = 0;
  for (const file of selected.values()) {
    if (providerPaths.has(normalizePath(file.path))) count++;
  }
  return count;
}

function readPriorityPaths(path: string | undefined): Set<string> {
  if (!path) return new Set();
  const absolute = resolve(path);
  const raw = readFileSync(absolute, "utf8");
  if (absolute.endsWith(".json")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("--priority-file-list JSON must be an array");
    }
    return new Set(
      parsed
        .map((entry) => {
          if (typeof entry === "string") return normalizePath(entry);
          if (
            entry &&
            typeof entry === "object" &&
            "path" in entry &&
            typeof entry.path === "string"
          ) {
            return normalizePath(entry.path);
          }
          return undefined;
        })
        .filter((entry): entry is string => Boolean(entry)),
    );
  }
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => normalizePath(line.trim()))
      .filter((line) => line && !line.startsWith("#")),
  );
}

function summarizeSelection(files: readonly FileMetadata[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const file of files) {
    const key = groupKey(file.path);
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])),
  );
}

async function readProviderDocumentPaths(
  repoRoot: string,
  scipConfig: { enabled?: boolean; indexes?: Array<{ path: string }> } | undefined,
): Promise<Set<string>> {
  const providerPaths = new Set<string>();
  if (!scipConfig?.enabled || !scipConfig.indexes || scipConfig.indexes.length === 0) {
    return providerPaths;
  }
  const { createScipDecoder } = await import("../dist/scip/decoder-factory.js");
  for (const index of scipConfig.indexes) {
    const indexPath = resolve(repoRoot, index.path);
    if (!existsSync(indexPath)) continue;
    const decoder = await createScipDecoder(indexPath);
    try {
      for await (const document of decoder.documents()) {
        if (document.relativePath) {
          providerPaths.add(normalizePath(document.relativePath));
        }
      }
    } finally {
      decoder.close();
    }
  }
  return providerPaths;
}

function parseMetrics(
  repeat: number,
  stdout: string,
  stderr: string,
  paths: Pick<
    BenchmarkRunMetrics,
    "exitCode" | "stdoutPath" | "stderrPath" | "configPath" | "graphDbPath"
  >,
): BenchmarkRunMetrics {
  const providerCoverage = stdout.match(
    /Provider-first coverage: (\d+)\/(\d+) .* provider-primary/,
  );
  const scanScope = stdout.match(/scan scope (\d+), provider docs (\d+)/);
  const fallback = stdout.match(
    /Provider-first legacy fallback diagnostics: files=(\d+) total=(\d+)ms/,
  );
  const providerUnusableMatches = [
    ...stdout.matchAll(/: (\d+) file\(s\)(?:;|$)/g),
  ];
  return {
    repeat,
    exitCode: paths.exitCode,
    wallTimeMs: numberMatch(stdout, /Wall time: (\d+)ms/),
    durationMs: numberMatch(stdout, /Duration: (\d+)ms/),
    providerFirstTotalMs: numberMatch(
      stdout,
      /Provider-first timings: total=(\d+)ms/,
    ),
    providerPrimaryFiles: providerCoverage
      ? Number.parseInt(providerCoverage[1], 10)
      : undefined,
    semanticEligibleFiles: providerCoverage
      ? Number.parseInt(providerCoverage[2], 10)
      : undefined,
    scannedFiles: scanScope
      ? Number.parseInt(scanScope[1], 10)
      : numberMatch(stdout, /scanned (\d+) file\(s\)/),
    providerDocs: scanScope ? Number.parseInt(scanScope[2], 10) : undefined,
    fallbackFiles: fallback ? Number.parseInt(fallback[1], 10) : undefined,
    fallbackTotalMs: fallback ? Number.parseInt(fallback[2], 10) : undefined,
    fallbackEngine: parseFallbackEngineMetric(stdout),
    legacyFallbackPhases: parseLegacyFallbackPhaseMetrics(stdout),
    pass1DrainEdgeStats: parsePass1DrainEdgeStats(stdout),
    pass1DrainEdgePhaseStats: parsePass1DrainEdgePhaseStats(stdout),
    pass1ExtractionCacheStats: parsePass1ExtractionCacheStats(stdout),
    pass2DispatchStats: parsePass2DispatchStats(stdout),
    pass2WriteStats: parsePass2WriteStats(stdout),
    pass2Resolvers: parsePass2ResolverMetrics(stdout),
    providerUnusableFiles: providerUnusableMatches.reduce(
      (sum, match) => sum + Number.parseInt(match[1], 10),
      0,
    ),
    warningCount:
      countMatches(stderr, /\bwarn(?:ing)?\b/gi) +
      countMatches(stdout, /(^|\n)\s*(?:warn(?:ing)?|\[warn\])/gi),
    errorCount:
      countMatches(stderr, /\berror\b/gi) +
      countMatches(stdout, /(^|\n)\s*(?:error:|Error:|\[error\])/g),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    configPath: paths.configPath,
    graphDbPath: paths.graphDbPath,
  };
}

function parsePass1ExtractionCacheStats(
  stdout: string,
): Record<string, number> | undefined {
  const line = stdout.match(/pass2\.cache\.pass1Extraction: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const stats: Record<string, number> = {};
  for (const part of line.split(",")) {
    const match = part.trim().match(/^([A-Za-z.]+)=(\d+)$/);
    if (!match) continue;
    stats[match[1]] = Number.parseInt(match[2], 10);
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function parsePass2DispatchStats(
  stdout: string,
): Pass2DispatchStatsMetric | undefined {
  const line = stdout.match(/pass2\.dispatch: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const stats: Pass2DispatchStatsMetric = {};
  for (const part of line.split(",")) {
    const match = part.trim().match(/^([A-Za-z]+)=(\d+)$/);
    if (!match) continue;
    if (match[1] === "skippedNoExistingSymbols") {
      stats.skippedNoExistingSymbols = Number.parseInt(match[2], 10);
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function parseFallbackEngineMetric(
  stdout: string,
): FallbackEngineMetric | undefined {
  const match = stdout.match(
    /pass 1 engine=(\S+) fallback=(\S+) concurrency=(\d+) workers=(\d+) batchPersist=(on|off) autoDrain=(on|off) nativeChunks=(\S+) drainBetweenChunks=(on|off)/,
  );
  if (!match) return undefined;
  return {
    engine: match[1],
    mode: match[2],
    concurrency: Number.parseInt(match[3], 10),
    workers: Number.parseInt(match[4], 10),
    batchPersist: match[5] === "on",
    autoDrain: match[6] === "on",
    nativeChunks: match[7],
    drainBetweenChunks: match[8] === "on",
  };
}

function parseLegacyFallbackPhaseMetrics(
  stdout: string,
): LegacyFallbackPhaseMetrics | undefined {
  const topLevel = stdout.match(
    /pass1=(\d+)ms, pass1Drain=(\d+)ms,\s+pass2=(\d+)ms, finalize=(\d+)ms/,
  );
  const pass1Drain = parseTimingLine(
    stdout.match(/pass1Drain: ([^\r\n]+)/)?.[1],
  );
  const pass2 = parseTimingLine(stdout.match(/pass2: ([^\r\n]+)/)?.[1]);
  const finalize = parseTimingLine(stdout.match(/finalize: ([^\r\n]+)/)?.[1]);
  if (
    !topLevel &&
    pass1Drain.size === 0 &&
    pass2.size === 0 &&
    finalize.size === 0
  ) {
    return undefined;
  }
  return {
    pass1Ms: topLevel ? Number.parseInt(topLevel[1], 10) : undefined,
    pass1DrainMs: topLevel ? Number.parseInt(topLevel[2], 10) : undefined,
    pass1DrainInsertEdgesMs: pass1Drain.get("insertEdges"),
    pass1DrainInsertEdgesKnownEnsureMs: pass1Drain.get(
      "insertEdges.knownEnsure",
    ),
    pass1DrainInsertEdgesKnownEnsureProbeMs: pass1Drain.get(
      "insertEdges.knownEnsure.probe",
    ),
    pass1DrainInsertEdgesKnownEnsureCopyMissingCsvMaterializeMs:
      pass1Drain.get("insertEdges.knownEnsure.copyMissing.csv"),
    pass1DrainInsertEdgesKnownEnsureCopyMissingCopyFromMs: pass1Drain.get(
      "insertEdges.knownEnsure.copyMissing.copy",
    ),
    pass1DrainInsertEdgesKnownEnsureMatchExistingMs: pass1Drain.get(
      "insertEdges.knownEnsure.matchExisting",
    ),
    pass1DrainInsertEdgesKnownEnsureMergeFallbackMs: pass1Drain.get(
      "insertEdges.knownEnsure.mergeFallback",
    ),
    pass1DrainInsertEdgesKnownEnsureRepoLinkMs: pass1Drain.get(
      "insertEdges.knownEnsure.repoLink",
    ),
    pass1DrainInsertEdgesKnownCopyMs: pass1Drain.get("insertEdges.knownCopy"),
    pass1DrainInsertEdgesKnownCopyTxnBeginMs: pass1Drain.get(
      "insertEdges.knownCopy.txnBegin",
    ),
    pass1DrainInsertEdgesKnownCopyTxnBodyMs: pass1Drain.get(
      "insertEdges.knownCopy.txnBody",
    ),
    pass1DrainInsertEdgesKnownCopyTxnCommitMs: pass1Drain.get(
      "insertEdges.knownCopy.txnCommit",
    ),
    pass1DrainInsertEdgesKnownCopyCsvMaterializeMs: pass1Drain.get(
      "insertEdges.knownCopy.csv",
    ),
    pass1DrainInsertEdgesKnownCopyCopyFromMs: pass1Drain.get(
      "insertEdges.knownCopy.copy",
    ),
    pass1DrainInsertEdgesKnownCopyTempCleanupMs: pass1Drain.get(
      "insertEdges.knownCopy.cleanup",
    ),
    pass1DrainInsertEdgesRepairMs: pass1Drain.get("insertEdges.repair"),
    pass1DrainInsertEdgesRepairPrepareRowsMs: pass1Drain.get(
      "insertEdges.repair.prepareRows",
    ),
    pass1DrainInsertEdgesRepairEndpointMetadataMs: pass1Drain.get(
      "insertEdges.repair.endpointMetadata",
    ),
    pass1DrainInsertEdgesRepairTargetMetadataMs: pass1Drain.get(
      "insertEdges.repair.targetMetadata",
    ),
    pass1DrainInsertEdgesRepairTargetRepoLinkMs: pass1Drain.get(
      "insertEdges.repair.targetRepoLink",
    ),
    pass1DrainInsertEdgesRepairRelationshipCreateMs: pass1Drain.get(
      "insertEdges.repair.relationshipCreate",
    ),
    pass2Ms: topLevel ? Number.parseInt(topLevel[3], 10) : undefined,
    finalizeMs: topLevel ? Number.parseInt(topLevel[4], 10) : undefined,
    pass2TargetSelectionMs: pass2.get("targetSelection"),
    pass2ImportCacheMs: pass2.get("importCache"),
    pass2ResolverWarmupMs: pass2.get("resolverWarmup"),
    pass2ResolverDispatchMs: pass2.get("resolverDispatch"),
    pass2WriteActiveMs: pass2.get("writeActive"),
    pass2WriteQueueMs: pass2.get("writeQueue"),
    pass2WriteCopyEnsureMs: pass2.get("copyEnsure"),
    pass2WriteCopyEnsureSymbolsMs: pass2.get("copyEnsure.symbols"),
    pass2WriteCopyEnsureSymbolsProbeMs: pass2.get(
      "copyEnsure.symbols.probe",
    ),
    pass2WriteCopyEnsureSymbolsCopyMissingCsvMaterializeMs: pass2.get(
      "copyEnsure.symbols.copyMissing.csv",
    ),
    pass2WriteCopyEnsureSymbolsCopyMissingCopyFromMs: pass2.get(
      "copyEnsure.symbols.copyMissing.copy",
    ),
    pass2WriteCopyEnsureSymbolsMatchExistingMs: pass2.get(
      "copyEnsure.symbols.matchExisting",
    ),
    pass2WriteCopyEnsureSymbolsMergeFallbackMs: pass2.get(
      "copyEnsure.symbols.mergeFallback",
    ),
    pass2WriteCopyEnsureRepoLinksMs: pass2.get("copyEnsure.repoLinks"),
    pass2WriteCopyInsertMs: pass2.get("copyInsert"),
    pass2WriteCopyInsertTxnBeginMs: pass2.get("copyInsert.txnBegin"),
    pass2WriteCopyInsertTxnBodyMs: pass2.get("copyInsert.txnBody"),
    pass2WriteCopyInsertTxnCommitMs: pass2.get("copyInsert.txnCommit"),
    pass2WriteCopyInsertCsvMaterializeMs: pass2.get(
      "copyInsert.csvMaterialize",
    ),
    pass2WriteCopyInsertCopyFromMs: pass2.get("copyInsert.copyFrom"),
    pass2WriteCopyInsertTempCleanupMs: pass2.get("copyInsert.tempCleanup"),
    pass2WriteRepairInsertMs: pass2.get("repairInsert"),
    pass2WriteRepairInsertPrepareRowsMs: pass2.get(
      "repairInsert.prepareRows",
    ),
    pass2WriteRepairInsertSourceRepoLinkSymbolMetadataMs: pass2.get(
      "repairInsert.sourceRepoLink.symbolMetadata",
    ),
    pass2WriteRepairInsertSourceRepoLinkRepoLinkMs: pass2.get(
      "repairInsert.sourceRepoLink.repoLink",
    ),
    pass2WriteRepairInsertEndpointMetadataMs: pass2.get(
      "repairInsert.endpointMetadata",
    ),
    pass2WriteRepairInsertTargetMetadataMs: pass2.get(
      "repairInsert.targetMetadata",
    ),
    pass2WriteRepairInsertTargetRepoLinkMs: pass2.get(
      "repairInsert.targetRepoLink",
    ),
    pass2WriteRepairInsertRelationshipCreateMs: pass2.get(
      "repairInsert.relationshipCreate",
    ),
    pass2WriteRepairInsertRelationshipUpdateMs: pass2.get(
      "repairInsert.relationshipUpdate",
    ),
    finalizeMetricsCentralityFoldMs: finalize.get("metrics.centralityFold"),
    finalizeMetricsWriteRowsCsvMaterializeMs: finalize.get(
      "metrics.writeRows.csvMaterialize",
    ),
    finalizeMetricsWriteRowsDeleteExistingMs: finalize.get(
      "metrics.writeRows.deleteExisting",
    ),
    finalizeMetricsWriteRowsCopyFromMs: finalize.get(
      "metrics.writeRows.copyFrom",
    ),
    finalizeMetricsWriteRowsPrepareRowsMs: finalize.get(
      "metrics.writeRows.prepare",
    ),
    finalizeMetricsWriteRowsProbeExistingMs: finalize.get(
      "metrics.writeRows.probe",
    ),
    finalizeMetricsWriteRowsCopyMissingCsvMaterializeMs: finalize.get(
      "metrics.writeRows.copyMissing.csv",
    ),
    finalizeMetricsWriteRowsCopyMissingCopyFromMs: finalize.get(
      "metrics.writeRows.copyMissing.copy",
    ),
    finalizeMetricsWriteRowsCreateMissingMs: finalize.get(
      "metrics.writeRows.createMissing",
    ),
    finalizeMetricsWriteRowsMergeExistingMs: finalize.get(
      "metrics.writeRows.mergeExisting",
    ),
  };
}

function parseTimingLine(line: string | undefined): Map<string, number> {
  const timings = new Map<string, number>();
  if (!line) return timings;
  for (const part of line.split(",")) {
    const match = part.trim().match(/^([A-Za-z.]+)=(\d+)ms$/);
    if (!match) continue;
    timings.set(match[1], Number.parseInt(match[2], 10));
  }
  return timings;
}

function parsePass1DrainEdgeStats(
  stdout: string,
): Pass1DrainEdgeStatsMetric | undefined {
  const line = stdout.match(/pass1Drain\.edges: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const stats: Pass1DrainEdgeStatsMetric = {};
  for (const part of line.split(",")) {
    const match = part.trim().match(/^([A-Za-z]+)=(\d+)$/);
    if (!match) continue;
    const value = Number.parseInt(match[2], 10);
    switch (match[1]) {
      case "schema":
        stats.edgeStatsSchemaVersion = value;
        break;
      case "splitCalls":
        stats.splitCalls = value;
        break;
      case "totalEdges":
        stats.totalEdges = value;
        break;
      case "knownEndpointEdges":
        stats.knownEndpointEdges = value;
        break;
      case "initialRepairEdges":
        stats.initialRepairEdges = value;
        break;
      case "belowThresholdKnownEdges":
        stats.belowThresholdKnownEdges = value;
        break;
      case "knownCopyFlushes":
        stats.knownCopyFlushes = value;
        break;
      case "knownCopyEdges":
        stats.knownCopyEdges = value;
        break;
      case "repairCalls":
        stats.repairCalls = value;
        break;
      case "repairEdges":
        stats.repairEdges = value;
        break;
      case "repairCauseBelowThresholdKnown":
        stats.repairCauseBelowThresholdKnown = value;
        break;
      case "repairCauseUnresolvedSource":
        stats.repairCauseUnresolvedSource = value;
        break;
      case "repairCauseBothUnsafe":
        stats.repairCauseBothUnsafe = value;
        break;
      case "repairCauseSourceUnsafeOnly":
        stats.repairCauseSourceUnsafeOnly = value;
        break;
      case "repairCauseTargetUnsafeOnly":
        stats.repairCauseTargetUnsafeOnly = value;
        break;
      case "repairCauseTargetRealNotKnown":
        stats.repairCauseTargetRealNotKnown = value;
        break;
      case "repairCauseTargetNonReal":
        stats.repairCauseTargetNonReal = value;
        break;
      case "repairCauseOther":
        stats.repairCauseOther = value;
        break;
      case "repairCauseSum":
        stats.repairCauseSum = value;
        break;
      case "repairCauseDrift":
        stats.repairCauseDrift = value;
        break;
      case "repairSourceKnown":
        stats.repairSourceKnown = value;
        break;
      case "repairSourceUnknownOrUnsafe":
        stats.repairSourceUnknownOrUnsafe = value;
        break;
      case "repairSourceKnownTargetOnly":
        stats.repairSourceKnownTargetOnly = value;
        break;
      case "repairSourceKnownTargetRealNotKnown":
        stats.repairSourceKnownTargetRealNotKnown = value;
        break;
      case "repairSourceKnownTargetUnsafe":
        stats.repairSourceKnownTargetUnsafe = value;
        break;
      case "repairSourceKnownTargetNonReal":
        stats.repairSourceKnownTargetNonReal = value;
        break;
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function parsePass1DrainEdgePhaseStats(
  stdout: string,
): Record<string, PhaseStatsMetric> | undefined {
  const line = stdout.match(/pass1Drain\.edgePhaseStats: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const stats: Record<string, PhaseStatsMetric> = {};
  for (const part of line.split(",")) {
    const match = part
      .trim()
      .match(/^([A-Za-z.]+)\.(count|rows|maxMs)=(\d+)$/);
    if (!match) continue;
    const phase = match[1];
    const metric = match[2] as keyof PhaseStatsMetric;
    const value = Number.parseInt(match[3], 10);
    stats[phase] = { ...stats[phase], [metric]: value };
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function parsePass2WriteStats(stdout: string): Pass2WriteStatsMetric | undefined {
  const line = stdout.match(/pass2\.write: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const stats: Pass2WriteStatsMetric = {};
  for (const part of line.split(",")) {
    const match = part.trim().match(/^([A-Za-z]+)=(\d+)$/);
    if (!match) continue;
    const value = Number.parseInt(match[2], 10);
    switch (match[1]) {
      case "flushes":
        stats.flushes = value;
        break;
      case "edges":
        stats.edges = value;
        break;
      case "copyFlushes":
        stats.copyFlushes = value;
        break;
      case "copyEdges":
        stats.copyEdges = value;
        break;
      case "copyPlaceholders":
        stats.copyPlaceholders = value;
        break;
      case "copyPlaceholderRows":
        stats.copyPlaceholderRows = value;
        break;
      case "copyEnsuredRows":
        stats.copyEnsuredRows = value;
        break;
      case "copySkippedRows":
        stats.copySkippedRows = value;
        break;
      case "copyUnresolvedRows":
        stats.copyUnresolvedRows = value;
        break;
      case "copyExternalRows":
        stats.copyExternalRows = value;
        break;
      case "repairFlushes":
        stats.repairFlushes = value;
        break;
      case "repairEdges":
        stats.repairEdges = value;
        break;
      case "repairPrimaryEdges":
        stats.repairPrimaryEdges = value;
        break;
      case "repairUnresolvedSource":
        stats.repairUnresolvedSource = value;
        break;
      case "repairUnsafeSource":
        stats.repairUnsafeSource = value;
        break;
      case "repairUnsafeTarget":
        stats.repairUnsafeTarget = value;
        break;
      case "repairUnsafeBoth":
        stats.repairUnsafeBoth = value;
        break;
      case "repairOther":
        stats.repairOther = value;
        break;
      case "repairCauseSum":
        stats.repairCauseSum = value;
        break;
      case "repairCauseDrift":
        stats.repairCauseDrift = value;
        break;
      case "effectiveRepairRows":
        stats.effectiveRepairRows = value;
        break;
      case "smallCopyFlushes":
        stats.smallCopyFlushes = value;
        break;
      case "smallCopyEdges":
        stats.smallCopyEdges = value;
        break;
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function parsePass2ResolverMetrics(
  stdout: string,
): Pass2ResolverBenchmarkMetric[] | undefined {
  const line = stdout.match(/pass2\.resolvers: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const phaseTimingsByResolver = parsePass2ResolverPhaseMetrics(stdout);
  const metricCountsByResolver = parsePass2ResolverCountMetrics(stdout);
  const topFilesByResolver = parsePass2ResolverTopFileMetrics(stdout);
  const metrics = line
    .split(";")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const match = entry.match(
        /^(\S+) targets=(\d+) files=(\d+) edges=(\d+) cumulative=(\d+)ms unresolved=(\d+) ambiguous=(\d+) broken=(\d+)$/,
      );
      if (!match) return [];
      return [
        {
          resolverId: match[1],
          targets: Number.parseInt(match[2], 10),
          files: Number.parseInt(match[3], 10),
          edges: Number.parseInt(match[4], 10),
          cumulativeMs: Number.parseInt(match[5], 10),
          unresolved: Number.parseInt(match[6], 10),
          ambiguous: Number.parseInt(match[7], 10),
          broken: Number.parseInt(match[8], 10),
          phaseTimings: phaseTimingsByResolver.get(match[1]),
          metrics: metricCountsByResolver.get(match[1]),
          topFiles: topFilesByResolver.get(match[1]),
        },
      ];
    });
  return metrics.length > 0 ? metrics : undefined;
}

function parsePass2ResolverTopFileMetrics(
  stdout: string,
): Map<string, Record<string, Pass2ResolverTopFileMetric[]>> {
  const line = stdout.match(/pass2\.resolverTopFiles: ([^\r\n]+)/)?.[1];
  const topFilesByResolver = new Map<
    string,
    Record<string, Pass2ResolverTopFileMetric[]>
  >();
  if (!line) return topFilesByResolver;
  for (const entry of line.split(";")) {
    const trimmed = entry.trim();
    const [resolverId, ...phaseParts] = trimmed.split(/\s+/);
    if (!resolverId || phaseParts.length === 0) continue;
    const phases: Record<string, Pass2ResolverTopFileMetric[]> = {};
    for (const phasePart of phaseParts.join("").split(",")) {
      const match = phasePart.match(/^([A-Za-z0-9_.]+)=\[(.*)\]$/);
      if (!match) continue;
      const files = match[2]
        .split("|")
        .filter(Boolean)
        .flatMap((filePart) => {
          const fileMatch = filePart.match(/^(.+):(\d+)ms(?::(\d+)b)?$/);
          if (!fileMatch) return [];
          return [
            {
              filePath: decodeURIComponent(fileMatch[1]),
              elapsedMs: Number.parseInt(fileMatch[2], 10),
              bytes: fileMatch[3]
                ? Number.parseInt(fileMatch[3], 10)
                : undefined,
            },
          ];
        });
      if (files.length > 0) {
        phases[match[1]] = files;
      }
    }
    if (Object.keys(phases).length > 0) {
      topFilesByResolver.set(resolverId, phases);
    }
  }
  return topFilesByResolver;
}

function parsePass2ResolverCountMetrics(
  stdout: string,
): Map<string, Record<string, number>> {
  const line = stdout.match(/pass2\.resolverMetrics: ([^\r\n]+)/)?.[1];
  const metricCountsByResolver = new Map<string, Record<string, number>>();
  if (!line) return metricCountsByResolver;
  for (const entry of line.split(";")) {
    const trimmed = entry.trim();
    const [resolverId, ...metricParts] = trimmed.split(/\s+/);
    if (!resolverId || metricParts.length === 0) continue;
    const metrics: Record<string, number> = {};
    for (const metricPart of metricParts.join("").split(",")) {
      const match = metricPart.match(/^([A-Za-z0-9_.]+)=(\d+)$/);
      if (!match) continue;
      metrics[match[1]] = Number.parseInt(match[2], 10);
    }
    if (Object.keys(metrics).length > 0) {
      metricCountsByResolver.set(resolverId, metrics);
    }
  }
  return metricCountsByResolver;
}

function parsePass2ResolverPhaseMetrics(
  stdout: string,
): Map<string, Record<string, number>> {
  const line = stdout.match(/pass2\.resolverPhases: ([^\r\n]+)/)?.[1];
  const phaseTimingsByResolver = new Map<string, Record<string, number>>();
  if (!line) return phaseTimingsByResolver;
  for (const entry of line.split(";")) {
    const trimmed = entry.trim();
    const [resolverId, ...phaseParts] = trimmed.split(/\s+/);
    if (!resolverId || phaseParts.length === 0) continue;
    const phaseTimings: Record<string, number> = {};
    for (const phasePart of phaseParts.join("").split(",")) {
      const match = phasePart.match(/^([A-Za-z0-9_.]+)=(\d+)ms$/);
      if (!match) continue;
      phaseTimings[match[1]] = Number.parseInt(match[2], 10);
    }
    if (Object.keys(phaseTimings).length > 0) {
      phaseTimingsByResolver.set(resolverId, phaseTimings);
    }
  }
  return phaseTimingsByResolver;
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function median(values: Array<number | undefined>): number | undefined {
  const clean = values
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  return clean[Math.floor(clean.length / 2)];
}

function runIndexCommand(params: {
  args: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  envOverrides?: Record<string, string>;
}): Promise<ChildRunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutStream = createWriteStream(params.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(params.stderrPath, { flags: "w" });
    const childEnv = { ...process.env };
    // Benchmark repeat configs own graph DB isolation. Shell-level SDL graph
    // overrides would route runs into the user's live DB and invalidate the
    // artifacted timing/correctness evidence.
    delete childEnv.SDL_GRAPH_DB_PATH;
    delete childEnv.SDL_GRAPH_DB_DIR;
    delete childEnv.SDL_DB_PATH;
    Object.assign(childEnv, params.envOverrides);

    const child = spawn(process.execPath, params.args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrStream.write(chunk);
    });
    child.on("error", (error) => {
      stdoutStream.end();
      stderrStream.end();
      rejectRun(error);
    });
    child.on("close", (exitCode) => {
      stdoutStream.end();
      stderrStream.end();
      resolveRun({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(resolve("dist/cli/index.js"))) {
    throw new Error("dist/cli/index.js missing; run npm run build:runtime first");
  }

  const [{ loadConfig }, { scanRepository }] = await Promise.all([
    import("../dist/config/loadConfig.js"),
    import("../dist/indexer/fileScanner.js"),
  ]);
  const configPath = resolve(args.config);
  const loadedConfig = loadConfig(configPath);
  const repo =
    loadedConfig.repos.find((candidate: { repoId: string }) =>
      args.repoId ? candidate.repoId === args.repoId : true,
    ) ?? null;
  if (!repo) {
    throw new Error(`Repo not found: ${args.repoId ?? "<first repo>"}`);
  }

  const allFiles = (await scanRepository(repo.rootPath, {
    ...repo,
    sourceFileListPath: undefined,
  })) as FileMetadata[];
  const priorityPaths = readPriorityPaths(args.priorityFileList);
  const selection = selectRepresentativeFiles(
    allFiles,
    args.sampleSize,
    args.seed,
    priorityPaths,
    await readProviderDocumentPaths(repo.rootPath, loadedConfig.scip),
  );
  const selected = selection.files;
  const sourceFileListPath = join(outDir, "source-files.txt");
  writeFileSync(
    sourceFileListPath,
    `${selected.map((file) => file.path).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "source-files.json"),
    JSON.stringify(selected, null, 2),
    "utf8",
  );
  writeFileSync(
    join(outDir, "selection.json"),
    JSON.stringify(
      {
        repoId: repo.repoId,
        repoRoot: repo.rootPath,
        seed: args.seed,
        requestedSampleSize: args.sampleSize,
        checkpointThresholdBytes: args.checkpointThresholdBytes ?? null,
        totalCandidateFiles: allFiles.length,
        selectedFiles: selected.length,
        priorityFileList: args.priorityFileList
          ? resolve(args.priorityFileList)
          : null,
        priorityCandidateFiles: selection.priorityCandidateFiles,
        prioritySelectedFiles: selection.prioritySelectedFiles,
        priorityTarget: selection.priorityTarget,
        providerCandidateFiles: selection.providerCandidateFiles,
        providerSelectedFiles: selection.providerSelectedFiles,
        providerTarget: selection.providerTarget,
        groups: summarizeSelection(selected),
      },
      null,
      2,
    ),
    "utf8",
  );

  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const runMetrics: BenchmarkRunMetrics[] = [];

  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    const runConfig = structuredClone(rawConfig);
    const repoConfig = runConfig.repos.find(
      (candidate: { repoId: string }) => candidate.repoId === repo.repoId,
    );
    repoConfig.sourceFileListPath = sourceFileListPath;
    runConfig.graphDatabase = {
      ...(runConfig.graphDatabase ?? {}),
      path: normalizePath(join(outDir, `repeat-${repeat}.lbug`)),
    };
    runConfig.indexing = {
      ...(runConfig.indexing ?? {}),
      pipeline: "providerFirst",
      providerFirst: {
        ...(runConfig.indexing?.providerFirst ?? {}),
        maxLegacyFallbackFiles:
          args.maxLegacyFallbackFiles ?? Math.max(args.sampleSize, selected.length),
      },
    };
    if (args.pass2Concurrency !== undefined) {
      runConfig.indexing.pass2Concurrency = args.pass2Concurrency;
    }
    const runConfigPath = join(outDir, `repeat-${repeat}.config.json`);
    writeFileSync(runConfigPath, JSON.stringify(runConfig, null, 2), "utf8");

    const stdoutPath = join(outDir, `repeat-${repeat}.stdout.log`);
    const stderrPath = join(outDir, `repeat-${repeat}.stderr.log`);
    const graphDbPath = runConfig.graphDatabase.path;
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    const started = Date.now();
    const result = await runIndexCommand({
      args: [
        "dist/cli/index.js",
        "--config",
        runConfigPath,
        "index",
        "--repo-id",
        repo.repoId,
        "--force",
        "--diagnostics",
      ],
      stdoutPath,
      stderrPath,
      envOverrides: {
        ...(args.checkpointThresholdBytes === undefined
          ? {}
          : {
              SDL_MCP_LADYBUG_CHECKPOINT_THRESHOLD_BYTES: String(
                args.checkpointThresholdBytes,
              ),
            }),
        ...(args.pass2CopyBufferMaxEdges === undefined
          ? {}
          : {
              SDL_MCP_PASS2_COPY_BUFFER_MAX_EDGES: String(
                args.pass2CopyBufferMaxEdges,
              ),
            }),
      },
    });
    const stdout = result.stdout;
    const stderr = result.stderr;

    const metrics = parseMetrics(repeat, stdout, stderr, {
      exitCode: result.exitCode,
      stdoutPath,
      stderrPath,
      configPath: runConfigPath,
      graphDbPath,
    });
    metrics.wallTimeMs ??= Date.now() - started;
    runMetrics.push(metrics);
    writeFileSync(
      join(outDir, `repeat-${repeat}.metrics.json`),
      JSON.stringify(metrics, null, 2),
      "utf8",
    );
    console.log(
      `repeat ${repeat}: exit=${metrics.exitCode} wall=${metrics.wallTimeMs}ms fallback=${metrics.fallbackFiles ?? "n/a"} provider=${metrics.providerPrimaryFiles ?? "n/a"}/${metrics.scannedFiles ?? "n/a"}`,
    );
  }

  const summary = {
    repoId: repo.repoId,
    outDir,
    selectedFiles: selected.length,
    repeats: args.repeats,
    failedRuns: runMetrics.filter((run) => run.exitCode !== 0).length,
    medianWallTimeMs: median(runMetrics.map((run) => run.wallTimeMs)),
    medianProviderFirstTotalMs: median(
      runMetrics.map((run) => run.providerFirstTotalMs),
    ),
    medianFallbackTotalMs: median(runMetrics.map((run) => run.fallbackTotalMs)),
    runs: runMetrics,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`summary: ${join(outDir, "summary.json")}`);
  if (summary.failedRuns > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
