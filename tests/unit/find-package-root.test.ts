import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { findPackageRoot } from "../../dist/util/findPackageRoot.js";

describe("findPackageRoot", () => {
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "sdl-find-root-"));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("returns startDir when package.json exists there", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(dir), resolve(dir));
  });

  it("finds package.json in parent directory", () => {
    const root = makeTempDir();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(nested), resolve(root));
  });

  it("returns nearest package root when multiple ancestors contain package.json", () => {
    const root = makeTempDir();
    const child = join(root, "child");
    const deep = join(child, "deep");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(child, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(deep), resolve(child));
  });

  it("respects maxDepth and does not search beyond the limit", () => {
    const root = makeTempDir();
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(nested, 2), resolve(nested));
  });

  it("finds package.json when it is within maxDepth", () => {
    const root = makeTempDir();
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(nested, 4), resolve(root));
  });

  it("falls back to startDir when no package.json exists", () => {
    const root = makeTempDir();
    const nested = join(root, "x", "y");
    mkdirSync(nested, { recursive: true });

    assert.strictEqual(findPackageRoot(nested), resolve(nested));
  });

  it("returns resolved absolute path for relative startDir", () => {
    const cwd = process.cwd();
    const relative = ".";

    assert.strictEqual(findPackageRoot(relative, 0), resolve(cwd));
  });

  it("returns startDir when maxDepth is zero", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), "{}");

    assert.strictEqual(findPackageRoot(dir, 0), resolve(dir));
  });

  it("returns startDir when search reaches filesystem root without package.json", () => {
    const dir = makeTempDir();
    const nested = join(dir, "alone", "deep");
    mkdirSync(nested, { recursive: true });

    const result = findPackageRoot(nested, 100);
    assert.strictEqual(result, resolve(nested));
  });
});
