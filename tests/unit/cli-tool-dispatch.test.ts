import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert";
import { join, resolve } from "path";
import {
  normalizeToolActionName,
  resolveRepoId,
  suggestAction,
} from "../../dist/cli/commands/tool-dispatch.js";

function cliMetaEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "sdl-cli-meta-"));
  const blocker = join(dir, "not-a-directory");
  const configPath = join(dir, "sdlmcp.config.json");
  writeFileSync(blocker, "blocks graph init");
  writeFileSync(configPath, JSON.stringify({ repos: [], policy: {} }));
  return {
    ...process.env,
    SDL_CONFIG: configPath,
    SDL_GRAPH_DB_PATH: join(blocker, "graph.lbug"),
  };
}

function cliMemoryDisabledEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "sdl-cli-memory-disabled-"));
  const configPath = join(dir, "sdlmcp.config.json");
  const graphPath = join(dir, "graph.lbug");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: [{ repoId: "demo-repo", rootPath: dir, semantic: { enabled: false } }],
      policy: {},
      semantic: { enabled: false },
      graphDatabase: { path: graphPath },
    }),
  );
  return {
    ...process.env,
    SDL_CONFIG: configPath,
    SDL_GRAPH_DB_PATH: graphPath,
    SDL_MCP_DISABLE_NATIVE_ADDON: "1",
  };
}
function runTool(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [resolve("dist/cli/index.js"), "tool", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

function parseSuccessfulJson(result: ReturnType<typeof runTool>): unknown {
  assert.strictEqual(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout) as unknown;
}

describe("cli-tool-dispatch", () => {
  it("seals the family after successful and failed actions, permitting repeated CLI opens", () => {
    const env = cliMemoryDisabledEnv();
    const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { loadConfig } from './dist/config/loadConfig.js';
      import { initGraphDb } from './dist/db/initGraphDb.js';
      import { withWriteConn, closeLadybugDb } from './dist/db/ladybug.js';
      import { upsertRepo } from './dist/db/ladybug-repos.js';
      const config = loadConfig(process.env.SDL_CONFIG);
      await initGraphDb(config, process.env.SDL_CONFIG);
      await withWriteConn(conn => upsertRepo(conn, {
        ...config.repos[0], configJson: JSON.stringify(config.repos[0]),
        createdAt: new Date().toISOString(),
      }));
      await closeLadybugDb({ strict: true });
      process.exit(0);
    `], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = runTool(["repo.status", "--repo-id", "demo-repo", "--json"], env);
      const payload = parseSuccessfulJson(result) as { repoId: string };
      assert.equal(payload.repoId, "demo-repo");
      assert.equal(existsSync(env.SDL_GRAPH_DB_PATH + ".sdl-family.lock"), false);
      assert.equal(existsSync(env.SDL_GRAPH_DB_PATH + ".sdl-lineage.json"), true);
    }
    const failed = runTool(["repo.status", "--repo-id", "missing", "--json"], env);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Repository missing not found/);
    assert.equal(existsSync(env.SDL_GRAPH_DB_PATH + ".sdl-family.lock"), false);
    parseSuccessfulJson(runTool(["repo.status", "--repo-id", "demo-repo", "--json"], env));
  });

  it("closes strictly before output and preserves initialization, handler and close errors", () => {
    const child = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      const events = [];
      let openError, actionError, closeError;
      const ladybug = await import('./dist/db/ladybug.js');
      mock.module('./dist/db/ladybug.js', { namedExports: {
        ...ladybug,
        closeLadybugDb: async options => {
          assert.deepEqual(options, { strict: true });
          events.push('close');
          if (closeError) throw closeError;
        },
      }});
      mock.module('./dist/db/initGraphDb.js', { namedExports: {
        initGraphDb: async () => { events.push('open'); if (openError) throw openError; },
      }});
      mock.module('./dist/startup/plugins.js', { namedExports: {
        loadConfiguredAdapterPlugins: async () => {},
      }});
      mock.module('./dist/code-mode/index.js', { namedExports: {
        handleActionSearch: () => ({}), handleManual: () => ({}),
      }});
      mock.module('./dist/gateway/router.js', { namedExports: {
        createActionMap: () => ({ 'repo.status': { handler: async () => {
          events.push('handler'); if (actionError) throw actionError; return { ok: true };
        }}}),
        prepareActionEntryArgs: (_action, _entry, args) => args,
      }});
      process.stdin.isTTY = true;
      process.stdout.write = () => { events.push('output'); return true; };
      const { toolDispatchCommand } = await import('./dist/cli/commands/tool-dispatch.js');
      const dispatch = () => toolDispatchCommand({ action: 'repo.status', rawArgs: ['--repo-id', 'demo-repo', '--json'] });
      await dispatch();
      assert.deepEqual(events, ['open', 'handler', 'close', 'output']);
      for (const stage of ['open', 'handler', 'close', 'both']) {
        events.length = 0;
        openError = stage === 'open' ? new Error('family lock owner PID 123 is not running') : undefined;
        actionError = stage === 'handler' || stage === 'both' ? new Error('handler failed') : undefined;
        closeError = stage === 'close' || stage === 'both' ? new Error('checkpoint failed') : undefined;
        await assert.rejects(dispatch, error => {
          if (stage === 'both') {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [actionError, closeError]);
            assert.match(error.message, /handler failed.*checkpoint failed/);
          } else assert.equal(error, openError ?? actionError ?? closeError);
          return true;
        });
        assert.equal(events.filter(event => event === 'close').length, 1);
        assert.ok(!events.includes('output'));
      }
    `], { env: cliMemoryDisabledEnv(), encoding: "utf8", timeout: 60_000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });

  describe("resolveRepoId", () => {
    it("uses explicit repoId if provided", () => {
      const explicit = "my-explicit-repo";
      const repos = [{ repoId: "configured-repo", rootPath: "/path/to/repo" }];
      assert.strictEqual(resolveRepoId(explicit, repos), "my-explicit-repo");
    });

    it("matches cwd to configured repo root", () => {
      const cwd = process.cwd();
      const repos = [
        { repoId: "other-repo", rootPath: "/some/other/path" },
        { repoId: "cwd-repo", rootPath: cwd },
      ];
      // It should match the second repo because it matches cwd
      assert.strictEqual(resolveRepoId(undefined, repos), "cwd-repo");
    });

    it("prefers the longest path-boundary match for sibling repo roots", () => {
      const originalCwd = process.cwd();
      const root = mkdtempSync(join(tmpdir(), "sdl-repo-match-"));
      const appRoot = join(root, "app");
      const appToolsRoot = join(root, "app-tools");
      mkdirSync(appRoot, { recursive: true });
      mkdirSync(appToolsRoot, { recursive: true });

      try {
        process.chdir(appToolsRoot);
        const repos = [
          { repoId: "app", rootPath: appRoot },
          { repoId: "app-tools", rootPath: appToolsRoot },
        ];

        assert.strictEqual(resolveRepoId(undefined, repos), "app-tools");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("matches cwd to a subdirectory of a configured repo", () => {
      const cwd = process.cwd();
      const parentDir = resolve(cwd, "..");
      const repos = [
        { repoId: "parent-repo", rootPath: parentDir },
      ];
      // CWD is a subdirectory of the configured rootPath
      assert.strictEqual(resolveRepoId(undefined, repos), "parent-repo");
    });

    it("falls back to single configured repo if no match", () => {
      const repos = [{ repoId: "single-repo", rootPath: "/non-matching/path" }];
      assert.strictEqual(resolveRepoId(undefined, repos), "single-repo");
    });

    it("returns undefined if multiple repos and no match", () => {
      const repos = [
        { repoId: "repo1", rootPath: "/non/matching/1" },
        { repoId: "repo2", rootPath: "/non/matching/2" },
      ];
      assert.strictEqual(resolveRepoId(undefined, repos), undefined);
    });

    it("returns undefined if no repos configured", () => {
      assert.strictEqual(resolveRepoId(undefined, []), undefined);
    });
  });

  describe("suggestAction", () => {
    it("finds exact prefix matches", () => {
      assert.strictEqual(suggestAction("symbol.sear"), "symbol.search");
      assert.strictEqual(suggestAction("slice.b"), "slice.build");
    });

    it("finds substring matches", () => {
      assert.strictEqual(suggestAction("overview"), "repo.overview");
    });

    it("returns undefined for ambiguous matches", () => {
      assert.strictEqual(suggestAction("symbol"), undefined); // multiple symbol.* actions
    });

    it("returns undefined for no matches", () => {
      assert.strictEqual(suggestAction("does.not.exist"), undefined);
    });
  });

  describe("normalizeToolActionName", () => {
    it("normalizes supported sdl. meta aliases", () => {
      assert.strictEqual(normalizeToolActionName("sdl.action.search"), "action.search");
      assert.strictEqual(normalizeToolActionName("sdl.manual"), "manual");
    });

    it("leaves unsupported meta aliases for explicit rejection", () => {
      assert.strictEqual(normalizeToolActionName("sdl.context"), "sdl.context");
    });
  });

  describe("CLI meta dispatch", () => {
    it("rejects detached refresh before opening the database", () => {
      const result = runTool([
        "index.refresh",
        '{"repoId":"demo-repo","mode":"incremental","async":true,"reason":"test"}',
        "--json",
      ], cliMetaEnv());
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot run in the background/);
      assert.doesNotMatch(result.stderr, /LadybugDB initialization/);
    });

    it("runs action.search without graph DB initialization", () => {
      const result = runTool([
        "action.search",
        "--query",
        "manual",
        "--limit",
        "5",
        "--output-format",
        "json-compact",
      ], cliMetaEnv());
      const payload = parseSuccessfulJson(result) as { actions?: Array<{ action: string }> };

      assert.ok(payload.actions?.some((entry) => entry.action === "manual"));
    });

    it("accepts positional JSON and --json for action arguments", () => {
      const payload = parseSuccessfulJson(
        runTool([
          "action.search",
          "{\"query\":\"manual\",\"limit\":1}",
          "--json",
        ], cliMetaEnv()),
      ) as { actions?: Array<{ action: string }> };

      assert.equal(payload.actions?.length, 1);
      assert.equal(payload.actions?.[0]?.action, "manual");
    });

    it("reports disabled memory actions instead of missing handlers", () => {
      const result = runTool([
        "memory.query",
        "--repo-id",
        "demo-repo",
        "--query",
        "auth",
        "--json",
      ], cliMemoryDisabledEnv());

      const combined = result.stdout + "\n" + result.stderr;
      assert.notStrictEqual(result.status, 0);
      assert.match(
        combined,
        /disabled action "memory\.query"|memory\.enabled: true/,
      );
      assert.doesNotMatch(combined, /not found in handler map/);
    });
    it("runs sdl.action.search as an equivalent alias", () => {
      const args = [
        "--query",
        "manual",
        "--summary-only",
        "--output-format",
        "json-compact",
      ];
      const direct = parseSuccessfulJson(runTool(["action.search", ...args], cliMetaEnv()));
      const alias = parseSuccessfulJson(runTool(["sdl.action.search", ...args], cliMetaEnv()));

      assert.deepStrictEqual(alias, direct);
    });

    it("returns focused manual content without graph DB initialization", () => {
      const result = runTool([
        "manual",
        "--actions",
        "action.search",
        "--format",
        "json",
        "--output-format",
        "json-compact",
      ], cliMetaEnv());
      const payload = parseSuccessfulJson(result) as { actions?: Array<{ action: string }> };

      assert.deepStrictEqual(payload.actions?.map((entry) => entry.action), ["action.search"]);
    });

    it("lists repo.register update guard flags in action help", () => {
      const result = runTool(["repo.register", "--help"]);

      assert.strictEqual(
        result.status,
        0,
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /--dry-run/);
      assert.match(result.stdout, /--update-existing/);
    });

    it("rejects unsupported meta tools with the supported CLI proxies", () => {
      for (const action of [
        "sdl.context",
        "context",
        "sdl.workflow",
        "workflow",
        "sdl.file",
        "file",
      ]) {
        const result = runTool([action, "--output-format", "json-compact"]);

        assert.notStrictEqual(result.status, 0, action);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /Only action\.search and manual are proxied metadata tools/,
        );
      }
    });

    it("rejects symbol.edit apply because CLI plan handles are process-local", () => {
      const result = runTool([
        "symbol.edit",
        "--repo-id",
        "demo-repo",
        "--mode",
        "apply",
        "--plan-handle",
        "se-demo",
        "--output-format",
        "json-compact",
      ], cliMetaEnv());

      assert.notStrictEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /process-local preview plan/,
      );
    });
  });
});
