# Extend Semantic Layers to C#, C++, C, and Shell — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining semantic resolution gaps for C#, C++, C, and Shell by adding the missing layers (ImportResolution adapters, Pass2Resolvers, and one resolveCall hook) where they deliver measurable value.

**Architecture:** Three independent semantic layers (adapter-level `resolveCall`, import-resolution adapters, cross-file pass2 resolvers) each have well-defined interfaces and 7 existing reference implementations. Work proceeds language-by-language, following the established patterns exactly. Each new implementation is a single file + registration + tests. No framework changes needed.

**Tech Stack:** TypeScript, tree-sitter (AST parsing), node:test (testing), LadybugDB (graph persistence)

---

## Current State Matrix

```
                 resolveCall   ImportRes    Pass2       Status
C#               ✅             ✅           ❌          2/3 layers
C++              ✅             ❌           ❌          1/3 layers
C                ❌             ❌           ❌          0/3 layers
Shell            ❌             ❌           ❌          0/3 layers
```

## Target State Matrix

```
                 resolveCall   ImportRes    Pass2       Status
C#               ✅ (exists)   ✅ (exists)  ✅ NEW      fully semantic
C++              ✅ (exists)   ✅ NEW        ✅ NEW      fully semantic
C                ⊘ skip        ✅ NEW        ✅ NEW      2/3 layers (justified)
Shell            ⊘ skip        ✅ NEW        ✅ NEW      2/3 layers (justified)
```

### Why resolveCall is skipped for C and Shell

The `resolveCall` hook disambiguates callee identifiers using receiver patterns (`this.method()`, `self.call()`, `Namespace::func()`), namespace lookups, and import matching. It exists to resolve **ambiguity** from OOP dispatch and module namespacing.

**C has none of these patterns.** C function calls are bare identifiers (`helper()`). There are no receivers, no namespaces, no classes, no `this`/`self`. The struct field expression pattern (`ptr->func`) is a function pointer dereference — dynamic dispatch that `resolveCall` cannot statically resolve. The hook would return `null` for every call.

**Shell has none of these patterns.** Shell function calls are bare command names (`my_function arg1`). There are no classes, no namespaces, no method dispatch. Every call is already as unambiguous as it can be at the adapter level.

Adding empty `resolveCall` implementations would be code that does nothing. Cross-file resolution for both languages is handled entirely by the Pass2 layer, where `#include` (C) and `source`/`.` (Shell) chains are resolved to actual symbols.

---

## Priority Order

| Priority  | Task                      | Value                            | Complexity | Estimate |
| --------- | ------------------------- | -------------------------------- | ---------- | -------- |
| P1        | Pass2: C#                 | High (completes 3/3 layers)      | Medium     | 4h       |
| P2        | ImportRes: C/C++ (shared) | High (enables Pass2 for both)    | Low        | 2h       |
| P3        | Pass2: C++                | High (namespace, class .h/.cpp)  | High       | 6h       |
| P4        | Pass2: C                  | Medium (cross-file via headers)  | Medium     | 4h       |
| P5        | ImportRes: Shell          | Medium (enables Pass2 for Shell) | Low        | 1h       |
| P6        | Pass2: Shell              | Low (cross-file via source)      | Low        | 3h       |
| **Total** |                           |                                  |            | **20h**  |

---

## Reference Files

### Interfaces

| Interface                 | File                                     | Purpose                                                           |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `Pass2Resolver`           | `src/indexer/pass2/types.ts`             | `id`, `supports(target)`, `resolve(target, context)`              |
| `ImportResolutionAdapter` | `src/indexer/import-resolution/types.ts` | `id`, `supports(language)`, `resolveImportCandidatePaths(params)` |
| `resolveCall`             | `src/indexer/adapter/LanguageAdapter.ts` | Optional method on LanguageAdapter                                |

### Template implementations to follow

