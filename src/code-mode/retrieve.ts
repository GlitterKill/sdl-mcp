import { z } from "zod";

import { ValidationError } from "../domain/errors.js";
import type { ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";

export const RETRIEVE_ACTION_BY_OP = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  sliceBuild: "slice.build",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
} as const;

export const RetrieveOpSchema = z.enum([
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "codeSkeleton",
  "codeHotPath",
  "codeNeedWindow",
]);

export const RetrieveRequestSchema = z.object({
  repoId: z.string().min(1),
  op: RetrieveOpSchema,
  args: z.record(z.string(), z.unknown()).optional().default({}),
  responseMode: z.enum(["inline", "auto", "handle"]).optional(),
  includeDiagnostics: z.boolean().optional().default(false),
});

type RetrieveOp = z.infer<typeof RetrieveOpSchema>;

interface RetrieveOptions {
  responseMode?: "inline" | "auto" | "handle";
  includeDiagnostics?: boolean;
}

export function normalizeRetrieveArgs(
  op: RetrieveOp,
  args: Record<string, unknown>,
  opts: RetrieveOptions,
): Record<string, unknown> {
  const normalized = { ...args };

  if (op === "symbolSearch" && normalized.wireFormat === undefined) {
    normalized.wireFormat = "auto";
  }

  if (op === "sliceBuild") {
    normalized.wireFormat ??= "auto";
    normalized.cardDetail ??= "compact";
    normalized.includeLegend ??= false;
    normalized.includeRetrievalEvidence ??= false;
    normalized.includeProcesses ??= false;
  }

  if (op === "codeNeedWindow" && normalized.responseMode === undefined) {
    normalized.responseMode = opts.responseMode ?? "auto";
  }

  if (opts.includeDiagnostics) {
    normalized.includeDiagnostics = true;
  }

  return normalized;
}

export async function handleRetrieve(
  rawArgs: unknown,
  actionMap: ActionMap,
  context?: ToolContext,
): Promise<unknown> {
  const request = RetrieveRequestSchema.parse(rawArgs);
  const actionName = RETRIEVE_ACTION_BY_OP[request.op];
  const action = actionMap[actionName];

  if (!action) {
    throw new ValidationError(
      `Retrieval action ${actionName} is not available in this server configuration.`,
    );
  }

  const normalizedArgs = normalizeRetrieveArgs(request.op, request.args, {
    responseMode: request.responseMode,
    includeDiagnostics: request.includeDiagnostics,
  });
  const gatewayArgs = {
    repoId: request.repoId,
    action: actionName,
    ...normalizedArgs,
  };

  const parsedArgs = action.schema.parse(gatewayArgs);
  return action.handler(parsedArgs, context);
}
