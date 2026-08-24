import type { NextBestAction } from "../../domain/types.js";
import {
  type RecoveryActionDefinition,
  resolveRecoveryActionDefinition,
  resolveRecoveryWorkflowFunction,
} from "../../code-mode/recovery-action-catalog.js";
import { logger } from "../../util/logger.js";
import type {
  RecoveryActionCall,
  RecoveryBuildResult,
  RecoveryValidationContext,
  RecoveryValidationMetrics,
} from "./types.js";

const MAX_RECOVERY_BYTES = 32 * 1024;
const MAX_RECOVERY_DEPTH = 256;
const MAX_RECOVERY_NODES = 10_000;
export const RECOVERY_DEFAULT_MAX_BYTES = 8192;
const RECOVERY_METADATA_FIELDS = new Set([
  "action",
  "tool",
  "id",
  "args",
  "kind",
  "message",
  "rationale",
  "description",
]);
const PRESENTATION_ONLY_FIELDS = new Set([
  "detail",
  "includeDiagnostics",
  "includeTelemetry",
]);
const POLICY_NEXT_BEST_ACTIONS = new Set<NextBestAction>([
  "requestSkeleton",
  "requestHotPath",
  "requestRaw",
  "refreshSlice",
  "buildSlice",
  "provideIdentifiersToFind",
  "provideErrorCodeRefs",
  "provideFrontierJustification",
  "increaseBudget",
  "narrowScope",
  "retryWithSameInputs",
]);
const AMBIENT_REFERENCE_PATTERN = /\$\d+/;

let invalidRecoveryCount = 0;
let strictValidationForTests = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoveryStructureProblem(root: unknown): string | undefined {
  const visiting = new WeakSet<object>();
  const stack: Array<{ value: unknown; exiting: boolean; depth: number }> = [
    { value: root, exiting: false, depth: 0 },
  ];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const value = frame.value;
    if (!Array.isArray(value) && !isRecord(value)) {
      continue;
    }
    if (frame.exiting) {
      visiting.delete(value);
      continue;
    }
    if (frame.depth > MAX_RECOVERY_DEPTH) {
      return "exceeds the maximum nesting depth";
    }
    if (visiting.has(value)) {
      return "contains a cyclic reference";
    }

    visitedNodes += 1;
    if (visitedNodes > MAX_RECOVERY_NODES) {
      return "exceeds the maximum structural complexity";
    }

    visiting.add(value);
    stack.push({ value, exiting: true, depth: frame.depth });
    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: children[index],
        exiting: false,
        depth: frame.depth + 1,
      });
    }
  }

  return undefined;
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return Object.hasOwn(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;
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

export function isPolicyNextBestAction(
  value: unknown,
): value is NextBestAction {
  return (
    typeof value === "string" &&
    POLICY_NEXT_BEST_ACTIONS.has(value as NextBestAction)
  );
}

type StableContainer = unknown[] | Record<string, unknown>;

function isStableContainer(value: unknown): value is StableContainer {
  return Array.isArray(value) || isRecord(value);
}

function createStableContainer(value: StableContainer): StableContainer {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

function stableContainerKeys(value: StableContainer): string[] {
  if (!Array.isArray(value)) return Object.keys(value).sort();

  const keys: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index in value) keys.push(String(index));
  }
  return keys;
}

function stableValue(value: unknown): unknown {
  if (!isStableContainer(value)) return value;

  const stableRoot = createStableContainer(value);
  const stack: Array<{
    source: StableContainer;
    target: StableContainer;
    keys: string[];
    nextKey: number;
  }> = [
    {
      source: value,
      target: stableRoot,
      keys: stableContainerKeys(value),
      nextKey: 0,
    },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame) break;
    if (frame.nextKey >= frame.keys.length) {
      stack.pop();
      continue;
    }

    const key = frame.keys[frame.nextKey];
    frame.nextKey += 1;
    if (key === undefined) continue;

    const child = Array.isArray(frame.source)
      ? frame.source[Number(key)]
      : frame.source[key];
    const stableChild = isStableContainer(child)
      ? createStableContainer(child)
      : child;

    if (Array.isArray(frame.target)) {
      frame.target[Number(key)] = stableChild;
    } else {
      defineOwn(frame.target, key, stableChild);
    }

    if (isStableContainer(child) && isStableContainer(stableChild)) {
      stack.push({
        source: child,
        target: stableChild,
        keys: stableContainerKeys(child),
        nextKey: 0,
      });
    }
  }

  return stableRoot;
}

function stableRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return stableValue(value) as Record<string, unknown>;
}

function containsAmbientReference(value: unknown): boolean {
  if (typeof value === "string") {
    return AMBIENT_REFERENCE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsAmbientReference);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some(containsAmbientReference);
}

function extractCandidate(
  candidate: unknown,
): { action: string; args: Record<string, unknown> } | undefined {
  if (!isRecord(candidate)) return undefined;

  const action =
    ownString(candidate, "action") ??
    ownString(candidate, "tool") ??
    ownString(candidate, "id");
  if (!action) return undefined;

  const args: Record<string, unknown> =
    Object.hasOwn(candidate, "args") && isRecord(candidate.args)
      ? stableRecord(candidate.args)
      : {};
  for (const [key, value] of Object.entries(candidate)) {
    if (RECOVERY_METADATA_FIELDS.has(key) || Object.hasOwn(args, key)) {
      continue;
    }
    defineOwn(args, key, stableValue(value));
  }
  return { action, args };
}

function applyAliases(
  definition: RecoveryActionDefinition,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = stableRecord(args);
  for (const [alias, canonical] of Object.entries(definition.aliases ?? {})) {
    if (
      Object.hasOwn(normalized, alias) &&
      !Object.hasOwn(normalized, canonical)
    ) {
      defineOwn(normalized, canonical, normalized[alias]);
    }
    delete normalized[alias];
  }
  return normalized;
}

function contextRepoId(context: RecoveryValidationContext): string | undefined {
  if (typeof context.repoId === "string" && context.repoId.length > 0) {
    return context.repoId;
  }
  const failedRepoId = context.failedCall?.args.repoId;
  return typeof failedRepoId === "string" && failedRepoId.length > 0
    ? failedRepoId
    : undefined;
}

function materializeArgs(
  definition: RecoveryActionDefinition,
  args: Readonly<Record<string, unknown>>,
  context: RecoveryValidationContext,
): Record<string, unknown> {
  const materialized = applyAliases(definition, args);
  const repoId = contextRepoId(context);
  if (materialized.repoId === undefined && repoId !== undefined) {
    materialized.repoId = repoId;
  }

  const continuation = context.continuation;
  if (definition.action === "response.get") {
    if (materialized.handle === undefined && continuation?.handle !== undefined) {
      materialized.handle = continuation.handle;
    }
    if (
      materialized.maxBytes === undefined &&
      continuation?.maxBytes !== undefined
    ) {
      materialized.maxBytes = continuation.maxBytes;
    }
  } else if (definition.action === "runtime.queryOutput") {
    if (
      materialized.artifactHandle === undefined &&
      continuation?.handle !== undefined
    ) {
      materialized.artifactHandle = continuation.handle;
    }
    if (materialized.view === undefined && continuation?.view !== undefined) {
      materialized.view = continuation.view;
    }
    if (materialized.cursor === undefined && continuation?.cursor !== undefined) {
      materialized.cursor = { ...continuation.cursor };
    }
  }

  return materialized;
}

