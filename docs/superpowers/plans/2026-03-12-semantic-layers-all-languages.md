# Extend Semantic Layers to All Supported Languages — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the semantic resolution gaps across all 11 language adapters by implementing `resolveCall` hooks, `ImportResolutionAdapter`s, and `Pass2Resolver`s where they add measurable value.

**Architecture:** Three independent semantic layers (adapter-level `resolveCall`, import-resolution adapters, cross-file pass2 resolvers) each have well-defined interfaces and existing reference implementations. Work proceeds language-by-language within each layer, following the existing patterns exactly. Each new implementation is a single file + registration + tests. No framework changes needed.

**Tech Stack:** TypeScript, tree-sitter (AST parsing), node:test (testing), LadybugDB (graph persistence)

---

## Current State Matrix

```
Layer 1: resolveCall (adapter-level, pass1)
Layer 2: ImportResolutionAdapter (specifier → file paths)
Layer 3: Pass2Resolver (cross-file semantic edges)

                 resolveCall   ImportRes    Pass2
TypeScript       ❌            ❌ (rel.)    ✅ TsPass2
Python           ✅            ❌           ❌
Go               ✅            ✅           ✅ GoPass2
Java             ✅            ✅ (shared)  ❌
C#               ❌            ❌           ❌
C                ❌            ❌           ❌
C++              ❌            ❌           ❌
PHP              ❌            ✅           ❌
Rust             ❌            ✅           ❌
Kotlin           ❌            ✅ (shared)  ❌
Shell            ❌            ❌           ❌
```

## Target State Matrix

```
                 resolveCall   ImportRes    Pass2
TypeScript       ⊘ skip        ⊘ skip       ✅ (exists)
Python           ✅ (exists)   ✅ NEW        ✅ NEW
Go               ✅ (exists)   ✅ (exists)   ✅ (exists)
Java             ✅ (exists)   ✅ (exists)   ✅ NEW
C#               ✅ NEW        ✅ NEW        ⊘ defer
C                ⊘ skip        ⊘ skip        ⊘ skip
C++              ✅ NEW        ⊘ skip        ⊘ defer
PHP              ✅ NEW        ✅ (exists)   ✅ NEW
Rust             ✅ NEW        ✅ (exists)   ✅ NEW
Kotlin           ✅ NEW        ✅ (exists)   ✅ NEW
Shell            ⊘ skip        ⊘ skip        ⊘ skip
```

**Key:** ✅ = implement, ⊘ = skip (ROI too low or covered by existing infrastructure)

### Skip Justifications

- **TypeScript resolveCall**: Pass2 (TsPass2Resolver) handles everything; generic fallback was designed for TS. Adding resolveCall would be redundant.
- **TypeScript ImportResolution**: Built-in relative resolver in `registry.ts` already handles `./`/`../` imports. Bare module resolution (node_modules) and tsconfig paths would require reading tsconfig — the TS compiler API in pass2 already covers this.
- **C resolveCall**: No receivers, no namespaces. Generic fallback's global-name matching is sufficient.
- **C ImportResolution**: `#include "foo.h"` is relative (already handled). `#include <system.h>` is build-system-specific (CMake/Make include paths) — not resolvable without build config.
- **C/C++/Shell Pass2**: Very high effort for marginal gain. C has no namespacing; C++ needs template/vtable resolution; Shell sourcing is dynamic.
- **Shell resolveCall/ImportRes**: No OOP, no module system. `source ./file.sh` is already handled by relative resolver.
- **C++ ImportResolution**: Same problem as C — include paths are build-system-specific.

---

## Priority Order (by impact × effort)

| Priority | Task                                 | Impact                             | Effort    | Phase |
| -------- | ------------------------------------ | ---------------------------------- | --------- | ----- |
| P0       | Foundation: resolveCall test harness | Enables all resolveCall work       | Low       | 1     |
| P1       | resolveCall: C#                      | High (popular lang, no resolution) | Low       | 2     |
| P2       | resolveCall: Kotlin                  | High (mirrors Java exactly)        | Low       | 2     |
| P3       | resolveCall: Rust                    | High (self/Type:: patterns)        | Medium    | 2     |
| P4       | resolveCall: PHP                     | Medium ($this/self/parent)         | Medium    | 2     |
| P5       | resolveCall: C++                     | Medium (this->/Namespace::)        | Medium    | 2     |
| P6       | ImportResolution: Python             | High (relative imports, packages)  | Medium    | 3     |
| P7       | ImportResolution: C#                 | Medium (namespace→directory)       | Medium    | 3     |
| P8       | Pass2: Python                        | High (cross-module, class methods) | High      | 4     |
| P9       | Pass2: Java                          | High (same-package, inheritance)   | High      | 4     |
| P10      | Pass2: Kotlin                        | High (same as Java + extensions)   | High      | 4     |
| P11      | Pass2: Rust                          | High (impl blocks, traits)         | Very High | 4     |
| P12      | Pass2: PHP                           | Medium (autoload classes)          | Medium    | 4     |

---

## Chunk 1: Foundation — resolveCall Test Harness

### Background

All three existing `resolveCall` implementations (Python, Go, Java) have **zero direct unit tests**. The hook is only exercised indirectly through full indexing integration tests. Before adding 5 new implementations, we need a direct unit test pattern that exercises `resolveCall` in isolation with mock `CallResolutionContext` inputs.

### Contracts and Types Reference

```typescript
// INPUT — src/indexer/adapter/LanguageAdapter.ts:9-14
interface CallResolutionContext {
  call: ExtractedCall;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  nameToSymbolIds: Map<string, string[]>;
}

// OUTPUT — src/indexer/adapter/LanguageAdapter.ts:16-23
interface AdapterResolvedCall {
  symbolId: string | null;
  isResolved: boolean;
  confidence?: number;
  strategy?: EdgeResolutionStrategy; // "exact" | "heuristic" | "unresolved"
  candidateCount?: number;
  targetName?: string;
}

// The hook — src/indexer/adapter/LanguageAdapter.ts:65
resolveCall?(context: CallResolutionContext): AdapterResolvedCall | null;
```

