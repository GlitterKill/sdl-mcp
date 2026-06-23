import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isUpdateInstall,
  retrySetupCommands,
  SETUP_WIZARD_PROMPT_TIMEOUT_MS,
  shouldOfferSetupWizard,
} from "../../scripts/postinstall.mjs";

test("postinstall guard requires TTY, dist CLI, and non-CI environment", () => {
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      distCliExists: true,
    }),
    true,
  );
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: false,
      stdoutIsTTY: true,
      env: {},
      distCliExists: true,
    }),
    false,
  );
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { CI: "true" },
      distCliExists: true,
    }),
    false,
  );
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { SDL_MCP_SKIP_SETUP_WIZARD: "1" },
      distCliExists: true,
    }),
    false,
  );
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { SDL_MCP_UPDATE: "1" },
      distCliExists: true,
    }),
    false,
  );
  assert.equal(
    shouldOfferSetupWizard({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      distCliExists: false,
    }),
    false,
  );
});

test("retry commands include local bin and npx latest forms", () => {
  assert.deepEqual(retrySetupCommands(), [
    "sdl-mcp init",
    "npx --yes sdl-mcp@latest init",
  ]);
});

test("postinstall setup offer waits thirty seconds", () => {
  assert.equal(SETUP_WIZARD_PROMPT_TIMEOUT_MS, 30_000);
});

test("postinstall recognizes update installs", () => {
  assert.equal(isUpdateInstall({ SDL_MCP_UPDATE: "1" }), true);
  assert.equal(isUpdateInstall({ npm_command: "update" }), true);
  assert.equal(isUpdateInstall({ npm_config_sdl_mcp_update: "true" }), true);
  assert.equal(isUpdateInstall({}), false);
});

test("postinstall offers setup before quiet maintenance steps", () => {
  const source = readFileSync("scripts/postinstall.mjs", "utf8");

  assert.ok(
    source.indexOf("await offerSetupWizard();") < source.indexOf("for (const step of STEPS)"),
  );
  assert.match(source, /stdio: verbose \? "inherit" : "ignore"/);
});
