import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  detectLanguagesFromRepo,
  detectRepoId,
  mergeIgnorePatterns,
} from "../../src/cli/commands/init.js";

describe("init non-interactive helpers", () => {
  it("detects languages from repository file extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-init-lang-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export const x = 1;\n", "utf8");
      writeFileSync(join(root, "scripts", "task.py"), "print('ok')\n", "utf8");

      const languages = detectLanguagesFromRepo(root);
      assert.ok(languages.includes("ts"));
      assert.ok(languages.includes("py"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives repo id from package.json name", () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-init-repo-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "@scope/Test Repo" }, null, 2),
        "utf8",
      );
      assert.strictEqual(detectRepoId(root), "scope-test-repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges .gitignore patterns into default ignore list", () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-init-ignore-"));
    try {
      writeFileSync(join(root, ".gitignore"), ".cache/\noutput\n", "utf8");
      const merged = mergeIgnorePatterns(root);
      assert.ok(merged.includes("**/.cache/**"));
      assert.ok(merged.includes("**/output"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
