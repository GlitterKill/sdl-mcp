import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BUILTIN_IDENTIFIERS,
  BUILTIN_CONSTRUCTORS,
  isBuiltinCall,
} from "../../src/indexer/edge-builder/builtins.js";

describe("BUILTIN_IDENTIFIERS", () => {
  it("contains expected Array prototype members", () => {
    for (const m of ["push", "pop", "map", "filter", "reduce", "forEach"]) {
      assert.ok(BUILTIN_IDENTIFIERS.has(m), `missing ${m}`);
    }
  });

  it("contains expected JSON members", () => {
    assert.ok(BUILTIN_IDENTIFIERS.has("stringify"));
    assert.ok(BUILTIN_IDENTIFIERS.has("parse"));
  });

  it("contains expected Promise members", () => {
    assert.ok(BUILTIN_IDENTIFIERS.has("then"));
    assert.ok(BUILTIN_IDENTIFIERS.has("catch"));
    assert.ok(BUILTIN_IDENTIFIERS.has("finally"));
  });

  it("does NOT contain random user-defined names", () => {
    assert.ok(!BUILTIN_IDENTIFIERS.has("myFunction"));
    assert.ok(!BUILTIN_IDENTIFIERS.has("UserService"));
    assert.ok(!BUILTIN_IDENTIFIERS.has("handleRequest"));
  });
});

describe("BUILTIN_CONSTRUCTORS", () => {
  it("contains expected JS constructors", () => {
    for (const c of ["Map", "Set", "Error", "Promise", "Date", "RegExp"]) {
      assert.ok(BUILTIN_CONSTRUCTORS.has(c), `missing ${c}`);
    }
  });

  it("contains expected Rust constructors", () => {
    for (const c of ["Vec", "HashMap", "Some", "None", "Ok", "Err"]) {
      assert.ok(BUILTIN_CONSTRUCTORS.has(c), `missing ${c}`);
    }
  });

  it("does NOT contain random names", () => {
    assert.ok(!BUILTIN_CONSTRUCTORS.has("MyClass"));
    assert.ok(!BUILTIN_CONSTRUCTORS.has("AppConfig"));
  });
});

describe("isBuiltinCall", () => {
  it("returns true for builtin identifiers", () => {
    assert.strictEqual(isBuiltinCall("push"), true);
    assert.strictEqual(isBuiltinCall("stringify"), true);
    assert.strictEqual(isBuiltinCall("then"), true);
  });

  it("returns true for builtin constructors", () => {
    assert.strictEqual(isBuiltinCall("Map"), true);
    assert.strictEqual(isBuiltinCall("Error"), true);
    assert.strictEqual(isBuiltinCall("Promise"), true);
  });

  it("returns false for non-builtins", () => {
    assert.strictEqual(isBuiltinCall("myFunction"), false);
    assert.strictEqual(isBuiltinCall("UserService"), false);
    assert.strictEqual(isBuiltinCall("handleAuth"), false);
  });

  it("handles compound Rust names with colons", () => {
    // "Vec::new" → split on ":" gives ["Vec", "", "new"], Vec is builtin
    assert.strictEqual(isBuiltinCall("Vec::new"), true);
    assert.strictEqual(isBuiltinCall("HashMap::new"), true);
  });

  it("returns false for non-builtin compound names", () => {
    assert.strictEqual(isBuiltinCall("MyStruct::method"), false);
  });

  it("returns false for empty string", () => {
    assert.strictEqual(isBuiltinCall(""), false);
  });

  it("handles single character names", () => {
    assert.strictEqual(isBuiltinCall("x"), false);
  });
});
