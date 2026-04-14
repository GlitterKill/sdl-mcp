import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionMap, routeGatewayCall } from "../../dist/gateway/router.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("Gateway router", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so all 31 actions are present
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-gw-router-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: [{ repoId: "test", rootPath: tmpDir, memory: { enabled: true } }],
      policy: {},
    }));
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    invalidateConfigCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createActionMap", () => {
    it("contains all 31 actions", () => {
      const map = createActionMap();
      const actions = Object.keys(map);
      assert.strictEqual(actions.length, 31);
    });

    it("each entry has schema and handler", () => {
      const map = createActionMap();
      for (const [action, entry] of Object.entries(map)) {
        assert.ok(entry.schema, `${action} missing schema`);
        assert.ok(
          typeof entry.handler === "function",
          `${action} missing handler`,
        );
      }
    });

    it("contains known actions", () => {
      const map = createActionMap();
      const expected = [
        "symbol.search",
        "symbol.getCard",
        "slice.build",
        "slice.refresh",
        "slice.spillover.get",
        "delta.get",
        "pr.risk.analyze",
        "code.needWindow",
        "code.getSkeleton",
        "code.getHotPath",
        "repo.register",
        "repo.status",
        "repo.overview",
        "index.refresh",
        "policy.get",
        "policy.set",
        "usage.stats",
        "file.read",
        "agent.feedback",
        "agent.feedback.query",
        "buffer.push",
        "buffer.checkpoint",
        "buffer.status",
        "runtime.execute",
        "runtime.queryOutput",
        "memory.store",
        "memory.query",
        "memory.remove",
        "memory.surface",
      ];
      for (const name of expected) {
        assert.ok(name in map, `Missing action: ${name}`);
      }
    });
  });

  describe("routeGatewayCall", () => {
    it("throws for unknown action", async () => {
      const map = createActionMap();
      await assert.rejects(
        () =>
          routeGatewayCall({ action: "unknown.action", repoId: "test" }, map),
        /Unknown gateway action/,
      );
    });

    it("merges repoId into action params", async () => {
      // Create a mock action map with a test handler
      let receivedArgs: unknown = null;
      const mockMap = {
        "test.action": {
          schema: {
            parse(args: unknown) {
              return args;
            },
          },
          handler: async (args: unknown) => {
            receivedArgs = args;
            return { ok: true };
          },
        },
      };

      await routeGatewayCall(
        { action: "test.action", repoId: "my-repo", extra: "data" },
        mockMap as any,
      );

      assert.deepStrictEqual(receivedArgs, {
        repoId: "my-repo",
        extra: "data",
      });
    });

    it("strips action field from handler params", async () => {
      let receivedArgs: unknown = null;
      const mockMap = {
        "test.strip": {
          schema: {
            parse(args: unknown) {
              return args;
            },
          },
          handler: async (args: unknown) => {
            receivedArgs = args;
            return {};
          },
        },
      };

      await routeGatewayCall(
        { action: "test.strip", repoId: "r", foo: "bar" },
        mockMap as any,
      );

      const received = receivedArgs as Record<string, unknown>;
      assert.strictEqual(received.action, undefined);
      assert.strictEqual(received.repoId, "r");
      assert.strictEqual(received.foo, "bar");
    });
  });
});
