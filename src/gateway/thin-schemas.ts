import {
  compactJsonSchema,
  zodSchemaToJsonSchema,
} from "./compact-schema.js";
import {
  AGENT_ACTIONS,
  CODE_ACTIONS,
  QUERY_ACTIONS,
  REPO_ACTIONS,
} from "./schemas.js";
import { createActionMap, type ActionMap } from "./router.js";

type JsonSchema = Record<string, unknown>;

function buildActionEnvelope(
  action: string,
  actionMap: ActionMap,
): JsonSchema {
  const baseSchema = zodSchemaToJsonSchema(actionMap[action].schema);
  return {
    type: "object",
    allOf: [
      baseSchema,
      {
        type: "object",
        properties: {
          action: {
            type: "string",
            const: action,
            description: "Gateway action name.",
          },
        },
        required: ["action"],
      },
    ],
  };
}

export function buildGatewayWireSchema(
  actions: readonly string[],
  actionMap: ActionMap,
): JsonSchema {
  // Filter to only actions present in the map (memory actions may be gated)
  const activeActions = actions.filter((action) => action in actionMap);
  return compactJsonSchema({
    type: "object",
    oneOf: activeActions.map((action) => buildActionEnvelope(action, actionMap)),
  });
}

const DEFAULT_ACTION_MAP = createActionMap();

export const QUERY_THIN_SCHEMA = buildGatewayWireSchema(
  QUERY_ACTIONS,
  DEFAULT_ACTION_MAP,
);
export const CODE_THIN_SCHEMA = buildGatewayWireSchema(
  CODE_ACTIONS,
  DEFAULT_ACTION_MAP,
);
export const REPO_THIN_SCHEMA = buildGatewayWireSchema(
  REPO_ACTIONS,
  DEFAULT_ACTION_MAP,
);
export const AGENT_THIN_SCHEMA = buildGatewayWireSchema(
  AGENT_ACTIONS,
  DEFAULT_ACTION_MAP,
);