| Component        | File                                                   | Lines | Notes                                 |
| ---------------- | ------------------------------------------------------ | ----- | ------------------------------------- |
| Pass2 (Go)       | `src/indexer/pass2/resolvers/go-pass2-resolver.ts`     | 793   | Canonical Pass2 template              |
| Pass2 (Python)   | `src/indexer/pass2/resolvers/python-pass2-resolver.ts` | 840   | Newest Pass2                          |
| Pass2 (Java)     | `src/indexer/pass2/resolvers/java-pass2-resolver.ts`   | ~700  | Same-package pattern                  |
| ImportRes (C#)   | `src/indexer/import-resolution/csharp-adapter.ts`      | 71    | Namespace → directory + glob fallback |
| ImportRes (Go)   | `src/indexer/import-resolution/go-adapter.ts`          | ~60   | Package path → directory              |
| ImportRes (Rust) | `src/indexer/import-resolution/rust-adapter.ts`        | ~80   | Crate module → file                   |

### Adapter files (current state)

| Language | Adapter                                          | Extensions                                  | extractImports                                     | resolveCall             |
| -------- | ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------- | ----------------------- |
| C#       | `src/indexer/adapter/csharp.ts` (BaseAdapter)    | `.cs`                                       | `using` directives (qualified name, static, alias) | ✅ `this`/`base`        |
| C++      | `src/indexer/adapter/cpp.ts` (LanguageAdapter)   | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.h` | `#include` (local `""` vs system `<>`)             | ✅ `this`/`Namespace::` |
| C        | `src/indexer/adapter/c.ts` (LanguageAdapter)     | `.c`, `.h`                                  | `#include` (local `""` vs system `<>`)             | ❌ N/A                  |
| Shell    | `src/indexer/adapter/shell.ts` (LanguageAdapter) | `.sh`, `.bash`                              | `source`/`.` commands                              | ❌ N/A                  |

### Shared files modified by every task

| File                                                | What changes                                                 |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `src/indexer/pass2/registry.ts`                     | Import + add to `createDefaultPass2ResolverRegistry()` array |
| `src/indexer/import-resolution/registry.ts`         | Import + add to `IMPORT_RESOLUTION_ADAPTERS` array           |
| `tests/unit/pass2-registry.test.ts`                 | Add language support assertions                              |
| `tests/unit/doctor-confidence-capabilities.test.ts` | Add `pass2-<lang>` assertion                                 |
| `tests/unit/import-resolution-adapters.test.ts`     | Add language adapter tests                                   |

---

## Chunk 1: C# Pass2 Resolver

C# already has `resolveCall` and `ImportResolutionAdapter`. This task adds the final layer.

### What C# Pass2 resolves that pass1 can't

- **Same-namespace class references**: C# classes in the same namespace can reference each other without `using` directives, similar to Java same-package
- **`using` directive resolution**: `using System.Collections.Generic;` makes `List<T>` available — resolve to the specific class
- **`this.Method()` inheritance**: Method calls on `this` where the method is defined in a base class
- **Static `using` resolution**: `using static System.Math;` makes `Sqrt()` callable without qualifier

### Task 1: C# Pass2Resolver

**Files:**

- Create: `src/indexer/pass2/resolvers/csharp-pass2-resolver.ts`
- Create: `tests/unit/csharp-pass2-resolver.test.ts`
- Create: `tests/integration/csharp-pass2-indexing.test.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Modify: `tests/unit/pass2-registry.test.ts` (add `.cs` assertion)
- Modify: `tests/unit/doctor-confidence-capabilities.test.ts` (add `pass2-csharp`)

- [ ] **Step 1: Write unit tests**

Create `tests/unit/csharp-pass2-resolver.test.ts`:

- `supports()` returns true for `.cs` with language `"csharp"`
- `supports()` returns false for `.java`, `.py`, etc.
- `id` is `"pass2-csharp"`
- `resolve()` throws if `target.repoId` is missing

- [ ] **Step 2: Run tests to verify they fail**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/unit/csharp-pass2-resolver.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement CSharpPass2Resolver**

Create `src/indexer/pass2/resolvers/csharp-pass2-resolver.ts` following Go/Python/Java patterns:

Key resolution strategies (in order):

1. `"same-file"` (0.93) — callee node ID resolved in same file
2. `"using-import"` (0.90) — name matches a `using` directive target
3. `"same-namespace"` (0.92) — name matches a symbol in the same namespace/directory
4. `"receiver-this"` (0.85) — `this.Method()` resolved via class hierarchy
5. `"static-using"` (0.80) — `using static` imported members
6. `"global-fallback"` (0.45)
7. `"unresolved"` (0.35)

Implementation structure:

- Same helper functions as other resolvers (toFullKey, toStartKey, etc.)
- Namespace index: build directory → symbols mapping (C# namespaces generally map to directories)
- Import maps: `using Namespace.Type` → resolved symbol IDs
- Static using maps: `using static Namespace.Type` → all static members
- Class hierarchy: `this.Method()` → find in enclosing class and base classes

The C# adapter already extracts imports as `using` directives with:

- `specifier`: qualified namespace name (e.g., `"System.Collections.Generic"`)
- `imports`: `["*"]` for static using, `[]` for regular using
- `defaultImport`: alias name if `using Alias = Namespace.Type`

The existing `CSharpImportResolutionAdapter` resolves namespace specifiers to file paths by:

1. Splitting `Namespace.Type` → directory path `Namespace/Type.cs`
2. Checking if file exists at that path
3. Falling back to `**/{Type}.cs` glob search

- [ ] **Step 4: Run unit tests — verify pass**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/unit/csharp-pass2-resolver.test.ts
```

- [ ] **Step 5: Register in registry.ts**

Add import and entry:

```typescript
import { CSharpPass2Resolver } from "./resolvers/csharp-pass2-resolver.js";
// Add to array: new CSharpPass2Resolver()
```

- [ ] **Step 6: Write integration test**

Create `tests/integration/csharp-pass2-indexing.test.ts`:

Test fixture:

```
Models/User.cs:     namespace App.Models { public class User { public string Name { get; set; } } }
Services/UserService.cs: namespace App.Services { using App.Models; public class UserService { public User GetUser() { return new User(); } } }
Program.cs:         using App.Services; public class Program { public void Main() { var svc = new UserService(); svc.GetUser(); } }
```

Assert:

- `UserService.GetUser()` → `User` constructor: `resolution: "using-import"`, `resolverId: "pass2-csharp"`
- `Program.Main()` → `UserService` constructor: `resolution: "using-import"`, `resolverId: "pass2-csharp"`

- [ ] **Step 7: Run integration test**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/integration/csharp-pass2-indexing.test.ts
```

- [ ] **Step 8: Update shared tests**

- `tests/unit/pass2-registry.test.ts` — add `.cs` support assertion
- `tests/unit/doctor-confidence-capabilities.test.ts` — assert `pass2-csharp`

- [ ] **Step 9: Run all related tests + typecheck**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/unit/csharp-pass2-resolver.test.ts tests/integration/csharp-pass2-indexing.test.ts tests/unit/pass2-registry.test.ts tests/unit/doctor-confidence-capabilities.test.ts
npx tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(csharp): add pass2 resolver — using imports, same-namespace, this/static resolution"
```

---

## Chunk 2: C/C++ Include Import Resolution

C and C++ share identical `#include` semantics. Both adapters already extract includes with the same format:

- Local includes: `#include "path/to/file.h"` → `specifier: "path/to/file.h"`, `isRelative: true/false`, `isExternal: false`
- System includes: `#include <stdio.h>` → `specifier: "stdio.h"`, `isExternal: true`

A single shared `CIncludeImportResolutionAdapter` handles both languages.

### Task 2: C/C++ Include ImportResolution Adapter

**Files:**

- Create: `src/indexer/import-resolution/c-include-adapter.ts`
- Modify: `src/indexer/import-resolution/registry.ts` (register)
- Modify: `tests/unit/import-resolution-adapters.test.ts` (add C/C++ tests)

- [ ] **Step 1: Write unit tests**

Add to `tests/unit/import-resolution-adapters.test.ts`:

```typescript
describe("CIncludeImportResolutionAdapter", () => {
  it("supports c and cpp languages", () => { ... });
  it("resolves local include to relative path", async () => {
    // #include "mylib.h" in src/main.c → src/mylib.h
  });
  it("resolves quoted include with subdirectory", async () => {
    // #include "utils/helper.h" in src/main.c → src/utils/helper.h
  });
  it("skips system includes (angle brackets)", async () => {
    // #include <stdio.h> → []  (isExternal: true is already set by adapter)
  });
  it("resolves include relative to repo root when not found relative to importer", async () => {
    // #include "include/lib.h" → include/lib.h
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement CIncludeImportResolutionAdapter**

Create `src/indexer/import-resolution/c-include-adapter.ts`:

```typescript
export class CIncludeImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "c-include";

  supports(language: string): boolean {
    return language === "c" || language === "cpp";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    // Skip system includes (angle bracket includes are marked isExternal by adapters)
    // The specifier from C/C++ adapters is the raw path: "utils/helper.h"

    const specifier = params.specifier;

    // Skip if specifier has no extension (safety check)
    if (!specifier.includes(".")) {
      return [];
    }

    // Strategy 1: Resolve relative to the importer's directory
    const importerDir = dirname(params.importerRelPath);
    const relativeCandidate = normalizePath(join(importerDir, specifier));
    if (await existsAsync(join(params.repoRoot, relativeCandidate))) {
      return [relativeCandidate];
    }

    // Strategy 2: Resolve relative to repo root
    const rootCandidate = normalizePath(specifier);
    if (await existsAsync(join(params.repoRoot, rootCandidate))) {
      return [rootCandidate];
    }

    // Strategy 3: Search common include directories
    for (const includeDir of ["include", "inc", "src"]) {
      const candidate = normalizePath(join(includeDir, specifier));
      if (await existsAsync(join(params.repoRoot, candidate))) {
        return [candidate];
      }
    }

    return [];
  }
}
```

Resolution order:

1. Relative to importer directory (most common for local includes)
2. Relative to repo root (project-level include paths)
3. Common include directories (`include/`, `inc/`, `src/`)

System includes (`<stdio.h>`) are already marked `isExternal: true` by the adapter's `extractImports()`. The built-in import resolution pipeline in `import-resolution.ts` filters these out before reaching the adapter — it only processes non-external imports. So the adapter never receives system includes.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Register in registry.ts**

Add import and entry to `IMPORT_RESOLUTION_ADAPTERS`:

```typescript
import { CIncludeImportResolutionAdapter } from "./c-include-adapter.js";
// Add to array: new CIncludeImportResolutionAdapter()
```

- [ ] **Step 6: Run all import-resolution tests + typecheck**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/unit/import-resolution-adapters.test.ts
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(c,cpp): add shared include import resolution adapter"
```