### Task 1: Create resolveCall Test Harness

**Files:**

- Create: `tests/unit/resolve-call-hook.test.ts`

- [ ] **Step 1: Write test helper factory and first Python test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CallResolutionContext,
  AdapterResolvedCall,
} from "../../src/indexer/adapter/LanguageAdapter.js";
import type { ExtractedCall } from "../../src/indexer/treesitter/extractCalls.js";
import { PythonAdapter } from "../../src/indexer/adapter/python.js";
import { GoAdapter } from "../../src/indexer/adapter/go.js";
import { JavaAdapter } from "../../src/indexer/adapter/java.js";

function makeCall(overrides: Partial<ExtractedCall> = {}): ExtractedCall {
  return {
    callerNodeId: "caller-1",
    calleeIdentifier: overrides.calleeIdentifier ?? "someFunction",
    isResolved: false,
    callType: overrides.callType ?? "function",
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 20 },
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<CallResolutionContext> = {},
): CallResolutionContext {
  return {
    call: overrides.call ?? makeCall(),
    importedNameToSymbolIds: overrides.importedNameToSymbolIds ?? new Map(),
    namespaceImports: overrides.namespaceImports ?? new Map(),
    nameToSymbolIds: overrides.nameToSymbolIds ?? new Map(),
  };
}

