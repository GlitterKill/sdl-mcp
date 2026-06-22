import assert from "node:assert/strict";
import test from "node:test";

import { parseInitOptions } from "../../src/cli/argParsing.ts";

test("--agents parses comma-separated agent list", () => {
  const options = parseInitOptions(
    ["--agents", "codex,claude-code"],
    {},
    {},
  );

  assert.deepEqual(options.agents, ["codex", "claude-code"]);
});

test("--client remains a single-agent alias", () => {
  const options = parseInitOptions(["--client", "codex"], {}, {});

  assert.equal(options.client, "codex");
});

test("--from-postinstall is parsed as a hidden init flag", () => {
  const options = parseInitOptions(["--from-postinstall"], {}, {});

  assert.equal(options.fromPostinstall, true);
});
