/**
 * Domain error types.
 *
 * These are infrastructure/domain errors used across all layers.
 * MCP-specific error formatting lives in `src/mcp/errors.ts`.
 */

export enum ErrorCode {
  CONFIG_ERROR = "CONFIG_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  INDEX_ERROR = "INDEX_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NOT_FOUND = "NOT_FOUND",
  POLICY_ERROR = "POLICY_ERROR",
  RUNTIME_ERROR = "RUNTIME_ERROR",
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

export class NotFoundError extends Error {
  readonly code = ErrorCode.NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// ============================================================================
// Runtime Execution Errors
// ============================================================================

export class RuntimePolicyDeniedError extends Error {
  readonly code = ErrorCode.POLICY_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimePolicyDeniedError";
  }
}

export class RuntimeNotFoundError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNotFoundError";
  }
}

export class RuntimeTimeoutError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTimeoutError";
  }
}

export class RuntimeOutputLimitError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeOutputLimitError";
  }
}

export class ArtifactNotFoundError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactCleanupError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCleanupError";
  }
}

export class ScipDecodeError extends Error {
  readonly code = ErrorCode.INDEX_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ScipDecodeError";
  }
}

export class ScipFileNotFoundError extends Error {
  readonly code = ErrorCode.NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = "ScipFileNotFoundError";
  }
}

export class ScipIngestionError extends Error {
  readonly code = ErrorCode.INDEX_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ScipIngestionError";
  }
}

export class ScipSymbolMatchError extends Error {
  readonly code = ErrorCode.VALIDATION_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ScipSymbolMatchError";
  }
}
