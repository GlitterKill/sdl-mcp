import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(
  join(repoRoot, "scripts", "install-local-global.ps1"),
  "utf-8",
);

describe("install-local-global.ps1", () => {
  it("verifies managed Watchman through the installed sdl-mcp resolver", () => {
    assert.match(script, /function Resolve-InstalledWatchmanBinary/);
    assert.match(script, /resolveWatchmanBinary/);
    assert.match(script, /SDL_MCP_VERIFY_PACKAGE_ROOT/);
    assert.doesNotMatch(
      script,
      /Join-Path \$globalRoot "sdl-mcp-watchman-win32-x64\/vendor\/bin\/watchman\.exe"/,
    );
  });

  it("stops managed Watchman before restaging package files", () => {
    assert.match(script, /function Stop-ManagedWatchmanBinary/);
    assert.match(script, /shutdown-server/);
    // watch-del-all must run before shutdown-server: shutting down with live
    // watcher threads crashes the vendored watchman build (teardown race).
    assert.match(script, /watch-del-all[\s\S]*shutdown-server/);
    assert.match(
      script,
      /Stop-ManagedWatchmanBinary -BinaryPath \$watchmanBinary[\s\S]*Invoke-Native node scripts\/prepare-watchman-packages\.mjs/,
    );
  });

  it("links managed Watchman packages into the checkout for symlinked global installs", () => {
    assert.match(script, /function Install-CheckoutWatchmanPackages/);
    assert.match(script, /New-Item -ItemType Junction/);
    assert.doesNotMatch(script, /npm install --no-save/);
    assert.match(script, /Install-CheckoutWatchmanPackages -RepoRoot \$repoRoot/);
  });

  it("runs the Watchman resolver from a temp mjs file to preserve Node import quotes", () => {
    assert.match(script, /Set-Content -LiteralPath \$resolverScriptPath/);
    assert.match(script, /node \$resolverScriptPath/);
    assert.doesNotMatch(script, /node --input-type=module --eval \$resolverScript/);
  });

  it("uses an existing staged Watchman binary during repo dependency install", () => {
    assert.match(script, /SDL_WATCHMAN_BINARY/);
    assert.ok(script.includes("$env:SDL_WATCHMAN_BINARY = $watchmanBinary"));
    assert.match(script, /Invoke-Native npm install --legacy-peer-deps/);
  });

  it("verifies the installed tokenizer runtime before reporting success", () => {
    assert.match(script, /Invoke-Step "Verify tokenizer runtime"/);
    assert.match(
      script,
      /require\(require\.resolve\('tokenizers', \{ paths: \[process\.argv\[1\]\] \}\)\)/,
    );
    assert.match(
      script,
      /Install local packages globally[\s\S]*Verify tokenizer runtime[\s\S]*Global sdl-mcp now points/,
    );
  });
});
