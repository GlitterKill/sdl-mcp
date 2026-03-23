import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_IDENTIFIERS,
  BUILTIN_MACROS,
  BUILTIN_GLOBAL_NAMESPACES,
  NODE_BUILTIN_MODULE_NAMES,
  isBuiltinCall,
} from "../../dist/indexer/edge-builder/builtins.js";
import { TypeScriptAdapter } from "../../dist/indexer/adapter/typescript.js";
import type {
  CallResolutionContext,
  AdapterResolvedCall,
} from "../../dist/indexer/adapter/LanguageAdapter.js";
import type { ExtractedCall } from "../../dist/indexer/treesitter/extractCalls.js";
import {
  disambiguateRustCandidates,
  isExternalCrateCall,
  KNOWN_EXTERNAL_CRATE_PREFIXES,
} from "../../dist/indexer/pass2/resolvers/rust-pass2-resolver.js";

// --- Test helpers ---

function makeCall(calleeIdentifier: string): ExtractedCall {
  return {
    callerNodeId: "caller",
    calleeIdentifier,
    isResolved: false,
    callType: "function",
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
  };
}

function makeContext(input: {
  call: ExtractedCall;
  imported?: Record<string, string[]>;
  namespaces?: Record<string, Record<string, string>>;
  names?: Record<string, string[]>;
}): CallResolutionContext {
  const namespaceImports = new Map<string, Map<string, string>>();
  for (const [ns, members] of Object.entries(input.namespaces ?? {})) {
    namespaceImports.set(ns, new Map(Object.entries(members)));
  }
  return {
    call: input.call,
    importedNameToSymbolIds: new Map(Object.entries(input.imported ?? {})),
    namespaceImports,
    nameToSymbolIds: new Map(Object.entries(input.names ?? {})),
  };
}

function tsResolve(context: CallResolutionContext): AdapterResolvedCall | null {
  const adapter = new TypeScriptAdapter();
  return adapter.resolveCall(context);
}

// --- BUILTIN_IDENTIFIERS: ambiguous names removed ---

describe("BUILTIN_IDENTIFIERS — ambiguous names removed (Critical #1)", () => {
  const REMOVED_AMBIGUOUS = [
    "find",
    "resolve",
    "on",
    "off",
    "run",
    "all",
    "close",
    "ok",
    "err",
    "into",
    "from",
    "insert",
    "remove",
    "take",
    "chain",
    "any",
    "count",
    "lock",
    "spawn",
    "flush",
    "seek",
    "write",
    "update",
    "next",
    "done",
    "send",
    "end",
  ];

  for (const name of REMOVED_AMBIGUOUS) {
    it(`"${name}" is NOT in BUILTIN_IDENTIFIERS`, () => {
      assert.ok(
        !BUILTIN_IDENTIFIERS.has(name),
        `"${name}" should have been removed — too ambiguous for context-free filtering`,
      );
    });
  }

  it('"super" is NOT in BUILTIN_IDENTIFIERS (Critical #2)', () => {
    assert.ok(
      !BUILTIN_IDENTIFIERS.has("super"),
      '"super" belongs in language adapters, not global filter',
    );
  });

  it("still contains structurally unambiguous names", () => {
    const UNAMBIGUOUS = [
      "push",
      "forEach",
      "stringify",
      "parseInt",
      "readFileSync",
      "toISOString",
      "unwrap",
      "unwrap_or",
      "to_string",
      "collect",
    ];
    for (const name of UNAMBIGUOUS) {
      assert.ok(
        BUILTIN_IDENTIFIERS.has(name),
        `"${name}" should remain — structurally unambiguous`,
      );
    }
  });
});

// --- BUILTIN_MACROS ---

describe("BUILTIN_MACROS", () => {
  it("contains common Rust macros with ! suffix", () => {
    for (const m of [
      "println!",
      "format!",
      "vec!",
      "panic!",
      "assert_eq!",
      "dbg!",
      "cfg_if!",
    ]) {
      assert.ok(BUILTIN_MACROS.has(m), `missing ${m}`);
    }
  });

  it("isBuiltinCall detects macros", () => {
    assert.strictEqual(isBuiltinCall("println!"), true);
    assert.strictEqual(isBuiltinCall("vec!"), true);
    assert.strictEqual(isBuiltinCall("format!"), true);
  });

  it("does not match without ! suffix", () => {
    assert.ok(!BUILTIN_MACROS.has("println"));
    assert.ok(!BUILTIN_MACROS.has("vec"));
  });
});

// --- BUILTIN_GLOBAL_NAMESPACES & NODE_BUILTIN_MODULE_NAMES (DRY #4) ---

