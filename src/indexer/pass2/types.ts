import type { CallResolutionTelemetry } from "../edge-builder/telemetry.js";
import type { SymbolIndex, TsCallResolver } from "../edge-builder/types.js";

export interface Pass2Target {
  repoId?: string;
  fileId?: string;
  filePath: string;
  extension: string;
  language: string;
}

export interface Pass2ResolverResult {
  edgesCreated: number;
}

export interface Pass2ResolverContext {
  repoRoot: string;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  globalPreferredSymbolId?: Map<string, string>;
  telemetry?: CallResolutionTelemetry;
  cache?: Map<string, unknown>;
}

export interface Pass2Resolver {
  readonly id: string;
  supports(target: Pass2Target): boolean;
  resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult>;
}
