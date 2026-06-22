import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunSetupWizard } from "../../src/cli/setup-wizard/run.ts";

test("-y and non-TTY skip the setup wizard", () => {
  assert.equal(shouldRunSetupWizard({ yes: true }, true), false);
  assert.equal(shouldRunSetupWizard({}, false), false);
});

test("normal TTY init runs the setup wizard", () => {
  assert.equal(shouldRunSetupWizard({}, true), true);
});

test("postinstall flag still runs only when TTY is available", () => {
  assert.equal(shouldRunSetupWizard({ fromPostinstall: true }, true), true);
  assert.equal(shouldRunSetupWizard({ fromPostinstall: true }, false), false);
});
