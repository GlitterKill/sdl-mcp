import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { PolicyEngine } from "../../dist/policy/engine.js";
import type { RuntimePolicyRequestContext } from "../../dist/policy/types.js";
import { RuntimeConfigSchema } from "../../dist/config/types.js";
import type { RuntimeConfig } from "../../dist/config/types.js";
import { createConcurrencyTracker } from "../../dist/runtime/executor.js";
import { getRuntime } from "../../dist/runtime/runtimes.js";

function makeRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    enabled: true,
    allowedRuntimes: ["node", "python"],
    ...overrides,
  });
}

function makeContext(
  overrides: Partial<RuntimePolicyRequestContext> = {},
): RuntimePolicyRequestContext {
  return {
    requestType: "runtimeExecute",
    repoId: "test-repo",
    runtime: "node",
    executable: "node",
    args: ["-e", "console.log('hi')"],
    relativeCwd: ".",
    timeoutMs: 5000,
    envKeys: [],
    ...overrides,
  };
}

describe("PolicyEngine - Runtime Execution Policy", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  // ========================================================================
  // Rule 1: runtime-enabled
  // ========================================================================

  it("should deny when runtime.enabled is false", () => {
    const config = makeRuntimeConfig({ enabled: false });
    const context = makeContext();

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(decision.deniedReasons.some((r) => r.includes("disabled")));
  });

  // ========================================================================
  // Rule 2: runtime-allowed
  // ========================================================================

  it("should deny when runtime not in allowedRuntimes", () => {
    const config = makeRuntimeConfig({ allowedRuntimes: ["python"] });
    const context = makeContext({ runtime: "node" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not in the allowed runtimes"),
      ),
    );
  });

  it("should deny when executable not in allowedExecutables (when list is non-empty)", () => {
    const config = makeRuntimeConfig({
      allowedExecutables: ["python3"],
    });
    const context = makeContext({ executable: "node" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not in the allowed executables"),
      ),
    );
  });

  it("should allow any executable when allowedExecutables is empty", () => {
    const config = makeRuntimeConfig({ allowedExecutables: [] });
    const context = makeContext({ executable: "node" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "approve");
  });

  it("should deny when executable override is not compatible with the selected runtime", () => {
    const config = makeRuntimeConfig({ allowedExecutables: [] });
    const context = makeContext({ executable: "powershell" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not compatible with runtime"),
      ),
    );
  });

  it("should allow the resolved default executable when it is explicitly allowlisted", () => {
    const defaultShellExecutable =
      getRuntime("shell")?.buildCommand([], { codePath: "/tmp/dummy.sh" }).executable;
    assert.ok(defaultShellExecutable, "Expected shell runtime default");

    const config = makeRuntimeConfig({
      allowedRuntimes: ["shell"],
      allowedExecutables: [defaultShellExecutable],
    });
    const context = makeContext({
      runtime: "shell",
      executable: defaultShellExecutable,
      args: ["echo", "hello"],
    });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "approve");
  });

  // ========================================================================
  // Rule 3: cwd-scope
  // ========================================================================

  it("should deny when relativeCwd contains ..", () => {
    const config = makeRuntimeConfig();
    const context = makeContext({ relativeCwd: "../escape" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(decision.deniedReasons.some((r) => r.includes("path traversal")));
  });

  it("should deny when relativeCwd is absolute path (unix-style)", () => {
    const config = makeRuntimeConfig();
    const context = makeContext({ relativeCwd: "/etc/passwd" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(decision.deniedReasons.some((r) => r.includes("absolute path")));
  });

  it("should deny when relativeCwd is absolute path (Windows-style)", () => {
    const config = makeRuntimeConfig();
    const context = makeContext({ relativeCwd: "C:\\Windows" });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
  });

  // ========================================================================
  // Rule 4: env-allowlist
  // ========================================================================

  it("should deny when env keys not in allowlist", () => {
    const config = makeRuntimeConfig({ envAllowlist: ["NODE_ENV"] });
    const context = makeContext({ envKeys: ["NODE_ENV", "SECRET_KEY"] });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("not in allowlist")),
    );
  });

  it("should allow env keys that are in allowlist", () => {
    const config = makeRuntimeConfig({ envAllowlist: ["NODE_ENV", "CI"] });
    const context = makeContext({ envKeys: ["NODE_ENV"] });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "approve");
  });

  // ========================================================================
  // Rule 5: timeout-cap
  // ========================================================================

  it("should deny when timeout exceeds maxDurationMs", () => {
    const config = makeRuntimeConfig({ maxDurationMs: 5000 });
    const context = makeContext({ timeoutMs: 60_000 });

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("exceeds maximum")),
    );
  });

  // ========================================================================
  // Rule 6: concurrency-cap
  // ========================================================================

  it("should deny when concurrency limit reached", () => {
    const config = makeRuntimeConfig({ maxConcurrentJobs: 2 });
    const context = makeContext();
    const tracker = createConcurrencyTracker(2);
    tracker.acquire();
    tracker.acquire();

    const decision = engine.evaluateRuntimePolicy(context, config, tracker);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("Concurrency limit")),
    );
  });

  // ========================================================================
  // Approval
  // ========================================================================

  it("should approve valid request within all limits", () => {
    const config = makeRuntimeConfig();
    const context = makeContext();

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.strictEqual(decision.decision, "approve");
    assert.strictEqual(decision.deniedReasons, undefined);
  });

  // ========================================================================
  // Audit hash
  // ========================================================================

  it("should generate a non-empty audit hash", () => {
    const config = makeRuntimeConfig();
    const context = makeContext();

    const decision = engine.evaluateRuntimePolicy(context, config);

    assert.ok(decision.auditHash, "Expected non-empty auditHash");
    assert.ok(
      decision.auditHash.length > 10,
      "Expected hash of reasonable length",
    );
  });

  it("should produce different audit hashes for approve vs deny", () => {
    const config = makeRuntimeConfig();
    const context = makeContext();

    const approved = engine.evaluateRuntimePolicy(context, config);

    const configDenied = makeRuntimeConfig({ enabled: false });
    const denied = engine.evaluateRuntimePolicy(context, configDenied);

    assert.notStrictEqual(approved.auditHash, denied.auditHash);
  });
});

describe("config validation", () => {
  it("defaults runtime.enabled to true when omitted", () => {
    const config = RuntimeConfigSchema.parse({});
    assert.strictEqual(config.enabled, true);
  });

  it("defaults allowedRuntimes to node, typescript, python, and shell", () => {
    const config = RuntimeConfigSchema.parse({});
    assert.deepStrictEqual(config.allowedRuntimes, [
      "node",
      "typescript",
      "python",
      "shell",
    ]);
  });

  it("should accept valid runtime names in allowedRuntimes", () => {
    const config = RuntimeConfigSchema.parse({
      enabled: true,
      allowedRuntimes: ["node", "go", "rust", "typescript"],
    });
    assert.deepStrictEqual(config.allowedRuntimes, ["node", "go", "rust", "typescript"]);
  });

  it("should reject typos in allowedRuntimes", () => {
    assert.throws(() => {
      RuntimeConfigSchema.parse({
        enabled: true,
        allowedRuntimes: ["noed"],
      });
    });
  });

  it("should reject unknown runtime names", () => {
    assert.throws(() => {
      RuntimeConfigSchema.parse({
        enabled: true,
        allowedRuntimes: ["lua"],
      });
    });
  });
});
