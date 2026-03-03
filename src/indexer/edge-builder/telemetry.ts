import type { SymbolKind } from "../../db/schema.js";

const TS_CALL_RESOLUTION_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

export function isTsCallResolutionFile(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return TS_CALL_RESOLUTION_EXTENSIONS.has(ext);
}

const CALL_RESOLUTION_TELEMETRY_SAMPLE_LIMIT = 20;

export type CallResolutionTelemetry = {
  repoId: string;
  mode: "full" | "incremental";
  tsFileCount: number;

  pass2Targets: number;
  pass2FilesProcessed: number;
  pass2FilesNoExistingSymbols: number;
  pass2FilesNoMappedSymbols: number;

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
  tsFileCount: number;
}): CallResolutionTelemetry {
  return {
    repoId: params.repoId,
    mode: params.mode,
    tsFileCount: params.tsFileCount,
    pass2Targets: 0,
    pass2FilesProcessed: 0,
    pass2FilesNoExistingSymbols: 0,
    pass2FilesNoMappedSymbols: 0,
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

