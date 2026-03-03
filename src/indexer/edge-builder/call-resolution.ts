import { calibrateResolutionConfidence } from "../edge-confidence.js";
import type {
  AdapterResolvedCall,
  LanguageAdapter,
} from "../adapter/LanguageAdapter.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";

/**
 * Result of resolving a call target
 * 36-1.3: Now returns unresolved results with candidate info instead of null
 */
interface ResolvedCallTarget {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  strategy: "exact" | "heuristic" | "unresolved";
  candidateCount?: number;
  targetName?: string;
}

function finalizeCallResolution(input: {
  symbolId: string | null;
  isResolved: boolean;
  strategy?: "exact" | "heuristic" | "unresolved";
  confidence?: number;
  candidateCount?: number;
  targetName?: string;
}): ResolvedCallTarget {
  const calibrated = calibrateResolutionConfidence({
    isResolved: input.isResolved,
    strategy: input.strategy,
    candidateCount: input.candidateCount,
    baseConfidence: input.confidence,
  });
  return {
    symbolId: input.symbolId,
    isResolved: input.isResolved,
    confidence: calibrated.confidence,
    strategy: calibrated.strategy,
    candidateCount: input.candidateCount,
    targetName: input.targetName,
  };
}

function normalizeAdapterResolution(
  adapterResolved: AdapterResolvedCall,
): ResolvedCallTarget {
  return finalizeCallResolution({
    symbolId: adapterResolved.symbolId,
    isResolved: adapterResolved.isResolved,
    confidence: adapterResolved.confidence,
    strategy: adapterResolved.strategy,
    candidateCount: adapterResolved.candidateCount,
    targetName: adapterResolved.targetName,
  });
}

export function resolveCallTarget(
  call: ExtractedCall,
  nodeIdToSymbolId: Map<string, string>,
  nameToSymbolIds: Map<string, string[]>,
  importedNameToSymbolIds: Map<string, string[]>,
  namespaceImports: Map<string, Map<string, string>>,
  adapter?: LanguageAdapter | null,
  globalNameToSymbolIds?: Map<string, string[]>,
): ResolvedCallTarget | null {
  if (adapter?.resolveCall) {
    const adapterResolved = adapter.resolveCall({
      call,
      importedNameToSymbolIds,
      namespaceImports,
      nameToSymbolIds,
    });
    if (adapterResolved) {
      return normalizeAdapterResolution(adapterResolved);
    }
  }

  // Already resolved to a specific symbol
  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return finalizeCallResolution({
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      strategy: "exact",
      confidence: 0.85,
    });
  }

  const candidateId = call.calleeSymbolId ?? call.calleeIdentifier;
  if (!candidateId) {
    return null;
  }

  const cleaned = candidateId.replace(/^new\s+/, "");
  if (cleaned.includes(".")) {
    const parts = cleaned.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    const namespace = namespaceImports.get(prefix);
    if (namespace && namespace.has(member)) {
      return finalizeCallResolution({
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        strategy: "exact",
        confidence: 0.92,
      });
    }
  }

  const identifier = extractLastIdentifier(candidateId);
  if (!identifier) {
    return null;
  }

  // Check imported names first
  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return finalizeCallResolution({
      symbolId: importedCandidates[0],
      isResolved: true,
      strategy: "exact",
      confidence: 0.9,
    });
  }

  // 36-1.3: Handle ambiguous imported names - create unresolved edge
  if (importedCandidates && importedCandidates.length > 1) {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: importedCandidates.length,
      targetName: identifier,
    });
  }

  // Check local symbols
  const candidates = nameToSymbolIds.get(identifier);
  if (candidates && candidates.length === 1) {
    return finalizeCallResolution({
      symbolId: candidates[0],
      isResolved: true,
      strategy: "heuristic",
      confidence: cleaned.includes(".") ? 0.68 : 0.9,
    });
  }

  // 36-1.3: Handle ambiguous local names - create unresolved edge
  if (candidates && candidates.length > 1) {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: candidates.length,
      targetName: identifier,
    });
  }

  // Global symbol index fallback: try repo-wide symbol lookup for cross-file calls.
  // Only resolve when there is a single unique match (high confidence).
  if (globalNameToSymbolIds && identifier) {
    const globalCandidates = globalNameToSymbolIds.get(identifier);
    if (globalCandidates && globalCandidates.length === 1) {
      return finalizeCallResolution({
        symbolId: globalCandidates[0],
        isResolved: true,
        strategy: "heuristic",
        confidence: 0.9,
      });
    }
  }

  // No candidates at all - still create an unresolved edge if we have a name
  // This helps with external calls that might be resolved later
  if (identifier && call.callType !== "dynamic") {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: 0,
      targetName: identifier,
    });
  }

  return null;
}

function extractLastIdentifier(text: string): string | null {
  const cleaned = text.replace(/^new\s+/, "");
  const parts = cleaned.split(".");
  const last = parts[parts.length - 1]?.trim();
  return last || null;
}

