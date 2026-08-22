# Prompt Cache Hygiene

SDL-MCP is designed to be prompt-cache-neutral or better: it never invalidates a client's prompt cache through instability of its own, and its output design lets cached context amortize across a session. This page explains why that matters, what SDL-MCP guarantees, and the rules that keep those guarantees true as the project grows.

## Why this matters

Anthropic's prompt caching is a byte-exact prefix cache. The prompt is assembled in a fixed order — tool definitions, then the system prompt, then the message history — and a request reuses cached computation only for the prefix that matches a previous request exactly. Matching is not semantic. One changed byte early in the prompt invalidates everything after it, and invalidation cascades down the hierarchy: a change to tool definitions invalidates the cached system prompt and the entire conversation history along with it.

Cache reads are billed at roughly a tenth of the base input-token price, while writes carry a modest premium over base price. In an agentic session, the conversation history is re-read on every turn, so a stable prefix is the difference between paying full price for the whole session repeatedly and paying it approximately once. Clients such as Claude Code manage cache breakpoints automatically; an MCP server has no direct control over caching. Its entire influence is exercised through the bytes it contributes to the prompt. SDL-MCP contributes bytes in two places — its tool definitions, which sit at the very front of the prompt, and its tool results, which accumulate in the message history — and both must be stable for caching to work at all.

There is no error signal when hygiene breaks. A timestamp accidentally added to a tool response does not fail any test a functional suite would catch; it silently converts every affected session from ~90%-discounted reads back to full price. That failure mode is why hygiene is enforced by CI rather than by convention.

## Guarantees

**Static tool surface.** SDL-MCP's tool names, descriptions, input schemas, and their serialization order are fixed for the lifetime of a server process and identical across processes running the same SDL-MCP version. Tool descriptions never embed dynamic values such as index statistics, file counts, or freshness timestamps, and SDL-MCP does not re-register or mutate tools mid-session. Because tool definitions serialize ahead of everything else in the prompt, this guarantee protects the entire cached prefix.

**Single-copy session guidance.** SDL-MCP leaves MCP initialization instructions unset because clients may flatten that field into every imported tool description. The ordered `tools/list` response prefixes the canonical workflow only to its first tool description. For an unchanged server configuration, repeated `tools/list` snapshots remain byte-identical. A client that refreshes the catalog replaces its previous snapshot rather than appending another copy.

**Deterministic tool outputs.** Identical tool calls against an unchanged index return byte-identical results when the tool's contract is content-shaped rather than session-scoped — within a process, across fresh processes, and across a from-scratch re-index of unchanged source. For `sdl.context`, this guarantee requires `responseMode: "inline"` with `refsMode: "off"`. Default/auto response-artifact handles and session refs are deliberately session-scoped: handles may vary, and repeated evidence may become `{ ref, unchanged: true }`. Every LadybugDB query carries an explicit `ORDER BY` with a deterministic tiebreaker (file path, then symbol name, then byte offset), because columnar engines with parallel scans do not guarantee row order otherwise. Result serialization uses a locked key order.

`sdl.context` computes its ETag from the complete canonical v2 payload before
session refs, packed encoding, or generic response-artifact wrapping. The
canonical payload therefore has one content identity across supported wrappers.

**No volatile content in deterministic projections.** Content-shaped model-facing tool responses contain no wall-clock timestamps, query durations, session identifiers, or machine-specific absolute paths. Opaque response-artifact handles and session refs are exempt as described above; the content they reference still follows the same projection rules. Paths are otherwise reported relative to the indexed repository root. Telemetry-off `repo.status` omits machine-specific root paths and timestamps at every detail level; callers set `includeTelemetry: true` to opt into operational and volatile fields.

For `sdl.info({ redactPaths: true })`, a configured log-file path is projected as the literal `"<redacted>"` and disabled file logging remains `null`; no per-process log filename survives, including in the matching fallback warning. The call is covered by the fresh-process determinism fixture.