describe("resolveCall hook — Python", () => {
  const adapter = new PythonAdapter();

  it("resolves direct import (single candidate)", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "helper" }),
      importedNameToSymbolIds: new Map([["helper", ["sym-1"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-1");
    assert.equal(result.isResolved, true);
  });

  it("resolves self.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "self.process" }),
      nameToSymbolIds: new Map([["process", ["sym-2"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-2");
    assert.equal(result.isResolved, true);
  });

  it("resolves namespace import (module.func)", () => {
    const nsMap = new Map([["helper", "sym-3"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "utils.helper" }),
      namespaceImports: new Map([["utils", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-3");
  });

  it("returns null for unresolvable call", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "unknown_func" }),
    });
    const result = adapter.resolveCall!(ctx);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Add Go resolveCall tests**

```typescript
describe("resolveCall hook — Go", () => {
  const adapter = new GoAdapter();

  it("resolves package-qualified call (fmt.Println)", () => {
    const nsMap = new Map([["Println", "sym-10"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "fmt.Println" }),
      namespaceImports: new Map([["fmt", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-10");
    assert.equal(result.isResolved, true);
  });

  it("resolves dot-import (import . 'strings')", () => {
    const dotMap = new Map([["Contains", "sym-11"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Contains" }),
      namespaceImports: new Map([[".", dotMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-11");
  });

  it("returns null for unresolved dotted call (no matching namespace)", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "obj.Method" }),
    });
    const result = adapter.resolveCall!(ctx);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 3: Add Java resolveCall tests**

```typescript
describe("resolveCall hook — Java", () => {
  const adapter = new JavaAdapter();

  it("resolves this.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "this.process" }),
      nameToSymbolIds: new Map([["process", ["sym-20"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-20");
    assert.equal(result.isResolved, true);
  });

  it("resolves super.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "super.init" }),
      nameToSymbolIds: new Map([["init", ["sym-21"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-21");
  });

  it("resolves namespace-qualified call (Collections.sort)", () => {
    const nsMap = new Map([["sort", "sym-22"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Collections.sort" }),
      namespaceImports: new Map([["Collections", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-22");
  });

  it("resolves direct import (unqualified name)", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "ArrayList" }),
      importedNameToSymbolIds: new Map([["ArrayList", ["sym-23"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-23");
  });
});
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx tsx --test tests/unit/resolve-call-hook.test.ts`
Expected: All tests PASS (these test existing implementations)

- [ ] **Step 5: Commit**

```bash
git add tests/unit/resolve-call-hook.test.ts
git commit -m "test: add direct unit tests for resolveCall hook (Python, Go, Java)"
```

---

## Chunk 2: resolveCall Implementations (5 Languages)

### Common Pattern

All existing resolveCall implementations follow the same decision tree:

```
1. Strip "new " prefix from calleeIdentifier, trim
2. If empty → return null
3. If dotted identifier:
   a. namespace lookup: namespaceImports[prefix][member] → exact, 0.9
   b. language-specific receiver (self/this/base) → heuristic, 0.78
4. Import lookup: importedNameToSymbolIds[name] → exact, 0.88–0.9
5. return null (defer to generic fallback)
```

**Confidence scale already in use:**
| Confidence | Meaning |
|-----------|---------|
| 0.92 | Namespace-qualified exact match |
| 0.9 | Direct import exact match |
| 0.88 | Import match (secondary position) |
| 0.78 | Self/this/super receiver (heuristic) |
| 0.76 | Dot-import / glob-import (heuristic) |

### Task 2: resolveCall for C#

C# mirrors Java exactly: `this.Method()` and `base.Method()` (C#'s `super` equivalent).

**Files:**

- Modify: `src/indexer/adapter/csharp.ts` (add `resolveCall` method + imports)
- Modify: `tests/unit/resolve-call-hook.test.ts` (add C# tests)

- [ ] **Step 1: Write failing C# resolveCall tests**

Add to `tests/unit/resolve-call-hook.test.ts`:

```typescript
import { CSharpAdapter } from "../../src/indexer/adapter/csharp.js";

describe("resolveCall hook — C#", () => {
  const adapter = new CSharpAdapter();

  it("implements resolveCall", () => {
    assert.equal(typeof adapter.resolveCall, "function");
  });

  it("resolves this.Method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "this.Process" }),
      nameToSymbolIds: new Map([["Process", ["sym-30"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-30");
    assert.equal(result.isResolved, true);
    assert.equal(result.strategy, "heuristic");
  });

  it("resolves base.Method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "base.Initialize" }),
      nameToSymbolIds: new Map([["Initialize", ["sym-31"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-31");
  });

  it("resolves namespace-qualified call (Math.Abs)", () => {
    const nsMap = new Map([["Abs", "sym-32"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Math.Abs" }),
      namespaceImports: new Map([["Math", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-32");
    assert.equal(result.strategy, "exact");
  });

  it("resolves direct import (unqualified name)", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Console" }),
      importedNameToSymbolIds: new Map([["Console", ["sym-33"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-33");
  });

  it("returns null for unknown call", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "UnknownMethod" }),
    });
    const result = adapter.resolveCall!(ctx);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/resolve-call-hook.test.ts`
Expected: C# tests FAIL — `adapter.resolveCall` is undefined

- [ ] **Step 3: Implement resolveCall in csharp.ts**

Add imports at top of `src/indexer/adapter/csharp.ts`:

```typescript
import type {
  AdapterResolvedCall,
  CallResolutionContext,
} from "./LanguageAdapter.js";
```

Add method to the `CSharpAdapter` class (after `extractCalls`):

```typescript
  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) return null;

    if (identifier.includes(".")) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // Namespace/static class qualified call: Math.Abs, Console.WriteLine
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }

      // C# receivers: this.Method, base.Method
      if (prefix === "this" || prefix === "base") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }
    }

    // Direct using import match (unqualified name)
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null;
  }
```

Note: `csharp.ts` implements `LanguageAdapter` directly (not via `BaseAdapter`). The method is added to the class object. You must also add `resolveCall` to the interface satisfaction — since `resolveCall?` is optional on `LanguageAdapter`, no interface change is needed; just implement the method.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/unit/resolve-call-hook.test.ts`
Expected: All C# tests PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src/indexer/adapter/csharp.ts tests/unit/resolve-call-hook.test.ts
git commit -m "feat(csharp): implement resolveCall hook — this/base receiver + namespace + import resolution"
```

---

### Task 3: resolveCall for Kotlin

Kotlin mirrors Java: `this.method()` and `super.method()`.

**Files:**

- Modify: `src/indexer/adapter/kotlin.ts` (add `resolveCall` method + imports)
- Modify: `tests/unit/resolve-call-hook.test.ts` (add Kotlin tests)

- [ ] **Step 1: Write failing Kotlin resolveCall tests**

Add to `tests/unit/resolve-call-hook.test.ts`:

```typescript
import { KotlinAdapter } from "../../src/indexer/adapter/kotlin.js";

describe("resolveCall hook — Kotlin", () => {
  const adapter = new KotlinAdapter();

  it("implements resolveCall", () => {
    assert.equal(typeof adapter.resolveCall, "function");
  });

  it("resolves this.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "this.process" }),
      nameToSymbolIds: new Map([["process", ["sym-40"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-40");
    assert.equal(result.isResolved, true);
  });

  it("resolves super.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "super.init" }),
      nameToSymbolIds: new Map([["init", ["sym-41"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-41");
  });

  it("resolves companion/object qualified call", () => {
    const nsMap = new Map([["create", "sym-42"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Factory.create" }),
      namespaceImports: new Map([["Factory", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-42");
  });

  it("resolves direct import", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "listOf" }),
      importedNameToSymbolIds: new Map([["listOf", ["sym-43"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-43");
  });

  it("returns null for unknown call", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "unknownFunc" }),
    });
    const result = adapter.resolveCall!(ctx);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/resolve-call-hook.test.ts`
Expected: Kotlin tests FAIL

- [ ] **Step 3: Implement resolveCall in kotlin.ts**

Add imports at top of `src/indexer/adapter/kotlin.ts`:

```typescript
import type {
  AdapterResolvedCall,
  CallResolutionContext,
} from "./LanguageAdapter.js";
```

Add method to the `KotlinAdapter` class (after `extractCalls`):

```typescript
  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) return null;

    if (identifier.includes(".")) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // Object/companion/package qualified call
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }

      // Kotlin receivers: this.method, super.method
      if (prefix === "this" || prefix === "super") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }
    }

    // Direct import match (unqualified name)
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null;
  }
```

Note: `kotlin.ts` implements `LanguageAdapter` directly. Same approach as C# above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/unit/resolve-call-hook.test.ts`
Expected: All Kotlin tests PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src/indexer/adapter/kotlin.ts tests/unit/resolve-call-hook.test.ts
git commit -m "feat(kotlin): implement resolveCall hook — this/super receiver + namespace + import resolution"
```

---

### Task 4: resolveCall for Rust

Rust uses `self.method()` for receiver calls and `Type::method()` for associated function calls. The `::` separator differentiates Rust from `.`-separated languages.

**Important:** Rust's `extractCalls` (in `rust.ts`) already extracts calls with identifiers like `self.process`, `HashMap::new`, `Vec::push`. Check what format `calleeIdentifier` uses — the adapter uses `.` for method calls on instances and `::` for scoped/associated calls.

**Files:**

- Modify: `src/indexer/adapter/rust.ts` (add `resolveCall` method + imports)
- Modify: `tests/unit/resolve-call-hook.test.ts` (add Rust tests)

- [ ] **Step 1: Write failing Rust resolveCall tests**

```typescript
import { RustAdapter } from "../../src/indexer/adapter/rust.js";

describe("resolveCall hook — Rust", () => {
  const adapter = new RustAdapter();

  it("implements resolveCall", () => {
    assert.equal(typeof adapter.resolveCall, "function");
  });

  it("resolves self.method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "self.process" }),
      nameToSymbolIds: new Map([["process", ["sym-50"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-50");
    assert.equal(result.isResolved, true);
  });

  it("resolves Type::method via namespace imports", () => {
    const nsMap = new Map([["new", "sym-51"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "HashMap::new" }),
      namespaceImports: new Map([["HashMap", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-51");
    assert.equal(result.strategy, "exact");
  });

  it("resolves direct use import (unqualified)", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "process_data" }),
      importedNameToSymbolIds: new Map([["process_data", ["sym-52"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-52");
  });

  it("handles module-qualified call (mod::func)", () => {
    const nsMap = new Map([["helper", "sym-53"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "utils::helper" }),
      namespaceImports: new Map([["utils", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-53");
  });

  it("returns null for unresolvable call", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "unknown_func" }),
    });
    const result = adapter.resolveCall!(ctx);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement resolveCall in rust.ts**

Add imports at top of `src/indexer/adapter/rust.ts`:

```typescript
import type {
  AdapterResolvedCall,
  CallResolutionContext,
} from "./LanguageAdapter.js";
```

Add method to the `RustAdapter` class:

```typescript
  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) return null;

    // Rust uses both :: (scoped) and . (method) as separators
    const hasDot = identifier.includes(".");
    const hasDoubleColon = identifier.includes("::");

    if (hasDot) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // self.method — Rust instance method receiver
      if (prefix === "self") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }

      // variable.method — namespace import lookup
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    if (hasDoubleColon) {
      const parts = identifier.split("::");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // Type::method or mod::func — namespace import lookup
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    // Direct use import match (unqualified name)
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null;
  }
```

Note: `rust.ts` implements `LanguageAdapter` directly. Check what `extractCalls` produces for `calleeIdentifier` with `::` — the adapter's `extractChainedCalls` and the 4 call query patterns may produce different identifier formats. Verify with existing `tests/integration/rust-adapter-calls.test.ts` fixtures before finalizing.

- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Run typecheck**
- [ ] **Step 6: Commit**

```bash
git add src/indexer/adapter/rust.ts tests/unit/resolve-call-hook.test.ts
git commit -m "feat(rust): implement resolveCall hook — self receiver + Type:: scoped + use import resolution"
```

---

### Task 5: resolveCall for PHP

PHP uses `$this->method()`, `self::method()`, `static::method()`, and `parent::method()` — four receiver keywords. The `->` and `::` separators mean the identifier format differs from `.`-separated languages.

**Important:** Check what `php.ts`'s `extractCalls` produces for `calleeIdentifier` — the 6 query patterns (function call, variable call, member call, variable member, scoped static `::`, qualified scoped) may produce identifiers with `->` or `::` or `.` depending on normalization.

**Files:**

- Modify: `src/indexer/adapter/php.ts` (add `resolveCall` method + imports)
- Modify: `tests/unit/resolve-call-hook.test.ts` (add PHP tests)

- [ ] **Step 1: Write failing PHP resolveCall tests**

```typescript
import { PhpAdapter } from "../../src/indexer/adapter/php.js";

describe("resolveCall hook — PHP", () => {
  const adapter = new PhpAdapter();

  it("implements resolveCall", () => {
    assert.equal(typeof adapter.resolveCall, "function");
  });

  // NOTE: Verify the exact calleeIdentifier format from extractCalls before finalizing.
  // PHP extractCalls may use "." instead of "->" for member access.
  // Check php.ts and tests/integration/php-adapter.test.ts fixtures.

  it("resolves $this->method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "$this.process" }),
      nameToSymbolIds: new Map([["process", ["sym-60"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-60");
  });

  it("resolves self::staticMethod via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "self.staticMethod" }),
      nameToSymbolIds: new Map([["staticMethod", ["sym-61"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-61");
  });

  it("resolves parent::method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "parent.init" }),
      nameToSymbolIds: new Map([["init", ["sym-62"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-62");
  });

  it("resolves ClassName::staticCall via namespace imports", () => {
    const nsMap = new Map([["getInstance", "sym-63"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "Cache.getInstance" }),
      namespaceImports: new Map([["Cache", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-63");
  });

  it("resolves direct use import", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "array_map" }),
      importedNameToSymbolIds: new Map([["array_map", ["sym-64"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-64");
  });
});
```

- [ ] **Step 2: Verify calleeIdentifier format from php.ts extractCalls**

Before implementing, read the `extractCalls` method in `src/indexer/adapter/php.ts` to verify how it normalizes `->` and `::` in `calleeIdentifier`. The tests above assume `.` normalization — adjust if the adapter uses the raw PHP separators.

- [ ] **Step 3: Implement resolveCall in php.ts**

Add imports and implement the method following the receiver pattern. PHP receivers:

- `$this` → instance method
- `self` → static method (same class)
- `static` → late static binding
- `parent` → parent class method

```typescript
  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) return null;

    if (identifier.includes(".")) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // Namespace/class qualified: ClassName.method
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }

      // PHP receivers: $this, self, static, parent
      if (prefix === "$this" || prefix === "self" || prefix === "static" || prefix === "parent") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }
    }

    // Direct import/use match
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null;
  }
```

- [ ] **Step 4: Run tests, typecheck, commit**

---

### Task 6: resolveCall for C++

C++ uses `this->method()` (pointer receiver) and `Namespace::function()` / `Class::staticMethod()` (scope resolution). The `::` separator is key.

**Important:** C++'s `extractCalls` in `cpp.ts` already handles `template_function` calls. The `calleeIdentifier` may contain `::` for namespace-qualified calls. Check existing fixtures.

**Files:**

- Modify: `src/indexer/adapter/cpp.ts` (add `resolveCall` method + imports)
- Modify: `tests/unit/resolve-call-hook.test.ts` (add C++ tests)

- [ ] **Step 1: Write failing C++ resolveCall tests**

```typescript
import { CppAdapter } from "../../src/indexer/adapter/cpp.js";

describe("resolveCall hook — C++", () => {
  const adapter = new CppAdapter();

  it("implements resolveCall", () => {
    assert.equal(typeof adapter.resolveCall, "function");
  });

  it("resolves this->method via local symbols", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "this.process" }),
      nameToSymbolIds: new Map([["process", ["sym-70"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-70");
  });

  it("resolves Namespace::function via namespace imports", () => {
    const nsMap = new Map([["sort", "sym-71"]]);
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "std::sort" }),
      namespaceImports: new Map([["std", nsMap]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-71");
  });

  it("resolves direct include import", () => {
    const ctx = makeContext({
      call: makeCall({ calleeIdentifier: "printf" }),
      importedNameToSymbolIds: new Map([["printf", ["sym-72"]]]),
    });
    const result = adapter.resolveCall!(ctx);
    assert.ok(result);
    assert.equal(result.symbolId, "sym-72");
  });
});
```

- [ ] **Step 2: Verify calleeIdentifier format from cpp.ts extractCalls**

- [ ] **Step 3: Implement resolveCall in cpp.ts**

```typescript
  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) return null;

    // Check both . (normalized method access) and :: (scope resolution)
    const hasDot = identifier.includes(".");
    const hasDoubleColon = identifier.includes("::");

    if (hasDot) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // this->method (normalized to this.method by extractCalls)
      if (prefix === "this") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }

      // object.method — namespace lookup
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    if (hasDoubleColon) {
      const parts = identifier.split("::");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // Namespace::func or Class::staticMethod
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    // Direct include import match
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null;
  }
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
git commit -m "feat(cpp): implement resolveCall hook — this-> receiver + Namespace:: scoped + import resolution"
```

---

## Chunk 3: Import Resolution Adapters (2 Languages)

### Contracts Reference

```typescript
// src/indexer/import-resolution/types.ts
interface ImportResolutionAdapter {
  readonly id: string;
  supports(language: string): boolean;
  resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]>;
}

interface ResolveImportCandidatePathsParams {
  language: string; // e.g. "python"
  repoRoot: string; // absolute path to repo root
  importerRelPath: string; // relative path of the importing file
  specifier: string; // raw import string from source
  extensions: string[]; // file extensions for this language
}
```

**Registration:** Add instance to `IMPORT_RESOLUTION_ADAPTERS` array in `src/indexer/import-resolution/registry.ts`.

**Testing pattern:** Real temp directories with `mkdtempSync`, real files, call `resolveImportCandidatePaths` from registry.

### Task 7: ImportResolutionAdapter for Python

Python relative imports use `.` and `..` prefix syntax: `from . import foo`, `from ..utils import bar`. These are NOT handled by the built-in `./`/`../` relative resolver because Python uses a different syntax. Python absolute imports use dot-separated package paths: `from mypackage.submodule import func`.

**Files:**

- Create: `src/indexer/import-resolution/python-adapter.ts`
- Modify: `src/indexer/import-resolution/registry.ts` (register adapter)
- Modify: `tests/unit/import-resolution-adapters.test.ts` (add Python tests)

- [ ] **Step 1: Write failing Python import resolution tests**

Add to `tests/unit/import-resolution-adapters.test.ts`:

```typescript
it("resolves Python relative dot-import (from . import foo)", async () => {
  const repoRoot = createTempRepo("sdl-python-imports-");
  writeRepoFile(repoRoot, "mypackage/__init__.py", "");
  writeRepoFile(repoRoot, "mypackage/foo.py", "def helper(): pass");
  writeRepoFile(repoRoot, "mypackage/bar.py", "from . import foo");

  const paths = await resolveImportCandidatePaths({
    language: "python",
    repoRoot,
    importerRelPath: "mypackage/bar.py",
    specifier: ".foo",
    extensions: [".py"],
  });

  assert.deepStrictEqual(paths, ["mypackage/foo.py"]);
});

it("resolves Python parent relative import (from ..utils import bar)", async () => {
  const repoRoot = createTempRepo("sdl-python-imports-");
  writeRepoFile(repoRoot, "pkg/__init__.py", "");
  writeRepoFile(repoRoot, "pkg/utils.py", "def bar(): pass");
  writeRepoFile(repoRoot, "pkg/sub/__init__.py", "");
  writeRepoFile(repoRoot, "pkg/sub/mod.py", "from ..utils import bar");

  const paths = await resolveImportCandidatePaths({
    language: "python",
    repoRoot,
    importerRelPath: "pkg/sub/mod.py",
    specifier: "..utils",
    extensions: [".py"],
  });

  assert.deepStrictEqual(paths, ["pkg/utils.py"]);
});

it("resolves Python absolute package import", async () => {
  const repoRoot = createTempRepo("sdl-python-imports-");
  writeRepoFile(repoRoot, "mypackage/__init__.py", "");
  writeRepoFile(repoRoot, "mypackage/core/__init__.py", "");
  writeRepoFile(repoRoot, "mypackage/core/engine.py", "class Engine: pass");

  const paths = await resolveImportCandidatePaths({
    language: "python",
    repoRoot,
    importerRelPath: "main.py",
    specifier: "mypackage.core.engine",
    extensions: [".py"],
  });

  assert.deepStrictEqual(paths, ["mypackage/core/engine.py"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement python-adapter.ts**

```typescript
import { dirname, join, resolve } from "path";
import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";
import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

export class PythonImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "python";

  supports(language: string): boolean {
    return language === "python";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const { specifier, repoRoot, importerRelPath, extensions } = params;

    if (!specifier) return [];

    // Relative imports: leading dots
    if (specifier.startsWith(".")) {
      return this.resolveRelativeImport(
        specifier,
        repoRoot,
        importerRelPath,
        extensions,
      );
    }

    // Absolute imports: dot-separated package path
    if (specifier.includes(".")) {
      return this.resolveAbsoluteImport(specifier, repoRoot, extensions);
    }

    // Single-segment import: try as top-level module
    return this.resolveSingleSegment(specifier, repoRoot, extensions);
  }

  private async resolveRelativeImport(
    specifier: string,
    repoRoot: string,
    importerRelPath: string,
    extensions: string[],
  ): Promise<string[]> {
    // Count leading dots
    let dotCount = 0;
    while (dotCount < specifier.length && specifier[dotCount] === ".") {
      dotCount++;
    }

    const modulePart = specifier.slice(dotCount);
    let baseDir = dirname(normalizePath(importerRelPath));

    // Each dot beyond the first goes up one directory
    for (let i = 1; i < dotCount; i++) {
      baseDir = dirname(baseDir);
    }

    if (!modulePart) {
      // "from . import foo" — specifier is just dots, resolve to __init__.py
      return this.findPythonModule(repoRoot, baseDir, extensions);
    }

    // Convert dot-separated module path to directory path
    const segments = modulePart.split(".");
    const modulePath = join(baseDir, ...segments);

    return this.findPythonModule(repoRoot, modulePath, extensions);
  }

  private async resolveAbsoluteImport(
    specifier: string,
    repoRoot: string,
    extensions: string[],
  ): Promise<string[]> {
    const segments = specifier.split(".");
    const modulePath = join(...segments);

    return this.findPythonModule(repoRoot, modulePath, extensions);
  }

  private async resolveSingleSegment(
    specifier: string,
    repoRoot: string,
    extensions: string[],
  ): Promise<string[]> {
    return this.findPythonModule(repoRoot, specifier, extensions);
  }

  private async findPythonModule(
    repoRoot: string,
    modulePath: string,
    extensions: string[],
  ): Promise<string[]> {
    const candidates: string[] = [];
    const normalized = normalizePath(modulePath);

    // Try as file: module.py
    for (const ext of extensions) {
      const filePath = `${normalized}${ext}`;
      if (await existsAsync(resolve(repoRoot, filePath))) {
        candidates.push(normalizePath(filePath));
      }
    }

    // Try as package: module/__init__.py
    for (const ext of extensions) {
      const initPath = normalizePath(join(normalized, `__init__${ext}`));
      if (await existsAsync(resolve(repoRoot, initPath))) {
        candidates.push(normalizePath(initPath));
      }
    }

    return Array.from(new Set(candidates)).sort();
  }
}
```

- [ ] **Step 4: Register in registry.ts**

Add import and instance to `src/indexer/import-resolution/registry.ts`:

```typescript
import { PythonImportResolutionAdapter } from "./python-adapter.js";

const IMPORT_RESOLUTION_ADAPTERS: ImportResolutionAdapter[] = [
  new GoImportResolutionAdapter(),
  new JavaKotlinImportResolutionAdapter(),
  new RustImportResolutionAdapter(),
  new PhpImportResolutionAdapter(),
  new PythonImportResolutionAdapter(), // NEW
];
```

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
git commit -m "feat(python): add import resolution adapter — relative dot-imports + absolute package paths"
```

---

### Task 8: ImportResolutionAdapter for C#

C# uses `using Namespace.Class;` — dot-separated namespace paths that map to directory/file structure. Similar pattern to Java/Kotlin.

**Files:**

- Create: `src/indexer/import-resolution/csharp-adapter.ts`
- Modify: `src/indexer/import-resolution/registry.ts` (register adapter)
- Modify: `tests/unit/import-resolution-adapters.test.ts` (add C# tests)

- [ ] **Step 1: Write failing C# import resolution tests**

```typescript
it("resolves C# namespace import (using MyApp.Services)", async () => {
  const repoRoot = createTempRepo("sdl-csharp-imports-");
  writeRepoFile(
    repoRoot,
    "MyApp/Services/UserService.cs",
    "namespace MyApp.Services { class UserService {} }",
  );

  const paths = await resolveImportCandidatePaths({
    language: "csharp",
    repoRoot,
    importerRelPath: "MyApp/Program.cs",
    specifier: "MyApp.Services.UserService",
    extensions: [".cs"],
  });

  assert.deepStrictEqual(paths, ["MyApp/Services/UserService.cs"]);
});
```

- [ ] **Step 2: Implement csharp-adapter.ts**

Follow the Java/Kotlin adapter pattern: split specifier on `.`, treat last segment as type name, preceding segments as directory path. Check exact file existence first, fall back to fast-glob.

```typescript
import fastGlob from "fast-glob";
import { dirname, join } from "path";
import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";
import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

export class CSharpImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "csharp";

  supports(language: string): boolean {
    return language === "csharp";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    if (!params.specifier.includes(".")) return [];

    const parts = params.specifier.split(".");
    const typeName = parts[parts.length - 1] ?? "";
    const namespacePath = parts.slice(0, -1).join("/");

    if (!namespacePath || !typeName) return [];

    const matches: string[] = [];

    // Primary: exact path from namespace structure
    for (const ext of params.extensions) {
      const candidate = normalizePath(join(namespacePath, `${typeName}${ext}`));
      if (await existsAsync(join(params.repoRoot, candidate))) {
        matches.push(candidate);
      }
    }

    if (matches.length > 0) {
      return Array.from(new Set(matches)).sort();
    }

    // Fallback: glob search across repo
    const fallbackPatterns = params.extensions.map(
      (ext) => `**/${typeName}${ext}`,
    );
    const fallbackMatches = await fastGlob(fallbackPatterns, {
      cwd: params.repoRoot,
      onlyFiles: true,
    });
    return fallbackMatches.map((p) => normalizePath(p)).sort();
  }
}
```

- [ ] **Step 3: Register in registry.ts**

```typescript
import { CSharpImportResolutionAdapter } from "./csharp-adapter.js";
// Add: new CSharpImportResolutionAdapter() to IMPORT_RESOLUTION_ADAPTERS array
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
git commit -m "feat(csharp): add import resolution adapter — namespace-to-directory path resolution"
```

---

## Chunk 4: Pass2 Resolvers (5 Languages)

### Contracts Reference

```typescript
// src/indexer/pass2/types.ts
interface Pass2Resolver {
  readonly id: string;
  supports(target: Pass2Target): boolean;
  resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult>;
}

interface Pass2Target {
  repoId?: string;
  fileId?: string;
  filePath: string;
  extension: string;
  language: string;
}

interface Pass2ResolverContext {
  repoRoot: string;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: CallResolutionTelemetry;
  cache?: Map<string, unknown>;
}

interface Pass2ResolverResult {
  edgesCreated: number;
}
```

**Registration:** Add instance to array in `createDefaultPass2ResolverRegistry()` in `src/indexer/pass2/registry.ts`.

**Pipeline behavior:** When a pass2 resolver is registered for a language, pass1 **skips call edge creation** for files of that language (`skipCallResolution = true` in `indexer.ts`). All call edges come exclusively from the pass2 resolver. This is critical — the pass2 resolver must handle ALL call resolution, not just the gaps.

**Reference implementation:** `GoPass2Resolver` (794 lines) is the best template for languages with package/namespace semantics.

### Important Architecture Note

Each pass2 resolver follows this internal structure:

1. Re-parse the file with the language adapter
2. Re-extract symbols, imports, and calls
3. Map extracted symbols to existing DB symbols (4-strategy fallback: full_range → start_only → start_line → name_kind_unique)
4. Build an import-resolved name index (cross-file scope)
5. Resolve each call using the language-specific algorithm
6. Write edges to LadybugDB with `resolverId`, `resolutionPhase: "pass2"`, and `resolution` string
7. Return edge count

### Task 9: Pass2 Resolver for Python

**What it resolves that pass1 can't:**

- Cross-module function calls (e.g., `from utils import helper` then `helper()`)
- `self.method()` where method is defined in a parent class
- `import *` resolution (all exported names from the imported module)
- Class-level method dispatch across files

**Files:**

- Create: `src/indexer/pass2/resolvers/python-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts` (register resolver)
- Create: `tests/unit/python-pass2-resolver.test.ts` (unit tests)
- Create: `tests/integration/python-pass2-indexing.test.ts` (integration tests)

- [ ] **Step 1: Write unit test for supports() and repoId guard**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PythonPass2Resolver } from "../../src/indexer/pass2/resolvers/python-pass2-resolver.js";
import type { Pass2Target } from "../../src/indexer/pass2/types.js";

describe("PythonPass2Resolver", () => {
  const resolver = new PythonPass2Resolver();

  it("has id 'pass2-python'", () => {
    assert.equal(resolver.id, "pass2-python");
  });

  it("supports .py files with python language", () => {
    const target: Pass2Target = {
      filePath: "src/app.py",
      extension: ".py",
      language: "python",
    };
    assert.equal(resolver.supports(target), true);
  });

  it("does not support .ts files", () => {
    const target: Pass2Target = {
      filePath: "src/app.ts",
      extension: ".ts",
      language: "typescript",
    };
    assert.equal(resolver.supports(target), false);
  });

  it("throws if repoId is missing", async () => {
    const target: Pass2Target = {
      filePath: "src/app.py",
      extension: ".py",
      language: "python",
    };
    await assert.rejects(() => resolver.resolve(target, {} as any), {
      message: /requires target\.repoId/,
    });
  });
});
```

- [ ] **Step 2: Implement PythonPass2Resolver skeleton**

Create `src/indexer/pass2/resolvers/python-pass2-resolver.ts`. Use `GoPass2Resolver` as the structural template. Key differences from Go:

- **No package concept:** Python uses module/file-level scope. The "package index" equivalent is mapping `__init__.py` packages to their exported symbols.
- **Receiver types:** `self.method()` requires finding the class that `self` refers to and looking up the method in that class's defined symbols (same-file and inherited).
- **`import *` handling:** Resolve all exported symbols from the imported module.
- **Module-level scope:** All top-level symbols in a `.py` file are accessible to `import` statements.

The resolver should support these resolution strategies:

- `"same-module"` (0.92) — function/class defined in the same Python package
- `"import-matched"` (0.90) — direct import match cross-file
- `"receiver-self"` (0.85) — `self.method()` resolved to class method
- `"global-fallback"` (0.45) — unique name match repo-wide

- [ ] **Step 3: Register in registry.ts**

```typescript
import { PythonPass2Resolver } from "./resolvers/python-pass2-resolver.js";

export function createDefaultPass2ResolverRegistry(): Pass2ResolverRegistry {
  return createPass2ResolverRegistry([
    new TsPass2Resolver(),
    new GoPass2Resolver(),
    new PythonPass2Resolver(), // NEW
  ]);
}
```

- [ ] **Step 4: Write integration test**

Follow `tests/integration/go-pass2-indexing.test.ts` pattern: create a multi-file Python fixture, run `indexRepo()`, assert edges with correct `resolverId: "pass2-python"` and `resolutionPhase: "pass2"`.

- [ ] **Step 5: Run full test suite, typecheck, commit**

```bash
git commit -m "feat(python): add pass2 resolver — cross-module calls, self.method, import-star resolution"
```

---

### Task 10: Pass2 Resolver for Java

**What it resolves that pass1 can't:**

- Same-package class calls (Java convention: classes in the same package can reference each other without imports)
- `this.method()` where method is inherited
- Static import resolution
- Wildcard import resolution (`import java.util.*`)

**Files:**

- Create: `src/indexer/pass2/resolvers/java-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Create: `tests/unit/java-pass2-resolver.test.ts`
- Create: `tests/integration/java-pass2-indexing.test.ts`

- [ ] **Step 1: Write unit tests (supports, repoId guard)**
- [ ] **Step 2: Implement JavaPass2Resolver**

Key resolution strategies:

- `"same-package"` (0.92) — classes in the same directory/package
- `"import-matched"` (0.90) — cross-package import match
- `"receiver-this"` (0.85) — `this.method()` resolved via class hierarchy
- `"wildcard-import"` (0.80) — `import java.util.*` resolved to specific class
- `"global-fallback"` (0.45)

Structure mirrors GoPass2Resolver with:

- Package index: directory → all class/method symbols in that package
- Import index: import statements → resolved symbols
- Source root detection: reuse `resolveSourceRoot()` from `java-kotlin-adapter.ts`

- [ ] **Step 3: Register in registry.ts**
- [ ] **Step 4: Write integration test**
- [ ] **Step 5: Full test suite, typecheck, commit**

```bash
git commit -m "feat(java): add pass2 resolver — same-package calls, this/super, wildcard imports"
```

---

### Task 11: Pass2 Resolver for Kotlin

**Shares most logic with Java.** Kotlin and Java can coexist in the same project and reference each other. Key differences:

- Extension functions appear as top-level functions callable on receiver types
- Companion objects (`Companion.method()` or `ClassName.method()`)
- Object declarations (Kotlin singletons)

**Files:**

- Create: `src/indexer/pass2/resolvers/kotlin-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Create: `tests/unit/kotlin-pass2-resolver.test.ts`
- Create: `tests/integration/kotlin-pass2-indexing.test.ts`

**Approach:** If the Java resolver is well-structured, the Kotlin resolver can share the package index and resolution logic, extending it with Kotlin-specific patterns. Consider making a shared base class or shared utility module between the Java and Kotlin resolvers.

- [ ] **Step 1–5:** Same pattern as Java above, with Kotlin-specific extensions

```bash
git commit -m "feat(kotlin): add pass2 resolver — same-package, companion objects, extension functions"
```

---

### Task 12: Pass2 Resolver for Rust

**The most complex resolver.** Rust's module system, trait dispatch, and `impl` blocks create unique resolution challenges.

**What it resolves:**

- `impl Type { fn method() }` → `Type::method()` and `instance.method()` calls
- Trait method dispatch: `trait Foo { fn bar(&self) }` + `impl Foo for MyType { fn bar(&self) }` → `my_type.bar()` resolves to the `impl` method
- Module re-exports: `pub use submodule::Thing;` makes `Thing` accessible from the re-exporting module
- `use crate::module::function` cross-file resolution

**Files:**

- Create: `src/indexer/pass2/resolvers/rust-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Create: `tests/unit/rust-pass2-resolver.test.ts`
- Create: `tests/integration/rust-pass2-indexing.test.ts`

**Key resolution strategies:**

- `"impl-method"` (0.90) — `impl Type` block method resolution
- `"use-import"` (0.90) — cross-module `use` path resolution
- `"crate-path"` (0.88) — `crate::module::function` resolution
- `"trait-method"` (0.82) — trait impl method dispatch (lower confidence due to complexity)
- `"global-fallback"` (0.45)

**Note:** Trait dispatch is the hardest part. For MVP, focus on `impl` methods and `use` imports. Trait dispatch can be a follow-up.

- [ ] **Step 1–5:** Same pattern, Rust-specific resolution

```bash
git commit -m "feat(rust): add pass2 resolver — impl methods, use imports, crate:: paths"
```

---

### Task 13: Pass2 Resolver for PHP

**What it resolves:**

- `$this->method()` where method is inherited
- `ClassName::staticMethod()` cross-file resolution
- PSR-4 autoloaded class resolution (already have `PhpImportResolutionAdapter`)
- `use Namespace\ClassName` aliased calls

**Files:**

- Create: `src/indexer/pass2/resolvers/php-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Create: `tests/unit/php-pass2-resolver.test.ts`
- Create: `tests/integration/php-pass2-indexing.test.ts`

**Key resolution strategies:**

- `"use-import"` (0.90) — `use` statement namespace resolution
- `"psr4-autoload"` (0.88) — PSR-4 class file resolution
- `"receiver-this"` (0.85) — `$this->method()` class hierarchy dispatch
- `"static-call"` (0.85) — `ClassName::method()` resolution
- `"global-fallback"` (0.45)

- [ ] **Step 1–5:** Same pattern, PHP-specific resolution

```bash
git commit -m "feat(php): add pass2 resolver — use imports, PSR-4 autoload, $this/static resolution"
```

---

## Validation and Metrics

### After all implementations, verify:

- [ ] **Run full test suite:** `npm test`
- [ ] **Run typecheck:** `npm run typecheck`
- [ ] **Run lint:** `npm run lint`
- [ ] **Index the sdl-mcp repo and check health:**

```bash
npx tsx src/cli/index.ts index sdl-mcp
npx tsx src/cli/index.ts health sdl-mcp
```

The `edgeQuality` and `callResolution` health components should improve from the current values:

- `edgeQuality`: 0.68 → target ≥ 0.75
- `callResolution`: 0.68 → target ≥ 0.75

### Per-language validation:

For each language that received a new pass2 resolver, index a representative open-source repo and compare edge counts:

```bash
# Before (baseline)
npx tsx src/cli/index.ts index <repo> --full
npx tsx src/cli/index.ts health <repo> --json > before.json

# After (with new resolver)
npx tsx src/cli/index.ts index <repo> --full
npx tsx src/cli/index.ts health <repo> --json > after.json

# Compare edgeQuality and callResolution metrics
```

### Test repos per language:

- **Python**: any Django/Flask project with multiple modules
- **Java**: any Spring Boot project with package structure
- **Kotlin**: any Android project with Kotlin modules
- **Rust**: any multi-crate Cargo workspace
- **PHP**: any Laravel project with PSR-4 autoloading

---

## Final State Matrix

```
                 resolveCall   ImportRes    Pass2       Status
TypeScript       ⊘             ⊘            ✅          complete (unchanged)
Python           ✅             ✅ NEW       ✅ NEW      fully semantic
Go               ✅             ✅           ✅          complete (unchanged)
Java             ✅             ✅           ✅ NEW      fully semantic
C#               ✅ NEW         ✅ NEW       ⊘           2/3 layers
C                ⊘             ⊘            ⊘           baseline only
C++              ✅ NEW         ⊘            ⊘           1/3 layers
PHP              ✅ NEW         ✅           ✅ NEW      fully semantic
Rust             ✅ NEW         ✅           ✅ NEW      fully semantic
Kotlin           ✅ NEW         ✅           ✅ NEW      fully semantic
Shell            ⊘             ⊘            ⊘           baseline only
```

**Languages reaching full semantic coverage:** Python, Java, PHP, Rust, Kotlin (5 new, joining Go and TypeScript)
**Languages with partial improvement:** C# (2 layers), C++ (1 layer)
**Languages staying at baseline:** C, Shell (justified — no OOP/module system worth the effort)

---

## Estimated Effort

| Chunk                        | Tasks        | Estimated Time  | Complexity     |
| ---------------------------- | ------------ | --------------- | -------------- |
| 1: Foundation                | 1 task       | 1–2 hours       | Low            |
| 2: resolveCall (5 langs)     | 5 tasks      | 4–6 hours       | Low–Medium     |
| 3: ImportRes (2 langs)       | 2 tasks      | 3–4 hours       | Medium         |
| 4: Pass2 Resolvers (5 langs) | 5 tasks      | 20–40 hours     | High–Very High |
| **Total**                    | **13 tasks** | **28–52 hours** | —              |

Chunk 4 dominates effort. Each pass2 resolver is a significant piece of work (400–800 lines), with the Rust resolver being the most complex due to trait dispatch.

**Recommended execution order:** Chunks 1 → 2 → 3 → 4 (in priority order within chunk 4: Python → Java → Kotlin → PHP → Rust).
