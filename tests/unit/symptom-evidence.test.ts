import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifySymptomType } from "../../dist/retrieval/evidence.js";

describe("classifySymptomType", () => {
  it("returns stackTrace when stackTrace is provided", () => {
    assert.equal(classifySymptomType({ stackTrace: "Error at line 5" }), "stackTrace");
  });

  it("returns failingTest when failingTestPath is provided", () => {
    assert.equal(classifySymptomType({ failingTestPath: "tests/auth.test.ts" }), "failingTest");
  });

  it("returns editedFiles when editedFiles is provided", () => {
    assert.equal(classifySymptomType({ editedFiles: ["src/auth.ts"] }), "editedFiles");
  });

  it("returns taskText as fallback", () => {
    assert.equal(classifySymptomType({ taskText: "fix login bug" }), "taskText");
  });

  it("returns taskText when no inputs provided", () => {
    assert.equal(classifySymptomType({}), "taskText");
  });

  it("prefers stackTrace over taskText", () => {
    assert.equal(
      classifySymptomType({ stackTrace: "Error", taskText: "fix it" }),
      "stackTrace",
    );
  });

  it("prefers stackTrace over failingTestPath", () => {
    assert.equal(
      classifySymptomType({ stackTrace: "Error", failingTestPath: "tests/foo.test.ts" }),
      "stackTrace",
    );
  });

  it("prefers failingTest over editedFiles", () => {
    assert.equal(
      classifySymptomType({ failingTestPath: "tests/foo.test.ts", editedFiles: ["src/foo.ts"] }),
      "failingTest",
    );
  });

  it("prefers editedFiles over taskText", () => {
    assert.equal(
      classifySymptomType({ editedFiles: ["src/foo.ts"], taskText: "fix it" }),
      "editedFiles",
    );
  });

  it("returns taskText for empty editedFiles array", () => {
    assert.equal(
      classifySymptomType({ editedFiles: [], taskText: "fix it" }),
      "taskText",
    );
  });
});