---

## Chunk 3: C++ Pass2 Resolver

C++ has the most complex resolution challenges among these 4 languages: namespaces, class methods split across headers and implementation files, `using namespace` directives, and namespace-qualified calls.

### What C++ Pass2 resolves that pass1 can't

- **Namespace-qualified calls**: `std::vector`, `MyLib::Utils::helper()` — resolve across files
- **Class methods across .h/.cpp**: Method declared in `Widget.h`, defined in `Widget.cpp`, called from `main.cpp`
- **`using namespace` directives**: `using namespace MyLib;` makes `helper()` callable without qualifier
- **Header-sourced symbols**: Functions declared in headers, resolved to their definition files

### Task 3: C++ Pass2Resolver

**Files:**

- Create: `src/indexer/pass2/resolvers/cpp-pass2-resolver.ts`
- Create: `tests/unit/cpp-pass2-resolver.test.ts`
- Create: `tests/integration/cpp-pass2-indexing.test.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Modify: `tests/unit/pass2-registry.test.ts` (add `.cpp`, `.hpp`, `.h`, `.cc` assertions)
- Modify: `tests/unit/doctor-confidence-capabilities.test.ts` (add `pass2-cpp`)

- [ ] **Step 1: Write unit tests**

Create `tests/unit/cpp-pass2-resolver.test.ts`:

- `supports()` true for `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.h` with language `"cpp"`
- `supports()` false for other extensions
- `id` is `"pass2-cpp"`
- `resolve()` throws if `target.repoId` missing

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement CppPass2Resolver**

Create `src/indexer/pass2/resolvers/cpp-pass2-resolver.ts`:

Key resolution strategies (in order):

1. `"same-file"` (0.93) — callee node ID resolved in same file
2. `"include-matched"` (0.90) — name matches symbol from an included header
3. `"namespace-qualified"` (0.90) — `Namespace::function()` resolved via namespace index
4. `"header-pair"` (0.88) — symbol found in corresponding .h/.cpp pair
5. `"using-namespace"` (0.82) — `using namespace X;` makes X's symbols available
6. `"same-directory"` (0.78) — symbol in same directory (common for C++ modules)
7. `"global-fallback"` (0.45)
8. `"unresolved"` (0.35)

Implementation details:

- **Include chain index**: Build a map of which files are included by the current file. Use the `CIncludeImportResolutionAdapter` (from Task 2) to resolve `#include "file.h"` specifiers to actual repo file paths. Collect all symbols from those files.
- **Namespace index**: Build directory → symbols mapping. C++ namespaces don't strictly map to directories, but directory grouping is a reasonable heuristic.
- **Header/implementation pairing**: For a file `Widget.cpp`, check if `Widget.h` or `Widget.hpp` exists and include its symbols. For a call to `Widget::method()`, resolve the `Widget` prefix to the header's class, then find `method` in that class.
- **Using namespace handling**: Extract `using namespace X;` directives (already captured by `extractImports` in the C++ adapter — the adapter emits them as namespace imports). Build a set of "open" namespaces for each file, and when resolving a bare identifier, check if it matches a symbol in any open namespace.

