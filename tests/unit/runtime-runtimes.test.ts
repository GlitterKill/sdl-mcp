import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isExecutableCompatibleWithRuntime,
  normalizeExecutableName,
} from "../../dist/runtime/runtimes.js";

describe("runtime executable compatibility", () => {
  it("should normalize executable basenames from absolute paths", () => {
    assert.strictEqual(
      normalizeExecutableName("C:\\Program Files\\nodejs\\node.exe"),
      "node.exe",
    );
  });

  it("should accept runtime-family executables", () => {
    assert.strictEqual(
      isExecutableCompatibleWithRuntime("node", "C:\\Program Files\\nodejs\\node.exe"),
      true,
    );
  });

  it("should reject executables from a different runtime family", () => {
    assert.strictEqual(
      isExecutableCompatibleWithRuntime("node", "powershell"),
      false,
    );
  });
});
