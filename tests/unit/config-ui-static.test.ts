import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

async function readUiAsset(name: string): Promise<string> {
  return readFile(join(repoRoot, "src", "ui", name), "utf8");
}

async function readBuiltUiAsset(name: string): Promise<string> {
  return readFile(join(repoRoot, "dist", "ui", name), "utf8");
}

describe("config UI static assets", () => {
  it("serves a dependency-free config route shell with admin navigation", async () => {
    const html = await readUiAsset("config.html");
    assert.match(html, /href="\/ui\/admin-shell\.css"/);
    assert.match(html, /href="\/ui\/observability"/);
    assert.match(html, /src="\/ui\/config\.js"/);
    assert.match(html, /id="tokenInput"/);
    assert.doesNotMatch(html, /react|vite|webpack/i);
  });

  it("links the observability dashboard back to the config admin page", async () => {
    const html = await readUiAsset("observability.html");
    assert.match(html, /href="\/ui\/admin-shell\.css"/);
    assert.match(html, /href="\/ui\/config"/);
  });

  it("copies dependency-free UI assets into the built dist directory", async () => {
    for (const asset of ["admin-shell.css", "config.css", "config.html", "config.js", "observability.html"]) {
      const built = await readBuiltUiAsset(asset);
      assert.ok(built.length > 0, `missing built asset ${asset}`);
    }
  });

  it("contains the expected edit, diff, validation, backup, and profile surfaces", async () => {
    const js = await readUiAsset("config.js");
    for (const token of [
      "/api/config/validate",
      "/api/config/save",
      "/api/config/rollback",
      "/api/config/profiles",
      "headers.Authorization",
      "rollbackBackup(action.backupId, highRiskAccepted)",
      "applyProfile(action.profileId, highRiskAccepted)",
      "high_risk_confirmation_required",
      "replace secret",
      "Preset staged",
    ]) {
      assert.ok(js.includes(token), `missing ${token}`);
    }
  });
});