function continuationProblem(
  action: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  if (action === "response.get") {
    if (typeof args.handle !== "string" || args.handle.length === 0) {
      return "response.get requires an artifact handle";
    }
    const view = args.view ?? "model";
    if (view !== "model") {
      return "response.get requires the sanitized model view";
    }
    const cursor = isRecord(args.cursor)
      ? args.cursor
      : { offsetBytes: args.offsetBytes ?? 0 };
    if (
      typeof cursor.offsetBytes !== "number" ||
      !Number.isInteger(cursor.offsetBytes) ||
      cursor.offsetBytes < 0
    ) {
      return "response.get requires a schema-valid byte cursor";
    }
    if (
      typeof args.maxBytes !== "number" ||
      !Number.isInteger(args.maxBytes) ||
      args.maxBytes <= 0 ||
      args.maxBytes > 65_536
    ) {
      return "response.get requires a positive maxBytes bound no larger than 65,536";
    }
  }

  if (action === "delta.get" && args.cursor !== undefined) {
    const cursor = args.cursor;
    if (
      !isRecord(cursor) ||
      typeof cursor.fromVersion !== "string" ||
      typeof cursor.toVersion !== "string" ||
      typeof cursor.offset !== "number" ||
      !Number.isInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      return "delta.get requires an exact version-bound cursor";
    }
    if (
      args.fromVersion !== cursor.fromVersion ||
      args.toVersion !== cursor.toVersion
    ) {
      return "delta.get cursor versions must match the requested versions";
    }
  }

  if (action === "runtime.queryOutput") {
    if (
      typeof args.artifactHandle !== "string" ||
      args.artifactHandle.length === 0
    ) {
      return "runtime.queryOutput requires an artifact handle";
    }
    if (args.view !== "model" && args.view !== "raw") {
      return "runtime.queryOutput requires an explicit view";
    }
    if (
      !isRecord(args.cursor) ||
      (args.cursor.stream !== "stdout" && args.cursor.stream !== "stderr") ||
      typeof args.cursor.afterLine !== "number" ||
      !Number.isInteger(args.cursor.afterLine) ||
      args.cursor.afterLine < 0
    ) {
      return "runtime.queryOutput requires an explicit cursor";
    }
  }

  return undefined;
}

function withoutPresentationFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !PRESENTATION_ONLY_FIELDS.has(key))
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function logicalCallSignature(
  call: RecoveryActionCall,
  ambientRepoId?: string,
): string | undefined {
  const definition = resolveRecoveryActionDefinition(call.action);
  if (!definition) return undefined;

  const withRepoId = stableRecord(call.args);
  if (withRepoId.repoId === undefined && ambientRepoId !== undefined) {
    withRepoId.repoId = ambientRepoId;
  }
  const parsed = definition.schema.safeParse(applyAliases(definition, withRepoId));
  const args = parsed.success && isRecord(parsed.data)
    ? parsed.data
    : withRepoId;
  return JSON.stringify({
    action: definition.action,
    args: withoutPresentationFields(args),
  });
}

function invalidRecovery(
  reason: string,
  action?: string,
): RecoveryBuildResult {
  invalidRecoveryCount += 1;
  logger.warn("Invalid generated recovery omitted", {
    reason,
    action: action ?? "unknown",
    invalidRecoveryCount,
  });
  if (strictValidationForTests) {
    throw new Error(`Invalid generated recovery: ${reason}`);
  }
  return { invalidRecoveryCount: 1 };
}

function boundedResult(
  nextAction: RecoveryActionCall,
  validatedAction: RecoveryActionCall,
): RecoveryBuildResult {
  const serialized = JSON.stringify(nextAction);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES) {
    return invalidRecovery("serialized recovery exceeds the byte bound", nextAction.action);
  }
  return { nextAction, validatedAction, invalidRecoveryCount: 0 };
}

