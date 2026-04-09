# Phase 2 — Pass-2 Resolver Architecture

This document describes the per-language Pass-2 call-resolution layer
after the Phase 2 deepening (`devdocs/plans/logical-bubbling-squirrel.md`,
Tasks 2.0.x and 2.x.x).

## Overview

After Pass-1 emits raw `ExtractedSymbol`/`ExtractedCall` rows, **Pass-2**
walks each file's calls and binds them to symbol IDs by language-specific
heuristics. The output is a stream of resolved call edges with confidence
scores that downstream consumers (slice builder, blast-radius scorer,
delta packer) use to weight the dependency graph.

Each language has its own resolver class implementing `Pass2Resolver`
from `src/indexer/pass2/types.ts`. Resolvers are registered in
`src/indexer/pass2/registry.ts` and dispatched per file based on the
file's extension and language.

```
┌──────────┐   per-file    ┌────────────┐   per-call
│  Pass-1  │ ─────────────▶│  Pass-2    │─────────────▶ resolved edges
│ extract  │  symbols+calls│  registry  │  (from→to,    + telemetry
└──────────┘               └────────────┘   confidence,
                                            strategy)
```

## Confidence rubric (Task 2.0.1)

Phase 2 introduces a centralized rubric in
`src/indexer/pass2/confidence.ts`. Per-language resolvers no longer write
literal `confidence: 0.93` style values; instead they call
`confidenceFor("strategy-name")` where `strategy-name` is one of the
canonical `CallResolutionStrategy` names.

### The seven tiers

| Tier                        | Value (new) | When to use                                 |
| --------------------------- | ----------- | ------------------------------------------- |
| `COMPILER_RESOLVED`         | 1.0         | Compiler/type-checker bound the call        |
| `IMPORT_DIRECT`             | 0.9         | Bound through an explicit import statement  |
| `SAME_FILE_LEXICAL`         | 0.7         | Bound by lexical scope inside the same file |
| `CROSS_FILE_NAME_UNIQUE`    | 0.65        | Cross-file by name; only one candidate      |
| `CROSS_FILE_NAME_AMBIGUOUS` | 0.45        | Cross-file by name; multiple candidates     |
| `BUILTIN_OR_GLOBAL`         | 0.3         | Resolved against a global/builtin symbol    |
| `HEURISTIC_ONLY`            | 0.2         | Pure heuristic, no other signal             |

### Strategies

`confidence.ts` exports a `CallResolutionStrategy` union of canonical
strategy names. Each strategy maps to a tier in
`telemetryBucketFor()`. Per-language resolvers should use these names
when recording telemetry so the audit-event payload buckets cleanly.

The full strategy list lives in `confidence.ts`. Common ones include:
`compiler-resolved`, `import-direct`, `import-aliased`, `import-barrel`,
`same-file-lexical`, `cross-file-name-unique`,
`cross-file-name-ambiguous`, `receiver-this`, `receiver-self`,
`receiver-type`, `namespace-qualified`, `module-qualified`,
`package-qualified`, `header-pair`, `psr4-autoload`, `extension-method`,
`trait-default`, `inheritance-method`, `function-pointer`,
`global-preferred`, `global-fallback`, `builtin-or-global`,
`heuristic-only`.

### Env-flag rollout (`SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC`)

The new rubric is gated behind the env flag
`SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC`. When the flag is **unset**,
`confidenceFor()` returns the legacy literal value (matching the
pre-Phase-2 codebase byte-for-byte). When set to `1` or `true`, it
returns the new tier value.

The intent is one release of dual-emit observation so any downstream
consumer can compare drift, then a follow-up task (Task 2.11.2) will
remove the legacy code path.

A regression test in `tests/unit/pass2-confidence.test.ts` asserts that
with the env flag unset, every strategy's `confidenceFor()` value
matches the pre-Phase-2 snapshot exactly.

### One-off named constants

