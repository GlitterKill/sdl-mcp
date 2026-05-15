import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
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
  writeFileSync(blocker, "blocks graph init");
  return {
    ...process.env,
    SDL_GRAPH_DB_PATH: join(blocker, "graph.lbug"),
  };
}

function runTool(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [resolve("dist/cli/index.js"), "tool", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
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
