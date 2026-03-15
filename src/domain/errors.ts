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
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class DatabaseError extends Error {
  readonly code = ErrorCode.DATABASE_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

export class IndexError extends Error {
  readonly code = ErrorCode.INDEX_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
    Object.setPrototypeOf(this, IndexError.prototype);
  }
}

export class ValidationError extends Error {
  readonly code = ErrorCode.VALIDATION_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class PolicyError extends Error {
  readonly code = ErrorCode.POLICY_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
    Object.setPrototypeOf(this, PolicyError.prototype);
  }
}

export class NotFoundError extends Error {
  readonly code = ErrorCode.NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
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
    Object.setPrototypeOf(this, RuntimePolicyDeniedError.prototype);
  }
}

export class RuntimeNotFoundError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNotFoundError";
    Object.setPrototypeOf(this, RuntimeNotFoundError.prototype);
  }
}

export class RuntimeTimeoutError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTimeoutError";
    Object.setPrototypeOf(this, RuntimeTimeoutError.prototype);
  }
}

export class RuntimeOutputLimitError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeOutputLimitError";
    Object.setPrototypeOf(this, RuntimeOutputLimitError.prototype);
  }
}

export class ArtifactNotFoundError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
    Object.setPrototypeOf(this, ArtifactNotFoundError.prototype);
  }
}

export class ArtifactCleanupError extends Error {
  readonly code = ErrorCode.RUNTIME_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCleanupError";
    Object.setPrototypeOf(this, ArtifactCleanupError.prototype);
  }
}
