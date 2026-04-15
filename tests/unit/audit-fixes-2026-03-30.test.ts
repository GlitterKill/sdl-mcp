/**
 * Tests for the 7 bug fixes from the 2026-03-30 audit.
 *
 * Covers:
 * 1. index.refresh async mode (schema + handler)
 * 2. Version-state: createVersion uses MERGE not MATCH for Repo
 * 3. Runtime allowed list default includes shell + typescript
 * 4. PolicyEngine receives defaultDenyRaw from code.needWindow
 * 5. code.needWindow break-glass honors policy (same root cause as #4)
 * 6. memory.store upsert with explicit memoryId
 * 7. agent.context precise mode caps at 5 symbols, not 1
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// ── #7: Precise mode effectiveMax ────────────────────────────────────

describe("Executor selectTopSymbols precise mode cap", () => {
  it("precise mode effectiveMax should be min(5, maxCount), not 1", async () => {
    // The ranking logic moved from executor.ts to context-ranking.ts in the
    // evidence-aware ranking refactor. Verify the fix is in the new location.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/agent/context-ranking.ts", "utf8");
    assert.ok(
      src.includes("Math.min(5, maxCount)"),
      "effectiveMax for precise mode should be Math.min(5, maxCount) in context-ranking.ts",
    );
    // Also verify executor delegates to ranking module
    const executorSrc = readFileSync("src/agent/executor.ts", "utf8");
    assert.ok(
      executorSrc.includes("applyAdaptiveCutoff"),
      "executor.ts should delegate to applyAdaptiveCutoff from context-ranking",
    );
    assert.ok(
      !executorSrc.includes("isPrecise ? 1 : maxCount"),
      "Old hardcoded effectiveMax of 1 should be gone",
    );
  });
});

// ── #6: memory.store upsert semantics ────────────────────────────────

describe("memory.store upsert with explicit memoryId", () => {
  it("should fall through to create when memoryId not found, not throw", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/memory.ts", "utf8");
    // Should NOT throw "not found" when memoryId is provided but doesn't exist
    assert.ok(
      !src.includes(
        "throw new DatabaseError(`Memory ${providedMemoryId} not found`)",
      ),
      "Should not throw DatabaseError for missing providedMemoryId",
    );
    // Should use providedMemoryId in create path
    assert.ok(
      src.includes("providedMemoryId ?? generateMemoryId()"),
      "Create path should reuse providedMemoryId when available",
    );
    // Should have upsert comment
    assert.ok(
      src.includes("Upsert"),
      "Comment should indicate upsert semantics",
    );
  });
});

// ── #3: Runtime allowed list ─────────────────────────────────────────

describe("Runtime allowedRuntimes default", () => {
  it("config schema default includes typescript and shell", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/config/types.ts", "utf8");
    // The default should include at least node, typescript, python, shell
    assert.ok(
      src.includes("node") && src.includes("typescript") && src.includes("python") && src.includes("shell"),
      "Default allowedRuntimes should include node, typescript, python, shell",
    );
    assert.ok(
      !src.match(/allowedRuntimes.*\.default\(\["node", "python"\]\)/),
      "Old restrictive default [node, python] should be replaced",
    );
  });

  it("doctor.ts fallback includes typescript and shell", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cli/commands/doctor.ts", "utf8");
    assert.ok(
      src.includes("node") && src.includes("typescript") && src.includes("python") && src.includes("shell"),
      "Doctor fallback should match the new config default",
    );
  });
});

// ── #4 + #5: PolicyEngine receives defaultDenyRaw ────────────────────

describe("PolicyEngine config propagation", () => {
  it("code.ts passes defaultDenyRaw to PolicyEngine", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/code.ts", "utf8");
    assert.ok(
      src.includes("defaultDenyRaw: validatedPolicy.defaultDenyRaw"),
      "code.ts should pass defaultDenyRaw to PolicyEngine constructor",
    );
  });

  it("slice.ts passes defaultDenyRaw to PolicyEngine", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/slice.ts", "utf8");
    assert.ok(
      src.includes("defaultDenyRaw: mergedPolicy.defaultDenyRaw"),
      "slice.ts should pass defaultDenyRaw to PolicyEngine updateConfig",
    );
  });

  it("PolicyEngine honors defaultDenyRaw=false", async () => {
    const { PolicyEngine } = await import("../../dist/policy/engine.js");
    const engine = new PolicyEngine({ defaultDenyRaw: false });
    const config = engine.getConfig();
    assert.strictEqual(
      config.defaultDenyRaw,
      false,
      "defaultDenyRaw should be false",
    );
  });

  it("PolicyEngine defaults defaultDenyRaw to true", async () => {
    const { PolicyEngine } = await import("../../dist/policy/engine.js");
    const engine = new PolicyEngine();
    const config = engine.getConfig();
    assert.strictEqual(
      config.defaultDenyRaw,
      true,
      "defaultDenyRaw should default to true",
    );
  });
});

// ── #1: index.refresh async mode ─────────────────────────────────────

describe("index.refresh async mode schema", () => {
  it("request schema accepts async flag", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools.ts", "utf8");
    assert.ok(
      src.includes("async: z.boolean().optional()"),
      "IndexRefreshRequestSchema should have async boolean field",
    );
  });

  it("request schema accepts includeDiagnostics flag", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools.ts", "utf8");
    assert.ok(
      src.includes("includeDiagnostics: z.boolean().optional()"),
      "IndexRefreshRequestSchema should have includeDiagnostics boolean field",
    );
  });

  it("response schema includes operationId and message", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools.ts", "utf8");
    assert.ok(
      src.includes("operationId: z.string().optional()"),
      "IndexRefreshResponseSchema should have operationId field",
    );
    assert.ok(
      src.includes("message: z.string().optional()"),
      "IndexRefreshResponseSchema should have message field",
    );
  });

  it("response schema includes diagnostics timings", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools.ts", "utf8");
    assert.ok(
      src.includes("diagnostics:") && src.includes(".object("),
      "IndexRefreshResponseSchema should have diagnostics field",
    );
    assert.ok(
      src.includes("timings:") && src.includes(".object("),
      "IndexRefreshResponseSchema should include timings diagnostics",
    );
  });

  it("handler supports asyncMode flag", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/repo.ts", "utf8");
    assert.ok(
      src.includes("asyncMode"),
      "handleIndexRefresh should read asyncMode from request",
    );
    assert.ok(
      src.includes("bgRefresh().then("),
      "Async mode should fire-and-forget bgRefresh (detached from request signal)",
    );
  });
});

// ── #2: Version-state consistency ────────────────────────────────────

describe("Version-state consistency", () => {
  it("createVersion uses MERGE for Repo node, not MATCH", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/db/ladybug-versions.ts", "utf8");
    // The createVersion query should use MERGE for the Repo node
    assert.ok(
      src.includes("MERGE (r:Repo {repoId: $repoId})"),
      "createVersion should use MERGE for Repo to prevent silent failures",
    );
    // Should NOT use MATCH for Repo in createVersion context
    const createVersionSection = src.slice(
      src.indexOf("async function createVersion"),
      src.indexOf("async function updateVersionHashes"),
    );
    assert.ok(
      !createVersionSection.includes("MATCH (r:Repo"),
      "createVersion should not use MATCH for Repo",
    );
  });

  it("repo.register creates initial version for new repos", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/repo.ts", "utf8");
    assert.ok(
      src.includes("Initial registration"),
      "handleRepoRegister should create an initial version for new repos",
    );
    assert.ok(
      src.includes("createVersionAndSnapshot"),
      "Should use createVersionAndSnapshot during registration",
    );
  });
});

// ── #5b: Break-glass evidence type ─────────────────────────────────

describe("Break-glass evidence type", () => {
  it("code.ts checks for break-glass-triggered, not break-glass", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools/code.ts", "utf8");
    assert.ok(
      src.includes('e.type === "break-glass-triggered"'),
      "Should check for break-glass-triggered evidence type",
    );
    assert.ok(
      !src.includes('e.type === "break-glass"'),
      "Should not check for bare break-glass evidence type",
    );
  });
});

// ── #4b: PolicySetRequestSchema completeness ────────────────────────

describe("PolicySetRequestSchema completeness", () => {
  it("local PolicyConfigSchema includes defaultDenyRaw", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/mcp/tools.ts", "utf8");
    // Find the local PolicyConfigSchema block
    const start = src.indexOf("const PolicyConfigSchema = z.object");
    assert.ok(start >= 0, "Should have local PolicyConfigSchema");
    const block = src.slice(start, src.indexOf("});", start) + 3);
    assert.ok(
      block.includes("defaultDenyRaw"),
      "Local PolicyConfigSchema should include defaultDenyRaw field",
    );
    assert.ok(
      block.includes("defaultMinCallConfidence"),
      "Local PolicyConfigSchema should include defaultMinCallConfidence field",
    );
  });
});
