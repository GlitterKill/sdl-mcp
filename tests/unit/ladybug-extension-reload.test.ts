import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/db/ladybug.ts", "utf-8");

describe("LadybugDB extension reload guard", () => {
  it("routes replacement connection extension loads through the WAL checkpoint guard", () => {
    assert.match(source, /function loadExtensionsAfterWalCheckpoint/);
    assert.match(
      source,
      /pre-extension-load-\$\{label\}-replacement/,
      "write replacement connections should checkpoint before LOAD EXTENSION",
    );
    assert.match(
      source,
      /pre-extension-load-read-replacement-\$\{idx\}/,
      "read replacement connections should checkpoint before LOAD EXTENSION",
    );
    assert.doesNotMatch(
      source,
      /const replacement = await createConnection\(db\);\s+await loadExtensionsOnConnection\(replacement\);/,
      "replacement connections must not bypass the dirty-WAL guard",
    );
  });

  it("records per-connection extension load results without publishing pool-wide success", () => {
    const functionStart = source.indexOf("async function loadExtensionsOnConnection");
    assert.notEqual(functionStart, -1);
    const functionBody = source.slice(functionStart, functionStart + 900);

    assert.match(functionBody, /recordConnectionExtensionLoad\(conn, ext, true\)/);
    assert.match(functionBody, /catch \(err\)[\s\S]*recordConnectionExtensionLoad\(conn, ext, false\)/);
    assert.doesNotMatch(
      functionBody,
      /markExtensionLoaded\(ext\)/,
      "a single successful connection load must not publish pool-wide success",
    );
  });

  it("publishes loaded capabilities only after all active connection loads are known", () => {
    const functionStart = source.indexOf("async function loadExtensionsOnConnection");
    assert.notEqual(functionStart, -1);
    const nextFunctionStart = source.indexOf(
      "function markExtensionsUnavailableAfterSkippedLoad",
      functionStart,
    );
    assert.notEqual(nextFunctionStart, -1);
    const functionBody = source.slice(functionStart, nextFunctionStart);

    assert.match(source, /function publishExtensionCapabilitiesForConnections/);
    assert.doesNotMatch(
      functionBody,
      /markExtensionLoaded\(ext\)/,
      "a single successful connection load must not publish pool-wide success",
    );
    assert.match(
      source,
      /activeConnections\.every/,
      "pool-wide success must require every active connection to have loaded the extension",
    );
  });
});