The same boundary applies to the six public gateways. `sdl.context` canonical
evidence contains no action durations or evidence timestamps. Opaque artifact
handles remain session-scoped, while manual and response-artifact projections
expose stable capability or content metadata rather than process start times,
runtime versions, expiry times, or session-key hashes. Error responses follow
the same rule so a repeated invalid call is as cache-stable as a successful one.
Traversal and realpath checks therefore keep resolved host paths in operational
logs only; model-facing errors use stable, path-free descriptions.

Workflow continuation data receives the same deterministic model projection as the first page. Zero-identifier-match hot-path fallbacks are omitted because adjacent source text does not prove identifier relevance. Internal `$N` result piping continues to use raw step data, so response shaping never changes workflow semantics. Persisted runtime artifacts remain byte-faithful after configured redaction; only default model-facing excerpts remove leading command-prompt echoes and recognized Node test-duration suffixes.

Graph-integrity status follows the same contract. `repo.status` exposes only deterministic state, graph Version, current revision, verified revision, content digest, and recovery action; worker timing, queue state, mismatch diagnostics, and internal error text stay in operational logs or benchmark artifacts. The worker publishes through an exact Version-and-revision compare-and-set, so repeated status calls against unchanged state preserve byte-identical fields and key order even when verification runs asynchronously. A `verifying` or `failed` state can remain graph-readable without claiming that the latest revision is verified.

The digest uses fixed canonical tuples plus explicit UTF-8 file and symbol ordering that matches LadybugDB, so the same authoritative graph produces the same value across processes and unchanged re-indexes. File and fileless manifests use deterministic tuple serialization and repository relationships. Membership follows `SYMBOL_IN_REPO` rather than the mutable convenience `repoId` node property, keeping shared placeholders deterministic in multi-repository databases. Mutable summary provenance such as `summarySource` is intentionally excluded because semantic refresh can rewrite it before final verification. Dependency placeholders are physically normalized to stable canonical defaults before pruning. Read compatibility normalizes only definition-derived fingerprint and signature fields for historical or reused fileless SCIP externals; status and placeholder classification metadata remain part of the digest and still expose corruption.

**Cache-friendly session start.** Context that SDL-MCP contributes at session start (via the SessionStart hook) is content-addressed: it changes only when the indexed codebase changes, never with wall-clock time or per-session state. When the codebase is unchanged, a new session presents a byte-identical prefix, making cross-session cache reuse possible within the cache's lifetime.

**Compact responses as a caching property.** Response compactness is usually framed as a context-quality feature, but it is also a caching one: context-window compaction rewrites the message history, which is total cache invalidation followed by re-encoding the full prompt at write prices. Every token SDL-MCP saves per result pushes compaction further out.

## Rules for contributors

These rules exist because each one, when broken, degrades caching for every user with no visible error. CI enforces the first four directly (see below); the rest are reviewed.

1. **Every LadybugDB query orders its results explicitly**, with a deterministic tiebreaker. "It came back sorted in testing" is not ordering — parallel scan scheduling makes unordered results appear stable within a warm process and then diverge across processes.
2. **No timestamps, durations, counters, or session state in deterministic, content-shaped tool responses or in tool descriptions.** Opaque session-scoped response-artifact handles and refs remain exempt as documented above; route other values that can differ between two runs against identical source to logging.
3. **No absolute paths outside the repository root in responses.** Report paths relative to the indexed root so output is identical across checkouts and machines.
4. **New tools ship with determinism fixtures.** Adding a tool without adding calls to `determinism.fixtures.json` fails the build. Intentional exclusions require an allowlisted entry with a written justification, and should be treated as a design smell.
5. **Tool definitions change only with releases, never at runtime.** No `listChanged` notifications mid-session, no schema fields computed from index state. A tool-surface change is a full-cache invalidation event for every active session and should be batched into versioned releases.
6. **Serialization order is part of the contract.** Response object key order and tool-list ordering are locked; refactors must not reorder them. The byte-diff in CI is the arbiter, not intent.
7. **Session-start context must be a pure function of index content.** Anything injected by the SessionStart hook is keyed to the index's content hash. A single volatile byte there forfeits cross-session cache reuse for every session.

## CI enforcement

