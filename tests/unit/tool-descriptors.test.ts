import { describe, it } from "node:test";
import assert from "node:assert";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";

// Read the committed inventory for expected tool names
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const inventoryPath = resolve(__dirname, "../../docs/generated/tool-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf-8"));
// The generated inventory is a superset that still documents opt-in memory tools.
// Default flat registration hides those unless memory tools are enabled in config.
const defaultVisibleFlatToolNames = inventory.flatToolNames.filter(
  (name: string) => !name.startsWith("sdl.memory."),
);

const provenOutputSchemaTools = new Set([
  "sdl.repo.register",
  "sdl.repo.status",
  "sdl.repo.unregister",
  "sdl.index.refresh",
  "sdl.buffer.push",
  "sdl.buffer.checkpoint",
  "sdl.buffer.status",
  "sdl.symbol.search",
  "sdl.symbol.getCard",
  "sdl.slice.build",
  "sdl.slice.refresh",
  "sdl.slice.spillover.get",
  "sdl.delta.get",
  "sdl.code.getSkeleton",
  "sdl.code.getHotPath",
  "sdl.policy.get",
  "sdl.policy.set",
  "sdl.pr.risk.analyze",
  "sdl.agent.feedback",
  "sdl.agent.feedback.query",
  "sdl.response.get",
  "sdl.memory.store",
  "sdl.memory.query",
  "sdl.memory.remove",
  "sdl.memory.surface",
  "sdl.usage.stats",
  "sdl.runtime.execute",
  "sdl.runtime.queryOutput",
]);

const intentionalOutputSchemaOmissions = new Map([
  ["sdl.repo.overview", "Public full and notModified projections are disjoint with no common required root property; faithful union yields invalid root anyOf, while partial+refine weakens converted JSON Schema"],
  ["sdl.symbol.edit", "Preview/apply/applyNow union lacks exported response Zod schema"],
  [
    "sdl.code.needWindow",
    "Approved/denied/response-artifact union converts to anyOf without the MCP-required root object; see tests/unit/mcp-code-need-window-policy.test.ts",
  ],
  ["sdl.file.read", "Inline/read-hint/response-artifact variants lack exported response Zod schema"],
  ["sdl.file.write", "Typed response lacks exported response Zod schema"],
  ["sdl.semantic.enrichment.refresh", "Provider result lacks stable exported MCP response Zod schema"],
  [
    "sdl.semantic.enrichment.status",
    "Compact/full response union lacks one exported Zod response schema; Chunk 8 stabilizes both variants but does not invent a broad schema in this remediation",
  ],
  ["sdl.search.edit", "Preview/apply/response-artifact union lacks exported response Zod schema"],
]);

describe("buildFlatToolDescriptors", () => {
  const descriptors = buildFlatToolDescriptors({} as any);

  it("defers repo.overview instead of advertising a schema that accepts an empty object", () => {
    const overview = descriptors.find((descriptor) => descriptor.name === "sdl.repo.overview");
    assert.ok(overview, "expected sdl.repo.overview descriptor");
    assert.strictEqual(overview.outputSchema, undefined);
    assert.strictEqual(
      intentionalOutputSchemaOmissions.get("sdl.repo.overview"),
      "Public full and notModified projections are disjoint with no common required root property; faithful union yields invalid root anyOf, while partial+refine weakens converted JSON Schema",
    );
  });

  it("documents the semantic enrichment status schema deferral", () => {
    assert.strictEqual(
      intentionalOutputSchemaOmissions.get("sdl.semantic.enrichment.status"),
      "Compact/full response union lacks one exported Zod response schema; Chunk 8 stabilizes both variants but does not invent a broad schema in this remediation",
    );
  });

  it("classifies every flat tool as schema-backed or intentionally omitted", () => {
    const allDescriptors = buildFlatToolDescriptors({
      actionAvailability: { memoryTools: true },
    } as any);
    const classifiedNames = [
      ...provenOutputSchemaTools,
      ...intentionalOutputSchemaOmissions.keys(),
    ].sort();

    assert.deepStrictEqual(classifiedNames, [...inventory.flatToolNames].sort());
    for (const descriptor of allDescriptors) {
      const required = provenOutputSchemaTools.has(descriptor.name);
      const omissionReason = intentionalOutputSchemaOmissions.get(descriptor.name);
      assert.notStrictEqual(
        required,
        omissionReason !== undefined,
        `${descriptor.name} must be in exactly one output schema set`,
      );
      if (required) {
        assert.ok(
          descriptor.outputSchema,
          `${descriptor.name} requires a proven output schema`,
        );
      } else {
        assert.ok(omissionReason, `${descriptor.name} requires a deferral reason`);
        assert.strictEqual(descriptor.outputSchema, undefined);
      }
    }
  });

  it("returns the expected number of flat tool descriptors", () => {
    assert.strictEqual(
      descriptors.length,
      defaultVisibleFlatToolNames.length,
      `expected ${defaultVisibleFlatToolNames.length} descriptors, got ${descriptors.length}`,
    );
  });

  it("every descriptor has required fields", () => {
    for (const d of descriptors) {
      assert.ok(d.name, `descriptor missing name`);
      assert.ok(typeof d.name === "string", `name must be string`);
      assert.ok(d.name.startsWith("sdl."), `name must start with sdl.: ${d.name}`);
      assert.ok(d.description, `descriptor ${d.name} missing description`);
      assert.ok(typeof d.description === "string", `description must be string for ${d.name}`);
      assert.ok(d.schema, `descriptor ${d.name} missing schema`);
      assert.ok(typeof d.handler === "function", `descriptor ${d.name} missing handler`);
    }
  });

  it("contains all expected tool names from inventory", () => {
    const names = new Set(descriptors.map((d) => d.name));
    for (const expected of defaultVisibleFlatToolNames) {
      assert.ok(names.has(expected), `missing expected tool: ${expected}`);
    }
  });

  it("does not expose direct SCIP ingest as a flat MCP tool", () => {
    const names = new Set(descriptors.map((d) => d.name));
    assert.ok(!names.has("sdl.scip.ingest"));
  });

  it("has no duplicate tool names", () => {
    const names = descriptors.map((d) => d.name);
    const unique = new Set(names);
    assert.strictEqual(
      unique.size,
      names.length,
      `found duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`,
    );
  });

  it("groups repo tools together at the start", () => {
    const repoToolNames = [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.repo.unregister",
      "sdl.index.refresh",
      "sdl.repo.overview",
    ];
    const repoIndices = repoToolNames.map((name) => descriptors.findIndex((d) => d.name === name));
    // All repo tools should exist
    for (let i = 0; i < repoToolNames.length; i++) {
      assert.ok(repoIndices[i] >= 0, `repo tool ${repoToolNames[i]} not found`);
    }
    // All should be within the first 6 positions (allowing for some buffer tools)
    const maxRepoIndex = Math.max(...repoIndices);
    assert.ok(maxRepoIndex < 8, `repo tools should be grouped near the start, but last is at index ${maxRepoIndex}`);
  });
});
