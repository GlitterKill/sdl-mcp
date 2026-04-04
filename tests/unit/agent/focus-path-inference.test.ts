import assert from "node:assert";
import { describe, it } from "node:test";
import { inferFocusPathsFromTaskText } from "../../../dist/agent/context-seeding.js";

describe("inferFocusPathsFromTaskText", () => {
  it("infers src/graph/ for beam search queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "How does the beam search algorithm work in buildGraphSlice?",
    );
    assert.ok(
      paths.includes("src/graph/"),
      `Expected src/graph/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/graph/ for slice-related queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "What algorithm does graph slice building use?",
    );
    assert.ok(
      paths.includes("src/graph/"),
      `Expected src/graph/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/code/ for skeleton IR queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "The skeleton IR output is sometimes missing function parameters",
    );
    assert.ok(
      paths.includes("src/code/"),
      `Expected src/code/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/indexer/ for import resolution queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "extractImports is not resolving barrel re-exports correctly",
    );
    assert.ok(
      paths.includes("src/indexer/"),
      `Expected src/indexer/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/cli/ for CLI command queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "Add a new CLI command called stats",
    );
    assert.ok(
      paths.includes("src/cli/"),
      `Expected src/cli/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/policy/ for gating/policy queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "Review the policy enforcement in code.needWindow gating logic",
    );
    assert.ok(
      paths.includes("src/policy/") || paths.includes("src/code/"),
      `Expected src/policy/ or src/code/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/delta/ for blast radius queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "How does the blast radius computation work in delta packs?",
    );
    assert.ok(
      paths.includes("src/delta/"),
      `Expected src/delta/ in ${JSON.stringify(paths)}`,
    );
  });

  it("infers src/db/ for database queries", () => {
    const paths = inferFocusPathsFromTaskText(
      "How does the ladybug schema handle cypher queries?",
    );
    assert.ok(
      paths.includes("src/db/"),
      `Expected src/db/ in ${JSON.stringify(paths)}`,
    );
  });

  it("returns empty array for unrecognized queries", () => {
    const paths = inferFocusPathsFromTaskText("what is the meaning of life?");
    assert.deepStrictEqual(paths, []);
  });

  it("limits results to MAX_INFERRED_PATHS (3)", () => {
    const paths = inferFocusPathsFromTaskText(
      "indexer adapter tree-sitter graph slice beam search delta blast radius policy gating",
    );
    assert.ok(paths.length <= 3, `Expected <= 3 paths, got ${paths.length}`);
  });

  it("deduplicates paths from overlapping keyword matches", () => {
    const paths = inferFocusPathsFromTaskText(
      "import resolution barrel re-export index adapter",
    );
    const unique = new Set(paths);
    assert.strictEqual(paths.length, unique.size, "Paths should be unique");
  });

  it("ranks by keyword match strength (longer matches first)", () => {
    const paths = inferFocusPathsFromTaskText(
      "beam search in the graph slice builder",
    );
    // "beam search" (11 chars) + "graph" (5) + "slice" (5) → src/graph/ should be first
    assert.strictEqual(paths[0], "src/graph/");
  });
});
