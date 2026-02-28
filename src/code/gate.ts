import * as db from "../db/queries.js";
import * as score from "../graph/score.js";
import { loadConfig } from "../config/loadConfig.js";
import { extractCodeWindow, identifiersExistInWindow } from "./windows.js";
import { logger } from "../util/logger.js";
import type {
  CodeWindowRequest,
  CodeWindowResponse,
  GraphSlice,
  NextBestActionCallable,
} from "../mcp/types.js";
import type { PolicyConfig } from "../config/types.js";
import type { SymbolRow } from "../db/schema.js";

/**
 * Minimum utility score threshold for automatic code window approval.
 * Symbols scoring above this threshold are considered high-value enough
 * to approve without explicit justification.
 */
const UTILITY_SCORE_THRESHOLD = 0.3;

export interface GateContext {
  slice?: GraphSlice;
  symbol?: SymbolRow;
  policy?: PolicyConfig;
}

/**
 * Result returned by generateDenialGuidance. Includes the legacy
 * suggestedNextRequest (parameter tweaks for needWindow) plus a new
 * nextBestAction that describes an immediately-executable alternative
 * tool call the agent should use instead.
 */
export interface DenialGuidance {
  suggestedNextRequest: Partial<CodeWindowRequest>;
  nextBestAction: NextBestActionCallable;
}

export function evaluateRequest(
  request: CodeWindowRequest,
  context: GateContext,
): CodeWindowResponse {
  const config = loadConfig();
  const policy = context.policy ?? config.policy;

  const window = extractCodeWindow(request.repoId, request.symbolId);
  if (!window) {
    return {
      approved: false,
      whyDenied: ["Symbol not found or invalid range"],
      suggestedNextRequest: undefined,
    };
  }

  const symbol = context.symbol || db.getSymbol(request.symbolId);
  if (!symbol) {
    return {
      approved: false,
      whyDenied: ["Symbol not found"],
      suggestedNextRequest: undefined,
    };
  }

  // Check policy limits first, before any approval logic
  const policyViolations: string[] = [];

  if (request.expectedLines > policy.maxWindowLines) {
    policyViolations.push(
      `Request exceeds maximum window lines (${request.expectedLines} > ${policy.maxWindowLines})`,
    );
  }

  if (request.maxTokens && request.maxTokens > policy.maxWindowTokens) {
    policyViolations.push(
      `Request exceeds maximum window tokens (${request.maxTokens} > ${policy.maxWindowTokens})`,
    );
  }

  if (request.identifiersToFind.length === 0 && policy.requireIdentifiers) {
    policyViolations.push("No identifiers to find provided");
  }

  if (policyViolations.length > 0) {
    const guidance = generateDenialGuidance(
      request,
      "general",
      policy,
      symbol,
    );
    return {
      approved: false,
      whyDenied: policyViolations,
      suggestedNextRequest: guidance.suggestedNextRequest,
      nextBestAction: guidance.nextBestAction,
    };
  }

  // Policy limits pass - now check approval criteria
  const whyApproved: string[] = [];

  if (request.identifiersToFind.length > 0) {
    if (
      window.approved &&
      identifiersExistInWindow(window.code, request.identifiersToFind)
    ) {
      whyApproved.push("identifiers-exist");
      return {
        ...window,
        whyApproved,
      };
    }
  }

  if (context.slice) {
    const inCards = context.slice.cards.some(
      (c) => c.symbolId === request.symbolId,
    );
    const inFrontier = context.slice.frontier?.some(
      (f) => f.symbolId === request.symbolId,
    );
    if (inCards || inFrontier) {
      whyApproved.push("in-slice-or-frontier");
      if (window.approved) {
        return {
          ...window,
          whyApproved,
        };
      }
    }
  }

  const scoreContext = {
    query: request.reason,
  };
  const utilityScore = score.scoreSymbol(symbol, scoreContext);
  if (utilityScore > UTILITY_SCORE_THRESHOLD) {
    whyApproved.push(`scorer-utility (${utilityScore.toFixed(2)})`);
    if (window.approved) {
      return {
        ...window,
        whyApproved,
      };
    }
  }

  const whyDenied: string[] = [];
  const guidance = generateDenialGuidance(
    request,
    "general",
    policy,
    symbol,
  );

  if (
    request.identifiersToFind.length > 0 &&
    window.approved &&
    !identifiersExistInWindow(window.code, request.identifiersToFind)
  ) {
    whyDenied.push("Identifiers not found in code window");
  }

  if (whyDenied.length === 0) {
    whyDenied.push("Request does not meet approval criteria");
  }

  return {
    approved: false,
    whyDenied,
    suggestedNextRequest: guidance.suggestedNextRequest,
    nextBestAction: guidance.nextBestAction,
  };
}

/**
 * Extract identifier suggestions from a symbol's signature JSON.
 * Returns up to 3 param names, falling back to the symbol name.
 */
