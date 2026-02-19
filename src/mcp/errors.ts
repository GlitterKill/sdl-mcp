import type { NextBestAction, RequiredFieldsForNext } from "./types.js";

export enum ErrorCode {
  CONFIG_ERROR = "CONFIG_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  INDEX_ERROR = "INDEX_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  POLICY_ERROR = "POLICY_ERROR",
}

export interface PolicyDenialError extends Error {
  code: ErrorCode;
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
}

export class ConfigError extends Error {
  readonly code = ErrorCode.CONFIG_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class DatabaseError extends Error {
  readonly code = ErrorCode.DATABASE_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class IndexError extends Error {
  readonly code = ErrorCode.INDEX_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export class ValidationError extends Error {
  readonly code = ErrorCode.VALIDATION_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class PolicyError extends Error {
  readonly code = ErrorCode.POLICY_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
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
