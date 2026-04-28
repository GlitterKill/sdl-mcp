import type { NextBestAction, RequiredFieldsForNext } from "./types.js";

// Re-export domain error types for backward compatibility
export {
  ErrorCode,
  ConfigError,
  DatabaseError,
  IndexError,
  ValidationError,
  PolicyError,
  NotFoundError,
} from "../domain/errors.js";

import { ErrorCode } from "../domain/errors.js";

export class WireFormatRetiredError extends Error {
  readonly retiredVersion: number;
  readonly migrationHint: string;
  constructor(retiredVersion: number) {
    const hint =
      "Compact wire format versions 1 and 2 were retired in 0.11.0. " +
      'Use wireFormatVersion: 3 (default) or wireFormat: "packed".';
    super(`wireFormatVersion ${retiredVersion} is retired. ${hint}`);
    this.name = "WireFormatRetiredError";
    this.retiredVersion = retiredVersion;
    this.migrationHint = hint;
    (this as { code?: string }).code = "WIRE_FORMAT_RETIRED";
  }
}

export class PolicyDenialError extends Error {
  readonly code = ErrorCode.POLICY_ERROR;
  readonly nextBestAction?: NextBestAction;
  readonly requiredFieldsForNext?: RequiredFieldsForNext;

  constructor(
    message: string,
    nextBestAction?: NextBestAction,
    requiredFieldsForNext?: RequiredFieldsForNext,
  ) {
    super(message);
    this.name = "PolicyDenialError";
    this.nextBestAction = nextBestAction;
    this.requiredFieldsForNext = requiredFieldsForNext;
    Object.setPrototypeOf(this, PolicyDenialError.prototype);
  }
}

export function createPolicyDenial(
  message: string,
  nextBestAction?: NextBestAction,
  requiredFieldsForNext?: RequiredFieldsForNext,
): PolicyDenialError {
  return new PolicyDenialError(message, nextBestAction, requiredFieldsForNext);
}

export interface McpErrorDetail {
  message: string;
  code?: string;
  details?: string[];
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
  classification?: string;
  retryable?: boolean;
  suggestedRetryDelayMs?: number;
  fallbackTools?: string[];
  fallbackRationale?: string;
  candidates?: Array<Record<string, unknown>>;
}

/**
 * Determines whether an error is a known domain error whose message is safe
 * to expose to MCP clients.  Unknown/unexpected errors are sanitized to
 * prevent leaking internal paths, stack traces, or DB state.
 */
function isDomainError(error: Error): boolean {
  const code = (error as { code?: string }).code;
  return (
    typeof code === "string" &&
    Object.values(ErrorCode).includes(code as ErrorCode)
  );
}

function defaultClassification(code?: string): string | undefined {
  switch (code) {
    case ErrorCode.NOT_FOUND:
      return "not_found";
    case ErrorCode.VALIDATION_ERROR:
      return "invalid_input";
    case ErrorCode.POLICY_ERROR:
      return "policy_denied";
    case ErrorCode.DATABASE_ERROR:
      return "internal_error";
    case ErrorCode.INDEX_ERROR:
      return "unavailable";
    case ErrorCode.CONFIG_ERROR:
      return "configuration_error";
    case ErrorCode.RUNTIME_ERROR:
      return "runtime_error";
    default:
      return undefined;
  }
}

function defaultRetryable(code?: string): boolean | undefined {
  switch (code) {
    case ErrorCode.DATABASE_ERROR:
    case ErrorCode.INDEX_ERROR:
    case ErrorCode.RUNTIME_ERROR:
      return true;
    case ErrorCode.NOT_FOUND:
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.POLICY_ERROR:
    case ErrorCode.CONFIG_ERROR:
      return false;
    default:
      return undefined;
  }
}

function fallbackToolsForNextAction(nextBestAction?: NextBestAction): string[] | undefined {
  switch (nextBestAction) {
    case "requestSkeleton":
      return ["sdl.code.getSkeleton"];
    case "requestHotPath":
      return ["sdl.code.getHotPath"];
    case "refreshSlice":
      return ["sdl.slice.refresh"];
    case "buildSlice":
      return ["sdl.slice.build"];
    case "retryWithSameInputs":
      return ["sdl.code.needWindow"];
    default:
      return undefined;
  }
}

function fallbackRationaleForNextAction(nextBestAction?: NextBestAction): string | undefined {
  switch (nextBestAction) {
    case "requestSkeleton":
      return "Use a skeleton request first to stay on the context ladder.";
    case "requestHotPath":
      return "Use a hot-path excerpt before requesting a larger code window.";
    case "refreshSlice":
      return "Refresh the existing slice before rebuilding broader context.";
    case "buildSlice":
      return "Build a focused slice before escalating to raw code access.";
    case "retryWithSameInputs":
      return "The request may succeed on a later retry with the same inputs.";
    default:
      return undefined;
  }
}

export function errorToMcpResponse(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    // Only expose the raw message for known domain errors; sanitize unexpected errors.
    const safe = isDomainError(error);
    const detail: McpErrorDetail = {
      message: safe
        ? error.message
        : "An internal error occurred. Check server logs for details.",
    };

    const codeError = error as { code?: string };
    if (codeError.code) {
      detail.code = codeError.code;
    }
    const detailError = error as { details?: string[] };
    if (Array.isArray(detailError.details)) {
      detail.details = detailError.details;
    }

    const policyError = error as Partial<PolicyDenialError>;
    if (policyError.nextBestAction) {
      detail.nextBestAction = policyError.nextBestAction;
    }
    if (policyError.requiredFieldsForNext) {
      detail.requiredFieldsForNext = policyError.requiredFieldsForNext;
    }

    const classifiedError = error as {
      classification?: string;
      retryable?: boolean;
      suggestedRetryDelayMs?: number;
      fallbackTools?: string[];
      fallbackRationale?: string;
      candidates?: Array<Record<string, unknown>>;
    };
    detail.classification =
      classifiedError.classification ?? defaultClassification(codeError.code);
    detail.retryable = classifiedError.retryable ?? defaultRetryable(codeError.code);
    if (classifiedError.suggestedRetryDelayMs !== undefined) {
      detail.suggestedRetryDelayMs = classifiedError.suggestedRetryDelayMs;
    }
    if (Array.isArray(classifiedError.fallbackTools)) {
      detail.fallbackTools = classifiedError.fallbackTools;
    } else if (detail.nextBestAction) {
      detail.fallbackTools = fallbackToolsForNextAction(detail.nextBestAction);
    }
    if (classifiedError.fallbackRationale) {
      detail.fallbackRationale = classifiedError.fallbackRationale;
    } else if (detail.nextBestAction) {
      detail.fallbackRationale = fallbackRationaleForNextAction(detail.nextBestAction);
    }
    if (Array.isArray(classifiedError.candidates)) {
      detail.candidates = classifiedError.candidates;
    }

    return { error: detail };
  }
  return {
    error: {
      message: "An internal error occurred. Check server logs for details.",
    },
  };
}
