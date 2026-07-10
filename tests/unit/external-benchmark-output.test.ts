import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";

import { writeUtf8Output } from "../../dist/benchmark/output-file.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it("keeps overwrite output compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-output-"));
  roots.push(root);
  const filePath = join(root, "result.json");
  writeFileSync(filePath, "old");

  writeUtf8Output(filePath, "new", "overwrite");

  assert.equal(readFileSync(filePath, "utf8"), "new");
});

it("creates exclusive output only when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-output-"));
  roots.push(root);
  const filePath = join(root, "result.json");

  writeUtf8Output(filePath, "first", "exclusive");
  assert.equal(readFileSync(filePath, "utf8"), "first");

  assert.throws(
    () => writeUtf8Output(filePath, "second", "exclusive"),
    { code: "EEXIST" },
  );
  assert.equal(readFileSync(filePath, "utf8"), "first");
});