`determinism.test.ts` runs against a frozen polyglot fixture repository and enforces three invariants: the tool surface serializes byte-identically across two independent server processes; every fixture call returns byte-identical results twice within one process and once in a fresh process; and outputs contain no fatal volatile patterns (current date, machine-specific paths), with softer patterns surfaced as warnings for review. Running with `REBUILD_INDEX=1` deletes the index between legs, upgrading the check to cover indexing determinism itself — recommended on main, optional locally. On mismatch, both payloads are written to `.determinism-diffs/` with the first divergent byte located, so the offending query or field is findable immediately.

The fresh-process leg is the load-bearing one. Most ordering bugs are invisible within a single warm process and only manifest when scan scheduling, hash seeds, and in-memory caches reset — which is exactly the condition under which real users start new sessions.

## Maintenance

`determinism.fixtures.json` joins the existing set of locations that must be updated in sync when SDL-MCP's tool surface or language support changes: the enforcement system prompts, `settings.json` guidance, the SessionStart hook, and now the determinism fixtures. The fixture repository itself is frozen; changes to its contents legitimately change expected outputs and must land as deliberate, isolated commits.

## Reference

Anthropic's prompt caching documentation, including the prefix hierarchy, invalidation rules, and pricing: https://platform.claude.com/docs/en/build-with-claude/prompt-caching

## Model projection boundary

One ModelProjection boundary projects both MCP content and structured content. It applies a stable key order and enforces combined budgets after projection, so one channel cannot evade the response limit.

Projection fails closed for malformed output, unrecognized profiles, unsafe recovery, and artifact sanitization failures. SDL-MCP validates recovery actions before it returns them and sanitizes artifacts before model access.

### Semantic detail and diagnostics

`detail` controls semantic breadth, not diagnostics. `compact`, `standard`, and `full` responses remain deterministic and diagnostic-free; `full` means semantically complete, not a raw canonical dump. `includeDiagnostics: true` opts into the bounded, allowlisted diagnostic profile and marks the call as a prompt-cache opt-out. Volatile timings such as runtime `durationMs` are permitted only in that diagnostic profile; they never appear by default. Where supported, `includeTelemetry: true` is a separate explicit opt-in for operational and volatile status fields.

### Recovery and delivery

An executable recovery uses `nextAction: { action, args }`. A recommendation list uses `{ id, args }`; the two shapes have different contracts, and a recommendation is not automatically callable. `responseMode: "inline"`, `"auto"`, and `"handle"` change how the same projected result is delivered, not its payload semantics or schema obligations. Inline results and model views recovered from handles must satisfy the same strict public schema.

Compact filtering removes ordinary nested fields such as `repoId` only where the projection contract allows it. A validated executable recovery call preserves required arguments, including `repoId`, inside `nextAction.args`; filtering never exposes `repoId` globally and never turns an otherwise callable action into an incomplete recommendation.

### Schema-derived coverage and isolated mutation

The public contract ledger derives action, field, enum, discriminator, union-arm, output-arm, and projection-option obligations from registered schemas and generated inventory. Each derived node must have an exercising case or a narrow, named exclusion with its proof; generated counts are informative and cannot replace exact set comparisons.

Mutation coverage runs only against runner-owned disposable repositories and databases. Before and after each scenario, the runner captures content-complete snapshots of the active worktree and the entire active database family, including sidecars, and fails if the active state changes. A disposable `index.refresh` scenario requires explicit approval before execution, and QA never refreshes the active `sdl-mcp` registration.

Successful workflow steps omit `status`; the absence of an error is the success signal. A successful minimal `runtimeExecute` step also omits `result`, while non-minimal modes expose only the requested runtime data and bounded recovery metadata. Failed steps retain `status: "error"` and `error`. Canonical executor results keep status, exit code, and accounting fields for `$N` references; directly called `runtime.execute` responses retain their own status because they have no workflow envelope.

## Contributor checks

When a projected response changes, add compact, full, and error coverage; validate each recovery path; regenerate the output-profile inventory; and update the determinism fixture. Keep intentional session-scoped exclusions narrow and documented.
