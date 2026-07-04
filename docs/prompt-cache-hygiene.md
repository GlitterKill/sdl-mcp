# Prompt Cache Hygiene

SDL-MCP is designed to be prompt-cache-neutral or better: it never invalidates a client's prompt cache through instability of its own, and its output design lets cached context amortize across a session. This page explains why that matters, what SDL-MCP guarantees, and the rules that keep those guarantees true as the project grows.

## Why this matters

Anthropic's prompt caching is a byte-exact prefix cache. The prompt is assembled in a fixed order — tool definitions, then the system prompt, then the message history — and a request reuses cached computation only for the prefix that matches a previous request exactly. Matching is not semantic. One changed byte early in the prompt invalidates everything after it, and invalidation cascades down the hierarchy: a change to tool definitions invalidates the cached system prompt and the entire conversation history along with it.

Cache reads are billed at roughly a tenth of the base input-token price, while writes carry a modest premium over base price. In an agentic session, the conversation history is re-read on every turn, so a stable prefix is the difference between paying full price for the whole session repeatedly and paying it approximately once. Clients such as Claude Code manage cache breakpoints automatically; an MCP server has no direct control over caching. Its entire influence is exercised through the bytes it contributes to the prompt. SDL-MCP contributes bytes in two places — its tool definitions, which sit at the very front of the prompt, and its tool results, which accumulate in the message history — and both must be stable for caching to work at all.

There is no error signal when hygiene breaks. A timestamp accidentally added to a tool response does not fail any test a functional suite would catch; it silently converts every affected session from ~90%-discounted reads back to full price. That failure mode is why hygiene is enforced by CI rather than by convention.

## Guarantees

**Static tool surface.** SDL-MCP's tool names, descriptions, input schemas, and their serialization order are fixed for the lifetime of a server process and identical across processes running the same SDL-MCP version. Tool descriptions never embed dynamic values such as index statistics, file counts, or freshness timestamps, and SDL-MCP does not re-register or mutate tools mid-session. Because tool definitions serialize ahead of everything else in the prompt, this guarantee protects the entire cached prefix.

**Deterministic tool outputs.** Identical tool calls against an unchanged index return byte-identical results — within a process, across fresh processes, and across a from-scratch re-index of unchanged source. Every LadybugDB query carries an explicit `ORDER BY` with a deterministic tiebreaker (file path, then symbol name, then byte offset), because columnar engines with parallel scans do not guarantee row order otherwise. Result serialization uses a locked key order.

**No volatile content.** Tool responses contain no wall-clock timestamps, query durations, session identifiers, or machine-specific absolute paths. Paths are reported relative to the indexed repository root. Performance and freshness telemetry belongs in logs, never in tool results.

**Cache-friendly session start.** Context that SDL-MCP contributes at session start (via the SessionStart hook) is content-addressed: it changes only when the indexed codebase changes, never with wall-clock time or per-session state. When the codebase is unchanged, a new session presents a byte-identical prefix, making cross-session cache reuse possible within the cache's lifetime.

**Compact responses as a caching property.** Response compactness is usually framed as a context-quality feature, but it is also a caching one: context-window compaction rewrites the message history, which is total cache invalidation followed by re-encoding the full prompt at write prices. Every token SDL-MCP saves per result pushes compaction further out.

## Rules for contributors

These rules exist because each one, when broken, degrades caching for every user with no visible error. CI enforces the first four directly (see below); the rest are reviewed.

1. **Every LadybugDB query orders its results explicitly**, with a deterministic tiebreaker. "It came back sorted in testing" is not ordering — parallel scan scheduling makes unordered results appear stable within a warm process and then diverge across processes.
2. **No timestamps, durations, counters, or session state in tool responses or tool descriptions.** If a value can differ between two runs against identical source, it does not belong in the prompt. Route it to logging.
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
