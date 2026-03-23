import { describe, it } from "node:test";
import assert from "node:assert";
import { formatOutput, detectOutputFormat, formatError } from "../../dist/cli/commands/tool-output.js";

describe("cli-tool-output", () => {
  describe("detectOutputFormat", () => {
    it("returns explicit valid formats", () => {
      assert.strictEqual(detectOutputFormat("json"), "json");
      assert.strictEqual(detectOutputFormat("json-compact"), "json-compact");
      assert.strictEqual(detectOutputFormat("pretty"), "pretty");
      assert.strictEqual(detectOutputFormat("table"), "table");
      assert.strictEqual(detectOutputFormat("PRETTY"), "pretty");
    });

    it("defaults to json if no explicit format provided", () => {
      assert.strictEqual(detectOutputFormat(), "json");
      assert.strictEqual(detectOutputFormat("invalid-format"), "json");
    });
  });

  describe("formatOutput", () => {
    function createMockStream(): { write: (chunk: string) => void; getOutput: () => string } {
      let output = "";
      return {
        write: (chunk: string) => {
          output += chunk;
        },
        getOutput: () => output,
      };
    }

    const testObj = { id: 1, name: "test" };

    it("formats as json (indented)", () => {
      const stream = createMockStream();
      // @ts-expect-error - Mock stream is enough for testing
      formatOutput(testObj, "json", stream);
      assert.strictEqual(stream.getOutput(), '{\n  "id": 1,\n  "name": "test"\n}\n');
    });

    it("formats as json-compact", () => {
      const stream = createMockStream();
      // @ts-expect-error
      formatOutput(testObj, "json-compact", stream);
      assert.strictEqual(stream.getOutput(), '{"id":1,"name":"test"}\n');
    });

    it("formats search results as pretty table", () => {
      const stream = createMockStream();
      const searchRes = {
        results: [
          { symbolId: "sym1", name: "foo", file: "a.ts", kind: "function" },
          { symbolId: "sym2", name: "barBaz", file: "b.ts", kind: "class" },
        ],
      };
      // @ts-expect-error
      formatOutput(searchRes, "pretty", stream);
      const out = stream.getOutput();
      assert.match(out, /Found 2 symbol\(s\):/);
      assert.match(out, /NAME\s+KIND\s+FILE/);
      assert.match(out, /foo\s+function\s+a\.ts/);
      assert.match(out, /barBaz\s+class\s+b\.ts/);
    });

    it("formats generic table output", () => {
      const stream = createMockStream();
      const feedbackQueryRes = {
        records: [
          { id: 1, type: "debug" },
          { id: 2, type: "review" },
        ],
      };
      // @ts-expect-error
      formatOutput(feedbackQueryRes, "table", stream);
      const out = stream.getOutput();
      assert.match(out, /id\s+type/i); // Header row
      assert.match(out, /1\s+debug/);
      assert.match(out, /2\s+review/);
    });

    it("falls back to json for unknown objects in pretty mode", () => {
      const stream = createMockStream();
      // @ts-expect-error
      formatOutput({ unknownData: true }, "pretty", stream);
      assert.strictEqual(stream.getOutput(), '{\n  "unknownData": true\n}\n');
    });
  });

  describe("formatError", () => {
    it("formats Error objects", () => {
      const e = new Error("Test error");
      assert.strictEqual(formatError(e), "Error: Test error");
    });

    it("formats string errors", () => {
      assert.strictEqual(formatError("String error"), "Error: String error");
    });

    it("formats other objects", () => {
      assert.strictEqual(formatError({ code: 500 }), "Error: [object Object]");
    });
  });
});
