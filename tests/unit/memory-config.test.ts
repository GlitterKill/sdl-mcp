import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("MemoryConfig schema and resolver", () => {
  it("app config accepts omitted memory section", async () => {
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const result = AppConfigSchema.safeParse({
      repos: [{ repoId: "test", rootPath: "/tmp" }],
      policy: {},
    });
    assert.ok(result.success);
    assert.strictEqual(result.data.memory, undefined);
  });

  it("repo config accepts omitted memory section", async () => {
    const { RepoConfigSchema } = await import("../../dist/config/types.js");
    const result = RepoConfigSchema.safeParse({ repoId: "test", rootPath: "/tmp" });
    assert.ok(result.success);
    assert.strictEqual(result.data.memory, undefined);
  });

  it("built-in default resolves to enabled=false", async () => {
    const { resolveMemoryConfig } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [{ repoId: "r", rootPath: "/tmp" }],
      policy: {},
    });
    const resolved = resolveMemoryConfig(config, "r");
    assert.strictEqual(resolved.enabled, false);
  });

  it("subordinate flags are gated by enabled=false", async () => {
    const { getMemoryCapabilities } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [{ repoId: "r", rootPath: "/tmp" }],
      policy: {},
    });
    const caps = getMemoryCapabilities(config, "r");
    assert.strictEqual(caps.enabled, false);
    assert.strictEqual(caps.toolsEnabled, false);
    assert.strictEqual(caps.fileSyncEnabled, false);
    assert.strictEqual(caps.surfacingEnabled, false);
    assert.strictEqual(caps.hintsEnabled, false);
  });

  it("repo-level override merges correctly", async () => {
    const { getMemoryCapabilities } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [{ repoId: "r", rootPath: "/tmp", memory: { enabled: true, fileSyncEnabled: false } }],
      policy: {},
      memory: { enabled: false },
    });
    const caps = getMemoryCapabilities(config, "r");
    assert.strictEqual(caps.enabled, true);
    assert.strictEqual(caps.fileSyncEnabled, false);
    assert.strictEqual(caps.toolsEnabled, true); // inherits default
    assert.strictEqual(caps.surfacingEnabled, true); // inherits default
  });

  it("anyRepoHasMemoryTools returns false when all repos disabled", async () => {
    const { anyRepoHasMemoryTools } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [{ repoId: "r", rootPath: "/tmp" }],
      policy: {},
    });
    assert.strictEqual(anyRepoHasMemoryTools(config), false);
  });

  it("anyRepoHasMemoryTools returns true when one repo enabled", async () => {
    const { anyRepoHasMemoryTools } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [
        { repoId: "a", rootPath: "/a" },
        { repoId: "b", rootPath: "/b", memory: { enabled: true } },
      ],
      policy: {},
    });
    assert.strictEqual(anyRepoHasMemoryTools(config), true);
  });

  it("global enabled + repo override disabled = disabled for that repo", async () => {
    const { getMemoryCapabilities } = await import("../../dist/config/memory-config.js");
    const { AppConfigSchema } = await import("../../dist/config/types.js");
    const config = AppConfigSchema.parse({
      repos: [{ repoId: "r", rootPath: "/tmp", memory: { enabled: false } }],
      policy: {},
      memory: { enabled: true },
    });
    const caps = getMemoryCapabilities(config, "r");
    assert.strictEqual(caps.enabled, false);
    assert.strictEqual(caps.toolsEnabled, false);
  });
});