The C++ adapter extensions: `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.h`

**Note on `.h` files**: Both C and C++ use `.h`. The adapter registry assigns `.h` to the C adapter. The C++ pass2 resolver should handle `.h` files that appear in C++ projects (included by `.cpp` files). The `supports()` method should accept language `"cpp"` with any of its extensions, and also accept `.h` files when the context indicates C++ (checking if the file is included by a `.cpp` file is complex — a simpler heuristic is to check if it uses C++ features, but for MVP, just support all listed extensions).

**Pragmatic decision**: Since `.h` files are registered as C language by the adapter registry, the C++ pass2 resolver should focus on `.cpp`/`.hpp`/`.cc`/`.cxx`/`.hxx` files. The resolver will still read symbols FROM `.h` files (via include resolution) to resolve calls — it just won't be invoked BY the pass2 runner for `.h` files. This is correct behavior: the `.h` file itself doesn't make calls, the `.cpp` file does.

- [ ] **Step 4: Run unit tests — verify pass**

- [ ] **Step 5: Register in registry.ts**

- [ ] **Step 6: Write integration test**

Create `tests/integration/cpp-pass2-indexing.test.ts`:

Test fixture:

```
include/utils.h:     namespace mylib { int helper(); }
src/utils.cpp:       #include "utils.h"
                     namespace mylib { int helper() { return 42; } }
src/main.cpp:        #include "utils.h"
                     using namespace mylib;
                     int main() { helper(); return 0; }
```

