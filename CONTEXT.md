# SDL-MCP Context Glossary

Authoritative vocabulary for SDL-MCP architecture and domain concepts. Use these terms exactly in design discussions, code reviews, ADRs, and module/file names. Drift into synonyms ("component", "service", "boundary") creates false distinctions.

Terms are alphabetical. When introducing a new concept during refactors or design work, add it here in the same turn — don't ship code that uses vocabulary not present in this file.

---

## Action Definition

The static identity and input contract of one SDL action: action name, code-mode function name, tool name, Zod schema, stable discovery text, examples, Context Ladder metadata, and required parameters. Runtime handler binding and response projection are separate Adapters keyed by the definition's action name.

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

## Database Seam

All Cypher lives in `src/db/ladybug-*.ts`. Functions accept row-shaped inputs and return number-typed rows; `toNumber()` is a db-internal concern.

## Delta Pack

Changes between two versions of a repository's symbol graph. Includes changed symbols with signature/invariant/side-effect diffs and a ranked Blast Radius. Computed by `src/delta/`.

## Depth

A property of a Module. A module is **deep** when its interface is small relative to the behavior behind it — high leverage. **Shallow** when the interface is nearly as complex as the implementation — low leverage.

The Code Access Decision module is intended to be deep: one entry function backed by a rule chain that internally dispatches over six request types.

## Dispatch Spine

The single path an SDL action request travels from surface envelope to typed handler: apply canonical aliases and surface defaults, parse once with the published schema, then invoke the typed handler. Gateway, retrieve, workflow, CLI, flat MCP, and validating direct-handler wrappers share this seam.

## Graph Slice

A task-scoped subgraph computed by BFS/beam search from seed symbols, weighted by edge type (call > config > import). Stops at token budget or score threshold. Returned cards-first; raw code only on escalation. Computed by `src/graph/slice/`.

## Hot-Path Excerpt

A focused code excerpt covering only the lines that contain specified identifiers, plus a small context window. Cheaper than a full Code Window, more concrete than a Skeleton IR. Computed by `src/code/hotpath.ts`.

## Implementation

The code inside a Module. Distinct from the Interface, which is everything callers must know.

## Import Candidate Resolution

Language-aware conversion of an import specifier into normalized repository-relative file candidates. Built-in factories are declared by Language Support and instantiated lazily by `src/indexer/import-resolution/registry.ts`; relative-path resolution remains the registry's shared fallback.

## Import Target Resolution

Conversion of resolved import file candidates and imported names into concrete symbol IDs or explicit unresolved/external placeholders. Lives in `src/indexer/edge-builder/import-target-resolver.ts` and consumes Import Candidate Resolution without owning language registration.

## Interface

Everything a caller must know to use a Module: the type signature plus invariants, error modes, ordering constraints, and config it depends on. Not just the type signature.

## Language Support

The lazy built-in registration contributed by one language: extensions, grammar key, Language Adapter factory, optional Import Candidate Resolution factory, pass-2 resolver factory, and structural matcher metadata. `src/indexer/language-support.ts` owns built-in declarations; the adapter registry retains lazy instance caching and runtime plugin overlays.

## Leverage

The benefit callers get from Depth: a small thing to learn, a lot of behavior gained. Maximizing leverage is the point of deepening refactors.

## Locality

The benefit maintainers get from Depth: change, bugs, knowledge concentrated in one place. When a single concept lives behind one Seam, edits, tests, and reasoning all converge there.

## Module

Anything with an Interface and an Implementation: a function, a class, a TypeScript file, a folder, an npm package. Not a synonym for "file."

## Native Addon Loader

The single Module that locates and caches the Rust native addon and applies the process-wide environment disable. Native consumers validate their required capabilities and own capability-specific fallback health.

## Policy Engine

The rule-chain implementation that backs Code Access Decision and Runtime Decision. `decideCodeAccess` / `decideRuntime` are the supported interface; `PolicyEngine` is an internal rule-chain implementation and is not re-exported from the policy barrel. External rule extensibility (`addRule`) was confirmed unused (2026-07).

## Proof-of-Need Gating

The discipline of requiring callers to justify Code Window requests with a `symbolId`, a reason, expected line count, and target identifiers — and denying requests where the identifiers cannot be verified to exist in the loaded window text. The combination of Code Access Decision (caps and rules) and Code Window Enforcement (identifier verification) implements this discipline.

## Runtime Decision

A pure decision over whether a runtime execution request (node, python, shell, etc.) may proceed, given the request shape, runtime config, and concurrency tracker. Output is `approve` or `deny` only — there is no downgrade target for runtime execution. Sibling to Code Access Decision.

Lives in `src/policy/runtime.ts` as `decideRuntime(ctx, cfg, tracker?)`.

## Seam

A place where an Interface lives — where behavior can be altered without editing in place. Use this term, not "boundary." A Seam earns its keep when at least two Adapters satisfy it; one Adapter is a hypothetical Seam.

## Setup Wizard

A guided first-run flow that turns repository, agent, language-provider, embedding, size-profile, and storage-location choices into an SDL-MCP configuration before the server is used.