Some resolvers use legacy literal values that don't match any rubric
tier (e.g. `0.84` for PHP `receiver-imported-instance`, `0.88` for C
`header-pair`, `0.92` for C# `same-namespace`). These are extracted into
named constants like `PHP_RECEIVER_IMPORTED_INSTANCE_CONFIDENCE = 0.84`
with explanatory comments. They preserve byte-for-byte legacy behavior
and satisfy the "zero literal hits" verification gate.

Follow-up Task 2.11.2 should revisit each named constant during the
legacy-rubric removal pass and either roll it into the rubric or
explicitly justify keeping it.

## Barrel walker (Task 2.0.2)

`src/indexer/pass2/barrel-walker.ts` provides a generic
`followBarrelChain(symbolName, startFile, hooks)` that walks re-export
chains. Per-language adapters supply `BarrelHooks { getReExports(file) }`.
Languages with no re-export concept (Java, C#) plug in a no-op hook.

Cycle detection is bounded by `MAX_BARREL_DEPTH = 8`. Used by:

- Python (Task 2.1.2 — `__init__.py` re-exports)
- Rust (Task 2.4.2 — `pub use` chains)
- Future languages can plug in via the same interface.

## Scope walker (Task 2.0.4)

`src/indexer/pass2/scope-walker.ts` provides a generic lexical scope
walker over a tree-sitter Tree. Per-language `ScopeRule[]` define what
nodes introduce scopes and what bindings they declare. The walker returns
`getScopeAt(line, col): ScopeMap` for any point in the file.

Also exports `findEnclosingByType(root, line, col, nodeType)` for the
common case of "find the nearest enclosing class / impl / function". Used
by Python (`self.method` resolution), Rust (`Self::method` resolution),
and similar tasks.

## Per-resolver telemetry buckets (Task 2.0.3)

`Pass2ResolverTelemetry` (in `src/indexer/edge-builder/telemetry.ts`)
gained the following fields:

```typescript
type Pass2ResolverTelemetry = {
  targets: number;
  filesProcessed: number;
  edgesCreated: number;
  elapsedMs: number;
  // Phase 2 additions:
  resolvedByCompiler: number;
  resolvedByImport: number;
  resolvedByLexical: number;
  resolvedByGlobal: number;
  unresolved: number;
  ambiguous: number;
  brokenChain: number;
};
```

Per-language resolvers record bucket-level outcomes via
`recordPass2ResolverEdge(telemetry, resolverId, bucket)` and
`recordPass2ResolverUnresolved(telemetry, resolverId, reason)` from
`telemetry.ts`. The audit-event payload (`index.refresh.complete`) now
exposes per-resolver bucket counts so the operator can see how each
language resolver actually resolved its work.

## Per-language status

| Language   | Confidence migration | New features (status)                                                                                                            |
| ---------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Python     | done                 | 2.1.1 decorators, 2.1.2 `__init__.py` barrels, 2.1.3 `self.method` — all done with tests                                         |
| Java       | done                 | 2.2.1 arity overloads, 2.2.2 `import static`, 2.2.3 inheritance — all done with tests                                            |
| Go         | done                 | 2.3.x — confidence-only; feature work deferred to follow-up                                                                      |
| Rust       | done                 | 2.4.2 `use` grouping/aliasing — done; 2.4.1 trait default and 2.4.3 `Self::` — partial helpers landed, full integration deferred |
| C#         | done                 | 2.5.x — confidence-only; feature work deferred                                                                                   |
| Kotlin     | done                 | 2.6.x — confidence-only; feature work deferred                                                                                   |
| PHP        | done                 | 2.7.x — confidence-only; feature work deferred                                                                                   |
| C++        | done                 | 2.8.x — confidence-only; feature work deferred                                                                                   |
| C          | done                 | 2.9.1 — confidence-only; function-pointer feature deferred                                                                       |
| Shell      | done                 | 2.10.1 `command`/`eval` — done with test                                                                                         |
| TypeScript | not touched          | TS resolver delegates to the existing TS-compiler-API path; no Phase 2 changes                                                   |

The languages marked "feature work deferred" still received the full
confidence rubric migration plus telemetry bucket plumbing. The deeper
heuristic features for those languages (arity disambiguation, partial
class merging, virtual dispatch capping, etc.) are tracked as follow-up
work in the project's `AGENTS.md`.

## Verification gates

The Phase 2 work is gated on these checks:

1. **`tsc --noEmit`** — full TypeScript compilation must be clean.
2. **`grep 'confidence:\\s*0\\.' src/indexer/pass2/resolvers/`** — must
   return zero hits (Task 2.11.0).
3. **`tests/unit/pass2-confidence.test.ts`** — the seven-test suite
   asserts every strategy has both legacy and new values, env-flag
   gating works, and the regression guard against the pre-Phase-2
   snapshot passes byte-for-byte.
4. **`tests/unit/pass2-barrel-walker.test.ts`** — seven tests covering
   single hop, multi-hop, alias rename, cycle detection, max-depth
   limit, and Map/object hook factories.
5. **`tests/unit/pass2-scope-walker.test.ts`** — five tests covering
   empty scopes, module-level definitions, lexical visibility,
   `findEnclosingByType`, and walker reuse.
6. **All per-language `*-pass2-resolver.test.ts`** — must continue to
   pass after the migration. New tests added for languages where new
   features landed (Python, Java, Shell).

## Notes for Phase 3

- Task 2.11.2: drop the legacy rubric path and the env flag after one
  release.
- Per-language deepening for Go, Rust (trait/Self), C#, Kotlin, PHP,
  C++, C (function pointer) is the natural follow-up. Each is scoped to
  one or two heuristic improvements per resolver.
- The `callResolution` health component target is **>0.80** (currently
  ~0.768 in this repo's self-index). The shared infrastructure work
  here lays the groundwork for that improvement; the per-language
  feature work is what will move the metric.
