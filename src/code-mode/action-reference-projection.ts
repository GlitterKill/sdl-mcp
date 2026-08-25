import {
  resolveRecoveryActionDefinition,
  resolveRecoveryWorkflowFunction,
} from "./action-catalog.js";
import { RetrieveRequestSchema } from "./retrieve-schema.js";
import {
  buildValidatedRecoveryAction,
  _recoveryValidationTesting,
  isPolicyNextBestAction,
  RECOVERY_DEFAULT_MAX_BYTES,
} from "../mcp/response-projection/recovery.js";
import {
  EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
} from "../mcp/response-projection/registry.js";
import type {
  RecoveryActionCall,
  RecoveryContinuationContext,
} from "../mcp/response-projection/types.js";

export {
  buildValidatedRecoveryAction,
  _recoveryValidationTesting,
};

type GatewayReference =
  | { tool: "sdl.retrieve"; op: string }
  | { tool: "sdl.workflow"; fn: string };

type ResponseContinuationProjectionOptions = Readonly<{
  detail?: "standard" | "full";
  includeDiagnostics?: true;
}>;

const EXCLUSIVE_GATEWAY_REFERENCES: Readonly<Record<string, GatewayReference>> =
  Object.freeze({
    "sdl.symbol.search": { tool: "sdl.retrieve", op: "symbolSearch" },
    "sdl.symbol.getCard": { tool: "sdl.retrieve", op: "symbolGetCard" },
    "sdl.code.getSkeleton": { tool: "sdl.retrieve", op: "codeSkeleton" },
    "sdl.code.getHotPath": { tool: "sdl.retrieve", op: "codeHotPath" },
    "sdl.code.needWindow": { tool: "sdl.retrieve", op: "codeNeedWindow" },
    "sdl.response.get": { tool: "sdl.retrieve", op: "responseGet" },
    "sdl.policy.set": { tool: "sdl.workflow", fn: "policySet" },
  });

const EXCLUSIVE_RECOVERY_TOOL_SET = new Set<string>(
  EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
);

const RECOVERY_TEXT_FIELDS = ["fallbackRationale", "downgradeGuidance"] as const;
const RECOVERY_TEXT_ARRAY_FIELDS = ["whyDenied", "warnings"] as const;
const MAX_RECOVERY_PROJECTION_RECORDS = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return Object.hasOwn(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function copyRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value).map((key) => [key, value[key]]));
}

function canonicalRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function rewriteRecoveryText(text: string): string {
  let rewritten = text;
  for (const [flatTool, gateway] of Object.entries(
    EXCLUSIVE_GATEWAY_REFERENCES,
  )) {
    const replacement =
      gateway.tool === "sdl.retrieve"
        ? `sdl.retrieve op:"${gateway.op}"`
        : `sdl.workflow step fn:"${gateway.fn}"`;
    rewritten = rewritten.replaceAll(flatTool, replacement);
  }
  return rewritten;
}

function candidateArgs(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const args =
    Object.hasOwn(value, "args") && isRecord(value.args)
      ? copyRecord(value.args)
      : {};
  for (const [key, candidateValue] of Object.entries(value)) {
    if (
      key === "action" ||
      key === "tool" ||
      key === "id" ||
      key === "args" ||
      key === "kind" ||
      key === "message" ||
      key === "rationale" ||
      key === "description" ||
      Object.hasOwn(args, key)
    ) {
      continue;
    }
    defineOwn(args, key, candidateValue);
  }
  return args;
}

function continuationForCandidate(
  value: unknown,
  materializeResponseBound: boolean,
): RecoveryContinuationContext | undefined {
  if (!isRecord(value)) return undefined;
  const actionName =
    ownString(value, "action") ??
    ownString(value, "tool") ??
    ownString(value, "id");
  if (!actionName) return undefined;

  const definition = resolveRecoveryActionDefinition(actionName);
  if (!definition || definition.action !== "response.get") {
    return undefined;
  }
  const args = candidateArgs(value);
  return {
    ...(typeof args.handle === "string" ? { handle: args.handle } : {}),
    ...(typeof args.maxBytes === "number"
      ? { maxBytes: args.maxBytes }
      : materializeResponseBound
        ? { maxBytes: RECOVERY_DEFAULT_MAX_BYTES }
        : {}),
  };
}

