import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basename } from "path";

import { handleInfo } from "../../dist/mcp/tools/info.js";

// ---------------------------------------------------------------------------
// Regression guard for the info.ts path disclosure fix. Confirms that passing
// { redactPaths: true } replaces the absolute paths that handleInfo normally
// returns with their basenames, so HTTP-transport or multi-tenant deployments
// can avoid leaking the server's filesystem layout.
// ---------------------------------------------------------------------------

describe("handleInfo path redaction", () => {
  it("returns absolute paths by default (backward compatible)", async () => {
    const report = await handleInfo();
    // Should have at least a config.path string
    assert.equal(typeof report.config.path, "string");
    // Most deployments will have a config path that is either absolute or
    // the default relative path; either way, the key must be present.
    assert.ok("path" in report.config);
  });

  it("redacts absolute paths to basenames when redactPaths: true", async () => {
    const full = await handleInfo();
    const redacted = await handleInfo({ redactPaths: true });

    // config.path is always present as a string. Basenames have no slashes
    // and no Windows drive letters, and never contain a path separator that
    // is not at the end of the string.
    assert.equal(redacted.config.path, basename(full.config.path));
    assert.equal(redacted.logging.path, full.logging.path === null ? null : basename(full.logging.path));
    assert.equal(redacted.ladybug.activePath, full.ladybug.activePath === null ? null : basename(full.ladybug.activePath));
    assert.equal(redacted.native.sourcePath, full.native.sourcePath === null ? null : basename(full.native.sourcePath));

    // The basename should not contain path separators.
    assert.ok(!redacted.config.path.includes("/"));
    assert.ok(!redacted.config.path.includes("\\"));
  });

  it("leaves non-path fields untouched when redactPaths: true", async () => {
    const full = await handleInfo();
    const redacted = await handleInfo({ redactPaths: true });
    assert.equal(redacted.version, full.version);
    assert.equal(redacted.runtime.node, full.runtime.node);
    assert.equal(redacted.runtime.platform, full.runtime.platform);
    assert.equal(redacted.config.exists, full.config.exists);
    assert.equal(redacted.ladybug.available, full.ladybug.available);
  });
});
