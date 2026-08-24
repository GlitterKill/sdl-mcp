/**
 * Model-facing detail requested from a projector. Diagnostics remain an
 * independent opt-in so increasing detail never enables them implicitly.
 */
export type DetailLevel = "summary" | "compact" | "standard" | "full";

/** Public callers use three stable levels; summary remains projector-internal. */
export type ProjectionDetailLevel = "compact" | "standard" | "full";

export type OutputBudgetClass =
  | "summary"
  | "empty"
  | "error"
  | "small"
  | "compact"
  | "standard"
  | "full"
  | "diagnostic";

export type LargeResponseStrategy = "truncate" | "artifact";

export type RecoveryPolicy = "none" | "on-truncation";

/** Stable identifiers let registries name behavior without coupling to functions. */
export type ProjectorId = string;
export type ObservabilityProfileId =
  | "standard"
  | "status"
  | "mutation"
  | "artifact"
  | "actionSearch"
  | "repoStatus"
  | "usage"
  | "workflow";

export interface ProjectionProfile {
  readonly projector: ProjectorId;
  readonly observabilityProfile: ObservabilityProfileId;
  readonly defaultDetail: DetailLevel;
  readonly budgetClass: OutputBudgetClass;
  readonly largeResponseStrategy: LargeResponseStrategy;
  readonly recoveryPolicy: RecoveryPolicy;
}

export interface ProjectionStats {
  readonly profile: ProjectionProfile;
  readonly effectiveDetail: DetailLevel;
  readonly diagnosticsIncluded: boolean;
  readonly rawBytes: number;
  readonly rawTokens: number;
  readonly projectedBytes: number;
  readonly projectedTokens: number;
  readonly removedFieldCount: number;
  readonly truncated: boolean;
  readonly responseHandled: boolean;
  readonly recoveryEmitted: boolean;
  /** Internal-only count; omitted from model-facing payloads. */
  readonly invalidRecoveryCount: number;
}

/** A fully materialized public recovery call. */
export interface RecoveryActionCall {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Bounded continuation state that may be copied into a generated recovery. */
export interface RecoveryContinuationContext {
  readonly handle?: string;
  readonly view?: "model" | "raw";
  readonly cursor?: {
    readonly stream: "stdout" | "stderr";
    readonly afterLine: number;
  };
  readonly maxBytes?: number;
}

/** Public surface and failed-call evidence available to recovery validation. */
export interface RecoveryValidationContext {
  readonly repoId?: string;
  readonly advertisedTools: readonly string[];
  /** Canonical names accepted by this server's fixed workflow dispatch map. */
  readonly activeWorkflowFunctions?: readonly string[];
  readonly failedCall?: RecoveryActionCall;
  readonly continuation?: RecoveryContinuationContext;
}

export interface RecoveryBuildResult {
  readonly nextAction?: RecoveryActionCall;
  readonly validatedAction?: RecoveryActionCall;
  readonly invalidRecoveryCount: number;
}

export interface RecoveryValidationMetrics {
  readonly invalidRecoveryCount: number;
}

export interface ModelProjection<T = unknown> {
  readonly value: T;
  readonly summary: string;
  readonly stats: ProjectionStats;
}

export interface ProjectionRequestOptions {
  readonly detail?: ProjectionDetailLevel;
  readonly includeDiagnostics?: boolean;
  readonly budgetClass?: OutputBudgetClass;
  readonly maxTokens?: number;
  readonly largeResponseStrategy?: LargeResponseStrategy;
  readonly recoveryPolicy?: RecoveryPolicy;
}

export interface EffectiveProjectionRequestOptions {
  readonly detail: ProjectionDetailLevel;
  readonly includeDiagnostics: boolean;
}

export type ModelOutputBoundaryErrorCode =
  | "MODEL_PROJECTION_FAILED"
  | "MODEL_OUTPUT_MEASUREMENT_FAILED"
  | "RESPONSE_HANDLING_FAILED";

/** Request and canonical state available while producing one model projection. */
export interface ProjectionEnclosingContext {
  readonly toolName: string;
  readonly requestArgs: Readonly<Record<string, unknown>>;
  readonly footerText?: string;
  readonly measurementSource?: unknown;
}

export interface ModelProjectionInput {
  readonly canonicalResult: unknown;
  readonly action: string;
  readonly profile: Readonly<ProjectionProfile>;
  readonly options: EffectiveProjectionRequestOptions;
  readonly context: ProjectionEnclosingContext;
}

export type ModelValueProjectionDelegate = (
  input: ModelProjectionInput,
) => unknown;

export interface ProjectionMeasurement {
  readonly rawBytes: number;
  readonly rawTokens: number;
  readonly projectedBytes: number;
  readonly projectedTokens: number;
  readonly invalidRecoveryCount: number;
}

export interface ProjectionOperationalStats {
  readonly status?: string;
  readonly resultStatus?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

export interface ModelProjectionDependencies {
  readonly prepareCanonicalValue?: (canonicalValue: unknown) => unknown;
  readonly projectValue?: (input: ModelProjectionInput) => unknown;
  readonly projectCompatibilityValue?: ModelValueProjectionDelegate;
  readonly measureProjection?: (
    rawValue: unknown,
    projectedValue: unknown,
  ) => Readonly<ProjectionMeasurement>;
}
