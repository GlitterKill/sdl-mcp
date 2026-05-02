/**
 * Code Window Enforcement.
 *
 * Takes an approved Code Access Decision (from `decideCodeAccess`) and a
 * concrete Code Window Loader, then produces a final CodeWindowResponse by:
 *
 *   1. Loading window text + symbol via the loader port.
 *   2. Verifying that requested identifiers actually appear in the loaded text.
 *   3. Falling back to slice membership / symbol utility approval when no
 *      identifiers were requested (preserves prior gate.ts semantics).
 *   4. Emitting identifier-based denial guidance when verification fails.
 *
 * Code Window-only — the other five Code Access artifact types (skeleton,
 * hotPath, symbolCard, graphSlice, delta) skip enforcement and consume the
 * decision directly.
 */

import { findMatchedIdentifiersInWindow } from "./windows.js";
import { safeJsonParseOptional, SignatureSchema } from "../util/safeJson.js";
import * as score from "../graph/score.js";
import type { WindowLoader } from "./window-loader.js";
import type {
  CodeAccessApprove,
  CodeAccessDowngrade,
} from "../policy/code-access.js";
import type {
  CodeWindowRequest,
  CodeWindowResponse,
  GraphSlice,
  NextBestActionCallable,
} from "../domain/types.js";
import type { SymbolRow } from "../db/schema.js";

export interface EnforceContext {
  breakGlass?: boolean;
  slice?: GraphSlice;
  /**
   * Optional override for the utility scorer used in the no-identifiers
   * fallback path. Production callers leave this unset and pick up the
   * default `score.scoreSymbol(symbol, { query: "" }, null)` evaluation.
   * Tests inject a stub to exercise the approve-by-utility branch
   * deterministically.
   */
  scoreFn?: (symbol: SymbolRow) => number;
}

export interface IdentifierDenialGuidance {
  suggestedNextRequest: Partial<CodeWindowRequest>;
  nextBestAction: NextBestActionCallable;
}

const UTILITY_SCORE_THRESHOLD = 0.3;

export async function enforceCodeWindow(
  request: CodeWindowRequest,
  _decision: CodeAccessApprove | CodeAccessDowngrade,
  loader: WindowLoader,
  context: EnforceContext = {},
): Promise<CodeWindowResponse> {
  const window = await loader.loadWindow(request.repoId, request.symbolId);
  if (!window) {
    return {
      approved: false,
      whyDenied: [
        "Code window could not be extracted — file may be too large, unreadable on disk, or the symbol range is invalid. " +
          "Try sdl.code.getSkeleton or sdl.symbol.getCard instead.",
      ],
      suggestedNextRequest: undefined,
    };
  }

  const symbol = await loader.getSymbol(request.symbolId);
  if (!symbol) {
    return {
      approved: false,
      whyDenied: ["Symbol not found"],
      suggestedNextRequest: undefined,
    };
  }

  if (request.identifiersToFind.length > 0) {
    const matched = findMatchedIdentifiersInWindow(
      window.code,
      request.identifiersToFind,
    );
    if (matched.length === 0) {
      const guidance = buildIdentifierDenialGuidance(
        request,
        "identifiers-not-found",
        symbol,
      );
      return {
        approved: false,
        whyDenied: ["Identifiers not found in code window"],
        suggestedNextRequest: guidance.suggestedNextRequest,
        nextBestAction: guidance.nextBestAction,
      };
    }
    return {
      ...window,
      whyApproved: [`Identifiers matched: ${matched.join(", ")}`],
    };
  }

  if (context.slice) {
    const inCards = context.slice.cards?.some(
      (c) => c.symbolId === request.symbolId,
    );
    const inFrontier = (
      context.slice.frontier as ReadonlyArray<unknown> | undefined
    )?.some((entry) => {
      if (typeof entry === "string") return entry === request.symbolId;
      if (entry && typeof entry === "object" && "symbolId" in entry) {
        return (entry as { symbolId: string }).symbolId === request.symbolId;
      }
      return false;
    });
    if (inCards || inFrontier) {
      return {
        ...window,
        whyApproved: ["Symbol present in active slice context"],
      };
    }
  }

  const utilityScore = context.scoreFn
    ? context.scoreFn(symbol)
    : score.scoreSymbol(symbol, { query: "" }, null);
  if (utilityScore > UTILITY_SCORE_THRESHOLD) {
    return {
      ...window,
      whyApproved: [`High utility score: ${utilityScore.toFixed(2)}`],
    };
  }

  if (context.breakGlass) {
    return {
      ...window,
      whyApproved: ["Break-glass approval"],
    };
  }

  const guidance = buildIdentifierDenialGuidance(
    request,
    "low-utility",
    symbol,
  );
  return {
    approved: false,
    whyDenied: ["Request does not meet approval criteria"],
    suggestedNextRequest: guidance.suggestedNextRequest,
    nextBestAction: guidance.nextBestAction,
  };
}

function buildIdentifierDenialGuidance(
  request: CodeWindowRequest,
  reason: "identifiers-not-found" | "low-utility",
  symbol: SymbolRow,
): IdentifierDenialGuidance {
  const suggestions: Partial<CodeWindowRequest> = {};
  const sigIds = extractSignatureIdentifiers(symbol);

  if (reason === "identifiers-not-found") {
    if (sigIds.length > 0) {
      suggestions.identifiersToFind = sigIds;
    }
    suggestions.reason = `${request.reason} (identifiers not found — try signature-derived identifiers)`;

    const nextBestAction: NextBestActionCallable = {
      tool: "sdl.code.getHotPath",
      args: {
        repoId: request.repoId,
        symbolId: request.symbolId,
        identifiersToFind:
          sigIds.length > 0 ? sigIds : request.identifiersToFind,
      },
      rationale:
        "Identifiers not present in raw window — hot-path will pinpoint the lines containing the matching identifiers if they exist anywhere in the symbol.",
    };
    return { suggestedNextRequest: suggestions, nextBestAction };
  }

  if (sigIds.length > 0) {
    suggestions.identifiersToFind = sigIds;
  }
  suggestions.reason = `${request.reason} (low utility — provide specific identifiers)`;

  const nextBestAction: NextBestActionCallable = {
    tool: "sdl.code.getSkeleton",
    args: {
      repoId: request.repoId,
      symbolId: request.symbolId,
    },
    rationale:
      "Symbol does not meet utility threshold for full window — start from the skeleton and refine identifier set.",
  };
  return { suggestedNextRequest: suggestions, nextBestAction };
}

function extractSignatureIdentifiers(symbol: SymbolRow): string[] {
  if (symbol.signature_json) {
    const signature = safeJsonParseOptional(
      symbol.signature_json,
      SignatureSchema,
    );
    if (
      signature?.params &&
      Array.isArray(signature.params) &&
      signature.params.length > 0
    ) {
      return signature.params.map((p) => p.name).slice(0, 3);
    }
  }
  return [symbol.name];
}
