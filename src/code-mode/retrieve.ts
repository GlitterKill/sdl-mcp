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
  return dispatchAction(
    actionName,
    actionArgs,
    actionMap,
    { kind: "retrieve", responseMode: request.responseMode },
    context,
  );
}