function failedCallFromTrace(
  value: Readonly<Record<string, unknown>>,
  fallbackRepoId: string | undefined,
  inherited: RecoveryActionCall | undefined,
): RecoveryActionCall | undefined {
  const failureLike =
    value.status === "error" ||
    value.status === "failure" ||
    (typeof value.message === "string" &&
      (value.kind === "gateway" || value.kind === "internal"));
  const action = ownString(value, "action");
  if (!failureLike || !action) {
    return inherited;
  }

  const traceArgs =
    Object.hasOwn(value, "_resolvedArgs") && isRecord(value._resolvedArgs)
      ? value._resolvedArgs
      : Object.hasOwn(value, "resolvedArgs") && isRecord(value.resolvedArgs)
        ? value.resolvedArgs
        : Object.hasOwn(value, "args") && isRecord(value.args)
          ? value.args
          : {};
  return {
    action,
    args: {
      ...(fallbackRepoId ? { repoId: fallbackRepoId } : {}),
      ...traceArgs,
    },
  };
}

function projectNextAction(
  value: unknown,
  fallbackRepoId: string | undefined,
  failedCall: RecoveryActionCall | undefined,
  responseContinuationOptions: ResponseContinuationProjectionOptions,
  materializeResponseBound = false,
): unknown | undefined {
  if (!isRecord(value)) return undefined;

  const referenceKey =
    ownString(value, "tool") !== undefined
      ? "tool"
      : ownString(value, "action") !== undefined
        ? "action"
        : ownString(value, "id") !== undefined
          ? "id"
          : undefined;
  if (!referenceKey) return undefined;

  const continuation = continuationForCandidate(
    value,
    materializeResponseBound,
  );
  const validated = buildValidatedRecoveryAction(value, {
    ...(fallbackRepoId ? { repoId: fallbackRepoId } : {}),
    advertisedTools: EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
    ...(failedCall ? { failedCall } : {}),
    ...(continuation ? { continuation } : {}),
  });
  if (validated.validatedAction?.action === "response.get") {
    const validatedArgs = validated.validatedAction.args;
    const repoId =
      fallbackRepoId
      ?? (typeof validatedArgs.repoId === "string"
        ? validatedArgs.repoId
        : undefined);
    if (!repoId) return undefined;

    const childArgs = copyRecord(validatedArgs);
    const responseMode =
      ownString(childArgs, "responseMode")
      ?? ownString(candidateArgs(value), "responseMode");
    delete childArgs.repoId;
    delete childArgs.detail;
    delete childArgs.includeDiagnostics;
    delete childArgs.responseMode;
    const parsedEnvelope = RetrieveRequestSchema.safeParse({
      repoId,
      op: "responseGet",
      args: canonicalRecord(childArgs),
      ...(responseMode === "inline"
      || responseMode === "auto"
      || responseMode === "handle"
        ? { responseMode }
        : {}),
    });
    if (!parsedEnvelope.success) return undefined;

    const projectedChildArgs = copyRecord(parsedEnvelope.data.args);
    for (const [key, defaultValue] of [
      ["detail", "compact"],
      ["full", false],
      ["includeDiagnostics", false],
      ["offsetBytes", 0],
      ["raw", false],
      ["view", "model"],
    ] as const) {
      if (projectedChildArgs[key] === defaultValue) {
        delete projectedChildArgs[key];
      }
    }
    const projectedEnvelope = copyRecord(parsedEnvelope.data);
    defineOwn(projectedEnvelope, "args", canonicalRecord(projectedChildArgs));
    const canonicalEnvelope = canonicalRecord(projectedEnvelope);
    if (responseContinuationOptions.detail !== undefined) {
      defineOwn(
        canonicalEnvelope,
        "detail",
        responseContinuationOptions.detail,
      );
    }
    if (responseContinuationOptions.includeDiagnostics === true) {
      defineOwn(canonicalEnvelope, "includeDiagnostics", true);
    }

    const projected = copyRecord(value);
    defineOwn(projected, referenceKey, "sdl.retrieve");
    defineOwn(projected, "args", canonicalEnvelope);
    return canonicalRecord(projected);
  }
  if (!validated.nextAction) return undefined;

  const projected = copyRecord(value);
  defineOwn(projected, referenceKey, validated.nextAction.action);
  defineOwn(projected, "args", validated.nextAction.args);
  return canonicalRecord(projected);
}

