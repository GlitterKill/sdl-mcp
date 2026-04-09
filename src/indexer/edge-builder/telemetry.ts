import type { SymbolKind } from "../../domain/types.js";

const TS_CALL_RESOLUTION_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

export function isTsCallResolutionFile(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return TS_CALL_RESOLUTION_EXTENSIONS.has(ext);
}

const CALL_RESOLUTION_TELEMETRY_SAMPLE_LIMIT = 20;

export type Pass2ResolverTelemetry = {
  targets: number;
  filesProcessed: number;
  edgesCreated: number;
  elapsedMs: number;
  /**
   * Phase 2 Task 2.0.3 — per-resolver bucket counts. Each call edge that
   * a resolver creates increments exactly one of these buckets so the
   * audit-event payload can show how a resolver actually resolved its
   * work. `unresolved` counts call sites the resolver looked at but
   * could not bind; `brokenChain` counts edges where the import chain
   * pointed at a file that no longer exists in the index.
   */
  resolvedByCompiler: number;
  resolvedByImport: number;
  resolvedByLexical: number;
  resolvedByGlobal: number;
  resolvedByHeuristic: number;
  unresolved: number;
  ambiguous: number;
  brokenChain: number;
};

export type CallResolutionTelemetry = {
  repoId: string;
  mode: "full" | "incremental";
  pass2EligibleFileCount: number;
  registeredResolvers: string[];

  /**
   * Legacy field retained for compatibility with existing audit-event readers.
   * It now represents the total number of pass2-eligible files across all
   * registered resolvers, not just TypeScript/JavaScript files.
   */
  tsFileCount: number;

  pass2Targets: number;
  pass2FilesProcessed: number;
  pass2FilesNoExistingSymbols: number;
  pass2FilesNoMappedSymbols: number;
  resolverBreakdown: Record<string, Pass2ResolverTelemetry>;

  pass2SymbolMapping: {
    extractedSymbols: number;
    existingSymbols: number;
    mappedSymbols: number;
    unmappedSymbols: number;
    strategyCounts: Record<string, number>;
  };

  adapterCalls: {
    total: number;
    resolved: number;
    unresolved: number;
    resolvedByStrategy: Record<string, number>;
    skippedBuiltin: number;
    returnedNull: number;
    duplicates: number;
  };

  tsResolverCalls: {
    total: number;
    edgesCreated: number;
    skippedNoCaller: number;
    skippedNoFromSymbol: number;
    skippedNoToSymbol: number;
    skippedDuplicate: number;
  };

  samples: {
    noMappedSymbols: string[];
    mappingFailures: Array<{
      file: string;
      kind: SymbolKind;
      name: string;
      startLine: number;
      startCol: number;
    }>;
    tsNoToSymbol: Array<{
      file: string;
      calleeFile: string;
      calleeName: string;
      calleeKind: SymbolKind;
    }>;
  };
};

export function createCallResolutionTelemetry(params: {
  repoId: string;
  mode: "full" | "incremental";
  pass2EligibleFileCount: number;
  registeredResolvers?: string[];
}): CallResolutionTelemetry {
  const resolverBreakdown = Object.fromEntries(
    (params.registeredResolvers ?? []).map((resolverId) => [
      resolverId,
      {
        targets: 0,
        filesProcessed: 0,
        edgesCreated: 0,
        elapsedMs: 0,
        resolvedByCompiler: 0,
        resolvedByImport: 0,
        resolvedByLexical: 0,
        resolvedByGlobal: 0,
        resolvedByHeuristic: 0,
        unresolved: 0,
        ambiguous: 0,
        brokenChain: 0,
      } satisfies Pass2ResolverTelemetry,
    ]),
  );

  return {
    repoId: params.repoId,
    mode: params.mode,
    pass2EligibleFileCount: params.pass2EligibleFileCount,
    registeredResolvers: [...(params.registeredResolvers ?? [])],
    tsFileCount: params.pass2EligibleFileCount,
    pass2Targets: 0,
    pass2FilesProcessed: 0,
    pass2FilesNoExistingSymbols: 0,
    pass2FilesNoMappedSymbols: 0,
    resolverBreakdown,
    pass2SymbolMapping: {
      extractedSymbols: 0,
      existingSymbols: 0,
      mappedSymbols: 0,
      unmappedSymbols: 0,
      strategyCounts: {},
    },
    adapterCalls: {
      total: 0,
      resolved: 0,
      unresolved: 0,
      resolvedByStrategy: {},
      skippedBuiltin: 0,
      returnedNull: 0,
      duplicates: 0,
    },
    tsResolverCalls: {
      total: 0,
      edgesCreated: 0,
      skippedNoCaller: 0,
      skippedNoFromSymbol: 0,
      skippedNoToSymbol: 0,
      skippedDuplicate: 0,
    },
    samples: {
      noMappedSymbols: [],
      mappingFailures: [],
      tsNoToSymbol: [],
    },
  };
}

function getResolverTelemetryBucket(
  telemetry: CallResolutionTelemetry,
  resolverId: string,
): Pass2ResolverTelemetry {
  if (!telemetry.resolverBreakdown[resolverId]) {
    telemetry.resolverBreakdown[resolverId] = {
      targets: 0,
      filesProcessed: 0,
      edgesCreated: 0,
      elapsedMs: 0,
      resolvedByCompiler: 0,
      resolvedByImport: 0,
      resolvedByLexical: 0,
      resolvedByGlobal: 0,
      resolvedByHeuristic: 0,
      unresolved: 0,
      ambiguous: 0,
      brokenChain: 0,
    };
  }
  return telemetry.resolverBreakdown[resolverId];
}

