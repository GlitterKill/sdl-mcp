import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const packageRoot = join(root, "packages", "create-sdl-mcp");
const binPath = join(packageRoot, "bin", "create-sdl-mcp.mjs");

test("create-sdl-mcp package stays tiny and executable", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    files?: string[];
  };

  assert.equal(pkg.bin?.["create-sdl-mcp"], "bin/create-sdl-mcp.mjs");
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.files?.includes("LICENSE"));
  assert.ok(existsSync(join(packageRoot, "LICENSE")));
});

test("create-sdl-mcp dry-run shows quiet install and init commands", () => {
  const result = spawnSync(
    process.execPath,
    [
      binPath,
      "--dry-run",
      "--sdl-package",
      "file:../sdl-mcp-0.11.8.tgz",
      "--",
      "--client",
      "codex",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm(?:\.cmd)? install -g file:\.\.\/sdl-mcp-0\.11\.8\.tgz/);
  assert.match(result.stdout, /--foreground-scripts=false/);
  assert.match(result.stdout, /--loglevel=error/);
  assert.match(result.stdout, /--no-fund/);
  assert.match(result.stdout, /--no-audit/);
  assert.doesNotMatch(result.stdout, /npm(?:\.cmd)? exec --global/);
  assert.match(result.stdout, /node(?:\.exe)? .*sdl-mcp.*dist.*cli.*index\.js init --client codex/);
});

test("create-sdl-mcp dry-run honors skip-install", () => {
  const result = spawnSync(
    process.execPath,
    [binPath, "--dry-run", "--skip-install", "--", "--client", "codex"],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /install -g/);
  assert.doesNotMatch(result.stdout, /npm(?:\.cmd)? exec --global/);
  assert.match(result.stdout, /node(?:\.exe)? .*sdl-mcp.*dist.*cli.*index\.js init --client codex/);
});
