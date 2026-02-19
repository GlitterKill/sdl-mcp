import * as db from "../db/queries.js";
import * as score from "../graph/score.js";
import { loadConfig } from "../config/loadConfig.js";
import { extractCodeWindow, identifiersExistInWindow } from "./windows.js";
import { logger } from "../util/logger.js";
import type {
  CodeWindowRequest,
  CodeWindowResponse,
  GraphSlice,
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
    const suggestedNextRequest = generateDenialGuidance(
      request,
      "general",
      policy,
    );
    return {
      approved: false,
      whyDenied: policyViolations,
      suggestedNextRequest,
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
  const suggestedNextRequest = generateDenialGuidance(
    request,
    "general",
    policy,
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
    suggestedNextRequest,
  };
}

export function generateDenialGuidance(
  request: CodeWindowRequest,
  reason: string,
  policyOverride?: PolicyConfig,
): Partial<CodeWindowRequest> {
  const config = loadConfig();
  const policy = policyOverride ?? config.policy;

  const suggestions: Partial<CodeWindowRequest> = {};

  if (request.expectedLines > policy.maxWindowLines) {
    suggestions.expectedLines = policy.maxWindowLines;
  }

  if (request.maxTokens && request.maxTokens > policy.maxWindowTokens) {
    suggestions.maxTokens = policy.maxWindowTokens;
  }

  if (request.identifiersToFind.length === 0) {
    const symbol = db.getSymbol(request.symbolId);
    if (symbol && symbol.signature_json) {
      try {
        const signature = JSON.parse(symbol.signature_json) as {
          params?: Array<{ name: string; type?: string }>;
          returns?: string;
        };
        if (signature.params && Array.isArray(signature.params)) {
          suggestions.identifiersToFind = signature.params
            .map((p) => p.name)
            .slice(0, 3);
        }
      } catch (error) {
        logger.warn(
          "Failed to parse signature_json for identifier suggestions",
          {
            symbolId: request.symbolId,
            error: String(error),
          },
        );
        suggestions.identifiersToFind = [symbol.name];
      }
    } else if (symbol) {
      suggestions.identifiersToFind = [symbol.name];
    }
  }

  if (reason === "too-broad" && !request.reason.includes("specific")) {
    suggestions.reason = `${request.reason} - focus on specific function/class`;
  }

  if (Object.keys(suggestions).length === 0) {
    suggestions.reason = `${request.reason} (please add context or identifiers)`;
  }

  return suggestions;
}