export function recordPass2ResolverTarget(
  telemetry: CallResolutionTelemetry,
  resolverId: string,
): void {
  getResolverTelemetryBucket(telemetry, resolverId).targets++;
}

export function recordPass2ResolverResult(
  telemetry: CallResolutionTelemetry,
  resolverId: string,
  params: {
    edgesCreated: number;
    elapsedMs: number;
    resolvedByCompiler?: number;
    resolvedByImport?: number;
    resolvedByLexical?: number;
    resolvedByGlobal?: number;
    unresolved?: number;
    ambiguous?: number;
    brokenChain?: number;
  },
): void {
  const bucket = getResolverTelemetryBucket(telemetry, resolverId);
  bucket.filesProcessed++;
  bucket.edgesCreated += params.edgesCreated;
  bucket.elapsedMs += params.elapsedMs;
  bucket.resolvedByCompiler += params.resolvedByCompiler ?? 0;
  bucket.resolvedByImport += params.resolvedByImport ?? 0;
  bucket.resolvedByLexical += params.resolvedByLexical ?? 0;
  bucket.resolvedByGlobal += params.resolvedByGlobal ?? 0;
  bucket.unresolved += params.unresolved ?? 0;
  bucket.ambiguous += params.ambiguous ?? 0;
  bucket.brokenChain += params.brokenChain ?? 0;
}

/**
 * Records a single resolved call edge under the appropriate per-resolver
 * telemetry bucket. Used by per-language resolvers that want to attribute
 * each edge to a strategy without rolling their own counter logic.
 */
/**
 * Maps a freeform `resolved.resolution` string emitted by per-language
 * resolvers to the canonical telemetry bucket. Centralized here so the
 * audit-event payload remains consistent across resolvers and so adding
 * a new resolution string is a single-file change. Unknown strings fall
 * back to `"heuristic"` which is the most pessimistic bucket and surfaces
 * an unmapped strategy as a low-confidence telemetry signal.
 */
export function bucketForResolution(
  resolution: string,
): "compiler" | "import" | "lexical" | "global" | "ambiguous" | "heuristic" {
  switch (resolution) {
    // Compiler / type-checker
    case "compiler-resolved":
      return "compiler";
    // Import-based bindings
    case "import-direct":
    case "import-aliased":
    case "import-barrel":
    case "import-matched":
    case "import-static":
    case "namespace-import":
    case "namespace-qualified":
    case "wildcard-import":
    case "use-import":
    case "use-import-aliased":
    case "crate-path":
    case "package-qualified":
    case "module-qualified":
    case "receiver-imported-instance":
    case "header-pair":
    case "psr4-autoload":
      return "import";
    // Lexical / same-file / scope-walked
    case "same-file":
    case "same-file-lexical":
    case "same-module":
    case "same-package":
    case "receiver-this":
    case "receiver-self":
    case "receiver-self-scope":
    case "receiver-type":
    case "impl-method":
    case "self-impl-method":
    case "trait-default":
    case "inheritance-method":
    case "extension-method":
    case "cross-file-name-unique":
      return "lexical";
    // Multi-candidate disambiguation
    case "disambiguated":
    case "cross-file-name-ambiguous":
    case "function-pointer":
      return "ambiguous";
    // Global / builtin fallback
    case "global-preferred":
    case "global-fallback":
    case "builtin-or-global":
      return "global";
    // Heuristic / decorator-chain / catch-all
    case "decorator-chain":
    case "heuristic-only":
      return "heuristic";
    default:
      return "heuristic";
  }
}

export function recordPass2ResolverEdge(
  telemetry: CallResolutionTelemetry,
  resolverId: string,
  bucket: "compiler" | "import" | "lexical" | "global" | "ambiguous" | "heuristic",
): void {
  const t = getResolverTelemetryBucket(telemetry, resolverId);
  switch (bucket) {
    case "compiler":
      t.resolvedByCompiler++;
      break;
    case "import":
      t.resolvedByImport++;
      break;
    case "lexical":
      t.resolvedByLexical++;
      break;
    case "heuristic":
      t.resolvedByHeuristic++;
      break;
    case "global":
      t.resolvedByGlobal++;
      break;
    case "ambiguous":
      t.ambiguous++;
      break;
  }
}

/**
 * Records a single unresolved call site under the appropriate per-resolver
 * bucket. Used so unresolved telemetry rolls up by resolver, not just by
 * the global pass2SymbolMapping counter.
 */
export function recordPass2ResolverUnresolved(
  telemetry: CallResolutionTelemetry,
  resolverId: string,
  reason: "unresolved" | "ambiguous" | "brokenChain" = "unresolved",
): void {
  const t = getResolverTelemetryBucket(telemetry, resolverId);
  if (reason === "ambiguous") t.ambiguous++;
  else if (reason === "brokenChain") t.brokenChain++;
  else t.unresolved++;
}
export function incRecord(
  record: Record<string, number>,
  key: string,
  by = 1,
): void {
  record[key] = (record[key] ?? 0) + by;
}

export function pushTelemetrySample<T>(arr: T[], value: T): void {
  if (arr.length >= CALL_RESOLUTION_TELEMETRY_SAMPLE_LIMIT) return;
  arr.push(value);
}
