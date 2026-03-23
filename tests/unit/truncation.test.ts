import { describe, it } from "node:test";
import assert from "node:assert";

import {
  applyCountTruncation,
  applyLineTruncation,
  applyTokenTruncation,
  mergeTruncationMetadata,
  truncateArray,
  truncateRange,
  truncateText,
} from "../../dist/util/truncation.js";

describe("truncation utilities", () => {
  describe("applyCountTruncation", () => {
    it("returns original items when within maxItems", () => {
      const result = applyCountTruncation([1, 2, 3], { maxItems: 3 });
      assert.deepStrictEqual(result.items, [1, 2, 3]);
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.droppedCount, 0);
      assert.strictEqual(result.howToResume, null);
    });

    it("truncates from end and returns cursor resume value", () => {
      const result = applyCountTruncation([1, 2, 3, 4, 5], {
        maxItems: 3,
        truncateAt: "end",
      });

      assert.deepStrictEqual(result.items, [1, 2, 3]);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 3 });
    });

    it("truncates from start and returns dropped-count cursor", () => {
      const result = applyCountTruncation([1, 2, 3, 4, 5], {
        maxItems: 2,
        truncateAt: "start",
      });

      assert.deepStrictEqual(result.items, [4, 5]);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.droppedCount, 3);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 3 });
    });

    it("supports preserveFirst/preserveLast branch", () => {
      const result = applyCountTruncation([1, 2, 3, 4, 5, 6], {
        maxItems: 4,
        truncateAt: "middle" as "start",
        preserveFirst: 1,
        preserveLast: 1,
      });

      assert.deepStrictEqual(result.items, [1, 2, 3, 6]);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 3 });
    });
  });

  describe("applyTokenTruncation", () => {
    it("does not truncate short text", () => {
      const result = applyTokenTruncation("hello world", { maxTokens: 100 });
      assert.strictEqual(result.text, "hello world");
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.droppedCount, 0);
      assert.strictEqual(result.howToResume, null);
    });

    it("truncates from end with token resume metadata", () => {
      const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
      const result = applyTokenTruncation(text, {
        maxTokens: 3,
        truncateAt: "end",
      });

      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.text, "aaaa\nbbbb");
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "token", value: 3 });
    });

    it("truncates from start", () => {
      const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
      const result = applyTokenTruncation(text, {
        maxTokens: 3,
        truncateAt: "start",
      });

      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.text, "cccc\ndddd");
      assert.strictEqual(result.droppedCount, 2);
    });
  });

  describe("applyLineTruncation", () => {
    it("truncates by line count from end", () => {
      const text = ["l1", "l2", "l3", "l4"].join("\n");
      const result = applyLineTruncation(text, {
        maxLines: 2,
        truncateAt: "end",
      });

      assert.strictEqual(result.text, "l1\nl2");
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 2 });
    });

    it("truncates by line count from start", () => {
      const text = ["l1", "l2", "l3", "l4"].join("\n");
      const result = applyLineTruncation(text, {
        maxLines: 2,
        truncateAt: "start",
      });

      assert.strictEqual(result.text, "l3\nl4");
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 2 });
    });
  });

  describe("truncateText", () => {
    it("combines token and line truncation when both limits are provided", () => {
      const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
      const result = truncateText(text, {
        maxTokens: 7,
        maxLines: 2,
        truncateAt: "end",
      });

      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.text, "aaaa\nbbbb");
      assert.strictEqual(result.droppedCount, 2);
      assert.deepStrictEqual(result.howToResume, { type: "cursor", value: 2 });
    });

    it("returns original text when no limits are provided", () => {
      const result = truncateText("x\ny", {});
      assert.strictEqual(result.text, "x\ny");
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.droppedCount, 0);
      assert.strictEqual(result.howToResume, null);
    });
  });

  describe("truncateArray", () => {
    it("returns original array when maxItems is undefined", () => {
      const result = truncateArray([1, 2, 3, 4], {});
      assert.deepStrictEqual(result.items, [1, 2, 3, 4]);
      assert.strictEqual(result.truncated, false);
    });
  });

  describe("truncateRange", () => {
    const baseRange = { startLine: 10, startCol: 3, endLine: 19, endCol: 12 };

    it("truncates range from end", () => {
      const result = truncateRange(baseRange, {
        maxLines: 4,
        truncateAt: "end",
      });

      assert.deepStrictEqual(result.range, {
        startLine: 10,
        startCol: 3,
        endLine: 13,
        endCol: 0,
      });
      assert.strictEqual(result.truncation.truncated, true);
      assert.strictEqual(result.truncation.droppedCount, 6);
      assert.deepStrictEqual(result.truncation.howToResume, {
        type: "cursor",
        value: 13,
      });
    });

    it("truncates range from start", () => {
      const result = truncateRange(baseRange, {
        maxLines: 4,
        truncateAt: "start",
      });

      assert.deepStrictEqual(result.range, {
        startLine: 16,
        startCol: 0,
        endLine: 19,
        endCol: 12,
      });
      assert.strictEqual(result.truncation.truncated, true);
      assert.strictEqual(result.truncation.droppedCount, 6);
      assert.deepStrictEqual(result.truncation.howToResume, {
        type: "cursor",
        value: 19,
      });
    });

    it("supports preserveFirst/preserveLast branch for ranges", () => {
      const result = truncateRange(baseRange, {
        maxLines: 4,
        truncateAt: "middle" as "start",
        preserveFirst: 1,
        preserveLast: 1,
      });

      assert.deepStrictEqual(result.range, {
        startLine: 11,
        startCol: 0,
        endLine: 12,
        endCol: 0,
      });
      assert.strictEqual(result.truncation.truncated, true);
      assert.strictEqual(result.truncation.droppedCount, 6);
    });
  });

  describe("mergeTruncationMetadata", () => {
    it("merges dropped counts and uses last truncated resume metadata", () => {
      const merged = mergeTruncationMetadata([
        { truncated: false, droppedCount: 0, howToResume: null },
        {
          truncated: true,
          droppedCount: 2,
          howToResume: { type: "cursor", value: 3 },
        },
        {
          truncated: true,
          droppedCount: 4,
          howToResume: { type: "token", value: 50 },
        },
      ]);

      assert.strictEqual(merged.truncated, true);
      assert.strictEqual(merged.droppedCount, 6);
      assert.deepStrictEqual(merged.howToResume, { type: "token", value: 50 });
    });

    it("returns non-truncated metadata for an empty list", () => {
      const merged = mergeTruncationMetadata([]);
      assert.strictEqual(merged.truncated, false);
      assert.strictEqual(merged.droppedCount, 0);
      assert.strictEqual(merged.howToResume, null);
    });
  });
});