describe("BUILTIN_GLOBAL_NAMESPACES (shared set)", () => {
  it("contains JS/TS global namespaces", () => {
    for (const g of [
      "Math",
      "JSON",
      "console",
      "Date",
      "Object",
      "Promise",
      "process",
    ]) {
      assert.ok(BUILTIN_GLOBAL_NAMESPACES.has(g), `missing ${g}`);
    }
  });

  it("does NOT contain user-defined names", () => {
    assert.ok(!BUILTIN_GLOBAL_NAMESPACES.has("myService"));
    assert.ok(!BUILTIN_GLOBAL_NAMESPACES.has("db"));
  });
});

describe("NODE_BUILTIN_MODULE_NAMES (shared set)", () => {
  it("contains Node.js built-in module names", () => {
    for (const m of [
      "path",
      "fs",
      "os",
      "crypto",
      "http",
      "stream",
      "events",
    ]) {
      assert.ok(NODE_BUILTIN_MODULE_NAMES.has(m), `missing ${m}`);
    }
  });

  it("does NOT contain user-defined names", () => {
    assert.ok(!NODE_BUILTIN_MODULE_NAMES.has("myModule"));
    assert.ok(!NODE_BUILTIN_MODULE_NAMES.has("auth"));
  });
});

// --- TypeScript adapter resolveCall ---

describe("TypeScript adapter resolveCall", () => {
  it("returns null for super calls", () => {
    const result = tsResolve(makeContext({ call: makeCall("super") }));
    assert.strictEqual(result, null);
  });

  it("returns null for super.method calls", () => {
    const result = tsResolve(makeContext({ call: makeCall("super.render") }));
    assert.strictEqual(result, null);
  });

  it("returns null for BUILTIN_GLOBAL_NAMESPACES prefix (Math.floor)", () => {
    const result = tsResolve(makeContext({ call: makeCall("Math.floor") }));
    assert.strictEqual(result, null);
  });

  it("returns null for console.log", () => {
    const result = tsResolve(makeContext({ call: makeCall("console.log") }));
    assert.strictEqual(result, null);
  });

  it("returns null for NODE_BUILTIN_MODULE_NAMES prefix (fs.readFile)", () => {
    const result = tsResolve(makeContext({ call: makeCall("fs.readFile") }));
    assert.strictEqual(result, null);
  });

  it("returns null for path.join", () => {
    const result = tsResolve(makeContext({ call: makeCall("path.join") }));
    assert.strictEqual(result, null);
  });

  it("resolves namespace import member (X.foo)", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("utils.doThing"),
        namespaces: { utils: { doThing: "sym:utils.doThing" } },
      }),
    );
    assert.deepStrictEqual(result, {
      symbolId: "sym:utils.doThing",
      isResolved: true,
      confidence: 0.92,
      strategy: "exact",
    });
  });

  it("resolves this.method via local symbols", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("this.process"),
        names: { process: ["sym:local.process"] },
      }),
    );
    assert.deepStrictEqual(result, {
      symbolId: "sym:local.process",
      isResolved: true,
      strategy: "heuristic",
      confidence: 0.78,
    });
  });

  it("returns null for this.method with multiple candidates", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("this.handle"),
        names: { handle: ["sym:a.handle", "sym:b.handle"] },
      }),
    );
    assert.strictEqual(result, null);
  });

  it("resolves direct import lookup", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("validateToken"),
        imported: { validateToken: ["sym:auth.validateToken"] },
      }),
    );
    assert.deepStrictEqual(result, {
      symbolId: "sym:auth.validateToken",
      isResolved: true,
      strategy: "exact",
      confidence: 0.88,
    });
  });

  it("returns null for direct import with multiple candidates", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("helper"),
        imported: { helper: ["sym:a.helper", "sym:b.helper"] },
      }),
    );
    assert.strictEqual(result, null);
  });

  it("returns null for unknown identifier (falls through to generic)", () => {
    const result = tsResolve(makeContext({ call: makeCall("unknownFn") }));
    assert.strictEqual(result, null);
  });

  it("strips 'new ' prefix before resolution", () => {
    const result = tsResolve(
      makeContext({
        call: makeCall("new MyClass"),
        imported: { MyClass: ["sym:my.MyClass"] },
      }),
    );
    assert.deepStrictEqual(result, {
      symbolId: "sym:my.MyClass",
      isResolved: true,
      strategy: "exact",
      confidence: 0.88,
    });
  });

  it("returns null for empty identifier after stripping", () => {
    const result = tsResolve(makeContext({ call: makeCall("") }));
    assert.strictEqual(result, null);
  });
});

// --- isBuiltinCall ---

