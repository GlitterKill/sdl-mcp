import type {
  CallResolutionTelemetry,
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  createCallResolutionTelemetry,
} from "./edge-builder.js";
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

export interface IndexProgress {
  stage: "scanning" | "parsing" | "pass1" | "pass2" | "finalizing" | "summaries" | "embeddings";
  current: number;
  total: number;
  currentFile?: string;
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
): Promise<{
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
}> {
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  const globalNameToSymbolIds = new Map<string, string[]>();
  const repoSymbols = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
  for (const symbol of repoSymbols) {
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    allSymbolsByName.set(symbol.name, byName);
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
  }
  const globalPreferredSymbolId = buildGlobalPreferredSymbolIds(allSymbolsByName);
  return { allSymbolsByName, globalNameToSymbolIds, globalPreferredSymbolId };
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
