import type { OutputExcerpt } from "../../../runtime/types.js";
import { boundResponseTextUtf8 } from "../../../runtime/response-artifacts.js";
import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

const NODE_TEST_DURATION_LINE =
  /^(\s*(?:[✔✖×] .+|(?:ok|not ok) \d+ - .+?))\s+\(\d+(?:\.\d+)?ms\)(\r?)$/;
export const RUNTIME_INLINE_OUTPUT_BYTES = 4 * 1024;
export const FILE_READ_PREVIEW_OUTPUT_BYTES = 1024;
const RUNTIME_PREVIEW_OUTPUT_BYTES = 1024;
export const RUNTIME_DIAGNOSTIC_FIELDS_BY_PROFILE = Object.freeze({
  "runtime.execute": Object.freeze(["durationMs"] as const),
});

export interface RuntimeObservability {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly totalStdoutBytes: number;
  readonly totalStderrBytes: number;
  readonly digest?: unknown;
  readonly durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/** Extract stable runtime metrics before model-facing fields are removed. */
export function extractRuntimeObservability(
  value: unknown,
): RuntimeObservability | undefined {
  if (!isRecord(value) || !isRecord(value.truncation)) return undefined;
  const truncation = value.truncation;
  return {
    exitCode:
      typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
        ? value.exitCode
        : null,
    signal: typeof value.signal === "string" ? value.signal : null,
    totalStdoutBytes: integer(truncation.totalStdoutBytes),
    totalStderrBytes: integer(truncation.totalStderrBytes),
    ...(value.digest !== undefined ? { digest: value.digest } : {}),
    durationMs: integer(value.durationMs),
  };
}

export function isWindowsCmdEchoLine(line: string): boolean {
  return /^[A-Za-z]:\\[^>]*>/.test(line) || /^\\\\[^>]+>/.test(line);
}

function isNodeOutput(runtime?: string, commandSummary?: string): boolean {
  return (
    runtime?.toLowerCase() === "node" ||
    /\bexecutable=node(?:\.exe)?\b/i.test(commandSummary ?? "")
  );
}

/** Sanitize bounded display excerpts without changing persisted artifact bytes. */
export function projectRuntimeOutputExcerpts(
  excerpts: readonly OutputExcerpt[],
  runtime?: string,
  commandSummary?: string,
): OutputExcerpt[] {
  const stripNodeDurations = isNodeOutput(runtime, commandSummary);
  return excerpts.flatMap((excerpt) => {
    const lines = excerpt.content.split("\n");
    let removedLeadingLines = 0;
    while (lines.length > 0) {
      let echoIndex = 0;
      while (echoIndex < lines.length && lines[echoIndex].trim().length === 0) {
        echoIndex += 1;
      }
      if (
        echoIndex >= lines.length ||
        !isWindowsCmdEchoLine(lines[echoIndex])
      ) {
        break;
      }
      lines.splice(0, echoIndex + 1);
      removedLeadingLines += echoIndex + 1;
    }
    if (
      removedLeadingLines > 0 &&
      (lines.length === 0 || lines.every((line) => line.trim().length === 0))
    ) {
      return [];
    }
    return [{
      ...excerpt,
      lineStart: excerpt.lineStart + removedLeadingLines,
      content: lines
        .map((line) =>
          stripNodeDurations
            ? line.replace(NODE_TEST_DURATION_LINE, "$1$2")
            : line,
        )
        .join("\n"),
    }];
  });
}

function asExcerpt(value: unknown): OutputExcerpt | undefined {
  if (
    !isRecord(value) ||
    typeof value.lineStart !== "number" ||
    typeof value.lineEnd !== "number" ||
    typeof value.content !== "string" ||
    (value.source !== "stdout" && value.source !== "stderr")
  ) {
    return undefined;
  }
  return {
    lineStart: value.lineStart,
    lineEnd: value.lineEnd,
    content: value.content,
    source: value.source,
  };
}

function runtimeName(input: ModelProjectionInput): string | undefined {
  const runtime = input.context.requestArgs.runtime;
  return typeof runtime === "string" ? runtime : undefined;
}

function canonicalExcerpts(
  value: Record<string, unknown>,
  input: ModelProjectionInput,
): OutputExcerpt[] {
  if (!Array.isArray(value.excerpts)) return [];
  return projectRuntimeOutputExcerpts(
    value.excerpts
      .map(asExcerpt)
      .filter((excerpt): excerpt is OutputExcerpt => excerpt !== undefined),
    runtimeName(input),
  );
}

function summary(
  value: unknown,
  source: "stdout" | "stderr",
  input: ModelProjectionInput,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return projectRuntimeOutputExcerpts(
    [{ lineStart: 1, lineEnd: value.split("\n").length, content: value, source }],
    runtimeName(input),
  )[0]?.content;
}

function selectOutput(
  value: Record<string, unknown>,
  input: ModelProjectionInput,
): Record<string, unknown> {
  const mode = input.context.requestArgs.outputMode ?? "minimal";
  if (mode === "minimal") return {};
  const excerpts = canonicalExcerpts(value, input);
  if (mode === "intent") return excerpts.length > 0 ? { excerpts } : {};
  if (mode === "digest") {
    const digest = isRecord(value.digest) ? value.digest : {};
    const selected =
      (typeof digest.excerpt === "string" && digest.excerpt.length > 0
        ? digest.excerpt
        : undefined) ??
      excerpts[0]?.content ??
      (typeof digest.summary === "string" && digest.summary.length > 0
        ? digest.summary
        : undefined);
    return selected ? { excerpts: [selected] } : {};
  }
  const stdoutSummary = summary(value.stdoutSummary, "stdout", input);
  const stderrSummary = summary(value.stderrSummary, "stderr", input);
  if (stdoutSummary || stderrSummary) {
    return {
      ...(stdoutSummary ? { stdoutSummary } : {}),
      ...(stderrSummary ? { stderrSummary } : {}),
    };
  }
  return excerpts.length > 0 ? { excerpts } : {};
}

function boundedPreview(selected: Record<string, unknown>): Record<string, unknown> {
  let remaining = RUNTIME_PREVIEW_OUTPUT_BYTES;
  const preview: Record<string, unknown> = {};
  for (const key of ["stdoutSummary", "stderrSummary"] as const) {
    const value = selected[key];
    if (typeof value !== "string" || remaining <= 0) continue;
    const bounded = boundResponseTextUtf8(value, remaining);
    if (bounded.length === 0) continue;
    preview[key] = bounded;
    remaining -= Buffer.byteLength(bounded, "utf8");
  }
  if (Array.isArray(selected.excerpts) && remaining > 0) {
    const first = selected.excerpts[0];
    const excerpt = asExcerpt(first);
    const content = typeof first === "string" ? first : excerpt?.content;
    if (content) {
      const bounded = boundResponseTextUtf8(content, remaining);
      if (bounded.length > 0) {
        preview.excerpts = excerpt
          ? [{ ...excerpt, content: bounded }]
          : [bounded];
      }
    }
  }
  return preview;
}

function streamFor(
  observability: RuntimeObservability | undefined,
): "stdout" | "stderr" | "both" {
  if (!observability) return "both";
  if (observability.totalStdoutBytes > 0 && observability.totalStderrBytes === 0) {
    return "stdout";
  }
  if (observability.totalStderrBytes > 0 && observability.totalStdoutBytes === 0) {
    return "stderr";
  }
  return "both";
}

function recovery(
  input: ModelProjectionInput,
  artifactHandle: string,
  observability: RuntimeObservability | undefined,
  cursor?: { stream: "stdout" | "stderr"; afterLine: number },
): { action: "runtime.queryOutput"; args: Record<string, unknown> } | undefined {
  const repoId = input.context.requestArgs.repoId;
  if (typeof repoId !== "string" || repoId.length === 0) return undefined;
  const queryTerms = Array.isArray(input.context.requestArgs.queryTerms)
    ? input.context.requestArgs.queryTerms.filter(
        (term): term is string => typeof term === "string" && term.length > 0,
      )
    : [];
  const queryOutput = input.action === "runtime.queryOutput"
    || input.action === "sdl.runtime.queryOutput";
  return {
    action: "runtime.queryOutput",
    args: {
      repoId,
      artifactHandle,
      view: "model",
      queryTerms: queryOutput ? queryTerms : [],
      cursor: cursor ?? {
        stream:
          observability?.totalStderrBytes ? "stderr" : "stdout",
        afterLine: 0,
      },
      stream: cursor?.stream ?? streamFor(observability),
      maxExcerpts: 10,
      contextLines:
        typeof input.context.requestArgs.contextLines === "number"
          ? input.context.requestArgs.contextLines
          : 3,
    },
  };
}

function projectRuntimeExecute(input: ModelProjectionInput): unknown {
  if (!isRecord(input.canonicalResult)) return input.canonicalResult;
  const value = input.canonicalResult;
  const observability = extractRuntimeObservability(value);
  if (!observability) return value;
  const status = typeof value.status === "string" ? value.status : "failure";
  const selected = selectOutput(value, input);
  const preview = boundedPreview(selected);
  const hasPreview = Object.keys(preview).length > 0;
  const truncation = isRecord(value.truncation) ? value.truncation : {};
  const stdoutTruncated = truncation.stdoutTruncated === true;
  const stderrTruncated = truncation.stderrTruncated === true;
  const captureTruncated = stdoutTruncated || stderrTruncated;
  const largeOutput =
    observability.totalStdoutBytes + observability.totalStderrBytes >
    RUNTIME_INLINE_OUTPUT_BYTES;
  const artifactHandle =
    typeof value.artifactHandle === "string" && value.artifactHandle.length > 0
      ? value.artifactHandle
      : undefined;

  if (captureTruncated) {
    return {
      status,
      ...(hasPreview ? { preview } : {}),
      incompleteCapture: {
        stdoutTruncated,
        stderrTruncated,
        recoverable: false,
      },
      handlingError: {
        code: "RUNTIME_OUTPUT_CAPTURE_INCOMPLETE",
        message:
          "Runtime output exceeded capture limits; discarded bytes are not recoverable.",
        retryable: false,
      },
    };
  }

  if (largeOutput && artifactHandle) {
    const nextAction = recovery(input, artifactHandle, observability);
    return {
      status,
      preview: hasPreview
        ? preview
        : { message: "Captured output is available through runtime.queryOutput." },
      artifactHandle,
      ...(nextAction ? { nextAction } : {}),
    };
  }

  if (largeOutput) {
    return {
      status,
      ...(hasPreview ? { preview } : {}),
      handlingError: {
        code: "RUNTIME_OUTPUT_RECOVERY_UNAVAILABLE",
        message:
          "Captured runtime output exceeded the inline limit but could not be persisted within the configured artifact limits.",
        retryable: false,
      },
    };
  }

  const projected: Record<string, unknown> = { status, ...selected };
  const capturedOutputHidden =
    Object.keys(selected).length === 0 &&
    observability.totalStdoutBytes + observability.totalStderrBytes > 0;
  if (capturedOutputHidden && artifactHandle) {
    const nextAction = recovery(input, artifactHandle, observability);
    projected.artifactHandle = artifactHandle;
    if (nextAction) projected.nextAction = nextAction;
  }
  const allowed =
    RUNTIME_DIAGNOSTIC_FIELDS_BY_PROFILE[
      input.action as keyof typeof RUNTIME_DIAGNOSTIC_FIELDS_BY_PROFILE
    ];
  if (input.options.includeDiagnostics && allowed?.includes("durationMs")) {
    projected.durationMs = observability.durationMs;
  }
  return projected;
}

/** Project runtime responses while leaving compatibility actions intact. */
export function projectFileReadValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const value = projectCompatibilityValue(input);
  if (!isRecord(value) || !isRecord(value.preview)) return value;

