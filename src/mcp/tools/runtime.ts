/**
 * MCP tool handler for sdl.runtime.execute.
 *
 * Thin adapter that wires: policy evaluation → executor → artifact persistence
 * → excerpt generation → telemetry → structured response.
 */

import type { ToolContext } from "../../server.js";
import {
  RuntimeExecuteRequestSchema,
  type RuntimeExecuteResponse,
} from "../tools.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  DatabaseError,
  RuntimePolicyDeniedError,
} from "../../domain/errors.js";
import { loadConfig } from "../../config/loadConfig.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { PolicyEngine } from "../../policy/engine.js";
import type { RuntimePolicyRequestContext } from "../../policy/types.js";
import { getRuntime, getRegisteredRuntimes, getRuntimeExtension, getRuntimeRequiredEnvKeys, isCompileThenExecute } from "../../runtime/runtimes.js";
import {
  execute,
  createConcurrencyTracker,
  buildScrubbedEnv,
  resolveAndValidateCwd,
} from "../../runtime/executor.js";
import { writeArtifact } from "../../runtime/artifacts.js";
import type { OutputExcerpt, ConcurrencyTracker } from "../../runtime/types.js";
import { logRuntimeExecution } from "../telemetry.js";
import { logPolicyDecision } from "../telemetry.js";
import { attachRawContext } from "../token-usage.js";
import { hashContent } from "../../util/hashing.js";
import { logger } from "../../util/logger.js";
import {
  RUNTIME_EXCERPT_HEAD_LINES,
  RUNTIME_EXCERPT_TAIL_LINES,
  RUNTIME_EXCERPT_STDERR_TAIL_LINES,
  RUNTIME_MAX_KEYWORD_EXCERPTS,
  RUNTIME_KEYWORD_CONTEXT_LINES,
} from "../../config/constants.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ============================================================================
// Module-Level Singletons
// ============================================================================

let concurrencyTracker: ConcurrencyTracker | undefined;
let trackerMaxJobs: number | undefined;

function getOrCreateConcurrencyTracker(maxJobs: number): ConcurrencyTracker {
  if (!concurrencyTracker || trackerMaxJobs !== maxJobs) {
    concurrencyTracker = createConcurrencyTracker(maxJobs);
    trackerMaxJobs = maxJobs;
  }
  return concurrencyTracker;
}

// ============================================================================
// Excerpt Generation
// ============================================================================

function generateExcerpts(
  stdout: string,
  stderr: string,
  maxResponseLines: number,
  queryTerms?: string[],
): {
  stdoutSummary: string;
  stderrSummary: string;
  excerpts: OutputExcerpt[];
} {
  const stdoutLines = stdout.split("\n");
  const stderrLines = stderr.split("\n");

  // Head + tail for stdout summary
  const headCount = Math.min(RUNTIME_EXCERPT_HEAD_LINES, maxResponseLines / 2);
  const tailCount = Math.min(RUNTIME_EXCERPT_TAIL_LINES, maxResponseLines / 2);

  let stdoutSummary: string;
  if (stdoutLines.length <= headCount + tailCount) {
    stdoutSummary = stdout;
  } else {
    const head = stdoutLines.slice(0, headCount);
    const tail = stdoutLines.slice(-tailCount);
    stdoutSummary = [
      ...head,
      `\n... (${stdoutLines.length - headCount - tailCount} lines omitted) ...\n`,
      ...tail,
    ].join("\n");
  }

  // Tail for stderr summary
  const stderrTailCount = Math.min(
    RUNTIME_EXCERPT_STDERR_TAIL_LINES,
    stderrLines.length,
  );
  const stderrSummary =
    stderrLines.length <= stderrTailCount
      ? stderr
      : stderrLines.slice(-stderrTailCount).join("\n");

  // Keyword-matched excerpts
  const excerpts: OutputExcerpt[] = [];
  if (queryTerms && queryTerms.length > 0) {
    const lowerTerms = queryTerms.map((t) => t.toLowerCase());

    const searchStream = (
      lines: string[],
      source: "stdout" | "stderr",
    ): void => {
      for (let i = 0; i < lines.length; i++) {
        if (excerpts.length >= RUNTIME_MAX_KEYWORD_EXCERPTS) break;
        const lineLower = lines[i].toLowerCase();
        if (lowerTerms.some((term) => lineLower.includes(term))) {
          const start = Math.max(0, i - RUNTIME_KEYWORD_CONTEXT_LINES);
          const end = Math.min(
            lines.length - 1,
            i + RUNTIME_KEYWORD_CONTEXT_LINES,
          );
          const content = lines.slice(start, end + 1).join("\n");
          excerpts.push({
            lineStart: start + 1,
            lineEnd: end + 1,
            content,
            source,
          });
          // Skip ahead to avoid overlapping windows
          i = end;
        }
      }
    };

    searchStream(stdoutLines, "stdout");
    searchStream(stderrLines, "stderr");
  }

  return { stdoutSummary, stderrSummary, excerpts };
}

// ============================================================================
// Handler
// ============================================================================

