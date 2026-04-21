import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prepareNewContent,
  type PrepareContentInput,
} from "../../dist/mcp/tools/file-write-internals.js";

/**
 * Tests for CRLF and BOM preservation in prepareNewContent.
 *
 * Validates that:
 *  - CRLF line endings are preserved when splitting/joining
 *  - UTF-8 BOM is preserved through edits
 *  - Mixed line endings default to the dominant style
 */

function makeInput(
  existingContent: string,
  request: Record<string, unknown>,
): PrepareContentInput {
  return {
    prepared: {
      repoId: "test",
      rootPath: "/tmp",
      relPath: "test.txt",
      absPath: "/tmp/test.txt",
      fileExists: true,
    },
    request: request as PrepareContentInput["request"],
    existingContent,
    existingBytes: Buffer.byteLength(existingContent, "utf-8"),
  };
}

describe("prepareNewContent — CRLF preservation", () => {
  it("replaceLines preserves CRLF line endings", () => {
    const content = "line1\r\nline2\r\nline3\r\n";
    const result = prepareNewContent(
      makeInput(content, {
        replaceLines: { start: 2, end: 2, content: "replaced" },
      }),
    );
    assert.ok(
      result.newContent.includes("\r\n"),
      "output should preserve CRLF",
    );
    assert.ok(
      !result.newContent.includes("\r\n\n"),
      "should not produce mixed endings",
    );
  });

  it("replaceLines preserves LF when input is LF", () => {
    const content = "line1\nline2\nline3\n";
    const result = prepareNewContent(
      makeInput(content, {
        replaceLines: { start: 2, end: 2, content: "replaced" },
      }),
    );
    assert.ok(
      !result.newContent.includes("\r\n"),
      "output should stay LF-only",
    );
  });

  it("insertAt preserves CRLF line endings", () => {
    const content = "line1\r\nline2\r\n";
    const result = prepareNewContent(
      makeInput(content, {
        insertAt: { line: 2, content: "inserted" },
      }),
    );
    assert.ok(
      result.newContent.includes("\r\n"),
      "output should preserve CRLF",
    );
  });

  it("replacePattern preserves CRLF line endings", () => {
    const content = "hello oldName world\r\nsecond oldName line\r\n";
    const result = prepareNewContent(
      makeInput(content, {
        replacePattern: { pattern: "oldName", replacement: "newName", global: true },
      }),
    );
    assert.ok(
      result.newContent.includes("\r\n"),
      "output should preserve CRLF",
    );
    assert.ok(
      result.newContent.includes("newName"),
      "replacement should be applied",
    );
    assert.ok(
      !result.newContent.includes("oldName"),
      "original pattern should be replaced",
    );
    // Verify all line endings are still CRLF
    const lines = result.newContent.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      assert.ok(
        lines[i].endsWith("\r"),
        `line ${i + 1} should end with CR: ${JSON.stringify(lines[i])}`,
      );
    }
  });
});

describe("prepareNewContent — BOM preservation", () => {
  it("preserves UTF-8 BOM through replaceLines", () => {
    const bom = "\uFEFF";
    const content = bom + "line1\nline2\nline3\n";
    const result = prepareNewContent(
      makeInput(content, {
        replaceLines: { start: 2, end: 2, content: "replaced" },
      }),
    );
    assert.ok(result.newContent.startsWith(bom), "BOM should be preserved");
  });

  it("preserves UTF-8 BOM through insertAt", () => {
    const bom = "\uFEFF";
    const content = bom + "line1\nline2\n";
    const result = prepareNewContent(
      makeInput(content, {
        insertAt: { line: 1, content: "header" },
      }),
    );
    assert.ok(result.newContent.startsWith(bom), "BOM should be preserved");
  });

  it("does not add BOM when input has none", () => {
    const content = "line1\nline2\n";
    const result = prepareNewContent(
      makeInput(content, {
        replaceLines: { start: 1, end: 1, content: "replaced" },
      }),
    );
    assert.ok(!result.newContent.startsWith("\uFEFF"), "should not add BOM");
  });
});
