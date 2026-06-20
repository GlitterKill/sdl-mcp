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
});
