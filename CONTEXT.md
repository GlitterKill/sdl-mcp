# SDL-MCP Context Glossary

Authoritative vocabulary for SDL-MCP architecture and domain concepts. Use these terms exactly in design discussions, code reviews, ADRs, and module/file names. Drift into synonyms ("component", "service", "boundary") creates false distinctions.

Terms are alphabetical. When introducing a new concept during refactors or design work, add it here in the same turn — don't ship code that uses vocabulary not present in this file.

---

## Adapter

A concrete implementation that satisfies an interface at a seam. Two adapters of the same interface make the seam real; one adapter is hypothetical.

**Examples in this codebase:**

- Language adapters (`src/indexer/adapter/*`) implement `LanguageAdapter` — 11 adapters across TS, Python, Go, Java, Rust, C#, C++, C, Kotlin, PHP, Shell.
- `LadybugWindowLoader` and `FakeWindowLoader` implement `WindowLoader` (the latter for tests).

## Audit Trail

Persisted record of policy evaluations and break-glass approvals. Stored in the `Audit` node table. Emitted from the enforcement layer (not the decision layer) so concrete artifact access is what gets logged.

## Blast Radius

Set of symbols affected by a change to a given symbol, ranked by proximity, fan-in, and test proximity. Computed by the delta layer (`src/delta/`) and exposed in `DeltaPack`.

## Code Access Decision

A pure decision over whether one of six data-access artifact types — Code Window, Skeleton IR, Hot-Path Excerpt, Symbol Card, Graph Slice, Delta Pack — may be returned to a caller, given the request shape and policy config. Output is one of `approve`, `downgrade-to-skeleton`, `downgrade-to-hotpath`, or `deny`. Pure: no I/O, no symbol lookup, no window text.

Lives in `src/policy/code-access.ts` as `decideCodeAccess(req, cfg)`. Sibling to Runtime Decision.

## Code Window

A range of raw source code returned to a caller. The most expensive rung of the Context Ladder. Subject to Proof-of-Need Gating — the only data-access artifact that requires identifier-presence verification against real file text.

Distinguished from Code Window Decision (the abstract approve/deny decision) and Code Window Enforcement (the concrete identifier check).

## Code Window Enforcement

The act of taking an approved Code Window Decision and producing a concrete `CodeWindowResponse` by loading window text via a Window Loader, verifying that the requested identifiers are actually present, and emitting identifier-based denial guidance when they are not.

Lives in `src/code/enforce.ts` as `enforceCodeWindow(req, decision, loader)`. Specific to Code Window — the other five Code Access artifact types do not require enforcement.

## Context Ladder

The four progressively richer rungs of code context offered by SDL-MCP, in cost order:

1. Symbol Card (always available, minimal tokens)
2. Skeleton IR (deterministic outline)
3. Hot-Path Excerpt (critical paths only)
4. Code Window (full code, gated)

Callers should walk the ladder bottom-up — only escalate to Code Window when shallower rungs are insufficient.

## Delta Pack

Changes between two versions of a repository's symbol graph. Includes changed symbols with signature/invariant/side-effect diffs and a ranked Blast Radius. Computed by `src/delta/`.

## Depth

A property of a Module. A module is **deep** when its interface is small relative to the behavior behind it — high leverage. **Shallow** when the interface is nearly as complex as the implementation — low leverage.

The Code Access Decision module is intended to be deep: one entry function backed by a rule chain that internally dispatches over six request types.

## Graph Slice

A task-scoped subgraph computed by BFS/beam search from seed symbols, weighted by edge type (call > config > import). Stops at token budget or score threshold. Returned cards-first; raw code only on escalation. Computed by `src/graph/slice/`.

## Hot-Path Excerpt

A focused code excerpt covering only the lines that contain specified identifiers, plus a small context window. Cheaper than a full Code Window, more concrete than a Skeleton IR. Computed by `src/code/hotpath.ts`.

## Implementation

The code inside a Module. Distinct from the Interface, which is everything callers must know.

## Interface

Everything a caller must know to use a Module: the type signature plus invariants, error modes, ordering constraints, and config it depends on. Not just the type signature.

## Leverage

The benefit callers get from Depth: a small thing to learn, a lot of behavior gained. Maximizing leverage is the point of deepening refactors.

## Locality

The benefit maintainers get from Depth: change, bugs, knowledge concentrated in one place. When a single concept lives behind one Seam, edits, tests, and reasoning all converge there.

## Module

Anything with an Interface and an Implementation: a function, a class, a TypeScript file, a folder, an npm package. Not a synonym for "file."

## Policy Engine

The rule-chain implementation that backs Code Access Decision and Runtime Decision. Currently exposed as a class (`PolicyEngine`) in `src/policy/engine.ts`; the class is being made private behind module-function entry points (`decideCodeAccess`, `decideRuntime`). External rule extensibility (`addRule`) is currently dead and under review (see `project_policy_engine_class_review.md` in agent memory).

## Proof-of-Need Gating

The discipline of requiring callers to justify Code Window requests with a `symbolId`, a reason, expected line count, and target identifiers — and denying requests where the identifiers cannot be verified to exist in the loaded window text. The combination of Code Access Decision (caps and rules) and Code Window Enforcement (identifier verification) implements this discipline.

## Runtime Decision

A pure decision over whether a runtime execution request (node, python, shell, etc.) may proceed, given the request shape, runtime config, and concurrency tracker. Output is `approve` or `deny` only — there is no downgrade target for runtime execution. Sibling to Code Access Decision.

Lives in `src/policy/runtime.ts` as `decideRuntime(ctx, cfg, tracker?)`.

## Seam

A place where an Interface lives — where behavior can be altered without editing in place. Use this term, not "boundary." A Seam earns its keep when at least two Adapters satisfy it; one Adapter is a hypothetical Seam.

## Skeleton IR

A deterministic outline of a symbol or file: signatures, structure, control-flow shape, with bodies elided. The second rung of the Context Ladder. Computed by `src/code/skeleton.ts`.

## Symbol Card

A compact JSON record for a single symbol containing identity, signature, 1–2 line summary, invariants, side effects, dependency edges (imports/calls), and metrics (fan-in/out, churn, test refs). The first rung of the Context Ladder.

## SymbolID

A stable hash combining `repoId + relPath + kind + name + astFingerprint`. Survives whitespace and trivial refactors. The canonical identity for a symbol across versions and tools.

## Window Loader

A port (interface) for loading concrete Code Window text and resolving symbols by ID. Required by Code Window Enforcement. Has at least two Adapters: `LadybugWindowLoader` (production, queries the graph DB) and `FakeWindowLoader` (test fixture). The presence of two Adapters makes this a real Seam, not a hypothetical one.

Defined in `src/code/window-loader.ts`.
