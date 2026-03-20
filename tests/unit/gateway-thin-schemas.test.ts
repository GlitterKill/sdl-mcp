import { describe, it } from "node:test";
import assert from "node:assert";
import {
  QUERY_THIN_SCHEMA,
  CODE_THIN_SCHEMA,
  REPO_THIN_SCHEMA,
  AGENT_THIN_SCHEMA,
} from "../../src/gateway/thin-schemas.js";
import {
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
} from "../../src/gateway/schemas.js";

/**
 * Tests for src/gateway/thin-schemas.ts — compact JSON schemas for gateway tools.
 * Verifies that each thin schema has the expected structure and action enums.
 */

describe("Gateway thin schemas", () => {
  describe("QUERY_THIN_SCHEMA", () => {
    it("is a valid JSON Schema object", () => {
      assert.strictEqual((QUERY_THIN_SCHEMA as any).type, "object");
      assert.ok((QUERY_THIN_SCHEMA as any).properties);
    });

    it("has repoId and action properties", () => {
      const props = (QUERY_THIN_SCHEMA as any).properties;
      assert.ok(props.repoId, "missing repoId property");
      assert.ok(props.action, "missing action property");
    });

    it("requires both action and repoId", () => {
      const required = (QUERY_THIN_SCHEMA as any).required as string[];
      assert.ok(required.includes("action"), "action should be required");
      assert.ok(required.includes("repoId"), "repoId should be required");
    });

    it("action enum matches QUERY_ACTIONS", () => {
      const actionEnum = (QUERY_THIN_SCHEMA as any).properties.action.enum;
      assert.deepStrictEqual(actionEnum, [...QUERY_ACTIONS]);
    });

    it("allows additionalProperties", () => {
      assert.strictEqual((QUERY_THIN_SCHEMA as any).additionalProperties, true);
    });

    it("repoId has type string with minLength 1", () => {
      const repoId = (QUERY_THIN_SCHEMA as any).properties.repoId;
      assert.strictEqual(repoId.type, "string");
      assert.strictEqual(repoId.minLength, 1);
    });
  });

  describe("CODE_THIN_SCHEMA", () => {
    it("is a valid JSON Schema object", () => {
      assert.strictEqual((CODE_THIN_SCHEMA as any).type, "object");
    });

    it("action enum matches CODE_ACTIONS", () => {
      const actionEnum = (CODE_THIN_SCHEMA as any).properties.action.enum;
      assert.deepStrictEqual(actionEnum, [...CODE_ACTIONS]);
    });

    it("requires action and repoId", () => {
      const required = (CODE_THIN_SCHEMA as any).required as string[];
      assert.ok(required.includes("action"));
      assert.ok(required.includes("repoId"));
    });
  });

  describe("REPO_THIN_SCHEMA", () => {
    it("is a valid JSON Schema object", () => {
      assert.strictEqual((REPO_THIN_SCHEMA as any).type, "object");
    });

    it("action enum matches REPO_ACTIONS", () => {
      const actionEnum = (REPO_THIN_SCHEMA as any).properties.action.enum;
      assert.deepStrictEqual(actionEnum, [...REPO_ACTIONS]);
    });

    it("requires action and repoId", () => {
      const required = (REPO_THIN_SCHEMA as any).required as string[];
      assert.ok(required.includes("action"));
      assert.ok(required.includes("repoId"));
    });
  });

  describe("AGENT_THIN_SCHEMA", () => {
    it("is a valid JSON Schema object", () => {
      assert.strictEqual((AGENT_THIN_SCHEMA as any).type, "object");
    });

    it("action enum matches AGENT_ACTIONS", () => {
      const actionEnum = (AGENT_THIN_SCHEMA as any).properties.action.enum;
      assert.deepStrictEqual(actionEnum, [...AGENT_ACTIONS]);
    });

    it("requires action and repoId", () => {
      const required = (AGENT_THIN_SCHEMA as any).required as string[];
      assert.ok(required.includes("action"));
      assert.ok(required.includes("repoId"));
    });
  });

  describe("all thin schemas", () => {
    const schemas = [
      { name: "QUERY", schema: QUERY_THIN_SCHEMA },
      { name: "CODE", schema: CODE_THIN_SCHEMA },
      { name: "REPO", schema: REPO_THIN_SCHEMA },
      { name: "AGENT", schema: AGENT_THIN_SCHEMA },
    ];

    for (const { name, schema } of schemas) {
      it(`${name} produces valid JSON when stringified`, () => {
        const json = JSON.stringify(schema);
        assert.ok(json.length > 0, `${name} should serialize to non-empty JSON`);
        const parsed = JSON.parse(json);
        assert.strictEqual(parsed.type, "object");
      });
    }
  });
});
