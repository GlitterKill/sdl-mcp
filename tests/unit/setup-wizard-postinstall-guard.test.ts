import assert from "node:assert/strict";
import test from "node:test";

import {
  retrySetupCommands,
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
