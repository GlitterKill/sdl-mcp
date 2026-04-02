/**
 * Tests for memory tool exposure gating.
 *
 * Validates that memory tools are hidden from all discovery surfaces
 * (flat descriptors, gateway action map, manual, catalog) when no
 * configured repo has memory tools enabled.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Save original env to restore after tests
const originalSdlConfig = process.env.SDL_CONFIG;

describe("memory tool exposure gating", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-mem-exposure-"));
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- memory-config.ts unit tests ---

  describe("anyRepoHasMemoryTools", () => {
    it("returns false when no memory config is set", async () => {
      const { anyRepoHasMemoryTools } = await import(
        "../../dist/config/memory-config.js"
      );
      const result = anyRepoHasMemoryTools({
        repos: [{ repoId: "r", rootPath: tmpDir, ignore: [], languages: [], maxFileBytes: 1024, includeNodeModulesTypes: false }],
        policy: {},
      } as any);
      assert.strictEqual(result, false);
    });

    it("returns false when memory.enabled is false", async () => {
      const { anyRepoHasMemoryTools } = await import(
        "../../dist/config/memory-config.js"
      );
      const result = anyRepoHasMemoryTools({
        repos: [{ repoId: "r", rootPath: tmpDir, ignore: [], languages: [], maxFileBytes: 1024, includeNodeModulesTypes: false }],
        memory: { enabled: false },
        policy: {},
      } as any);
      assert.strictEqual(result, false);
    });

    it("returns true when app-level memory.enabled is true", async () => {
      const { anyRepoHasMemoryTools } = await import(
        "../../dist/config/memory-config.js"
      );
      const result = anyRepoHasMemoryTools({
        repos: [{ repoId: "r", rootPath: tmpDir, ignore: [], languages: [], maxFileBytes: 1024, includeNodeModulesTypes: false }],
        memory: { enabled: true, toolsEnabled: true, fileSyncEnabled: true, autoSurfaceEnabled: true },
        policy: {},
      } as any);
      assert.strictEqual(result, true);
    });

    it("returns true when a repo has memory.enabled", async () => {
      const { anyRepoHasMemoryTools } = await import(
        "../../dist/config/memory-config.js"
      );
      const result = anyRepoHasMemoryTools({
        repos: [{
          repoId: "r",
          rootPath: tmpDir,
          ignore: [],
          languages: [],
          maxFileBytes: 1024,
          includeNodeModulesTypes: false,
          memory: { enabled: true, toolsEnabled: true, fileSyncEnabled: true, autoSurfaceEnabled: true },
        }],
        policy: {},
      } as any);
      assert.strictEqual(result, true);
    });

    it("returns false when master gate is on but toolsEnabled is false", async () => {
      const { anyRepoHasMemoryTools } = await import(
        "../../dist/config/memory-config.js"
      );
      const result = anyRepoHasMemoryTools({
        repos: [{ repoId: "r", rootPath: tmpDir, ignore: [], languages: [], maxFileBytes: 1024, includeNodeModulesTypes: false }],
        memory: { enabled: true, toolsEnabled: false, fileSyncEnabled: true, autoSurfaceEnabled: true },
        policy: {},
      } as any);
      assert.strictEqual(result, false);
    });
  });

  describe("getMemoryCapabilities", () => {
    it("applies master gate to disable all sub-features", async () => {
      const { getMemoryCapabilities } = await import(
        "../../dist/config/memory-config.js"
      );
      const caps = getMemoryCapabilities({
        repos: [{ repoId: "r", rootPath: tmpDir, ignore: [], languages: [], maxFileBytes: 1024, includeNodeModulesTypes: false }],
        memory: { enabled: false, toolsEnabled: true, fileSyncEnabled: true, autoSurfaceEnabled: true },
        policy: {},
      } as any);
      assert.strictEqual(caps.enabled, false);
      assert.strictEqual(caps.toolsEnabled, false);
      assert.strictEqual(caps.fileSyncEnabled, false);
      assert.strictEqual(caps.autoSurfaceEnabled, false);
    });

    it("respects per-repo override", async () => {
      const { getMemoryCapabilities } = await import(
        "../../dist/config/memory-config.js"
      );
      const caps = getMemoryCapabilities(
        {
          repos: [{
            repoId: "r",
            rootPath: tmpDir,
            ignore: [],
            languages: [],
            maxFileBytes: 1024,
            includeNodeModulesTypes: false,
            memory: { enabled: true, toolsEnabled: true, fileSyncEnabled: false, autoSurfaceEnabled: true },
          }],
          policy: {},
        } as any,
        "r",
      );
      assert.strictEqual(caps.enabled, true);
      assert.strictEqual(caps.toolsEnabled, true);
      assert.strictEqual(caps.fileSyncEnabled, false);
    });
  });

  // --- Integration: action map filtering ---

  describe("createActionMap gating", () => {
    it("excludes memory actions when memory is disabled", async () => {
      const configPath = join(tmpDir, "disabled-actionmap.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      // Invalidate cached config
      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { createActionMap } = await import("../../dist/gateway/router.js");
      const map = createActionMap();
      assert.strictEqual(map["memory.store"], undefined, "memory.store should be absent");
      assert.strictEqual(map["memory.query"], undefined, "memory.query should be absent");
      assert.strictEqual(map["memory.remove"], undefined, "memory.remove should be absent");
      assert.strictEqual(map["memory.surface"], undefined, "memory.surface should be absent");
      // Other actions should still be present
      assert.ok(map["symbol.search"], "symbol.search should be present");
      assert.ok(map["repo.status"], "repo.status should be present");
    });

    it("includes memory actions when memory is enabled", async () => {
      const configPath = join(tmpDir, "enabled-actionmap.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir, memory: { enabled: true } }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { createActionMap } = await import("../../dist/gateway/router.js");
      const map = createActionMap();
      assert.ok(map["memory.store"], "memory.store should be present");
      assert.ok(map["memory.query"], "memory.query should be present");
      assert.ok(map["memory.remove"], "memory.remove should be present");
      assert.ok(map["memory.surface"], "memory.surface should be present");
    });
  });

  // --- Integration: flat tool descriptor filtering ---

  describe("buildFlatToolDescriptors gating", () => {
    it("excludes memory tools when memory is disabled", async () => {
      const configPath = join(tmpDir, "disabled-flat.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { buildFlatToolDescriptors } = await import(
        "../../dist/mcp/tools/tool-descriptors.js"
      );
      const descriptors = buildFlatToolDescriptors({});
      const memTools = descriptors.filter((d: any) =>
        d.name.startsWith("sdl.memory."),
      );
      assert.strictEqual(memTools.length, 0, "memory tools should be hidden");
      // Non-memory tools should still be present
      const repoRegister = descriptors.find(
        (d: any) => d.name === "sdl.repo.register",
      );
      assert.ok(repoRegister, "sdl.repo.register should be present");
    });

    it("includes memory tools when memory is enabled", async () => {
      const configPath = join(tmpDir, "enabled-flat.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir, memory: { enabled: true } }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { buildFlatToolDescriptors } = await import(
        "../../dist/mcp/tools/tool-descriptors.js"
      );
      const descriptors = buildFlatToolDescriptors({});
      const memTools = descriptors.filter((d: any) =>
        d.name.startsWith("sdl.memory."),
      );
      assert.strictEqual(
        memTools.length,
        4,
        "all 4 memory tools should be present",
      );
    });
  });

  // --- Integration: manual generator filtering ---

  describe("manual generator gating", () => {
    it("excludes memory section when memory is disabled", async () => {
      const configPath = join(tmpDir, "disabled-manual.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { generateManual, invalidateManualCache } = await import(
        "../../dist/code-mode/manual-generator.js"
      );
      invalidateManualCache();
      const manual = generateManual();
      assert.ok(
        !manual.includes("// === Memory ==="),
        "Memory section should be stripped",
      );
      assert.ok(
        !manual.includes("function memoryStore"),
        "memoryStore fn should be stripped",
      );
      // Non-memory sections should remain
      assert.ok(
        manual.includes("// === Query ==="),
        "Query section should remain",
      );
    });

    it("includes memory section when memory is enabled", async () => {
      const configPath = join(tmpDir, "enabled-manual.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir, memory: { enabled: true } }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { generateManual, invalidateManualCache } = await import(
        "../../dist/code-mode/manual-generator.js"
      );
      invalidateManualCache();
      const manual = generateManual();
      assert.ok(
        manual.includes("// === Memory ==="),
        "Memory section should be present",
      );
      assert.ok(
        manual.includes("function memoryStore"),
        "memoryStore fn should be present",
      );
    });
  });

  // --- Integration: FN_NAME_MAP filtering ---

  describe("getActiveFnNameMap gating", () => {
    it("excludes memory fn names when memory is disabled", async () => {
      const configPath = join(tmpDir, "disabled-fnmap.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { getActiveFnNameMap } = await import(
        "../../dist/code-mode/manual-generator.js"
      );
      const fnMap = getActiveFnNameMap();
      assert.strictEqual(fnMap.memoryStore, undefined);
      assert.strictEqual(fnMap.memoryQuery, undefined);
      assert.strictEqual(fnMap.memoryRemove, undefined);
      assert.strictEqual(fnMap.memorySurface, undefined);
      // Non-memory entries should remain
      assert.ok(fnMap.symbolSearch, "symbolSearch should be present");
    });

    it("includes memory fn names when memory is enabled", async () => {
      const configPath = join(tmpDir, "enabled-fnmap.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir, memory: { enabled: true } }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { getActiveFnNameMap } = await import(
        "../../dist/code-mode/manual-generator.js"
      );
      const fnMap = getActiveFnNameMap();
      assert.strictEqual(fnMap.memoryStore, "memory.store");
      assert.strictEqual(fnMap.memoryQuery, "memory.query");
      assert.strictEqual(fnMap.memoryRemove, "memory.remove");
      assert.strictEqual(fnMap.memorySurface, "memory.surface");
    });
  });

  // --- Integration: AGENT_DESCRIPTION gating ---

  describe("getAgentDescription gating", () => {
    it("excludes memory actions from description when memory is disabled", async () => {
      const configPath = join(tmpDir, "disabled-desc.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { getAgentDescription } = await import(
        "../../dist/gateway/descriptions.js"
      );
      const desc = getAgentDescription();
      assert.ok(
        !desc.includes("memory.store"),
        "memory.store should not be in description",
      );
      assert.ok(
        !desc.includes("memory.query"),
        "memory.query should not be in description",
      );
      // Non-memory actions should remain
      assert.ok(
        desc.includes("agent.context"),
        "agent.context should be in description",
      );
      assert.ok(
        desc.includes("runtime.execute"),
        "runtime.execute should be in description",
      );
    });

    it("includes memory actions in description when memory is enabled", async () => {
      const configPath = join(tmpDir, "enabled-desc.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "r", rootPath: tmpDir, memory: { enabled: true } }],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;

      const { invalidateConfigCache } = await import(
        "../../dist/config/loadConfig.js"
      );
      invalidateConfigCache();

      const { getAgentDescription } = await import(
        "../../dist/gateway/descriptions.js"
      );
      const desc = getAgentDescription();
      assert.ok(
        desc.includes("memory.store"),
        "memory.store should be in description",
      );
      assert.ok(
        desc.includes("memory.query"),
        "memory.query should be in description",
      );
    });
  });
});
