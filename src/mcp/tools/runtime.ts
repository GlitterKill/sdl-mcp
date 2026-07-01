/**
 * MCP tool handler for sdl.runtime.execute.
 *
 * Thin adapter that wires: policy evaluation → executor → artifact persistence
 * → excerpt generation → telemetry → structured response.
 */

import { access, mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod";
import type { ToolContext } from "../../server.js";
import {
  RuntimeExecuteRequestSchema,
  type RuntimeExecuteRequest,
  type RuntimeExecuteResponse,
} from "../tools.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  DatabaseError,
  RuntimePolicyDeniedError,
  ValidationError,
} from "../../domain/errors.js";
import { loadConfig } from "../../config/loadConfig.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { decideRuntimeLegacy } from "../../policy/runtime.js";
import type { RuntimePolicyRequestContext } from "../../policy/types.js";
import {
  getRuntime,
  getRuntimeDefaultExecutable,
  getRegisteredRuntimes,
  getRuntimeExtension,
  getRuntimeRequiredEnvKeys,
  isCompileThenExecute,
  normalizeExecutableName,
} from "../../runtime/runtimes.js";
import {
  execute,
  createConcurrencyTracker,
  buildScrubbedEnv,
  resolveAndValidateCwd,
} from "../../runtime/executor.js";
import { writeArtifact } from "../../runtime/artifacts.js";
import type { OutputExcerpt, ConcurrencyTracker } from "../../runtime/types.js";
import { logRuntimeExecution, logPolicyDecision } from "../telemetry.js";
import { attachRawContext } from "../token-usage.js";
import { hashContent } from "../../util/hashing.js";
import { logger } from "../../util/logger.js";
import { getServerInfo } from "../../util/runtime-identity.js";
import {
  attachTimingDiagnostics,
  ToolPhaseTimer,
} from "../timing-diagnostics.js";
import {
  RUNTIME_MAX_KEYWORD_EXCERPTS,
  RUNTIME_KEYWORD_CONTEXT_LINES,
  RUNTIME_MAX_LINE_LENGTH,
} from "../../config/constants.js";

// ============================================================================
// Module-Level Singletons
// ============================================================================

let concurrencyTracker: ConcurrencyTracker | undefined;
let concurrencyTrackerLimit: number | undefined;

function summarizeCommand(
  executable: string,
  args: string[],
  hasCode: boolean,
  hasStdin: boolean,
): string {
  const executableName = executable.replace(/\\/g, "/").split("/").pop() || executable;
  return [
    `executable=${executableName}`,
    `argCount=${args.length}`,
    `code=${hasCode ? "yes" : "no"}`,
    `stdin=${hasStdin ? "yes" : "no"}`,
  ].join(" ");
}

function isNodeJsExecutable(executable: string): boolean {
  const name = normalizeExecutableName(executable);
  return name === "node" || name === "node.exe";
}

function buildRuntimeNextAction(
  response: RuntimeExecuteResponse,
): RuntimeExecuteResponse["nextAction"] {
  if (response.status === "timeout") {
    return {
      kind: "increaseTimeout",
      message: "Increase timeoutMs if the command is expected to run this long.",
    };
  }
  if (response.status === "denied") {
    if (response.stderrSummary.includes("Concurrency limit")) {
      return {
        kind: "retry",
        message: "Wait for current runtime jobs to finish, then retry.",
      };
    }
    return {
      kind: "inspectPolicy",
      message: "Inspect policyDecision.deniedReasons and adjust the request or policy.",
    };
  }
  if (response.status !== "success" && response.artifactHandle) {
    return {
      kind: "queryOutput",
      action: "runtime.queryOutput",
      message: "Query the failure artifact with runtime.queryOutput.",
      queryTerms: ["error", "failed", "exception"],
    };
  }
  return undefined;
}


function getOrCreateConcurrencyTracker(maxJobs: number): ConcurrencyTracker {
  // Recreate tracker if limit changed and no active slots
  if (concurrencyTracker && concurrencyTrackerLimit !== maxJobs) {
    if (concurrencyTracker.activeCount === 0) {
      concurrencyTracker = undefined;
    }
    // If slots active, log warning but continue with existing tracker
    // Config change will take effect when all slots complete
  }
  if (!concurrencyTracker) {
    concurrencyTracker = createConcurrencyTracker(maxJobs);
    concurrencyTrackerLimit = maxJobs;
  }
  return concurrencyTracker;
}

