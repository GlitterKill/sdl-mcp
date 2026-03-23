import { describe, it } from "node:test";
import assert from "node:assert";
import {
  QUERY_THIN_SCHEMA,
  CODE_THIN_SCHEMA,
  REPO_THIN_SCHEMA,
  AGENT_THIN_SCHEMA,
} from "../../dist/gateway/thin-schemas.js";
import {
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
} from "../../dist/gateway/schemas.js";

function assertGatewaySchema(
  schema: Record<string, unknown>,
  actions: readonly string[],
): void {
  assert.strictEqual(schema.type, "object");
  assert.ok(Array.isArray(schema.oneOf), "expected oneOf variants");
  assert.strictEqual((schema.oneOf as unknown[]).length, actions.length);

  for (const action of actions) {
    assert.match(
      JSON.stringify(schema),
      new RegExp(`"const":"${action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
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
    assertGatewaySchema(AGENT_THIN_SCHEMA, AGENT_ACTIONS);
  });
});