Assert:

- `main()` → `helper()`: `resolution: "include-matched"` or `"using-namespace"`, `resolverId: "pass2-cpp"`

- [ ] **Step 7: Run integration test**

- [ ] **Step 8: Update shared tests**

- [ ] **Step 9: Run all related tests + typecheck**

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(cpp): add pass2 resolver — include-matched, namespace-qualified, header pairs, using-namespace"
```

---

## Chunk 4: C Pass2 Resolver

C is simpler than C++ — no namespaces, no classes, no templates. All cross-file resolution goes through `#include` chains.

### What C Pass2 resolves that pass1 can't

- **Header-declared functions**: `void helper();` declared in `utils.h`, defined in `utils.c`, called from `main.c` via `#include "utils.h"`
- **Struct-associated functions**: Convention-based patterns like `widget_create()`, `widget_destroy()` that operate on a struct type
- **Cross-file function calls via include chains**: When `main.c` includes `api.h` which declares functions defined in `api.c`

### Task 4: C Pass2Resolver

**Files:**

- Create: `src/indexer/pass2/resolvers/c-pass2-resolver.ts`
- Create: `tests/unit/c-pass2-resolver.test.ts`
- Create: `tests/integration/c-pass2-indexing.test.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Modify: `tests/unit/pass2-registry.test.ts` (add `.c`, `.h` assertions)
- Modify: `tests/unit/doctor-confidence-capabilities.test.ts` (add `pass2-c`)

- [ ] **Step 1: Write unit tests**

Create `tests/unit/c-pass2-resolver.test.ts`:

- `supports()` true for `.c` and `.h` with language `"c"`
- `supports()` false for other extensions
- `id` is `"pass2-c"`
- `resolve()` throws if `target.repoId` missing

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement CPass2Resolver**

Create `src/indexer/pass2/resolvers/c-pass2-resolver.ts`:

Key resolution strategies (in order):

1. `"same-file"` (0.93) — callee node ID resolved in same file
2. `"include-matched"` (0.90) — function name matches symbol from an included header
3. `"header-pair"` (0.88) — symbol found in corresponding .h/.c pair
4. `"same-directory"` (0.78) — function in same directory
5. `"global-fallback"` (0.45)
6. `"unresolved"` (0.35)

Implementation structure (simpler than C++, no namespaces):

- **Include chain index**: Use `CIncludeImportResolutionAdapter` to resolve `#include "file.h"` → file paths. Collect all symbols from included files.
- **Header/implementation pairing**: For `main.c`, check if `main.h` exists. For any included header `utils.h`, find `utils.c` in the same directory.
- **No namespace handling** (C doesn't have namespaces)

**`.h` file handling**: The C adapter owns `.h` files in the adapter registry. The C pass2 resolver DOES process `.h` files — a header can contain `#include` chains and inline function calls. However, most `.h` files just declare functions (no calls to resolve), so the resolver will naturally produce 0 edges for declaration-only headers.

- [ ] **Step 4: Run unit tests — verify pass**

- [ ] **Step 5: Register in registry.ts**

- [ ] **Step 6: Write integration test**

Create `tests/integration/c-pass2-indexing.test.ts`:

Test fixture:

```
include/utils.h:    int helper(void);
src/utils.c:        #include "utils.h"
                    int helper(void) { return 42; }
src/main.c:         #include "utils.h"
                    int main(void) { return helper(); }
```

Assert:

- `main()` → `helper()`: `resolution: "include-matched"`, `resolverId: "pass2-c"`

- [ ] **Step 7: Run integration test**

- [ ] **Step 8: Update shared tests**

- [ ] **Step 9: Run all related tests + typecheck**

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(c): add pass2 resolver — include-matched, header-pair cross-file resolution"
```

---

## Chunk 5: Shell Import Resolution + Pass2

Shell has a simple but real import mechanism: `source script.sh` (or `. script.sh`). The adapter already extracts these as imports. This chunk adds both the ImportResolution adapter and Pass2 resolver.

### What Shell Pass2 resolves that pass1 can't

- **Sourced function calls**: `source ./lib.sh` followed by calling `log_info "msg"` where `log_info` is defined in `lib.sh`
- **Dot-sourced includes**: `. /path/to/common.sh` includes functions from `common.sh`
- **Cross-file function resolution**: Functions defined in sourced scripts, called in the sourcing script

### Task 5: Shell ImportResolution Adapter

**Files:**

- Create: `src/indexer/import-resolution/shell-adapter.ts`
- Modify: `src/indexer/import-resolution/registry.ts` (register)
- Modify: `tests/unit/import-resolution-adapters.test.ts` (add Shell tests)

- [ ] **Step 1: Write unit tests**

Add to `tests/unit/import-resolution-adapters.test.ts`:

```typescript
describe("ShellImportResolutionAdapter", () => {
  it("supports shell language", () => { ... });
  it("resolves relative source path", async () => {
    // source ./lib.sh in scripts/main.sh → scripts/lib.sh
  });
  it("resolves source path without ./ prefix", async () => {
    // source lib/common.sh in main.sh → lib/common.sh
  });
  it("tries multiple extensions when specifier has no extension", async () => {
    // source ./utils in main.sh → ./utils.sh or ./utils.bash
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement ShellImportResolutionAdapter**

Create `src/indexer/import-resolution/shell-adapter.ts`:

```typescript
export class ShellImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "shell";

  supports(language: string): boolean {
    return language === "shell";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const specifier = params.specifier;

    // Strategy 1: Exact path relative to importer
    const importerDir = dirname(params.importerRelPath);
    const relativeCandidate = normalizePath(join(importerDir, specifier));
    if (await existsAsync(join(params.repoRoot, relativeCandidate))) {
      return [relativeCandidate];
    }

    // Strategy 2: Exact path relative to repo root
    const rootCandidate = normalizePath(specifier);
    if (await existsAsync(join(params.repoRoot, rootCandidate))) {
      return [rootCandidate];
    }

    // Strategy 3: Try with shell extensions if no extension
    if (!specifier.includes(".")) {
      for (const ext of params.extensions) {
        const withExt = normalizePath(join(importerDir, `${specifier}${ext}`));
        if (await existsAsync(join(params.repoRoot, withExt))) {
          return [withExt];
        }
      }
    }

    return [];
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Register in registry.ts**

- [ ] **Step 6: Run all import-resolution tests + typecheck**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(shell): add source/dot import resolution adapter"
```

---

### Task 6: Shell Pass2Resolver

**Files:**

- Create: `src/indexer/pass2/resolvers/shell-pass2-resolver.ts`
- Create: `tests/unit/shell-pass2-resolver.test.ts`
- Create: `tests/integration/shell-pass2-indexing.test.ts`
- Modify: `src/indexer/pass2/registry.ts` (register)
- Modify: `tests/unit/pass2-registry.test.ts` (add `.sh`, `.bash` assertions)
- Modify: `tests/unit/doctor-confidence-capabilities.test.ts` (add `pass2-shell`)

- [ ] **Step 1: Write unit tests**

Create `tests/unit/shell-pass2-resolver.test.ts`:

- `supports()` true for `.sh` and `.bash` with language `"shell"`
- `supports()` false for other extensions
- `id` is `"pass2-shell"`
- `resolve()` throws if `target.repoId` missing

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement ShellPass2Resolver**

Create `src/indexer/pass2/resolvers/shell-pass2-resolver.ts`:

Key resolution strategies (in order):

1. `"same-file"` (0.93) — callee node ID resolved in same file
2. `"source-matched"` (0.90) — function name matches symbol from a sourced script
3. `"same-directory"` (0.78) — function in same directory
4. `"global-fallback"` (0.45)
5. `"unresolved"` (0.35)

Implementation (simplest of all resolvers):

- **Source chain index**: Use `ShellImportResolutionAdapter` to resolve `source ./lib.sh` → file paths. Collect all function symbols from those files.
- **Resolution**: For each unresolved call, check if the callee name matches a function in any sourced file.
- No namespaces, no classes, no methods — just flat function name matching against sourced files.

Shell's simplicity means this resolver will be ~300-400 lines — the shortest of all pass2 resolvers.

- [ ] **Step 4: Run unit tests — verify pass**

- [ ] **Step 5: Register in registry.ts**

- [ ] **Step 6: Write integration test**

Create `tests/integration/shell-pass2-indexing.test.ts`:

Test fixture:

```
lib/utils.sh:       log_info() { echo "[INFO] $1"; }
                    log_error() { echo "[ERROR] $1"; }
scripts/deploy.sh:  #!/bin/bash
                    source ./lib/utils.sh
                    deploy() { log_info "Deploying..."; }
                    deploy
```

Assert:

- `deploy()` → `log_info()`: `resolution: "source-matched"`, `resolverId: "pass2-shell"`

- [ ] **Step 7: Run integration test**

- [ ] **Step 8: Update shared tests**

- [ ] **Step 9: Run all related tests + typecheck**

```bash
set SDL_MCP_DISABLE_NATIVE_ADDON=1 && node --import tsx --test tests/unit/shell-pass2-resolver.test.ts tests/integration/shell-pass2-indexing.test.ts tests/unit/pass2-registry.test.ts tests/unit/doctor-confidence-capabilities.test.ts tests/unit/import-resolution-adapters.test.ts
npx tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(shell): add pass2 resolver — source-matched cross-file function resolution"
```

---

## Validation and Metrics

### After all implementations, verify:

- [ ] **Run full test suite:** `npm test`
- [ ] **Run typecheck:** `npm run typecheck`
- [ ] **Run lint:** `npm run lint`

### Final State Matrix

```
                 resolveCall   ImportRes    Pass2       Status
TypeScript       ⊘             ⊘            ✅          complete (unchanged)
Python           ✅             ✅           ✅          fully semantic
Go               ✅             ✅           ✅          fully semantic
Java             ✅             ✅           ✅          fully semantic
C#               ✅             ✅           ✅ NEW      fully semantic
C                ⊘ (N/A)       ✅ NEW        ✅ NEW      2/3 layers (max applicable)
C++              ✅             ✅ NEW        ✅ NEW      fully semantic
PHP              ✅             ✅           ✅          fully semantic
Rust             ✅             ✅           ✅          fully semantic
Kotlin           ✅             ✅           ✅          fully semantic
Shell            ⊘ (N/A)       ✅ NEW        ✅ NEW      2/3 layers (max applicable)
```

**Languages at full semantic coverage:** 9 of 11 (TypeScript, Python, Go, Java, C#, C++, PHP, Rust, Kotlin)
**Languages at max applicable coverage:** 2 of 11 (C, Shell — resolveCall N/A, justified above)

---

## Estimated Effort

| Chunk                       | Tasks       | Estimated Time | Complexity |
| --------------------------- | ----------- | -------------- | ---------- |
| 1: C# Pass2                 | 1 task      | 4h             | Medium     |
| 2: C/C++ ImportRes (shared) | 1 task      | 2h             | Low        |
| 3: C++ Pass2                | 1 task      | 6h             | High       |
| 4: C Pass2                  | 1 task      | 4h             | Medium     |
| 5: Shell ImportRes + Pass2  | 2 tasks     | 4h             | Low        |
| **Total**                   | **6 tasks** | **20h**        | —          |

**Recommended execution order:** Chunk 1 → 2 → 3 → 4 → 5

Chunk 2 (C/C++ include adapter) must complete before Chunks 3 and 4 (C++ and C pass2 resolvers use it). All other chunks are independent.

**Parallelization opportunities:**

- Chunk 1 (C# Pass2) can run in parallel with Chunk 2 (C/C++ ImportRes)
- Chunk 3 (C++ Pass2) and Chunk 4 (C Pass2) can run in parallel (after Chunk 2)
- Chunk 5 (Shell) is fully independent — can run in parallel with anything