  const preview = value.preview;
  if (typeof preview.content !== "string") return value;

  const content = boundResponseTextUtf8(
    preview.content,
    FILE_READ_PREVIEW_OUTPUT_BYTES,
  );
  const bytes = Buffer.byteLength(content, "utf-8");
  const truncated =
    preview.truncated === true ||
    bytes < Buffer.byteLength(preview.content, "utf-8");
  const projectedPreview: Record<string, unknown> = {
    ...preview,
    content,
    bytes,
    returnedLines: content.split(/\r?\n/).length,
    truncated,
  };
  if (truncated) projectedPreview.truncatedAt = bytes;
  else delete projectedPreview.truncatedAt;

  return {
    ...value,
    preview: projectedPreview,
  };
}

function projectRuntimeQueryOutput(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const projected = projectCompatibilityValue(input);
  if (!isRecord(projected) || !isRecord(input.canonicalResult)) {
    return projected;
  }
  const compact = {
    artifactHandle: projected.artifactHandle,
    excerpts: projected.excerpts,
    matchStatus: projected.matchStatus,
    ...(isRecord(input.canonicalResult.nextAction)
      ? { nextAction: input.canonicalResult.nextAction }
      : {}),
  };

  const cursor = input.canonicalResult.nextCursor;
  const artifactHandle = input.canonicalResult.artifactHandle;
  if (
    !isRecord(cursor)
    || (cursor.stream !== "stdout" && cursor.stream !== "stderr")
    || typeof cursor.afterLine !== "number"
    || !Number.isInteger(cursor.afterLine)
    || cursor.afterLine < 0
    || typeof artifactHandle !== "string"
    || artifactHandle.length === 0
  ) {
    return compact;
  }

  const nextAction = recovery(
    input,
    artifactHandle,
    extractRuntimeObservability(input.canonicalResult),
    { stream: cursor.stream, afterLine: cursor.afterLine },
  );
  return nextAction ? { ...compact, nextAction } : compact;
}

export function projectRuntimeValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  if (
    isRecord(input.canonicalResult)
    && isRecord(input.canonicalResult.error)
  ) {
    return projectCompatibilityValue(input);
  }
  if (
    input.action === "runtime.execute"
    || input.action === "sdl.runtime.execute"
  ) {
    return projectRuntimeExecute(input);
  }
  if (
    input.action === "runtime.queryOutput"
    || input.action === "sdl.runtime.queryOutput"
  ) {
    return projectRuntimeQueryOutput(input, projectCompatibilityValue);
  }
  if (input.action === "file.read" || input.action === "sdl.file.read") {
    return projectFileReadValue(input, projectCompatibilityValue);
  }
  return projectCompatibilityValue(input);
}
