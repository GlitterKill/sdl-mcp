import type {
  CallResolutionTelemetry,
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import { createCallResolutionTelemetry } from "./edge-builder.js";
import {
  createDefaultPass2ResolverRegistry,
  toPass2Target,
  type Pass2ResolverRegistry,
} from "./pass2/registry.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { normalizePath } from "../util/paths.js";
import type { ConfigEdge } from "./configEdges.js";
import type { RepoConfig } from "../config/types.js";
import type { FileMetadata } from "./fileScanner.js";
import type { ParserWorkerPool } from "./workerPool.js";
import type { SymbolMapFileUpdate } from "./symbol-map-cache.js";
import {
  getOrLoadSymbolMapCache,
  removeFilesFromSymbolMapCache,
  type SymbolMapCache,
} from "./symbol-map-cache.js";

export type IndexProgressSubstage =
  | "pass1Drain"
  | "importReresolution"
  | "edgeFinalize"
  | "versionSnapshot"
  | "metrics"
  | "fileSummaries"
  | "audit"
  | "qualityAudit"
  | "semanticSummaries"
  | "semanticEmbeddings"
  | "fileSummaryEmbeddings"
  | "clusterRefresh"
  | "processRefresh"
  | "algorithmRefresh";

export interface IndexProgress {
  stage:
    | "scanning"
    | "parsing"
    | "pass1"
    | "scipIngest"
    | "pass2"
    | "finalizing"
    | "summaries"
    | "embeddings";
  current: number;
  total: number;
  currentFile?: string;
  substage?: IndexProgressSubstage;
  stageCurrent?: number;
  stageTotal?: number;
  message?: string;
  /**
   * Embedding model identifier when `stage === "embeddings"`. Two models run
   * concurrently via Promise.all in metrics-updater.ts and emit interleaved
   * events; the CLI keys per-model state on this field so each model gets its
   * own progress line instead of fighting for the same one. Undefined for
   * non-embedding stages.
   */
  model?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type LadybugConn = Awaited<ReturnType<typeof getLadybugConn>>;

export interface Pass1Accumulator {
  filesProcessed: number;
  changedFiles: number;
  totalSymbolsIndexed: number;
  totalEdgesCreated: number;
  allConfigEdges: ConfigEdge[];
  changedFileIds: Set<string>;
  changedPass2FilePaths: Set<string>;
  symbolMapFileUpdates: Map<string, SymbolMapFileUpdate>;
  /**
   * Phase 1 Task 1.1 / 1.12 — Engine telemetry counters.
   *
   * Track which Pass-1 engine processed each file. When the active engine
   * is "rust" but a file’s language is not supported by the Rust
   * extractor (currently Kotlin, and any future gap), it is transparently
   * routed to the TypeScript engine on a per-file basis. These counters
   * make the split observable so fallback rates can be audited and future
   * Rust-side work prioritised by impact.
   */
  rustFilesProcessed: number;
  tsFilesProcessed: number;
  rustFallbackFiles: number;
  rustFallbackByLanguage: Map<string, number>;
  /**
   * Promise resolved when the BatchPersistAccumulator has finished draining
   * all queued FlushBatches to disk. The drain is kicked off as the last
   * step of pass-1 but NOT awaited there — callers in `indexer.ts` can run
   * the in-memory pass-2 bridge (applySymbolMapFileUpdates,
   * syncSymbolIndexFromCache) and, in `mode === "full"`, even kick off
   * `runPass2Resolvers` while the writes settle in the background. Pass-2
   * writes serialize through the same writeLimiter so they interleave
   * safely with the still-draining pass-1 batches.
   *
   * In `mode === "incremental"` the caller MUST await this promise before
   * `resolvePass2Targets` — that helper does DB reads off the changed-file
   * symbols and would miss un-flushed writes otherwise.
   */
  drainPromise: Promise<void>;
  /**
   * Pass-1 extraction outputs captured for files that the pass-2 TS
   * resolver will re-process. Lets pass-2 skip a redundant tree-sitter
   * parse + three `extract*` calls per file. Populated only for
   * `isTsCallResolutionFile(path)` matches — other-language pass-2
   * resolvers consume the live tree handle for scope walkers and stay on
   * the inline re-parse path. Dropped after pass-2 completes.
   *
   * Imported as a value type to avoid a circular import; `Pass1Accumulator`
   * is referenced by both pass-1 and pass-2 modules.
   */
  pass1Extractions: import("./pass2/types.js").Pass1ExtractionCache;
}

export interface Pass1Params {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  mode: "full" | "incremental";
  files: FileMetadata[];
  existingByPath: Map<string, ladybugDb.FileRow>;
  symbolIndex: SymbolIndex;
  pendingCallEdges: PendingCallEdge[];
  createdCallEdges: Set<string>;
  tsResolver: TsCallResolver | null;
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  supportsPass2FilePath: (relPath: string) => boolean;
  concurrency: number;
  workerPool?: ParserWorkerPool | null;
  onProgress: ((progress: IndexProgress) => void) | undefined;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeFileId(repoId: string, relPath: string): string {
  return `${repoId}:${normalizePath(relPath)}`;
}

export function fileIdForPath(
  repoId: string,
  relPath: string,
  existingByPath: Map<string, ladybugDb.FileRow>,
): string {
  return existingByPath.get(relPath)?.fileId ?? computeFileId(repoId, relPath);
}

// ---------------------------------------------------------------------------
// Pipeline phase helpers
// ---------------------------------------------------------------------------

/** Load existing symbols from DB and build name-to-symbol lookup maps. */
export async function loadExistingSymbolMaps(
  conn: LadybugConn,
  repoId: string,
  removedFileIds: Iterable<string> = [],
): Promise<{
  symbolMapCache: SymbolMapCache;
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
}> {
  const symbolMapCache = await getOrLoadSymbolMapCache(conn, repoId);
  removeFilesFromSymbolMapCache(symbolMapCache, removedFileIds);
  return {
    symbolMapCache,
    allSymbolsByName: symbolMapCache.allSymbolsByName,
    globalNameToSymbolIds: symbolMapCache.globalNameToSymbolIds,
    globalPreferredSymbolId: symbolMapCache.globalPreferredSymbolId,
  };
}

/**
 * For names with multiple symbols, pre-compute a single preferred symbol ID.
 * Prefers exported symbols; if exactly one exported candidate exists among
 * multiple total candidates, it wins.  This resolves the common pattern where
 * a function is defined once in source (exported) but re-declared in test
 * files (non-exported `let`/`const`).
 */
export function buildGlobalPreferredSymbolIds(
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>,
): Map<string, string> {
  const preferred = new Map<string, string>();
  for (const [name, symbols] of allSymbolsByName) {
    if (symbols.length <= 1) continue;
    const exported = symbols.filter((s) => s.exported);
    if (exported.length === 1) {
      preferred.set(name, exported[0].symbolId);
    }
  }
  return preferred;
}

/** Create the Pass 2 resolver registry, eligible file list, and telemetry object. */
export function initPass2Context(
  repoId: string,
  mode: "full" | "incremental",
  files: FileMetadata[],
): {
  pass2ResolverRegistry: Pass2ResolverRegistry;
  pass2EligibleFiles: FileMetadata[];
  callResolutionTelemetry: CallResolutionTelemetry;
  supportsPass2FilePath: (relPath: string) => boolean;
} {
  const pass2ResolverRegistry = createDefaultPass2ResolverRegistry();
  const registeredPass2Resolvers = pass2ResolverRegistry
    .listResolvers()
    .map((r) => r.id);
  const pass2EligibleFiles = files.filter((f) =>
    pass2ResolverRegistry.supports(toPass2Target(f)),
  );
  const supportsPass2FilePath = (relPath: string): boolean =>
    pass2ResolverRegistry.supports(toPass2Target({ path: relPath }));
  const callResolutionTelemetry = createCallResolutionTelemetry({
    repoId,
    mode,
    pass2EligibleFileCount: pass2EligibleFiles.length,
    registeredResolvers: registeredPass2Resolvers,
  });
  return {
    pass2ResolverRegistry,
    pass2EligibleFiles,
    callResolutionTelemetry,
    supportsPass2FilePath,
  };
}
