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

export interface PolicyDenialError extends Error {
  code: ErrorCode;
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
}

export function createPolicyDenial(
  message: string,
  nextBestAction?: NextBestAction,
  requiredFieldsForNext?: RequiredFieldsForNext,
): PolicyDenialError {
  const error = new Error(message) as PolicyDenialError;
  error.name = "PolicyError";
  error.code = ErrorCode.POLICY_ERROR;
  error.nextBestAction = nextBestAction;
  error.requiredFieldsForNext = requiredFieldsForNext;
  return error;
}

export interface McpErrorDetail {
  message: string;
  code?: string;
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
}

export function errorToMcpResponse(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const detail: McpErrorDetail = {
      message: error.message,
    };

    const codeError = error as { code?: string };
    if (codeError.code) {
      detail.code = codeError.code;
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
      message: String(error),
    },
  };
}
