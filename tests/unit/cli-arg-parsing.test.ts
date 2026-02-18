import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseInitOptions,
  parseIndexOptions,
  parseServeOptions,
  parseSummaryOptions,
  parseHealthOptions,
} from "../../src/cli/argParsing.js";
import type { CLIOptions } from "../../src/cli/types.js";

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

  it("parses --force for index command", () => {
    const options = parseIndexOptions([], global, {
      force: true,
    });

    assert.strictEqual(options.force, true);
  });

  it("parses init automation flags", () => {
    const options = parseInitOptions(["-y", "--auto-index", "--dry-run"], global, {});
    assert.strictEqual(options.yes, true);
    assert.strictEqual(options.autoIndex, true);
    assert.strictEqual(options.dryRun, true);
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

  it("parses summary options with short preset and json format", () => {
    const options = parseSummaryOptions(
      ["auth", "--short", "--format", "json"],
      global,
      {},
    );

    assert.strictEqual(options.query, "auth");
    assert.strictEqual(options.budget, 500);
    assert.strictEqual(options.format, "json");
  });

  it("parses health options for json and badge modes", () => {
    const options = parseHealthOptions([], global, {
      json: true,
      badge: true,
      "repo-id": "test-repo",
    });

    assert.strictEqual(options.jsonOutput, true);
    assert.strictEqual(options.badge, true);
    assert.strictEqual(options.repoId, "test-repo");
  });
});