// ============================================================================
// Line Truncation
// ============================================================================

function truncateLine(line: string): string {
  if (line.length <= RUNTIME_MAX_LINE_LENGTH) return line;
  return (
    line.slice(0, RUNTIME_MAX_LINE_LENGTH) +
    `… (+${line.length - RUNTIME_MAX_LINE_LENGTH})`
  );
}

function buildStdinMetadata(
  stdin: string | undefined,
): Pick<RuntimeExecuteResponse, "stdinBytes" | "stdinSha256"> {
  if (stdin === undefined) return {};
  return {
    stdinBytes: Buffer.byteLength(stdin, "utf-8"),
    stdinSha256: hashContent(stdin),
  };
}

function hasUnbalancedQuotes(text: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const escaped =
      index > 0 && (text[index - 1] === "\\" || text[index - 1] === "`");
    if (escaped) continue;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return quote !== undefined;
}

function detectQuotingWarnings(
  request: RuntimeExecuteRequest,
): string[] | undefined {
  const commandText = [request.executable, ...request.args, request.code]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const warnings = new Set<string>();
  const hasStdin = request.stdin !== undefined;

  const nodeEvalIndex = request.args.findIndex(
    (arg) => arg === "-e" || arg === "--eval",
  );
  const nodeEvalCode =
    nodeEvalIndex >= 0 ? request.args[nodeEvalIndex + 1] : undefined;
  if (request.runtime === "node" && nodeEvalCode?.includes("\n")) {
    warnings.add(
      "Multiline node -e code is quoting-sensitive; prefer runtime.execute stdin for script input or searchEditPreview identifier/structural/operations[] targeting for edits.",
    );
  }
  if (
    request.runtime === "shell" &&
    process.platform === "win32" &&
    /;/.test(request.code ?? "")
  ) {
    warnings.add(
      "Windows cmd.exe does not treat semicolons as command separators. Use newlines or & between commands in shell runtime code.",
    );
  }
  if (/@['"]\r?\n|\r?\n['"]@/.test(commandText)) {
    warnings.add(
      "PowerShell here-string command text is quoting-sensitive; prefer runtime.execute stdin for multiline input.",
    );
  }
  if (
    /base64|atob|fromBase64|FromBase64String|certutil\s+-decode/i.test(
      commandText,
    )
  ) {
    warnings.add(
      "Base64 decode/eval command workarounds add token overhead and hide intent; prefer runtime.execute stdin or searchEditPreview identifier/structural/operations[] targeting.",
    );
  }
  if (!hasStdin && /fs\.writeFileSync|writeFileSync\s*\(/.test(commandText)) {
    warnings.add(
      "Runtime write scripts without stdin are fragile for multiline edits; prefer searchEditPreview identifier/structural/operations[] targeting or pass payloads through runtime.execute stdin.",
    );
  }
  if (hasUnbalancedQuotes(commandText)) {
    warnings.add(
      "Command text appears to contain unbalanced quotes; prefer runtime.execute stdin for multiline or quote-heavy payloads.",
    );
  }

  return warnings.size > 0 ? Array.from(warnings) : undefined;
}

function mergeRuntimeHints(
  current: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  const merged = new Set([...(current ?? []), ...(next ?? [])]);
  return merged.size > 0 ? Array.from(merged) : undefined;
}

function detectRuntimeHints(
  request: RuntimeExecuteRequest,
  outputText = "",
): string[] | undefined {
  const hints = new Set<string>();
  const code = request.code ?? "";

  if (
    request.runtime === "node" &&
    /require is not defined in ES module scope|ReferenceError:\s*require is not defined/i.test(
      outputText,
    )
  ) {
    hints.add("ESM context: use import or createRequire instead of require().");
  }

  if (
    request.runtime === "shell" &&
    process.platform === "win32" &&
    /(^|\n)\s*(export\s+\w+=|source\s+|set\s+-[a-z]+|cat\s+<<|rm\s+-|ls\s+-)/i.test(
      code,
    )
  ) {
    hints.add(
      "Windows shell runtime uses cmd.exe; use cmd syntax or a portable node/python script.",
    );
  }

  return hints.size > 0 ? Array.from(hints) : undefined;
}

// ============================================================================
// Intent-Only Excerpts (for outputMode: "intent")
// ============================================================================

function generateIntentExcerpts(
  stdout: string,
  stderr: string,
  queryTerms: string[],
  contextLines = RUNTIME_KEYWORD_CONTEXT_LINES,
): OutputExcerpt[] {
  const excerpts: OutputExcerpt[] = [];
  const lowerTerms = queryTerms.map((t) => t.toLowerCase());
  const boundedContextLines = Math.max(0, Math.min(20, contextLines));

  const searchStream = (lines: string[], source: "stdout" | "stderr") => {
    for (
      let i = 0;
      i < lines.length && excerpts.length < RUNTIME_MAX_KEYWORD_EXCERPTS;
      i++
    ) {
      const lower = lines[i].toLowerCase();
      if (lowerTerms.some((t) => lower.includes(t))) {
        const start = Math.max(0, i - boundedContextLines);
        const end = Math.min(
          lines.length - 1,
          i + boundedContextLines,
        );
        excerpts.push({
          lineStart: start + 1,
          lineEnd: end + 1,
          content: lines
            .slice(start, end + 1)
            .map(truncateLine)
            .join("\n"),
          source,
        });
        i = end; // skip ahead past context window
      }
    }
  };

  if (stdout) searchStream(stdout.split("\n"), "stdout");
  if (stderr) searchStream(stderr.split("\n"), "stderr");
  return excerpts;
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
  const halfMax = Math.floor(maxResponseLines / 2);
  const headCount = Math.min(halfMax, stdoutLines.length);
  const tailCount = Math.min(
    maxResponseLines - headCount,
    Math.max(0, stdoutLines.length - headCount),
  );

  let stdoutSummary: string;
  if (stdoutLines.length <= headCount + tailCount) {
    stdoutSummary = stdoutLines.map(truncateLine).join("\n");
  } else {
    const head = stdoutLines.slice(0, headCount).map(truncateLine);
    const tail = stdoutLines.slice(-tailCount).map(truncateLine);
    stdoutSummary = [
      ...head,
      `\n... (${stdoutLines.length - headCount - tailCount} lines omitted) ...\n`,
      ...tail,
    ].join("\n");
  }

  // Tail for stderr summary
  const stderrTailCount = Math.min(
    Math.floor(maxResponseLines / 4),
    stderrLines.length,
  );
  const stderrSummary =
    stderrLines.length <= stderrTailCount
      ? stderrLines.map(truncateLine).join("\n")
      : stderrLines.slice(-stderrTailCount).map(truncateLine).join("\n");

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
          const content = lines
            .slice(start, end + 1)
            .map(truncateLine)
            .join("\n");
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

    // Fallback: if no keyword matches found, return first lines of output
    if (excerpts.length === 0) {
      const fallbackLines = (
        lines: string[],
        source: "stdout" | "stderr",
      ): void => {
        if (lines.length === 0 || (lines.length === 1 && lines[0] === ""))
          return;
        const end = Math.min(
          lines.length - 1,
          RUNTIME_MAX_KEYWORD_EXCERPTS - 1,
        );
        excerpts.push({
          lineStart: 1,
          lineEnd: end + 1,
          content: lines
            .slice(0, end + 1)
            .map(truncateLine)
            .join("\n"),
          source,
        });
      };
      fallbackLines(stdoutLines, "stdout");
      if (excerpts.length === 0) fallbackLines(stderrLines, "stderr");
    }
  }

  return { stdoutSummary, stderrSummary, excerpts };
}

// ============================================================================
// Handler
// ============================================================================

function runtimeValidationMessage(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
  const example = '{ runtime: "shell", code: "echo ok" }';
  return `${issues}. Use code, not args. Active platform: ${process.platform}. Valid shell example for this platform: ${example}`;
}

export async function handleRuntimeExecute(
  args: unknown,
  context?: ToolContext,
): Promise<RuntimeExecuteResponse> {
  const timer = new ToolPhaseTimer();
  const parseStartedAt = timer.start();
  let request: RuntimeExecuteRequest;
  try {
    request = RuntimeExecuteRequestSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(runtimeValidationMessage(error));
    }
    throw error;
  }
  timer.record("runtime.validate", parseStartedAt);

  const stdinMetadata = buildStdinMetadata(request.stdin);
  const quotingWarnings = detectQuotingWarnings(request);
  let runtimeHints = detectRuntimeHints(request);
  const serverInfo = getServerInfo();
  const augmentResponse = <T extends RuntimeExecuteResponse>(
    response: T,
  ): T => {
    const nextAction = buildRuntimeNextAction(response);
    return {
      ...response,
      ...stdinMetadata,
      ...(quotingWarnings ? { quotingWarnings } : {}),
      ...(runtimeHints ? { runtimeHints } : {}),
      ...(serverInfo.driftWarnings.length > 0
        ? { serverDriftWarnings: serverInfo.driftWarnings }
        : {}),
      ...(nextAction ? { nextAction } : {}),
    };
  };
  const finish = <T extends RuntimeExecuteResponse>(response: T): T => {
    const augmented = augmentResponse(response);
    return request.includeDiagnostics
      ? attachTimingDiagnostics(augmented, timer.snapshot())
      : augmented;
  };

  // 1. Load config + validate repo
  const repoStartedAt = timer.start();
  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${request.repoId} not found`);
  }
  timer.record("runtime.loadRepo", repoStartedAt);

  // 2. Resolve runtime descriptor
  const runtimeResolveStartedAt = timer.start();
  const runtimeDescriptor = getRuntime(request.runtime);
  if (!runtimeDescriptor) {
    const available = getRegisteredRuntimes().join(", ");
    throw new RuntimePolicyDeniedError(
      `Unknown runtime: ${request.runtime}. Available: ${available}`,
    );
  }
  timer.record("runtime.resolveRuntime", runtimeResolveStartedAt);

  // 3. Evaluate policy
  const policyStartedAt = timer.start();
  const tracker = getOrCreateConcurrencyTracker(
    runtimeConfig.maxConcurrentJobs,
  );
  const timeoutMs = request.timeoutMs ?? runtimeConfig.maxDurationMs;
  const executable =
    request.executable ??
    getRuntimeDefaultExecutable(request.runtime) ??
    runtimeDescriptor.name;

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

  const policyDecision = decideRuntimeLegacy(
    policyContext,
    runtimeConfig,
    tracker,
  );
  timer.record("runtime.policy", policyStartedAt);

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
    return finish({
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
    });
  }

  // 4. Acquire concurrency slot
  if (!tracker.acquire()) {
    return finish({
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
    });
  }

  let tempCodeDir: string | undefined;

  try {
    // 5. Resolve CWD
    let cwd: string;
    const cwdStartedAt = timer.start();
    try {
      cwd = await resolveAndValidateCwd(repo.rootPath, request.relativeCwd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RuntimePolicyDeniedError(
          `Working directory does not exist: ${request.relativeCwd || "(repo root)"}`,
        );
      }
      throw err;
    }
    timer.record("runtime.resolveCwd", cwdStartedAt);

    // 6. Handle code mode.
    let codePath: string | undefined;
    let executionStdin = request.stdin;
    let nodeCodeFromStdin = false;
    if (request.code) {
      if (
        request.runtime === "node" &&
        request.stdin === undefined &&
        isNodeJsExecutable(executable)
      ) {
        executionStdin = request.code;
        nodeCodeFromStdin = true;
      } else {
        // ponytail: code+stdin needs child stdin for user input; use a temp
        // .mjs in %TEMP% instead of a loader shim.
        const ext =
          request.runtime === "node"
            ? ".mjs"
            : getRuntimeExtension(request.runtime) ?? ".txt";
        tempCodeDir = await mkdtemp(join(tmpdir(), "sdl-runtime-code-"));
        codePath = join(tempCodeDir, `code${ext}`);
        await writeFile(codePath, request.code, {
          encoding: "utf-8",
          mode: 0o600,
        });
      }
    }

    // 7. Build command
    let cmd = nodeCodeFromStdin
      ? { executable, args: ["--input-type=module", "-", ...request.args] }
      : runtimeDescriptor.buildCommand(request.args, {
          codePath,
          executable,
        });

    // 8. Build env
    const requiredKeys = getRuntimeRequiredEnvKeys(request.runtime);
    const env = buildScrubbedEnv(runtimeConfig.envAllowlist, requiredKeys);

    const persistRuntimeArtifact = async (
      result: Awaited<ReturnType<typeof execute>>,
      phase: "compile" | "execute",
    ): Promise<string | null> => {
      if (!request.persistOutput) {
        return null;
      }

      try {
        const artifactStartedAt = timer.start();
        // Some runtimes fail before emitting bytes; keep a searchable artifact marker.
        const stderr =
          result.stderr.length > 0 || result.status === "success"
            ? result.stderr
            : Buffer.from(
                `${phase} phase error: ${request.runtime} runtime failed without captured stdout/stderr (exitCode=${result.exitCode ?? "none"}, signal=${result.signal ?? "none"}).`,
                "utf-8",
              );

        if (result.stdout.length === 0 && stderr.length === 0) {
          return null;
        }
        const argsHash = hashContent(
          JSON.stringify({ runtime: request.runtime, args: request.args, phase }),
        );
        const artifactResult = await writeArtifact({
          repoId: request.repoId,
          runtime: request.runtime,
          phase,
          argsHash,
          relativeCwd: request.relativeCwd,
          outputMode: request.outputMode,
          serverVersion: serverInfo.version,
          commandSummary: summarizeCommand(
            cmd.executable,
            cmd.args,
            Boolean(request.code),
            request.stdin !== undefined,
          ),
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr,
          policyAuditHash: policyDecision.auditHash,
          artifactTtlHours: runtimeConfig.artifactTtlHours,
          maxArtifactBytes: runtimeConfig.maxArtifactBytes,
          artifactBaseDir: runtimeConfig.artifactBaseDir,
          redactionConfig: appConfig.redaction,
        });
        timer.record("runtime.persistArtifact", artifactStartedAt);
        return artifactResult.artifactHandle;
      } catch (err) {
        logger.error("Failed to persist runtime artifact", {
          error: String(err),
          repoId: request.repoId,
          phase,
        });
        return null;
      }
    };


    // 8b. Compile-then-execute orchestration
    const COMPILE_MIN_EXEC_BUDGET_MS = 1000;
    let effectiveTimeoutMs = timeoutMs;

    if (isCompileThenExecute(request.runtime) && codePath) {
      const compileStartedAt = timer.start();
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
      timer.record("runtime.compile", compileStartedAt);

      if (compileResult.exitCode !== 0 || compileResult.status !== "success") {
        // Compile failed — return compiler output immediately
        const compileStdout = compileResult.stdout.toString("utf-8");
        const compileStderr = compileResult.stderr.toString("utf-8");
        const compileRawTokens = Math.ceil(
          (compileResult.totalStdoutBytes + compileResult.totalStderrBytes) / 4,
        );
        const artifactHandle = await persistRuntimeArtifact(
          compileResult,
          "compile",
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
          artifactHandle,
          diagnostics: request.includeDiagnostics
            ? timer.snapshot()
            : undefined,
        });

        if (request.outputMode === "minimal") {
          return finish(
            attachRawContext(
              {
                status: compileResult.status,
                exitCode: compileResult.exitCode,
                signal: compileResult.signal,
                durationMs: compileResult.durationMs,
                stdoutSummary: "",
                stderrSummary: "",
                artifactHandle,
                truncation: {
                  stdoutTruncated: compileResult.stdoutTruncated,
                  stderrTruncated: compileResult.stderrTruncated,
                  totalStdoutBytes: compileResult.totalStdoutBytes,
                  totalStderrBytes: compileResult.totalStderrBytes,
                },
                policyDecision: {
                  auditHash: policyDecision.auditHash,
                },
              },
              { rawTokens: compileRawTokens },
            ),
          );
        }

        if (request.outputMode === "intent") {
          const excerpts: OutputExcerpt[] = [];
          if (request.queryTerms && request.queryTerms.length > 0) {
            excerpts.push(
              ...generateIntentExcerpts(
                compileStdout,
                compileStderr,
                request.queryTerms,
                request.contextLines,
              ),
            );
          }
          return finish(
            attachRawContext(
              {
                status: compileResult.status,
                exitCode: compileResult.exitCode,
                signal: compileResult.signal,
                durationMs: compileResult.durationMs,
                stdoutSummary: "",
                stderrSummary: "",
                artifactHandle,
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
              },
              { rawTokens: compileRawTokens },
            ),
          );
        }

        // "summary" mode — existing behavior
        const { stdoutSummary, stderrSummary, excerpts } = generateExcerpts(
          compileStdout,
          compileStderr,
          request.maxResponseLines,
          request.queryTerms,
        );
        return finish(
          attachRawContext(
            {
              status: compileResult.status,
              exitCode: compileResult.exitCode,
              signal: compileResult.signal,
              durationMs: compileResult.durationMs,
              stdoutSummary,
              stderrSummary,
              artifactHandle,
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
            },
            { rawTokens: compileRawTokens },
          ),
        );
      }

      const compileDurationMs = Date.now() - compileStart;
      const remainingMs = effectiveTimeoutMs - compileDurationMs;
      if (remainingMs < COMPILE_MIN_EXEC_BUDGET_MS) {
        // Not enough time left to execute
        return finish({
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
        });
      }

      // Derive output binary path and replace cmd/codePath for execution phase
      const outBinary =
        codePath.replace(/\.[^.]+$/, "") +
        (process.platform === "win32" ? ".exe" : "");
      try {
        await access(outBinary);
      } catch {
        throw new RuntimePolicyDeniedError(
          `Compile succeeded but output binary not found at expected path: ${outBinary}`,
        );
      }
      cmd = { executable: outBinary, args: request.args };
      codePath = undefined;
      effectiveTimeoutMs = remainingMs;
    }

    // 9. Execute
    const executeStartedAt = timer.start();
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
      stdin: executionStdin,
    });
    timer.record("runtime.execute", executeStartedAt);

    // 10. Convert output to strings
    const decodeStartedAt = timer.start();
    const stdoutStr = result.stdout.toString("utf-8");
    const stderrStr = result.stderr.toString("utf-8");
    runtimeHints = mergeRuntimeHints(
      runtimeHints,
      detectRuntimeHints(request, `${stderrStr}\n${stdoutStr}`),
    );
    timer.record("runtime.decodeOutput", decodeStartedAt);

    // 11. Persist artifact (all modes)
    const artifactHandle = await persistRuntimeArtifact(result, "execute");

    // 12. Compute raw token equivalent
    const rawOutputTokens = Math.ceil(
      (result.totalStdoutBytes + result.totalStderrBytes) / 4,
    );

    // 13. Branch on outputMode
    if (request.outputMode === "minimal") {
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
        diagnostics: request.includeDiagnostics ? timer.snapshot() : undefined,
      });
      return finish(
        attachRawContext(
          {
            status: result.status,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            stdoutSummary: "",
            stderrSummary: "",
            artifactHandle,
            truncation: {
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
              totalStdoutBytes: result.totalStdoutBytes,
              totalStderrBytes: result.totalStderrBytes,
            },
            policyDecision: {
              auditHash: policyDecision.auditHash,
            },
          },
          { rawTokens: rawOutputTokens },
        ),
      );
    }

    if (request.outputMode === "intent") {
      const excerpts: OutputExcerpt[] = [];
      if (request.queryTerms && request.queryTerms.length > 0) {
        excerpts.push(
          ...generateIntentExcerpts(
            stdoutStr,
            stderrStr,
            request.queryTerms,
            request.contextLines,
          ),
        );
      }
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
        diagnostics: request.includeDiagnostics ? timer.snapshot() : undefined,
      });
      const intentResponse = {
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdoutSummary: "",
        stderrSummary: "",
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
      return finish(
        attachRawContext(intentResponse, { rawTokens: rawOutputTokens }),
      );
    }

    // "summary" mode — existing behavior
    const { stdoutSummary, stderrSummary, excerpts } = generateExcerpts(
      stdoutStr,
      stderrStr,
      request.maxResponseLines,
      request.queryTerms,
    );

    // 14. Log telemetry
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
      diagnostics: request.includeDiagnostics ? timer.snapshot() : undefined,
    });

    // 15. Return response
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
    return finish(attachRawContext(response, { rawTokens: rawOutputTokens }));
  } finally {
    tracker.release();

    // Cleanup temp code directory.
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
