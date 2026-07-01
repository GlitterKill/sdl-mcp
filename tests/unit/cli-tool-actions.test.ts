import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_MAP,
  ALL_ACTION_NAMES,
} from "../../dist/cli/commands/tool-actions.js";
import { ALL_ACTIONS } from "../../dist/gateway/schemas.js";

describe("CLI tool actions", () => {
  it("stays in sync with gateway schema actions plus CLI-only action proxies", () => {
    const expected = new Set([
      ...ALL_ACTIONS,
      "action.search",
      "file.write",
      "manual",
    ]);
    assert.deepStrictEqual(
      [...ALL_ACTION_NAMES].sort(),
      [...expected].sort(),
    );
  });

  it("exposes file.write with CLI-friendly write-mode flags", () => {
    const definition = ACTION_MAP.get("file.write");
    assert.ok(definition);
    assert.strictEqual(definition.namespace, "repo");

    const fields = new Set(definition.args.map((arg) => arg.field));
    assert.ok(fields.has("repoId"));
    assert.ok(fields.has("filePath"));
    assert.ok(fields.has("content"));
    assert.ok(fields.has("replaceLines"));
    assert.ok(fields.has("replacePattern"));
    assert.ok(fields.has("jsonPath"));
    assert.ok(fields.has("jsonValue"));
    assert.ok(fields.has("insertAt"));
    assert.ok(fields.has("append"));
    assert.ok(fields.has("createBackup"));
    assert.ok(fields.has("createIfMissing"));

    assert.strictEqual(
      definition.args.find((arg) => arg.flag === "--no-backup")?.invertBoolean,
      true,
    );
  });

  it("exposes usage.stats detail selection", () => {
    const definition = ACTION_MAP.get("usage.stats");
    assert.ok(definition);

    const detailArg = definition.args.find((arg) => arg.flag === "--detail");
    assert.equal(detailArg?.field, "detail");
    assert.equal(detailArg?.type, "string");
  });
});
