import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("packages/create-sdl-mcp/bin/create-sdl-mcp.mjs", "utf8");

test("create-sdl-mcp exposes a minimalist update install path", () => {
  assert.match(source, /--update/);
  assert.match(source, /SDL_MCP_UPDATE/);
  assert.match(source, /init --repo-path/);
  assert.match(source, /options\.update \|\| options\.yes/);
});
