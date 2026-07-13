import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectDominantEol,
  normalizeToLf,
  restoreEol,
} from "../../dist/util/eol.js";

test("detects dominant EOL", () => {
  assert.equal(detectDominantEol("a\r\nb\r\nc\n"), "\r\n");
  assert.equal(detectDominantEol("a\nb\n"), "\n");
  assert.equal(detectDominantEol("no newline"), "\n");
});

test("normalize + restore round-trips CRLF content", () => {
  const crlf = "line1\r\nline2\r\n";
  const lf = normalizeToLf(crlf);
  assert.equal(lf, "line1\nline2\n");
  assert.equal(restoreEol(lf, "\r\n"), crlf);
});

test("restoreEol does not double-convert existing CRLF", () => {
  assert.equal(restoreEol("a\r\nb\n", "\r\n"), "a\r\nb\r\n");
});
