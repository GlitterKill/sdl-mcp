import type { SymbolKind } from "../../db/schema.js";

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
  },
): void {
  const bucket = getResolverTelemetryBucket(telemetry, resolverId);
  bucket.filesProcessed++;
  bucket.edgesCreated += params.edgesCreated;
  bucket.elapsedMs += params.elapsedMs;
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
