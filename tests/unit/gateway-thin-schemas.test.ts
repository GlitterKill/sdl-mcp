import { describe, it } from "node:test";
import assert from "node:assert";
import { buildGatewayWireSchema } from "../../dist/gateway/thin-schemas.js";
import { createActionMap } from "../../dist/gateway/router.js";
import {
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
} from "../../dist/gateway/schemas.js";

const actionMap = createActionMap();
const QUERY_THIN_SCHEMA = buildGatewayWireSchema(QUERY_ACTIONS, actionMap);
const CODE_THIN_SCHEMA = buildGatewayWireSchema(CODE_ACTIONS, actionMap);
const REPO_THIN_SCHEMA = buildGatewayWireSchema(REPO_ACTIONS, actionMap);
const AGENT_THIN_SCHEMA = buildGatewayWireSchema(AGENT_ACTIONS, actionMap);

function assertGatewaySchema(
  schema: Record<string, unknown>,
  actions: readonly string[],
): void {
  assert.strictEqual(schema.type, "object");
  assert.ok(!("oneOf" in schema), "top-level oneOf is not API-compatible");
  assert.ok(!("anyOf" in schema), "top-level anyOf is not API-compatible");
  assert.ok(!("allOf" in schema), "top-level allOf is not API-compatible");

  const properties = schema.properties as Record<string, unknown>;
  const action = properties.action as Record<string, unknown>;
  assert.deepStrictEqual(action.enum, actions);

  for (const action of actions) {
    assert.match(
      JSON.stringify(schema),
      new RegExp(`"${action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
  }

  assert.match(JSON.stringify(schema), /Repository ID|Gateway action name/);
}

describe("Gateway wire schemas", () => {
  it("QUERY_THIN_SCHEMA carries action-specific envelopes", () => {
    assertGatewaySchema(QUERY_THIN_SCHEMA, QUERY_ACTIONS);
  });

  it("CODE_THIN_SCHEMA carries action-specific envelopes", () => {
    assertGatewaySchema(CODE_THIN_SCHEMA, CODE_ACTIONS);
  });

  it("REPO_THIN_SCHEMA carries action-specific envelopes", () => {
    assertGatewaySchema(REPO_THIN_SCHEMA, REPO_ACTIONS);
  });

  it("AGENT_THIN_SCHEMA carries action-specific envelopes", () => {
    // Memory actions are config-gated and excluded when memory is globally unused
    const MEMORY_ACTIONS = new Set([
      "memory.store",
      "memory.query",
      "memory.remove",
      "memory.surface",
    ]);
    const activeAgentActions = AGENT_ACTIONS.filter(
      (a) => !MEMORY_ACTIONS.has(a),
    );
    assertGatewaySchema(AGENT_THIN_SCHEMA, activeAgentActions);
  });
});
