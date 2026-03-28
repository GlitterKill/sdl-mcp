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

describe("buildFlatToolDescriptors", () => {
  const descriptors = buildFlatToolDescriptors({} as any);

  it("returns the expected number of flat tool descriptors", () => {
    assert.strictEqual(
      descriptors.length,
      inventory.flatToolNames.length,
      `expected ${inventory.flatToolNames.length} descriptors, got ${descriptors.length}`,
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
    for (const expected of inventory.flatToolNames) {
      assert.ok(names.has(expected), `missing expected tool: ${expected}`);
    }
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
    const repoToolNames = ["sdl.repo.register", "sdl.repo.status", "sdl.index.refresh", "sdl.repo.overview"];
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
