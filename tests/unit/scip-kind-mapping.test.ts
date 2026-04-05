import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mapScipKind,
  parseScipSymbol,
  extractPackageInfo,
  isExternalSymbol,
  extractNameFromDescriptors,
  LSP_KIND,
} from "../../dist/scip/kind-mapping.js";

// ---------------------------------------------------------------------------
// parseScipSymbol
// ---------------------------------------------------------------------------

describe("parseScipSymbol", () => {
  it("parses npm-style SCIP symbol", () => {
    const result = parseScipSymbol(
      "scip-typescript npm @types/node 18.0.0 path/posix/join().",
    );
    assert.strictEqual(result.scheme, "scip-typescript");
    assert.strictEqual(result.manager, "npm");
    assert.strictEqual(result.packageName, "@types/node");
    assert.strictEqual(result.packageVersion, "18.0.0");
    assert.strictEqual(result.descriptors, "path/posix/join().");
  });

  it("parses Go-style SCIP symbol", () => {
    const result = parseScipSymbol(
      "scip-go gomod github.com/pkg/errors v0.9.1 errors/New().",
    );
    assert.strictEqual(result.scheme, "scip-go");
    assert.strictEqual(result.manager, "gomod");
    assert.strictEqual(result.packageName, "github.com/pkg/errors");
    assert.strictEqual(result.packageVersion, "v0.9.1");
    assert.strictEqual(result.descriptors, "errors/New().");
  });

  it("parses Maven-style SCIP symbol", () => {
    const result = parseScipSymbol(
      "scip-java maven com.google.guava:guava 31.1 com/google/common/collect/ImmutableList#",
    );
    assert.strictEqual(result.scheme, "scip-java");
    assert.strictEqual(result.manager, "maven");
    assert.strictEqual(result.packageName, "com.google.guava:guava");
    assert.strictEqual(result.packageVersion, "31.1");
    assert.strictEqual(
      result.descriptors,
      "com/google/common/collect/ImmutableList#",
    );
  });

  it("parses Cargo-style SCIP symbol", () => {
    const result = parseScipSymbol(
      "scip-rust cargo serde 1.0.188 serde/Serialize#serialize().",
    );
    assert.strictEqual(result.scheme, "scip-rust");
    assert.strictEqual(result.manager, "cargo");
    assert.strictEqual(result.packageName, "serde");
    assert.strictEqual(result.packageVersion, "1.0.188");
    assert.strictEqual(result.descriptors, "serde/Serialize#serialize().");
  });

  it("parses local symbols", () => {
    const result = parseScipSymbol("local 42");
    assert.strictEqual(result.scheme, "local");
    assert.strictEqual(result.manager, "");
    assert.strictEqual(result.packageName, "");
    assert.strictEqual(result.packageVersion, "");
    assert.strictEqual(result.descriptors, "42");
  });

  it("handles malformed symbol with fewer than 4 spaces", () => {
    const result = parseScipSymbol("scip-typescript npm pkg");
    assert.strictEqual(result.scheme, "scip-typescript");
    assert.strictEqual(result.manager, "npm");
    assert.strictEqual(result.packageName, "pkg");
    assert.strictEqual(result.packageVersion, "");
    assert.strictEqual(result.descriptors, "");
  });
});

// ---------------------------------------------------------------------------
// extractPackageInfo
// ---------------------------------------------------------------------------

describe("extractPackageInfo", () => {
  it("extracts npm package info", () => {
    const info = extractPackageInfo(
      "scip-typescript npm lodash 4.17.21 lodash/map().",
    );
    assert.strictEqual(info.packageManager, "npm");
    assert.strictEqual(info.packageName, "lodash");
    assert.strictEqual(info.packageVersion, "4.17.21");
  });

  it("extracts Go module info", () => {
    const info = extractPackageInfo(
      "scip-go gomod golang.org/x/text v0.14.0 transform/Reader#",
    );
    assert.strictEqual(info.packageManager, "gomod");
    assert.strictEqual(info.packageName, "golang.org/x/text");
    assert.strictEqual(info.packageVersion, "v0.14.0");
  });

  it("returns empty strings for local symbols", () => {
    const info = extractPackageInfo("local 99");
    assert.strictEqual(info.packageManager, "");
    assert.strictEqual(info.packageName, "");
    assert.strictEqual(info.packageVersion, "");
  });
});

// ---------------------------------------------------------------------------
// isExternalSymbol
// ---------------------------------------------------------------------------