function projectFallbackTool(tool: unknown): unknown {
  if (typeof tool !== "string") return tool;
  const publicName = tool.startsWith("sdl.") ? tool : `sdl.${tool}`;
  if (EXCLUSIVE_RECOVERY_TOOL_SET.has(publicName)) {
    return publicName;
  }
  if (Object.hasOwn(EXCLUSIVE_GATEWAY_REFERENCES, publicName)) {
    return EXCLUSIVE_GATEWAY_REFERENCES[publicName].tool;
  }
  return resolveRecoveryWorkflowFunction(tool) ? "sdl.workflow" : tool;
}

function projectRecoveryValue<T>(
  value: T,
  fallbackRepoId: string | undefined,
  inheritedFailedCall: RecoveryActionCall | undefined,
  responseContinuationOptions: ResponseContinuationProjectionOptions,
): T {
  if (!isRecord(value)) return value;

  const projectedBySource = new WeakMap<
    Readonly<Record<string, unknown>>,
    Record<string, unknown>
  >();
  const pendingFrames: Array<{
    projected: Record<string, unknown>;
    inheritedFailedCall: RecoveryActionCall | undefined;
  }> = [];

  // Materialize each reachable record once so deep envelopes and cycles never
  // consume the JavaScript call stack. Error objects stay identity-preserving.
  const enqueueProjection = (
    candidate: unknown,
    failedCall: RecoveryActionCall | undefined,
  ): unknown => {
    if (!isRecord(candidate)) return candidate;

    const existing = projectedBySource.get(candidate);
    if (existing) return existing;
    // Omit excess branches instead of doing unbounded recovery work.
    if (pendingFrames.length >= MAX_RECOVERY_PROJECTION_RECORDS) {
      return undefined;
    }

    const projected: Record<string, unknown> =
      candidate instanceof Error ? candidate : copyRecord(candidate);
    projectedBySource.set(candidate, projected);
    pendingFrames.push({
      projected,
      inheritedFailedCall: failedCall,
    });
    return projected;
  };

  const projectedRoot = enqueueProjection(
    value,
    inheritedFailedCall,
  ) as Record<string, unknown>;

  for (
    let nextFrame = 0;
    nextFrame < pendingFrames.length;
    nextFrame += 1
  ) {
    const frame = pendingFrames[nextFrame];
    if (!frame) continue;
    const projected = frame.projected;
    const failedCall = failedCallFromTrace(
      projected,
      fallbackRepoId,
      frame.inheritedFailedCall,
    );

    if (
      Object.hasOwn(projected, "message") &&
      typeof projected.message === "string"
    ) {
      projected.message = rewriteRecoveryText(projected.message);
    }
    for (const field of RECOVERY_TEXT_FIELDS) {
      if (
        Object.hasOwn(projected, field) &&
        typeof projected[field] === "string"
      ) {
        projected[field] = rewriteRecoveryText(projected[field]);
      }
    }
    for (const field of RECOVERY_TEXT_ARRAY_FIELDS) {
      if (
        Object.hasOwn(projected, field) &&
        Array.isArray(projected[field])
      ) {
        projected[field] = projected[field].map((item) =>
          typeof item === "string" ? rewriteRecoveryText(item) : item,
        );
      }
    }

    if (
      Object.hasOwn(projected, "fallbackTools") &&
      Array.isArray(projected.fallbackTools)
    ) {
      projected.fallbackTools = [
        ...new Set(projected.fallbackTools.map(projectFallbackTool)),
      ];
    }

    if (
      Object.hasOwn(projected, "nextAction") &&
      projected.nextAction !== undefined
    ) {
      const nextAction = projectNextAction(
        projected.nextAction,
        fallbackRepoId,
        failedCall,
        responseContinuationOptions,
      );
      if (nextAction === undefined) {
        delete projected.nextAction;
      } else {
        projected.nextAction = nextAction;
      }
    }

    if (
      Object.hasOwn(projected, "nextBestAction") &&
      projected.nextBestAction !== undefined &&
      !isPolicyNextBestAction(projected.nextBestAction)
    ) {
      const nextBestAction = projectNextAction(
        projected.nextBestAction,
        fallbackRepoId,
        failedCall,
        responseContinuationOptions,
      );
      if (nextBestAction === undefined) {
        delete projected.nextBestAction;
      } else {
        projected.nextBestAction = nextBestAction;
      }
    }

    if (
      Object.hasOwn(projected, "nextCalls") &&
      Array.isArray(projected.nextCalls)
    ) {
      const nextCalls = projected.nextCalls
        .map((nextCall) =>
          projectNextAction(
            nextCall,
            fallbackRepoId,
            failedCall,
            responseContinuationOptions,
            true,
          ),
        )
        .filter((nextCall) => nextCall !== undefined);
      if (nextCalls.length === 0) {
        delete projected.nextCalls;
      } else {
        projected.nextCalls = nextCalls;
      }
    }

    if (
      Object.hasOwn(projected, "results") &&
      Array.isArray(projected.results)
    ) {
      projected.results = projected.results.map((result) =>
        enqueueProjection(result, failedCall),
      );
    }
    for (const field of ["result", "failureTrace"] as const) {
      if (Object.hasOwn(projected, field) && projected[field] !== undefined) {
        projected[field] = enqueueProjection(projected[field], failedCall);
      }
    }
    if (
      Object.hasOwn(projected, "details") &&
      isRecord(projected.details)
    ) {
      projected.details = enqueueProjection(projected.details, failedCall);
    }
    if (
      Object.hasOwn(projected, "data") &&
      Array.isArray(projected.data)
    ) {
      projected.data = projected.data.map((item) =>
        enqueueProjection(item, failedCall),
      );
    } else if (
      Object.hasOwn(projected, "data") &&
      isRecord(projected.data)
    ) {
      projected.data = enqueueProjection(projected.data, failedCall);
    }
    if (
      Object.hasOwn(projected, "error") &&
      typeof projected.error === "string"
    ) {
      projected.error = rewriteRecoveryText(projected.error);
    } else if (
      Object.hasOwn(projected, "error") &&
      projected.error !== undefined
    ) {
      projected.error = enqueueProjection(projected.error, failedCall);
    }
  }

  return projectedRoot as T;
}

/**
 * Validate and rewrite recovery fields for the exclusive Code Mode surface.
 * Invalid recovery fields are omitted without changing the surrounding result.
 */
export function projectExclusiveCodeModeRecovery<T>(
  value: T,
  fallbackRepoId?: string,
  responseContinuationOptions: ResponseContinuationProjectionOptions = {},
): T {
  return projectRecoveryValue(
    value,
    fallbackRepoId,
    undefined,
    responseContinuationOptions,
  );
}

/** Apply exclusive-surface projection to both successful results and typed errors. */
export async function withExclusiveCodeModeRecoveryProjection<T>(
  exclusive: boolean,
  call: () => Promise<T>,
  request?: unknown,
): Promise<T> {
  const repoId =
    isRecord(request) ? ownString(request, "repoId") : undefined;
  const deferSuccessfulResponseGet =
    isRecord(request) && ownString(request, "op") === "responseGet";
  try {
    const result = await call();
    return exclusive && !deferSuccessfulResponseGet
      ? projectExclusiveCodeModeRecovery(result, repoId)
      : result;
  } catch (error) {
    if (exclusive) projectExclusiveCodeModeRecovery(error, repoId);
    throw error;
  }
}