function extractSignatureIdentifiers(symbol: SymbolRow): string[] {
  if (symbol.signature_json) {
    try {
      const signature = JSON.parse(symbol.signature_json) as {
        params?: Array<{ name: string; type?: string }>;
        returns?: string;
      };
      if (signature.params && Array.isArray(signature.params) && signature.params.length > 0) {
        return signature.params.map((p) => p.name).slice(0, 3);
      }
    } catch (error) {
      logger.warn(
        "Failed to parse signature_json for identifier suggestions",
        {
          symbolId: symbol.symbol_id,
          error: String(error),
        },
      );
    }
  }
  return [symbol.name];
}

/**
 * Generates denial guidance including parameter suggestions for retrying
 * needWindow and a nextBestAction describing an alternative tool call.
 *
 * The nextBestAction follows these rules:
 * - expectedLines > maxWindowLines  → getSkeleton (cheaper than full window)
 * - identifiers not found in window → getHotPath with those identifiers
 * - identifiersToFind is empty      → getSkeleton with sig-derived identifiers
 * - token cap exceeded              → getSkeleton (no identifiers required)
 */
export function generateDenialGuidance(
  request: CodeWindowRequest,
  reason: string,
  policyOverride?: PolicyConfig,
  symbolHint?: SymbolRow,
): DenialGuidance {
  const config = loadConfig();
  const policy = policyOverride ?? config.policy;

  const suggestions: Partial<CodeWindowRequest> = {};

  // Determine which denial scenario we are in so we can build nextBestAction
  const tooBroad = request.expectedLines > policy.maxWindowLines;
  const tokenCapExceeded =
    !!(request.maxTokens && request.maxTokens > policy.maxWindowTokens);
  const noIdentifiers = request.identifiersToFind.length === 0;

  if (tooBroad) {
    suggestions.expectedLines = policy.maxWindowLines;
  }

  if (tokenCapExceeded) {
    suggestions.maxTokens = policy.maxWindowTokens;
  }

  // Resolve the symbol once for identifier extraction
  const symbol = symbolHint ?? db.getSymbol(request.symbolId);

  if (noIdentifiers) {
    if (symbol) {
      const ids = extractSignatureIdentifiers(symbol);
      suggestions.identifiersToFind = ids;
    }
  }

  if (reason === "too-broad" && !request.reason.includes("specific")) {
    suggestions.reason = `${request.reason} - focus on specific function/class`;
  }

  if (Object.keys(suggestions).length === 0) {
    suggestions.reason = `${request.reason} (please add context or identifiers)`;
  }

  // Build nextBestAction based on the primary denial reason
  let nextBestAction: NextBestActionCallable;

  const symbolName = symbol?.name ?? request.symbolId;

  if (tooBroad) {
    // Window too large — suggest skeleton which shows control flow cheaply
    const sigIds = symbol ? extractSignatureIdentifiers(symbol) : [];
    const skeletonArgs: Record<string, unknown> = {
      repoId: request.repoId,
      symbolId: request.symbolId,
    };
    if (sigIds.length > 0) {
      skeletonArgs.identifiersToFind = sigIds;
    }
    nextBestAction = {
      tool: "sdl.code.getSkeleton",
      args: skeletonArgs,
      rationale: `getSkeleton shows control flow of ${symbolName} without loading the full ${request.expectedLines}-line window`,
    };
  } else if (!noIdentifiers) {
    // Identifiers were provided but presumably not found in window
    nextBestAction = {
      tool: "sdl.code.getHotPath",
      args: {
        repoId: request.repoId,
        symbolId: request.symbolId,
        identifiersToFind: request.identifiersToFind,
      },
      rationale: `getHotPath finds the exact lines where ${request.identifiersToFind.slice(0, 3).join(", ")} appear in ${symbolName}`,
    };
  } else if (tokenCapExceeded) {
    // Token cap exceeded — suggest skeleton (no identifiers required)
    nextBestAction = {
      tool: "sdl.code.getSkeleton",
      args: {
        repoId: request.repoId,
        symbolId: request.symbolId,
      },
      rationale: `getSkeleton fits within token budget by eliding function bodies of ${symbolName}`,
    };
  } else {
    // No identifiers provided — suggest skeleton with sig-derived identifiers
    const sigIds = symbol ? extractSignatureIdentifiers(symbol) : [];
    const skeletonArgs: Record<string, unknown> = {
      repoId: request.repoId,
      symbolId: request.symbolId,
    };
    if (sigIds.length > 0) {
      skeletonArgs.identifiersToFind = sigIds;
    }
    nextBestAction = {
      tool: "sdl.code.getSkeleton",
      args: skeletonArgs,
      rationale: `getSkeleton shows the structure of ${symbolName}; add identifiersToFind to narrow further`,
    };
  }

  return {
    suggestedNextRequest: suggestions,
    nextBestAction,
  };
}