export async function handleRuntimeExecute(
  args: unknown,
  context?: ToolContext,
): Promise<RuntimeExecuteResponse> {
  const request = RuntimeExecuteRequestSchema.parse(args);

  // 1. Load config + validate repo
  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${request.repoId} not found`);
  }

  // 2. Resolve runtime descriptor
  const runtimeDescriptor = getRuntime(request.runtime);
  if (!runtimeDescriptor) {
    const available = getRegisteredRuntimes().join(", ");
    throw new RuntimePolicyDeniedError(`Unknown runtime: ${request.runtime}. Available: ${available}`);
  }

  // 3. Evaluate policy
  const tracker = getOrCreateConcurrencyTracker(
    runtimeConfig.maxConcurrentJobs,
  );
  const timeoutMs = request.timeoutMs ?? runtimeConfig.maxDurationMs;
  const executable =
    request.executable ?? runtimeDescriptor.buildCommand([], {}).executable;

  const policyContext: RuntimePolicyRequestContext = {
    requestType: "runtimeExecute",
    repoId: request.repoId,
    runtime: request.runtime,
    executable,
    args: request.args,
    relativeCwd: request.relativeCwd,
    timeoutMs,
    envKeys: [], // No custom env in v1
  };

  const engine = new PolicyEngine();
  const policyDecision = engine.evaluateRuntimePolicy(
    policyContext,
    runtimeConfig,
    tracker,
  );

  // Log policy decision
  logPolicyDecision({
    requestType: "runtimeExecute",
    repoId: request.repoId,
    decision: policyDecision.decision,
    auditHash: policyDecision.auditHash,
    evidenceUsed: policyDecision.evidenceUsed,
    deniedReasons: policyDecision.deniedReasons,
  });

  if (policyDecision.decision === "deny") {
    return {
      status: "denied",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutSummary: "",
      stderrSummary: "",
      artifactHandle: null,
      truncation: {
        stdoutTruncated: false,
        stderrTruncated: false,
        totalStdoutBytes: 0,
        totalStderrBytes: 0,
      },
      policyDecision: {
        auditHash: policyDecision.auditHash,
        deniedReasons: policyDecision.deniedReasons,
      },
    };
  }

  // 4. Acquire concurrency slot
  if (!tracker.acquire()) {
    return {
      status: "denied",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutSummary: "",
      stderrSummary:
        "Concurrency limit reached. Try again when current jobs complete.",
      artifactHandle: null,
      truncation: {
        stdoutTruncated: false,
        stderrTruncated: false,
        totalStdoutBytes: 0,
        totalStderrBytes: 0,
      },
      policyDecision: {
        auditHash: policyDecision.auditHash,
        deniedReasons: ["Concurrency limit reached"],
      },
    };
  }

  let tempCodeDir: string | undefined;

  try {
    // 5. Resolve CWD
    const cwd = await resolveAndValidateCwd(repo.rootPath, request.relativeCwd);

    // 6. Handle code mode — write to temp file
    let codePath: string | undefined;
    if (request.code) {
      tempCodeDir = await mkdtemp(join(tmpdir(), "sdl-runtime-code-"));
      const ext = getRuntimeExtension(request.runtime) ?? ".txt";
      codePath = join(tempCodeDir, `code${ext}`);
      await writeFile(codePath, request.code, { encoding: "utf-8", mode: 0o600 });
    }

    // 7. Build command
    let cmd = runtimeDescriptor.buildCommand(request.args, {
      codePath,
      executable,
    });

    // 8. Build env
    const requiredKeys = getRuntimeRequiredEnvKeys(request.runtime);
    const env = buildScrubbedEnv(runtimeConfig.envAllowlist, requiredKeys);

    // 8b. Compile-then-execute orchestration
    const COMPILE_MIN_EXEC_BUDGET_MS = 1000;
    let effectiveTimeoutMs = timeoutMs;

    if (isCompileThenExecute(request.runtime) && codePath) {
      const compileStart = Date.now();
      const compileResult = await execute({
        repoId: request.repoId,
        runtime: request.runtime,
        executable: cmd.executable,
        args: cmd.args,
        cwd,
        env,
        timeoutMs: effectiveTimeoutMs,
        maxStdoutBytes: runtimeConfig.maxStdoutBytes,
        maxStderrBytes: runtimeConfig.maxStderrBytes,
        signal: context?.signal,
      });

      if (compileResult.exitCode !== 0 || compileResult.status !== "success") {
        // Compile failed — return compiler output immediately
        const compileStdout = compileResult.stdout.toString("utf-8");
        const compileStderr = compileResult.stderr.toString("utf-8");
        const { stdoutSummary, stderrSummary, excerpts } = generateExcerpts(
          compileStdout,
          compileStderr,
          request.maxResponseLines,
          request.queryTerms,
        );
        logRuntimeExecution({
          repoId: request.repoId,
          runtime: request.runtime,
          executable: cmd.executable,
          exitCode: compileResult.exitCode,
          durationMs: compileResult.durationMs,
          stdoutBytes: compileResult.totalStdoutBytes,
          stderrBytes: compileResult.totalStderrBytes,
          timedOut: compileResult.status === "timeout",
          policyDecision: policyDecision.decision,
          auditHash: policyDecision.auditHash,
          artifactHandle: null,
        });
        return {
          status: compileResult.status,
          exitCode: compileResult.exitCode,
          signal: compileResult.signal,
          durationMs: compileResult.durationMs,
          stdoutSummary,
          stderrSummary,
          artifactHandle: null,
          excerpts: excerpts.length > 0 ? excerpts : undefined,
          truncation: {
            stdoutTruncated: compileResult.stdoutTruncated,
            stderrTruncated: compileResult.stderrTruncated,
            totalStdoutBytes: compileResult.totalStdoutBytes,
            totalStderrBytes: compileResult.totalStderrBytes,
          },
          policyDecision: {
            auditHash: policyDecision.auditHash,
          },
        };
      }

      const compileDurationMs = Date.now() - compileStart;
      const remainingMs = effectiveTimeoutMs - compileDurationMs;
      if (remainingMs < COMPILE_MIN_EXEC_BUDGET_MS) {
        // Not enough time left to execute
        return {
          status: "timeout",
          exitCode: null,
          signal: null,
          durationMs: compileDurationMs,
          stdoutSummary: "",
          stderrSummary: "Compile succeeded but execution budget exhausted.",
          artifactHandle: null,
          truncation: {
            stdoutTruncated: false,
            stderrTruncated: false,
            totalStdoutBytes: 0,
            totalStderrBytes: 0,
          },
          policyDecision: {
            auditHash: policyDecision.auditHash,
          },
        };
      }

      // Derive output binary path and replace cmd/codePath for execution phase
      const outBinary = codePath.replace(/\.[^.]+$/, "") + (process.platform === "win32" ? ".exe" : "");
      cmd = { executable: outBinary, args: request.args };
      codePath = undefined;
      effectiveTimeoutMs = remainingMs;
    }

    // 9. Execute
    const result = await execute({
      repoId: request.repoId,
      runtime: request.runtime,
      executable: cmd.executable,
      args: cmd.args,
      cwd,
      env,
      timeoutMs: effectiveTimeoutMs,
      maxStdoutBytes: runtimeConfig.maxStdoutBytes,
      maxStderrBytes: runtimeConfig.maxStderrBytes,
      signal: context?.signal,
      codePath,
    });

    // 10. Generate excerpts
    const stdoutStr = result.stdout.toString("utf-8");
    const stderrStr = result.stderr.toString("utf-8");
    const { stdoutSummary, stderrSummary, excerpts } = generateExcerpts(
      stdoutStr,
      stderrStr,
      request.maxResponseLines,
      request.queryTerms,
    );

    // 11. Persist artifact
    let artifactHandle: string | null = null;
    if (
      request.persistOutput &&
      (result.stdout.length > 0 || result.stderr.length > 0)
    ) {
      try {
        const argsHash = hashContent(JSON.stringify(request.args));
        const artifactResult = await writeArtifact({
          repoId: request.repoId,
          runtime: request.runtime,
          argsHash,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          policyAuditHash: policyDecision.auditHash,
          artifactTtlHours: runtimeConfig.artifactTtlHours,
          maxArtifactBytes: runtimeConfig.maxArtifactBytes,
          artifactBaseDir: runtimeConfig.artifactBaseDir,
          redactionConfig: appConfig.redaction,
        });
        artifactHandle = artifactResult.artifactHandle;
      } catch (err) {
        logger.error("Failed to persist runtime artifact", {
          error: String(err),
          repoId: request.repoId,
        });
        // Continue without artifact — don't fail the entire request
      }
    }

    // 12. Log telemetry
    logRuntimeExecution({
      repoId: request.repoId,
      runtime: request.runtime,
      executable: cmd.executable,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutBytes: result.totalStdoutBytes,
      stderrBytes: result.totalStderrBytes,
      timedOut: result.status === "timeout",
      policyDecision: policyDecision.decision,
      auditHash: policyDecision.auditHash,
      artifactHandle,
    });

    // 13. Return response
    // Raw equivalent = what the agent would consume watching full output
    const rawOutputTokens = Math.ceil(
      (result.totalStdoutBytes + result.totalStderrBytes) / 4,
    );
    const response = {
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdoutSummary,
      stderrSummary,
      artifactHandle,
      excerpts: excerpts.length > 0 ? excerpts : undefined,
      truncation: {
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        totalStdoutBytes: result.totalStdoutBytes,
        totalStderrBytes: result.totalStderrBytes,
      },
      policyDecision: {
        auditHash: policyDecision.auditHash,
      },
    };
    return attachRawContext(response, { rawTokens: rawOutputTokens });
  } finally {
    tracker.release();

    // Cleanup temp code directory
    if (tempCodeDir) {
      try {
        await rm(tempCodeDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn("Failed to cleanup temp code directory", {
          dir: tempCodeDir,
          error: String(err),
        });
      }
    }
  }
}
