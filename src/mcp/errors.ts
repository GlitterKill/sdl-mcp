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

    return { error: detail };
  }
  return {
    error: {
      message: "An internal error occurred. Check server logs for details.",
    },
  };
}
