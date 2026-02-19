import type { RepoId, SymbolId } from "../../db/schema.js";
import type { SliceBudget, GraphSlice } from "../../mcp/types.js";

export type SliceError =
  | { type: "invalid_repo"; repoId: RepoId }
  | { type: "no_version"; repoId: RepoId }
  | { type: "no_symbols"; repoId: RepoId; entrySymbols?: SymbolId[] }
  | { type: "policy_denied"; reason: string }
  | { type: "internal"; message: string; cause?: string };

export type SliceResult =
  | { ok: true; slice: GraphSlice }
  | { ok: false; error: SliceError };

export function sliceOk(slice: GraphSlice): SliceResult {
  return { ok: true, slice };
}

export function sliceErr(error: SliceError): SliceResult {
  return { ok: false, error };
}

export function isSliceOk(
  result: SliceResult,
): result is { ok: true; slice: GraphSlice } {
  return result.ok === true;
}

export function isSliceErr(
  result: SliceResult,
): result is { ok: false; error: SliceError } {
  return result.ok === false;
}

export function sliceErrorToMessage(error: SliceError): string {
  switch (error.type) {
    case "invalid_repo":
      return `Repository not found: ${error.repoId}`;
    case "no_version":
      return `No version found for repo ${error.repoId}. Please run indexing first.`;
    case "no_symbols":
      return error.entrySymbols
        ? `No symbols found for entry symbols in repo ${error.repoId}`
        : `No symbols indexed for repo ${error.repoId}`;
    case "policy_denied":
      return `Policy denied slice request: ${error.reason}`;
    case "internal":
      return error.cause
        ? `Internal error: ${error.message} (cause: ${error.cause})`
        : `Internal error: ${error.message}`;
  }
}

export function sliceErrorToCode(error: SliceError): string {
  switch (error.type) {
    case "invalid_repo":
      return "INVALID_REPO";
    case "no_version":
      return "NO_VERSION";
    case "no_symbols":
      return "NO_SYMBOLS";
    case "policy_denied":
      return "POLICY_DENIED";
    case "internal":
      return "INTERNAL_ERROR";
  }
}

export interface SliceErrorResponse {
  error: {
    code: string;
    message: string;
    type: SliceError["type"];
    repoId?: RepoId;
  };
}

export function sliceErrorToResponse(error: SliceError): SliceErrorResponse {
  return {
    error: {
      code: sliceErrorToCode(error),
      message: sliceErrorToMessage(error),
      type: error.type,
      repoId: "repoId" in error ? error.repoId : undefined,
    },
  };
}

export type { SliceBudget };
