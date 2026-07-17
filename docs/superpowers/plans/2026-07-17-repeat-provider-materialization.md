# Repeat Provider Materialization Safety Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this plan.

**Goal:** Keep repeat provider-first benchmarks from mutating COPY-loaded LadybugDB `Symbol` tables above the documented safe limit.

**Architecture:** Share the database layer's symbol-mutation ceiling with provider planning. When a repeat has reusable provider rows, a matching provider fingerprint, and unchanged scanned files, validate and reuse the complete persisted graph instead of rerunning provider materialization or legacy fallback.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, GitHub Actions.

## Implementation

- [x] Reproduce the hosted duplicate-key boundary with the exact locked Zod benchmark and isolated config/database environment variables.
- [x] Prove that provider deletion, merge-upsert, and version-writer dedup experiments do not repair the underlying large-table mutation defect.
- [x] Replace the planner's 50,000-symbol ceiling with `LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT`.
- [x] Add `shouldReuseProviderFirstFullGraph` with provider-row reuse, provider fingerprint, and unchanged-file gates.
- [x] Skip graph integrity setup, provider writes, and legacy fallback writes on the verified unchanged full-graph path.
- [x] Reuse the latest verified version through persisted no-op integrity verification.
- [x] Add focused planner and full-graph reuse policy regressions.
- [x] Run the exact local two-sample Zod guardrail against a fresh database and confirm all thresholds pass.
- [x] Run the affected test scope, typecheck, lint, and diff checks.
- [ ] Push the fix branch, dispatch `ci.yml`, and confirm the hosted Ubuntu benchmark job succeeds.
