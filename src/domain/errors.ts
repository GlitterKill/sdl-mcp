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
  PARSER_ADAPTER_CONTRACT_ERROR = "PARSER_ADAPTER_CONTRACT_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NOT_FOUND = "NOT_FOUND",
  POLICY_ERROR = "POLICY_ERROR",
  RUNTIME_ERROR = "RUNTIME_ERROR",
  PARSER_PROVENANCE_INCOMPLETE = "PARSER_PROVENANCE_INCOMPLETE",
  PARSER_FILE_STATE_MISSING = "PARSER_FILE_STATE_MISSING",
  PARSER_ENGINE_UNAVAILABLE = "PARSER_ENGINE_UNAVAILABLE",
  PARSER_CONTRACT_MISMATCH = "PARSER_CONTRACT_MISMATCH",
  PARSER_SYMBOL_REMAP = "PARSER_SYMBOL_REMAP",
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

/** Permanent evidence that the physical graph cannot safely accept writes. */
export class StorageIntegrityError extends DatabaseError {
  constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

export class IndexError extends Error {
  readonly code: ErrorCode = ErrorCode.INDEX_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export const PARSER_PROVENANCE_RECOVERY_GUIDANCE =
  "Reindex only if AST/provenance-dependent behavior is required; otherwise use a file-based fallback.";

const PARSER_PROVENANCE_RECOVERY_ACTION = "fileFallback";

export class ParserAdapterContractError extends IndexError {
  override readonly code: ErrorCode =
    ErrorCode.PARSER_ADAPTER_CONTRACT_ERROR;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;

  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      `Parser adapter contract ${requiredContract} is unavailable for ${repoRelativePath}. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserAdapterContractError";
  }
}

/** The graph integrity gate rejected a retrieval request. */
export class GraphRetrievalUnavailableError extends IndexError {
  constructor(message: string) {
    super(message);
    this.name = "GraphRetrievalUnavailableError";
  }
}

export const SAFE_REBUILD_RECOVERY_GUIDANCE =
  "Stop the service and run the existing safe-rebuild workflow before restarting.";

/** An existing database cannot cross a fresh-schema-only boundary in place. */
export class SafeRebuildRequiredError extends DatabaseError {
  constructor(message: string) {
    super(`${message} ${SAFE_REBUILD_RECOVERY_GUIDANCE}`);
    this.name = "SafeRebuildRequiredError";
  }
}

/** A fresh rebuild candidate did not pass the stopped, post-reopen gates. */
export class SafeRebuildValidationError extends IndexError {
  constructor(message: string) {
    super(message);
    this.name = "SafeRebuildValidationError";
  }
}

/** The current graph version does not have a verified incremental baseline. */
export class GraphIntegrityBaselineError extends IndexError {
  constructor(message: string) {
    super(message);
    this.name = "GraphIntegrityBaselineError";
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

export const RUNTIME_REPOSITORY_INSPECTION_DISALLOWED =
  'RUNTIME_REPOSITORY_INSPECTION_DISALLOWED: runtimeExecute executes repository tooling and cannot inspect repository files. Use sdl.context or sdl.retrieve for indexed source; use sdl.file with op="read" for non-indexed files.';

export class RuntimeRepositoryInspectionError extends RuntimePolicyDeniedError {
  constructor() {
    super(RUNTIME_REPOSITORY_INSPECTION_DISALLOWED);
    this.name = "RuntimeRepositoryInspectionError";
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

export class ParserProvenanceIncompleteError extends IndexError {
  readonly code = ErrorCode.PARSER_PROVENANCE_INCOMPLETE;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;
  readonly details: Record<string, string>;
  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      "Parser provenance is incomplete for " +
        repoRelativePath +
        "; required contract " +
        requiredContract +
        `. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserProvenanceIncompleteError";
    this.details = {
      repoRelativePath,
      requiredContract,
      recoveryAction: this.recoveryAction,
    };
  }
}

export class ParserFileStateMissingError extends IndexError {
  readonly code = ErrorCode.PARSER_FILE_STATE_MISSING;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;
  readonly details: Record<string, string>;
  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      "Parser file state is missing for " +
        repoRelativePath +
        "; required contract " +
        requiredContract +
        `. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserFileStateMissingError";
    this.details = {
      repoRelativePath,
      requiredContract,
      recoveryAction: this.recoveryAction,
    };
  }
}

export class ParserEngineUnavailableError extends IndexError {
  readonly code = ErrorCode.PARSER_ENGINE_UNAVAILABLE;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;
  readonly details: Record<string, string>;
  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      "Parser engine is unavailable for " +
        repoRelativePath +
        "; required contract " +
        requiredContract +
        `. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserEngineUnavailableError";
    this.details = {
      repoRelativePath,
      requiredContract,
      recoveryAction: this.recoveryAction,
    };
  }
}

export class ParserContractMismatchError extends IndexError {
  readonly code = ErrorCode.PARSER_CONTRACT_MISMATCH;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;
  readonly details: Record<string, string>;
  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      "Parser contract does not match for " +
        repoRelativePath +
        "; required contract " +
        requiredContract +
        `. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserContractMismatchError";
    this.details = {
      repoRelativePath,
      requiredContract,
      recoveryAction: this.recoveryAction,
    };
  }
}

export class ParserSymbolRemapError extends IndexError {
  readonly code = ErrorCode.PARSER_SYMBOL_REMAP;
  readonly recoveryAction = PARSER_PROVENANCE_RECOVERY_ACTION;
  readonly details: Record<string, string>;
  constructor(
    readonly repoRelativePath: string,
    readonly requiredContract: string,
  ) {
    super(
      "Parser symbol remap failed for " +
        repoRelativePath +
        "; required contract " +
        requiredContract +
        `. ${PARSER_PROVENANCE_RECOVERY_GUIDANCE}`,
    );
    this.name = "ParserSymbolRemapError";
    this.details = {
      repoRelativePath,
      requiredContract,
      recoveryAction: this.recoveryAction,
    };
  }
}
