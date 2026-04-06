import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClangDescriptors,
  mapScipKind,
  extractNameFromDescriptors,
} from "../../dist/scip/kind-mapping.js";

// ---------------------------------------------------------------------------
// normalizeClangDescriptors — descriptor-string transforms
// ---------------------------------------------------------------------------
describe("scip-clang tuning: normalizeClangDescriptors", () => {
  it("strips trailing parameter list from a free function", () => {
    assert.equal(
      normalizeClangDescriptors("utils/parse_line(int)."),
      "utils/parse_line().",
    );
  });

  it("leaves a method descriptor with empty parens unchanged", () => {
    assert.equal(
      normalizeClangDescriptors("net/Server#start()."),
      "net/Server#start().",
    );
  });

  it("strips parameter list from a method with typed parameters", () => {
    assert.equal(
      normalizeClangDescriptors("net/Server#listen(int)."),
      "net/Server#listen().",
    );
  });

  it("strips overload disambiguator hash and parameter list together", () => {
    assert.equal(
      normalizeClangDescriptors("math/add(int,int)#a1b2c3d4."),
      "math/add().",
    );
    assert.equal(
      normalizeClangDescriptors("math/add(double,double)#e5f6a7b8."),
      "math/add().",
    );
  });

  it("preserves class type descriptors (trailing #) unchanged", () => {
    assert.equal(normalizeClangDescriptors("net/Server#"), "net/Server#");
  });

  it("preserves field / variable descriptors unchanged", () => {
    assert.equal(
      normalizeClangDescriptors("net/Server#port."),
      "net/Server#port.",
    );
  });

  it("handles nested balanced parameter lists", () => {
    // e.g., std::function<void(int)> passed as a parameter type. The
    // right-to-left depth-counting open-paren finder must handle the inner
    // `(int)` without prematurely closing the outer list.
    assert.equal(
      normalizeClangDescriptors("ns/apply(std::function<void(int)>)."),
      "ns/apply().",
    );
  });

  it("is idempotent", () => {
    const once = normalizeClangDescriptors("math/add(int,int)#hash.");
    const twice = normalizeClangDescriptors(once);
    assert.equal(once, twice);
  });

  it("returns empty input unchanged", () => {
    assert.equal(normalizeClangDescriptors(""), "");
  });
});

// ---------------------------------------------------------------------------
// extractNameFromDescriptors after normalizeClangDescriptors
// ---------------------------------------------------------------------------
describe("scip-clang tuning: name extraction after normalization", () => {
  const extract = (desc: string): string =>
    extractNameFromDescriptors(normalizeClangDescriptors(desc));

  it("extracts bare name from a free function with parameters", () => {
    assert.equal(extract("utils/parse_line(int)."), "parse_line");
  });

  it("extracts bare name from an overloaded function with disambiguator", () => {
    assert.equal(extract("math/add(int,int)#a1b2c3d4."), "add");
    assert.equal(extract("math/add(double,double)#e5f6a7b8."), "add");
  });

  it("extracts method name from a class member", () => {
    assert.equal(extract("net/Server#start()."), "start");
  });

  it("extracts class name from a class type descriptor", () => {
    assert.equal(extract("net/Server#"), "Server");
  });

  it("extracts field name", () => {
    assert.equal(extract("net/Server#port."), "port");
  });
});

// ---------------------------------------------------------------------------
// mapScipKind — end-to-end kind resolution for scip-clang symbols
// ---------------------------------------------------------------------------
describe("scip-clang tuning: mapScipKind", () => {
  it("maps a scip-clang free function to function kind", () => {
    const r = mapScipKind(
      "scip-clang cxx my-project 1.0.0 utils/parse_line(int).",
    );
    assert.equal(r.skip, false);
    assert.equal(r.sdlKind, "function");
  });

  it("maps a scip-clang overloaded function to function kind", () => {
    const r = mapScipKind(
      "scip-clang cxx my-project 1.0.0 math/add(int,int)#a1b2c3d4.",
    );
    assert.equal(r.skip, false);
    assert.equal(r.sdlKind, "function");
  });

  it("maps a scip-clang method to method kind", () => {
    const r = mapScipKind(
      "scip-clang cxx my-project 1.0.0 net/Server#start().",
    );
    assert.equal(r.skip, false);
    assert.equal(r.sdlKind, "method");
  });

  it("maps a scip-clang class type descriptor to class kind", () => {
    const r = mapScipKind("scip-clang cxx my-project 1.0.0 net/Server#");
    assert.equal(r.skip, false);
    assert.equal(r.sdlKind, "class");
  });

  it("maps a scip-clang field to variable kind without LSP kind", () => {
    const r = mapScipKind(
      "scip-clang cxx my-project 1.0.0 net/Server#port.",
    );
    assert.equal(r.skip, false);
    assert.equal(r.sdlKind, "variable");
  });

  it("does not regress non-clang emitters", () => {
    const ts = mapScipKind(
      "scip-typescript npm my-project 1.0.0 src/utils.ts/parseLine().",
    );
    assert.equal(ts.skip, false);
    assert.equal(ts.sdlKind, "function");

    const go = mapScipKind(
      "scip-go gomod github.com/user/project v1.0.0 pkg/handler/HandleRequest().",
    );
    assert.equal(go.skip, false);
    assert.equal(go.sdlKind, "function");

    const rust = mapScipKind(
      "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#encode().",
    );
    assert.equal(rust.skip, false);
    assert.equal(rust.sdlKind, "method");
  });
});