## Skeleton IR

A deterministic outline of a symbol or file: signatures, structure, control-flow shape, with bodies elided. The second rung of the Context Ladder. Computed by `src/code/skeleton.ts`.

## Symbol Card

A compact JSON record for a single symbol containing identity, signature, 1–2 line summary, invariants, side effects, dependency edges (imports/calls), and metrics (fan-in/out, churn, test refs). The first rung of the Context Ladder.

## Symbol Identity

The computation chain `node → astFingerprint → SymbolID`. One TypeScript module owns the chain; shared golden vectors pin the Rust engine and Live Index draft parser to it. Provider-materialized symbols deliberately use the distinct `createProviderSymbolId` identity scheme in `src/indexer/provider-first/ids.ts`.

## SymbolID

A stable hash combining `repoId + relPath + kind + name + astFingerprint`. Survives whitespace and trivial refactors. The canonical identity for a symbol across versions and tools.

## Text Edit EOL Policy

Text-edit planning normalizes editable text to LF and restores the target file's dominant EOL at write time through `src/util/eol.ts`. Byte-preserving read, hashing, indexing, protocol, and fixture paths are outside this interface.

## Window Loader

A port (interface) for loading concrete Code Window text and resolving symbols by ID. Required by Code Window Enforcement. Has at least two Adapters: `LadybugWindowLoader` (production, queries the graph DB) and `FakeWindowLoader` (test fixture). The presence of two Adapters makes this a real Seam, not a hypothetical one.

Defined in `src/code/window-loader.ts`.

## Directory Structure

```
.
├── AGENTS.md                        # Task coordination (read this first!)
├── TASKS.md                         # Current wave plan
├── CHANGELOG.md                     # Version history
├── README.md                        # Project overview
├── docs/                            # Documentation hub (architecture, guides, deep-dives)
├── devdocs/                         # Design notes, benchmarks, ADRs
├── config/                          # Config schema + examples
├── src/                             # TypeScript implementation (~105K lines)
│   ├── main.ts                      # MCP server entry point (stdio transport)
│   ├── server.ts                    # MCPServer class - tool dispatch + Zod validation
│   ├── domain/                      # Pure types + SymbolRepository port (hexagonal core)
│   ├── cli/                         # CLI commands + transports (stdio, http)
│   ├── config/                      # Config loading + Zod validation + constants
│   ├── db/                          # LadybugDB graph backend (schema + queries)
│   ├── indexer/                     # Symbol extraction + indexing pipeline
│   │   ├── adapter/                 # 11 language adapters (TS, Python, Go, etc.)
│   │   └── treesitter/              # AST extraction (symbols, imports, calls)
│   ├── graph/                       # Slice building, beam search, clustering
│   ├── delta/                       # Versioning, diff, blast radius
│   ├── code/                        # Code windows, skeleton IR, hot-path, gating
│   ├── code-mode/                   # Code Mode surfaces (`sdl.context`, `sdl.workflow`)
│   ├── memory/                      # File-backed memory sync (.sdl-memory/)
│   ├── mcp/                         # MCP types, tools, errors, telemetry
│   ├── gateway/                     # Tool gateway routing + compact schemas
│   ├── agent/                       # Autopilot orchestrator (plan, execute rungs)
│   ├── live-index/                  # Real-time draft buffer, overlay, reconcile
│   ├── policy/                      # Decision engine for context governance
│   ├── runtime/                     # Runtime execution engine
│   ├── services/                    # Application service layer
│   ├── startup/                     # Server initialization
│   ├── sync/                        # Export/import gzip artifacts (CI/CD)
│   ├── benchmark/                   # CI regression testing framework
│   ├── experiments/                 # Event log replay (offline testing)
│   ├── ts/                          # TypeScript compiler API diagnostics
│   ├── types/                       # Shared type definitions
│   ├── ui/                          # UI utilities
│   ├── util/                        # Helpers (paths, hashing, tokenizer, truncation)
│   ├── info/                        # Server diagnostics report builder (sdl.info)
│   ├── retrieval/                   # Task-shaped retrieval orchestrator + ranking
│   └── scip/                        # SCIP index decoder + ingestion + edge builder
├── native/                          # Rust addon via napi-rs (~52K lines)
├── tests/                           # Unit + integration + golden + property + stress tests
├── scripts/                         # Build, benchmark, migration scripts
├── templates/                       # MCP client config + agent instruction templates
├── migrations/                      # Legacy SQLite migrations (removed; directory kept for compat)
└── dist/                            # Compiled JavaScript (build output)
```

## Setup Wizard Context

`sdl-mcp init` owns setup decisions and config writes. npm `postinstall` is only a guarded launcher: it offers the wizard in a human TTY, skips in CI/non-TTY/`SDL_MCP_SKIP_SETUP_WIZARD=1`, times out to skip, and prints `sdl-mcp init` plus `npx --yes sdl-mcp@latest init` for later setup. The wizard maps Language Providers to `indexing.pipeline`, semantic tiers to `semantic`, repo size to watcher/index defaults, and selected agents to repo-local generated assets.
