import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideRuntime,
  decideRuntimeLegacy,
} from "../../../dist/policy/runtime.js";
import type { RuntimePolicyRequestContext } from "../../../dist/policy/types.js";
import { RuntimeConfigSchema } from "../../../dist/config/types.js";
import type { RuntimeConfig } from "../../../dist/config/types.js";

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

describe("decideRuntime — approve path", () => {
  it("approves a valid node-runtime request", () => {
    const decision = decideRuntime(makeContext(), makeRuntimeConfig());
    assert.equal(decision.kind, "approve");
    if (decision.kind !== "approve") return;
    assert.ok(
      typeof decision.auditHash === "string" && decision.auditHash.length > 0,
    );
    assert.ok(Array.isArray(decision.evidenceUsed));
  });

  it("approves when allowedExecutables is empty (any compatible exe allowed)", () => {
    const decision = decideRuntime(
      makeContext({ executable: "node" }),
      makeRuntimeConfig({ allowedExecutables: [] }),
    );
    assert.equal(decision.kind, "approve");
  });
});

describe("decideRuntime — deny path", () => {
  it("denies when runtime is disabled globally", () => {
    const decision = decideRuntime(
      makeContext(),
      makeRuntimeConfig({ enabled: false }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some((r) => r.toLowerCase().includes("disabled")),
    );
  });

  it("denies when runtime is not in allowedRuntimes", () => {
    const decision = decideRuntime(
      makeContext({ runtime: "node" }),
      makeRuntimeConfig({ allowedRuntimes: ["python"] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not in the allowed runtimes"),
      ),
    );
  });

  it("denies when executable is incompatible with the runtime", () => {
    const decision = decideRuntime(
      makeContext({ runtime: "node", executable: "powershell" }),
      makeRuntimeConfig({ allowedExecutables: [] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not compatible with runtime"),
      ),
    );
  });

  it("denies when executable is not on allowedExecutables list", () => {
    const decision = decideRuntime(
      makeContext({ executable: "node" }),
      makeRuntimeConfig({ allowedExecutables: ["python3"] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.includes("not in the allowed executables"),
      ),
    );
  });

  it("denies when timeoutMs exceeds maxDurationMs", () => {
    const decision = decideRuntime(
      makeContext({ timeoutMs: 999_999 }),
      makeRuntimeConfig({ maxDurationMs: 60_000 }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some(
        (r) =>
          r.toLowerCase().includes("timeout") ||
          r.toLowerCase().includes("duration"),
      ),
    );
  });

  it("denies when relativeCwd attempts path traversal", () => {
    const decision = decideRuntime(
      makeContext({ relativeCwd: "../escape" }),
      makeRuntimeConfig(),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(decision.deniedReasons.length > 0);
  });

  it("denies when envKeys include a disallowed env name", () => {
    const decision = decideRuntime(
      makeContext({ envKeys: ["AWS_SECRET_ACCESS_KEY"] }),
      makeRuntimeConfig({ envAllowlist: ["NODE_ENV"] }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") return;
    assert.ok(
      decision.deniedReasons.some((r) => r.toLowerCase().includes("env")),
    );
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("AWS_SECRET_ACCESS_KEY")),
      "denial message should name the offending env key",
    );
  });

  it("approves when envKeys are all in envAllowlist", () => {
    const decision = decideRuntime(
      makeContext({ envKeys: ["NODE_ENV"] }),
      makeRuntimeConfig({ envAllowlist: ["NODE_ENV"] }),
    );
    assert.equal(decision.kind, "approve");
  });
});

describe("decideRuntime — concurrency tracker", () => {
  it("denies when active count is at the configured limit", () => {
    const tracker = {
      activeCount: 4,
      acquire: () => true,
      release: () => {},
    } as any;
    const decision = decideRuntime(
      makeContext(),
      makeRuntimeConfig({ maxConcurrentJobs: 4 }),
      tracker,
    );
    assert.equal(decision.kind, "deny");
  });

  it("approves when concurrency is below the limit", () => {
    const tracker = {
      activeCount: 0,
      acquire: () => true,
      release: () => {},
    } as any;
    const decision = decideRuntime(
      makeContext(),
      makeRuntimeConfig({ maxConcurrentJobs: 4 }),
      tracker,
    );
    assert.equal(decision.kind, "approve");
  });
});

describe("decideRuntimeLegacy — backward-compat shape", () => {
  it("returns a legacy RuntimePolicyDecision with decision='approve' on success", () => {
    const legacy = decideRuntimeLegacy(makeContext(), makeRuntimeConfig());
    assert.equal(legacy.decision, "approve");
    assert.ok(typeof legacy.auditHash === "string");
    assert.equal(legacy.deniedReasons, undefined);
  });

  it("returns a legacy RuntimePolicyDecision with decision='deny' on failure", () => {
    const legacy = decideRuntimeLegacy(
      makeContext(),
      makeRuntimeConfig({ enabled: false }),
    );
    assert.equal(legacy.decision, "deny");
    assert.ok(Array.isArray(legacy.deniedReasons));
    assert.ok((legacy.deniedReasons ?? []).length > 0);
  });
});
