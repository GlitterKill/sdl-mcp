import {
  compactJsonSchema,
  zodSchemaToJsonSchema,
} from "./compact-schema.js";
import type { ActionMap } from "./router.js";

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
