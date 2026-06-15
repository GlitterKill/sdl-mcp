import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readCargoLockVersion(packageName: string): string {
  const lockPath = resolve("native", "Cargo.lock");
  const lockfile = readFileSync(lockPath, "utf8");
  const packageBlocks = lockfile.split(/\n\[\[package\]\]\n/);

  for (const block of packageBlocks) {
    if (!block.includes(`name = "${packageName}"`)) {
      continue;
    }
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    assert.ok(version, `Expected ${packageName} to declare a version`);
    return version;
  }

  assert.fail(`Expected ${packageName} in ${lockPath}`);
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index++) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

describe("native Go grammar dependency", () => {
  it("keeps the native Go parser on the maintained 0.25.x grammar line", () => {
    const version = readCargoLockVersion("tree-sitter-go");

    assert.ok(
      compareSemver(version, "0.25.0") >= 0,
      `Expected tree-sitter-go >= 0.25.0, got ${version}`,
    );
  });
});
