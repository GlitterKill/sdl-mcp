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

export function errorToMcpResponse(error: unknown): {
  error?: { message: string };
} {
  if (error instanceof Error) {
    return {
      error: {
        message: error.message,
      },
    };
  }
  return {
    error: {
      message: String(error),
    },
  };
}
