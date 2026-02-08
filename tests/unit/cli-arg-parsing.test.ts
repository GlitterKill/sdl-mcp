import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseIndexOptions,
  parseServeOptions,
} from "../../dist/cli/argParsing.js";
import type { CLIOptions } from "../../dist/cli/types.js";

describe("CLI arg parsing", () => {
  const global: CLIOptions = {};

  it("prefers parsed --repo-id and --watch values for index command", () => {
    const options = parseIndexOptions([], global, {
      watch: true,
      "repo-id": "repo-from-values",
    });

    assert.strictEqual(options.watch, true);
    assert.strictEqual(options.repoId, "repo-from-values");
  });

  it("prefers parsed transport values for serve command", () => {
    const options = parseServeOptions([], global, {
      http: true,
      host: "127.0.0.1",
      port: "4567",
    });

    assert.strictEqual(options.transport, "http");
    assert.strictEqual(options.host, "127.0.0.1");
    assert.strictEqual(options.port, 4567);
  });
});