function normalizeWorkflowArgsForActiveSurface(
  action: string,
  args: Record<string, unknown>,
  context: RecoveryValidationContext,
): Record<string, unknown> | undefined {
  if (
    action !== "workflow" ||
    context.activeWorkflowFunctions === undefined
  ) {
    return args;
  }

  const activeFunctions = new Set(context.activeWorkflowFunctions);
  if (!Array.isArray(args.steps)) return undefined;

  const steps: Record<string, unknown>[] = [];
  for (const step of args.steps) {
    if (!isRecord(step)) return undefined;
    const requestedFn = ownString(step, "fn");
    if (!requestedFn) return undefined;
    const resolvedFn =
      resolveRecoveryWorkflowFunction(requestedFn) ?? requestedFn;
    if (!activeFunctions.has(resolvedFn)) return undefined;
    steps.push({ ...step, fn: resolvedFn });
  }

  return { ...args, steps };
}

/**
 * Materialize and validate a generated recovery before it crosses a public
 * response boundary. Invalid recovery is diagnostic-only and never replaces
 * the safe error/result that produced it.
 */
export function buildValidatedRecoveryAction(
  candidate: unknown,
  context: RecoveryValidationContext,
): RecoveryBuildResult {
  // Bound generated structures before canonicalization, schema parsing, or
  // serialization can replace the original safe error at the delivery boundary.
  const candidateProblem = recoveryStructureProblem(candidate);
  if (candidateProblem) {
    return invalidRecovery(`candidate ${candidateProblem}`);
  }
  const failedCallProblem = recoveryStructureProblem(context.failedCall);
  if (failedCallProblem) {
    return invalidRecovery(`failed call ${failedCallProblem}`);
  }

  const extracted = extractCandidate(candidate);
  if (!extracted) {
    return invalidRecovery("candidate does not name an action");
  }

  const definition = resolveRecoveryActionDefinition(extracted.action);
  if (!definition) {
    return invalidRecovery("candidate names an unknown action", extracted.action);
  }

  const materialized = materializeArgs(definition, extracted.args, context);
  const continuationError = continuationProblem(definition.action, materialized);
  if (continuationError) {
    return invalidRecovery(continuationError, definition.action);
  }

  const parsed = definition.schema.safeParse(materialized);
  if (!parsed.success || !isRecord(parsed.data)) {
    return invalidRecovery("candidate args fail the target input schema", definition.action);
  }

  const parsedArgs = { ...parsed.data };
  if (definition.action === "response.get") {
    if (materialized.view === undefined) delete parsedArgs.view;
    if (materialized.cursor === undefined) delete parsedArgs.cursor;
  }
  const activeArgs = normalizeWorkflowArgsForActiveSurface(
    definition.action,
    parsedArgs,
    context,
  );
  if (!activeArgs) {
    return invalidRecovery(
      "workflow recovery references a function outside this server's active surface",
      definition.action,
    );
  }

  const validatedAction: RecoveryActionCall = {
    action: definition.action,
    args: stableRecord(activeArgs),
  };
  if (context.failedCall) {
    const failedSignature = logicalCallSignature(
      context.failedCall,
      contextRepoId(context),
    );
    const candidateSignature = logicalCallSignature(
      validatedAction,
      contextRepoId(context),
    );
    if (
      failedSignature !== undefined &&
      candidateSignature !== undefined &&
      failedSignature === candidateSignature
    ) {
      return invalidRecovery(
        "candidate repeats the failed call without a cause-relevant change",
        definition.action,
      );
    }
  }

  const advertisedTools = new Set(
    context.advertisedTools.map((tool) =>
      tool.startsWith("sdl.") ? tool : `sdl.${tool}`,
    ),
  );
  if (definition.toolName && advertisedTools.has(definition.toolName)) {
    const nextAction: RecoveryActionCall = {
      action: definition.toolName,
      args: stableRecord(activeArgs),
    };
    if (
      nextAction.action === "sdl.workflow" &&
      containsAmbientReference(nextAction.args)
    ) {
      return invalidRecovery(
        "workflow recovery depends on ambient result references",
        definition.action,
      );
    }
    return boundedResult(nextAction, validatedAction);
  }

  if (!advertisedTools.has("sdl.workflow")) {
    return invalidRecovery(
      "target action is not advertised on the active public surface",
      definition.action,
    );
  }

  const fn = resolveRecoveryWorkflowFunction(definition.action);
  if (
    !fn ||
    (context.activeWorkflowFunctions !== undefined &&
      !context.activeWorkflowFunctions.includes(fn))
  ) {
    return invalidRecovery(
      "target action is not active in this server's workflow function map",
      definition.action,
    );
  }
  const repoId =
    typeof activeArgs.repoId === "string"
      ? activeArgs.repoId
      : contextRepoId(context);
  if (!repoId) {
    return invalidRecovery(
      "workflow recovery cannot materialize repoId",
      definition.action,
    );
  }

  const { repoId: _repoId, ...childArgs } = activeArgs;
  const workflowDefinition = resolveRecoveryActionDefinition("workflow");
  if (!workflowDefinition) {
    return invalidRecovery("workflow action is unavailable", definition.action);
  }
  const workflowParsed = workflowDefinition.schema.safeParse({
    repoId,
    steps: [{ fn, args: childArgs }],
    onError: "continue",
  });
  if (!workflowParsed.success || !isRecord(workflowParsed.data)) {
    return invalidRecovery(
      "materialized workflow fails the workflow input schema",
      definition.action,
    );
  }
  if (containsAmbientReference(workflowParsed.data)) {
    return invalidRecovery(
      "workflow recovery depends on ambient result references",
      definition.action,
    );
  }

  return boundedResult(
    {
      action: "sdl.workflow",
      args: stableRecord(workflowParsed.data),
    },
    validatedAction,
  );
}