describe("isBuiltinCall with Rust macros", () => {
  it("detects Rust macros via BUILTIN_MACROS", () => {
    assert.strictEqual(isBuiltinCall("println!"), true);
    assert.strictEqual(isBuiltinCall("vec!"), true);
    assert.strictEqual(isBuiltinCall("todo!"), true);
  });

  it("does not match non-macro identifiers with !", () => {
    assert.strictEqual(isBuiltinCall("myMacro!"), false);
    assert.strictEqual(isBuiltinCall("custom_log!"), false);
  });

  it("compound names with builtin constructors still work", () => {
    assert.strictEqual(isBuiltinCall("Vec::new"), true);
    assert.strictEqual(isBuiltinCall("HashMap::from"), true);
  });

  it("compound names with non-builtins return false", () => {
    assert.strictEqual(isBuiltinCall("MyStruct::new"), false);
    assert.strictEqual(isBuiltinCall("Config::load"), false);
  });

  it("compound names check BUILTIN_MACROS too (I1 fix)", () => {
    // A compound path containing a known macro part should match
    assert.strictEqual(isBuiltinCall("debug::assert_eq!"), true);
  });

  it("does not contain derive! or macro_rules! (S5 fix)", () => {
    assert.ok(!BUILTIN_MACROS.has("derive!"), "derive! is attribute syntax, not a call");
    assert.ok(!BUILTIN_MACROS.has("macro_rules!"), "macro_rules! is a definition, not a call");
  });
});

// --- isExternalCrateCall ---

describe("isExternalCrateCall", () => {
  it("returns false for non-pathed identifiers", () => {
    assert.strictEqual(isExternalCrateCall("foo", new Set()), false);
  });

  it("matches dynamic external crate prefixes", () => {
    const dynamic = new Set(["serde", "tokio"]);
    assert.strictEqual(isExternalCrateCall("serde::Deserialize", dynamic), true);
    assert.strictEqual(isExternalCrateCall("tokio::spawn", dynamic), true);
  });

  it("matches known universal crate prefixes (std, core, alloc)", () => {
    assert.strictEqual(isExternalCrateCall("std::fs::read", new Set()), true);
    assert.strictEqual(isExternalCrateCall("core::mem::swap", new Set()), true);
    assert.strictEqual(isExternalCrateCall("alloc::vec::Vec", new Set()), true);
  });

  it("does not match repo-internal crate paths", () => {
    assert.strictEqual(isExternalCrateCall("my_crate::utils::helper", new Set()), false);
  });

  it("KNOWN_EXTERNAL_CRATE_PREFIXES only contains universal crates (S1 fix)", () => {
    // After trimming, only std/core/alloc should remain
    assert.ok(KNOWN_EXTERNAL_CRATE_PREFIXES.has("std"));
    assert.ok(KNOWN_EXTERNAL_CRATE_PREFIXES.has("core"));
    assert.ok(KNOWN_EXTERNAL_CRATE_PREFIXES.has("alloc"));
    assert.strictEqual(KNOWN_EXTERNAL_CRATE_PREFIXES.size, 3);
  });
});

// --- disambiguateRustCandidates ---

describe("disambiguateRustCandidates", () => {
  it("returns the only candidate if length is 1", () => {
    const details = new Map([["sym:a", { filePath: "src/lib.rs", exported: true }]]);
    assert.strictEqual(disambiguateRustCandidates(["sym:a"], "src/main.rs", details), "sym:a");
  });

  it("returns null for empty candidates", () => {
    assert.strictEqual(disambiguateRustCandidates([], "src/main.rs", new Map()), null);
  });

  it("prefers same module subtree when unique", () => {
    const details = new Map([
      ["sym:a", { filePath: "src/handlers/auth.rs", exported: true }],
      ["sym:b", { filePath: "src/utils/misc.rs", exported: true }],
    ]);
    // Caller is in src/handlers/routes.rs → same parent module "crate::handlers"
    const result = disambiguateRustCandidates(
      ["sym:a", "sym:b"],
      "src/handlers/routes.rs",
      details,
    );
    assert.strictEqual(result, "sym:a");
  });

  it("prefers exported over private when module tie", () => {
    const details = new Map([
      ["sym:a", { filePath: "src/lib.rs", exported: false }],
      ["sym:b", { filePath: "src/lib.rs", exported: true }],
    ]);
    const result = disambiguateRustCandidates(
      ["sym:a", "sym:b"],
      "src/main.rs",
      details,
    );
    assert.strictEqual(result, "sym:b");
  });

  it("prefers non-test over test symbols", () => {
    const details = new Map([
      ["sym:a", { filePath: "src/tests/integration.rs", exported: true }],
      ["sym:b", { filePath: "src/core/engine.rs", exported: true }],
    ]);
    const result = disambiguateRustCandidates(
      ["sym:a", "sym:b"],
      "src/main.rs",
      details,
    );
    assert.strictEqual(result, "sym:b");
  });

  it("returns null when still ambiguous", () => {
    const details = new Map([
      ["sym:a", { filePath: "src/a.rs", exported: true }],
      ["sym:b", { filePath: "src/b.rs", exported: true }],
    ]);
    const result = disambiguateRustCandidates(
      ["sym:a", "sym:b"],
      "src/main.rs",
      details,
    );
    assert.strictEqual(result, null);
  });
});
