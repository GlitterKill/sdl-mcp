/**
 * Runtime execution types for SDL-MCP subprocess execution subsystem.
 *
 * This module defines the core types for repo-scoped command execution,
 * artifact persistence, and runtime detection.
 */

// ============================================================================
// Runtime Descriptor
// ============================================================================

/**
 * Describes a runtime environment (node, python, shell) with detection
 * and command-building capabilities.
 */
export interface RuntimeDescriptor {
  /** Runtime identifier (e.g., "node", "python", "shell"). */
  name: string;

  /**
   * Detect whether this runtime is available on the host.
   * Results are cached for the server lifetime.
   */
  detect(): Promise<RuntimeDetectionResult>;

  /**
   * Build the executable + args array for a given execution request.
   * @param args - User-provided arguments.
   * @param opts - Additional options (e.g., code temp file path).
   * @returns The resolved executable and final argument list.
   */
  buildCommand(
    args: string[],
    opts: { codePath?: string; executable?: string },
  ): { executable: string; args: string[] };
}

export interface RuntimeDetectionResult {
  available: boolean;
  version?: string;
  path?: string;
}

// ============================================================================
// Execution Request / Result
// ============================================================================

/**
 * Internal execution request passed to the executor after validation
 * and policy evaluation.
 */
export interface ExecutionRequest {
  repoId: string;
  runtime: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  codePath?: string;
}

/**
 * Result returned by the executor after process completion.
 */
export interface ExecutionResult {
  status: "success" | "failure" | "timeout" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  totalStdoutBytes: number;
  totalStderrBytes: number;
}

// ============================================================================
// Excerpt Types
// ============================================================================

export interface OutputExcerpt {
  lineStart: number;
  lineEnd: number;
  content: string;
  source: "stdout" | "stderr";
}

// ============================================================================
// Artifact Types
// ============================================================================

export interface ArtifactManifest {
  artifactId: string;
  repoId: string;
  runtime: string;
  argsHash: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  policyAuditHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface ArtifactWriteResult {
  artifactHandle: string;
  artifactDir: string;
  manifest: ArtifactManifest;
}

// ============================================================================
// Concurrency Tracking
// ============================================================================

export interface ConcurrencyTracker {
  /** Current number of running jobs. */
  activeCount: number;

  /**
   * Attempt to acquire a slot. Returns true if acquired.
   */
  acquire(): boolean;

  /**
   * Release a slot after job completion.
   */
  release(): void;
}