describe("isExternalSymbol", () => {
  it("returns true for npm package symbols", () => {
    assert.strictEqual(
      isExternalSymbol(
        "scip-typescript npm lodash 4.17.21 lodash/map().",
        "/project",
      ),
      true,
    );
  });

  it("returns true for Go module symbols", () => {
    assert.strictEqual(
      isExternalSymbol(
        "scip-go gomod github.com/pkg/errors v0.9.1 errors/New().",
        "/project",
      ),
      true,
    );
  });

  it("returns false for local symbols", () => {
    assert.strictEqual(isExternalSymbol("local 42", "/project"), false);
  });

  it("returns false when manager and package are empty", () => {
    // Hypothetical symbol with no package info
    assert.strictEqual(
      isExternalSymbol("scip-typescript   foo.", "/project"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// extractNameFromDescriptors
// ---------------------------------------------------------------------------

describe("extractNameFromDescriptors", () => {
  it("extracts method name from class method descriptor", () => {
    assert.strictEqual(
      extractNameFromDescriptors("src/foo.ts/MyClass#myMethod()."),
      "myMethod",
    );
  });

  it("extracts class name from type descriptor", () => {
    assert.strictEqual(
      extractNameFromDescriptors("src/foo.ts/MyClass#"),
      "MyClass",
    );
  });

  it("extracts variable name from term descriptor", () => {
    assert.strictEqual(
      extractNameFromDescriptors("src/foo.ts/MY_CONST."),
      "MY_CONST",
    );
  });

  it("extracts function name from function descriptor", () => {
    assert.strictEqual(
      extractNameFromDescriptors("src/utils/parse()."),
      "parse",
    );
  });

  it("returns empty string for empty descriptors", () => {
    assert.strictEqual(extractNameFromDescriptors(""), "");
  });
});

// ---------------------------------------------------------------------------
// mapScipKind — descriptor suffix -> SDL kind
// ---------------------------------------------------------------------------

describe("mapScipKind", () => {
  describe("Term with parens (method/function)", () => {
    it("maps function with LSP Function kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/utils/parse().",
        LSP_KIND.Function,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "function");
    });

    it("maps method with LSP Method kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/Foo#bar().",
        LSP_KIND.Method,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "method");
    });

    it("maps constructor by LSP Constructor kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/Foo#constructor().",
        LSP_KIND.Constructor,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "constructor");
    });

    it("maps constructor by name (__init__)", () => {
      const result = mapScipKind(
        "scip-python pip pkg 1.0.0 src/Foo#__init__().",
        LSP_KIND.Method,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "constructor");
    });

    it("maps constructor by name (<init>)", () => {
      const result = mapScipKind(
        "scip-java maven pkg 1.0.0 com/Foo#<init>().",
        LSP_KIND.Method,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "constructor");
    });

    it("infers method from # in descriptor path when no LSP kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/Foo#bar().",
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "method");
    });

    it("defaults to function when no LSP kind and no # in path", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/utils/parse().",
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "function");
    });
  });

  describe("Type descriptor (#)", () => {
    it("maps Class with LSP Class kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyClass#",
        LSP_KIND.Class,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "class");
    });

    it("maps Interface with LSP Interface kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyInterface#",
        LSP_KIND.Interface,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "interface");
    });

    it("maps Enum with LSP Enum kind to type", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyEnum#",
        LSP_KIND.Enum,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "type");
    });

    it("maps Struct with LSP Struct kind to class", () => {
      const result = mapScipKind(
        "scip-rust cargo pkg 1.0.0 src/MyStruct#",
        LSP_KIND.Struct,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "class");
    });

    it("defaults to class when no LSP kind provided", () => {
      const result = mapScipKind("scip-typescript npm pkg 1.0.0 src/MyClass#");
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "class");
    });

    it("defaults to class for UnspecifiedSymbolKind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyClass#",
        LSP_KIND.UnspecifiedSymbolKind,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "class");
    });

    it("maps other LSP kinds on Type descriptor to type", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyType#",
        LSP_KIND.Object, // unusual but possible
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "type");
    });
  });

  describe("Term without parens (variable/constant)", () => {
    it("maps variable with LSP Variable kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MY_CONST.",
        LSP_KIND.Variable,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "variable");
    });

    it("maps constant with LSP Constant kind", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MAX_SIZE.",
        LSP_KIND.Constant,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "variable");
    });

    it("maps arrow function (term without parens + Function LSP kind) to function", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/myFunc.",
        LSP_KIND.Function,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "function");
    });

    it("defaults to variable without LSP kind", () => {
      const result = mapScipKind("scip-typescript npm pkg 1.0.0 src/someVar.");
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "variable");
    });
  });

  describe("Namespace", () => {
    it("maps namespace descriptor to module", () => {
      // Namespace descriptors end with . but the segment before ends with /
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/utils/.",
        LSP_KIND.Namespace,
      );
      assert.strictEqual(result.skip, false);
      if (!result.skip) assert.strictEqual(result.sdlKind, "module");
    });
  });

  describe("Skip cases", () => {
    it("skips TypeParameter", () => {
      const result = mapScipKind(
        "scip-typescript npm pkg 1.0.0 src/MyClass#T[",
        LSP_KIND.TypeParameter,
      );
      assert.strictEqual(result.skip, true);
      if (result.skip) assert.strictEqual(result.reason, "typeParameter");
    });

    it("skips Parameter", () => {
      const result = mapScipKind("scip-typescript npm pkg 1.0.0 src/foo()/x(");
      assert.strictEqual(result.skip, true);
      if (result.skip) assert.strictEqual(result.reason, "parameter");
    });

    it("skips Local", () => {
      const result = mapScipKind("local 42");
      assert.strictEqual(result.skip, true);
      if (result.skip) assert.strictEqual(result.reason, "local");
    });

    it("skips Meta", () => {
      const result = mapScipKind("scip-typescript npm pkg 1.0.0 src/foo!");
      assert.strictEqual(result.skip, true);
      if (result.skip) assert.strictEqual(result.reason, "meta");
    });

    it("skips unknown descriptor suffix", () => {
      const result = mapScipKind("scip-typescript npm pkg 1.0.0 ");
      assert.strictEqual(result.skip, true);
      if (result.skip) {
        assert.strictEqual(result.reason, "unknown descriptor suffix");
      }
    });
  });
});
