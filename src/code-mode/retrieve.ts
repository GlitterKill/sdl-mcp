import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import { dispatchAction, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import {
  RetrieveRequestSchema,
} from "./retrieve-schema.js";

export {
  RetrieveOpSchema,
  RetrieveRequestSchema,
} from "./retrieve-schema.js";

export const RETRIEVE_ACTION_BY_OP = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  sliceBuild: "slice.build",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
} as const;

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

  const actionArgs = {
    repoId: request.repoId,
    ...request.args,
  };
  try {
    return await dispatchAction(
      actionName,
      actionArgs,
      actionMap,
      { kind: "retrieve", responseMode: request.responseMode },
      context,
    );
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;

    const details = error.issues.map((issue) => ({
      path: ["args", ...issue.path].join("."),
      message: issue.message,
    }));
    const validationError = new ValidationError(
      `Invalid tool arguments:\n${details
        .map((detail) => `  - ${detail.path}: ${detail.message}`)
        .join("\n")}`,
    );
    Object.assign(validationError, { details });
    throw validationError;
  }
}
