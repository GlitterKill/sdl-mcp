/**
 * End-to-end unit tests for the `sdl.search.edit` planner helpers and
 * the filesystem enumeration path.
 *
 * These cover the plan-requirement gaps previously flagged:
 *  - `.ipynb` / binary / archive exclusion by deny-list
 *  - include/exclude glob filtering
 *  - hidden-directory skipping during enumeration
 *  - regex compilation rules (single-or-literal exclusivity, ReDoS guard)
 *
 * The full `planSearchEditPreview` happy path is covered by the
 * integration smoke test; keeping this layer deterministic and DB-free
 * so it can run in CI without a LadybugDB native addon.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileSearchRegex,
  isPathAllowed,
  enumerateRepoFiles,
} from "../../dist/mcp/tools/search-edit/planner.js";

describe("search-edit planner — isPathAllowed (deny-list + globs)", () => {
  it("excludes .ipynb notebooks", () => {
    const r = isPathAllowed("notebooks/analysis.ipynb", undefined);
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /denied-extension/);
  });

  it("excludes common binary/archive types", () => {
    for (const rel of [
      "assets/logo.png",
      "dist/bundle.wasm",
      "releases/app.exe",
      "docs/spec.pdf",
      "bin/native.dll",
      "pkg/module.so",
      "pkg/module.dylib",
      "archive.zip",
      "archive.tar.gz",
      "archive.7z",
    ]) {
      const r = isPathAllowed(rel, undefined);
      assert.equal(r.allowed, false, `${rel} should be denied`);
      assert.match(r.reason ?? "", /denied-extension/);
    }
  });

  it("allows plain text and common indexed sources", () => {
    for (const rel of [
      "src/index.ts",
      "src/main.py",
      "README.md",
      "config/app.yaml",
      "data/records.json",
    ]) {
      const r = isPathAllowed(rel, undefined);
      assert.equal(r.allowed, true, `${rel} should be allowed`);
    }
  });

  it("honours include globs — excludes files outside the include set", () => {
    const filters = { include: ["src/**/*.ts"] };
    assert.equal(isPathAllowed("src/foo.ts", filters).allowed, true);
    assert.equal(isPathAllowed("docs/readme.md", filters).allowed, false);
  });

  it("honours exclude globs", () => {
    const filters = { exclude: ["**/*.test.ts"] };
    assert.equal(isPathAllowed("src/foo.ts", filters).allowed, true);
    assert.equal(isPathAllowed("src/foo.test.ts", filters).allowed, false);
  });

  it("rejects dotfiles that contain secrets (.env, .npmrc, .netrc)", () => {
    assert.equal(isPathAllowed(".env", undefined).allowed, false);
    assert.equal(isPathAllowed(".env.local", undefined).allowed, false);
    assert.equal(isPathAllowed(".npmrc", undefined).allowed, false);
    assert.equal(isPathAllowed(".netrc", undefined).allowed, false);
    assert.match(isPathAllowed(".env", undefined).reason ?? "", /denied-dotfile/);
  });

  it("blocks double-extension bypass (foo.dll.txt)", () => {
    const r = isPathAllowed("malicious.dll.txt", undefined);
    assert.equal(r.allowed, false, "double extension should be caught");
    assert.match(r.reason ?? "", /denied-extension/);
  });

  it("allows regular dotfiles that are not in the denylist", () => {
    assert.equal(isPathAllowed(".eslintrc.json", undefined).allowed, true);
    assert.equal(isPathAllowed(".prettierrc", undefined).allowed, true);
  });
});

describe("search-edit planner — compileSearchRegex", () => {
  it("rejects queries with neither literal nor regex", () => {
    assert.throws(() => compileSearchRegex({}, false), /exactly one/);
  });

  it("rejects queries with both literal and regex", () => {
    assert.throws(
      () => compileSearchRegex({ literal: "foo", regex: "foo" }, false),
      /exactly one/,
    );
  });

  it("escapes regex metacharacters in literal mode", () => {
    const re = compileSearchRegex({ literal: "a.b+c" }, false);
    assert.equal(re.test("a.b+c"), true);
    assert.equal(re.test("aXbYc"), false);
  });

  it("rejects regex with nested quantifiers (ReDoS guard)", () => {
    assert.throws(
      () => compileSearchRegex({ regex: "(a+)+" }, false),
      /nested quantifiers/,
    );
  });

  it("applies the global flag for batch edits", () => {
    const reGlobal = compileSearchRegex({ literal: "x" }, true);
    assert.equal(reGlobal.flags.includes("g"), true);
    const reSingle = compileSearchRegex({ literal: "x" }, false);
    assert.equal(reSingle.flags.includes("g"), false);
  });
});

describe("search-edit planner — enumerateRepoFiles", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "sdl-planner-enum-"));
    await writeFile(join(root, "visible.ts"), "export const x = 1;\n");
    await writeFile(join(root, "readme.md"), "# hello\n");
    await writeFile(join(root, "notebook.ipynb"), "{}\n");
    await writeFile(join(root, "logo.png"), "\x89PNG\r\n");
    // hidden directory must be skipped entirely
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    // nested hidden dir
    await mkdir(join(root, ".secret"), { recursive: true });
    await writeFile(join(root, ".secret", "keys.env"), "TOKEN=nope\n");
    // node_modules must be skipped
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "pkg", "index.js"),
      "module.exports = {};\n",
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips hidden directories, node_modules, and denied extensions", async () => {
    const { candidates, skipped } = await enumerateRepoFiles(
      root,
      undefined,
      200,
    );
    const rels = candidates.sort();
    assert.deepEqual(rels, ["readme.md", "visible.ts"]);

    // .ipynb and .png surfaced as skipped with a denied-extension reason
    const skippedPaths = skipped.map((s) => s.path).sort();
    assert.ok(skippedPaths.includes("notebook.ipynb"));
    assert.ok(skippedPaths.includes("logo.png"));
    for (const s of skipped) {
      assert.match(s.reason, /denied-extension/);
    }

    // hidden-dir and node_modules contents must NOT appear as candidates
    // or as skipped entries (dir-level skip is silent).
    const all = [...candidates, ...skippedPaths];
    assert.equal(
      all.some((p) => p.startsWith(".git") || p.startsWith(".secret")),
      false,
      "hidden directory contents must not leak",
    );
    assert.equal(
      all.some((p) => p.startsWith("node_modules")),
      false,
      "node_modules contents must not leak",
    );
  });


  it("rejects dotfiles that commonly contain secrets", async () => {
    await writeFile(join(root, ".env"), "SECRET=hunter2\n");
    await writeFile(join(root, ".npmrc"), "//registry:_auth=x\n");
    await writeFile(join(root, ".netrc"), "machine x\n");
    const { candidates } = await enumerateRepoFiles(root, undefined, 200);
    const dotfiles = candidates.filter((p) => p.startsWith("."));
    assert.equal(dotfiles.length, 0, "dotfiles should be excluded from enumeration");
  });

  it("respects maxFiles cap strictly", async () => {
    // Create more files than the maxFiles limit
    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, `extra-${i}.txt`), `content ${i}\n`);
    }
    const { candidates } = await enumerateRepoFiles(root, undefined, 3);
    assert.ok(candidates.length <= 3, `expected <= 3 candidates, got ${candidates.length}`);
  });
});
