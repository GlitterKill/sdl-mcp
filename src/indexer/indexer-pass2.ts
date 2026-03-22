import type {
  CallResolutionTelemetry,
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  addToSymbolIndex,
  cleanupUnresolvedEdges,
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
  resolvePass2Targets,
  resolvePendingCallEdges,
} from "./edge-builder.js";
import type { ConfigEdge } from "./configEdges.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { SymbolKind } from "../db/schema.js";
import type { RepoConfig } from "../config/types.js";
import type { FileMetadata } from "./fileScanner.js";
import {
  toPass2Target,
  type Pass2ResolverRegistry,
} from "./pass2/registry.js";
import { withWriteConn } from "../db/ladybug.js";
import {
  buildGlobalPreferredSymbolIds,
  type IndexProgress,
  type LadybugConn,
} from "./indexer-init.js";

/**
 * Rebuild the in-memory `symbolIndex` and `globalNameToSymbolIds` from the DB
 * after Pass 1 so Pass 2 resolvers see all freshly indexed symbols.
 */
export async function refreshSymbolIndexFromDb(
  conn: LadybugConn,
  repoId: string,
  symbolIndex: SymbolIndex,
  globalNameToSymbolIds: Map<string, string[]>,
  globalPreferredSymbolId?: Map<string, string>,
): Promise<void> {
  const refreshed: SymbolIndex = new Map();
  const allFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const filePathById = new Map(allFiles.map((f) => [f.fileId, f.relPath]));
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of symbols) {
    const filePath = filePathById.get(symbol.fileId);
    if (filePath)
      addToSymbolIndex(refreshed, filePath, symbol.symbolId, symbol.name, symbol.kind as SymbolKind);
  }
  symbolIndex.clear();
  for (const [fp, names] of refreshed) symbolIndex.set(fp, names);

  // Refresh global name index so Pass 2 can heuristically resolve cross-file calls.
  globalNameToSymbolIds.clear();
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  for (const symbol of symbols) {
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push({
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
    });
    allSymbolsByName.set(symbol.name, byName);
  }
  for (const ids of globalNameToSymbolIds.values()) {
    ids.sort();
    for (let i = ids.length - 1; i > 0; i--) {
      if (ids[i] === ids[i - 1]) ids.splice(i, 1);
    }
  }

  // Refresh preferred symbol disambiguation map
  if (globalPreferredSymbolId) {
    globalPreferredSymbolId.clear();
    const refreshedPreferred = buildGlobalPreferredSymbolIds(allSymbolsByName);
    for (const [name, id] of refreshedPreferred) {
      globalPreferredSymbolId.set(name, id);
    }
  }
}

/** Pass 2 — cross-file call resolution. Returns total new edges created. */
export async function runPass2Resolvers(params: {
  repoId: string;
  repoRoot: string;
  mode: "full" | "incremental";
  pass2EligibleFiles: FileMetadata[];
  changedPass2FilePaths: Set<string>;
  supportsPass2FilePath: (relPath: string) => boolean;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  createdCallEdges: Set<string>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  callResolutionTelemetry: CallResolutionTelemetry;
  onProgress: ((progress: IndexProgress) => void) | undefined;
}): Promise<number> {
  const {
    repoId, repoRoot, mode, pass2EligibleFiles, changedPass2FilePaths,
    supportsPass2FilePath, pass2ResolverRegistry, symbolIndex, tsResolver,
    config, createdCallEdges, globalNameToSymbolIds, globalPreferredSymbolId,
    callResolutionTelemetry, onProgress,
  } = params;

  const pass2Targets = await resolvePass2Targets({
    repoId,
    mode,
    pass2Files: pass2EligibleFiles,
    changedPass2FilePaths,
    supportsPass2FilePath,
  });
  callResolutionTelemetry.pass2Targets = pass2Targets.length;

  let totalEdgesCreated = 0;
  const pass2ResolverCache = new Map<string, unknown>();
  let pass2Processed = 0;

  for (const fileMeta of pass2Targets) {
    callResolutionTelemetry.pass2FilesProcessed++;
    onProgress?.({
      stage: "pass2",
      current: pass2Processed,
      total: pass2Targets.length,
      currentFile: fileMeta.path,
    });
    const resolver = pass2ResolverRegistry.getResolver(
      toPass2Target({ ...fileMeta, repoId }),
    );
    if (!resolver) {
      pass2Processed++;
      continue;
    }
    recordPass2ResolverTarget(callResolutionTelemetry, resolver.id);
    const resolverStartedAt = Date.now();
    const pass2Result = await resolver.resolve(
      toPass2Target({ ...fileMeta, repoId }),
      {
        repoRoot,
        symbolIndex,
        tsResolver,
        languages: config.languages,
        createdCallEdges,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
        telemetry: callResolutionTelemetry,
        cache: pass2ResolverCache,
      },
    );
    recordPass2ResolverResult(callResolutionTelemetry, resolver.id, {
      edgesCreated: pass2Result.edgesCreated,
      elapsedMs: Date.now() - resolverStartedAt,
    });
    totalEdgesCreated += pass2Result.edgesCreated;
    pass2Processed++;
  }

  if (pass2Targets.length > 0) {
    onProgress?.({
      stage: "pass2",
      current: pass2Targets.length,
      total: pass2Targets.length,
    });
  }
  return totalEdgesCreated;
}

/** Resolve pending call edges, clean up dangling edges, and persist config edges. */
export async function finalizeEdges(params: {
  repoId: string;
  pendingCallEdges: PendingCallEdge[];
  symbolIndex: SymbolIndex;
  createdCallEdges: Set<string>;
  allConfigEdges: ConfigEdge[];
  configEdgeWeight: number;
}): Promise<{ configEdgesCreated: number }> {
  const { repoId, pendingCallEdges, symbolIndex, createdCallEdges, allConfigEdges, configEdgeWeight } = params;

  await resolvePendingCallEdges(pendingCallEdges, symbolIndex, createdCallEdges, repoId);
  await cleanupUnresolvedEdges(repoId);

  const now = new Date().toISOString();
  const configEdgesToInsert: ladybugDb.EdgeRow[] = allConfigEdges.map(
    (edge) => ({
      repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "config",
      weight: edge.weight ?? configEdgeWeight,
      confidence: 1.0,
      resolution: "exact",
      provenance: edge.provenance ?? "config",
      createdAt: now,
    }),
  );
  await withWriteConn(async (wConn) => {
    await ladybugDb.insertEdges(wConn, configEdgesToInsert);
  });
  return { configEdgesCreated: configEdgesToInsert.length };
}
