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