export const _recoveryValidationTesting = {
  reset(): void {
    invalidRecoveryCount = 0;
    strictValidationForTests = false;
  },
  setStrictMode(enabled: boolean): void {
    strictValidationForTests = enabled;
  },
  getMetrics(): RecoveryValidationMetrics {
    return { invalidRecoveryCount };
  },
};

/**
 * Build the existing Code Mode paging call for a truncated hot-path response.
 * The exclusive recovery boundary validates this candidate against the live
 * retrieve schema before delivery.
 */
export function buildHotPathPagingRecovery(
  requestArgs: Readonly<Record<string, unknown>>,
  result: Readonly<Record<string, unknown>>,
): RecoveryActionCall | undefined {
  const actionArgs = isRecord(requestArgs.args) ? requestArgs.args : requestArgs;
  const repoId = typeof requestArgs.repoId === "string"
    ? requestArgs.repoId
    : typeof actionArgs.repoId === "string"
      ? actionArgs.repoId
      : undefined;
  const identifiersToFind = Array.isArray(actionArgs.identifiersToFind)
    ? actionArgs.identifiersToFind.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
    : [];
  const symbolId = typeof actionArgs.symbolId === "string"
    ? actionArgs.symbolId
    : undefined;
  const symbolRef = isRecord(actionArgs.symbolRef)
    ? actionArgs.symbolRef
    : undefined;
  if (!repoId || identifiersToFind.length === 0 || (!symbolId && !symbolRef)) {
    return undefined;
  }

  const requestedLines = typeof actionArgs.maxLines === "number"
    ? Math.trunc(actionArgs.maxLines)
    : 120;
  const expectedLines = Math.max(1, Math.min(1_000, requestedLines));
  const range = isRecord(result.range) ? result.range : {};
  const nestedEnd = isRecord(range.end) ? range.end : {};
  const endLine = typeof range.endLine === "number"
    ? range.endLine
    : typeof nestedEnd.line === "number"
      ? nestedEnd.line
      : undefined;

  return {
    action: "sdl.retrieve",
    args: {
      repoId,
      op: "codeNeedWindow",
      args: {
        ...(symbolId ? { symbolId } : { symbolRef }),
        reason: "Continue the truncated hot-path result.",
        expectedLines,
        identifiersToFind,
        ...(endLine !== undefined ? { cursor: endLine + 1 } : {}),
      },
    },
  };
}
