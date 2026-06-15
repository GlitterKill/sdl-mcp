# Granular Index Diagnostics Config Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add app-wide and category-specific diagnostic output controls so normal indexing runs can hide unnecessary provider-first noise without losing important correctness warnings.

**Architecture:** Extend the existing `diagnostics` config section with a separate `output` subtree for human-facing diagnostic output. Keep TypeScript diagnostic settings backward-compatible, and route all index CLI diagnostic print decisions through one resolver/helper instead of scattering config checks through the formatter.

**Tech Stack:** TypeScript 5.9, Zod config schemas, Node.js built-in test runner, SDL-MCP CLI/indexer code.

---

## Design Decisions

- Do not repurpose `diagnostics.enabled` as an output master switch. It already controls TypeScript diagnostics, so changing its meaning would be surprising.
- Add `diagnostics.output.enabled` as the human-facing diagnostic output master switch.
- Add granular index categories under `diagnostics.output.index`.
- Keep correctness and failure diagnostics visible by default. Make optimization/profiling detail opt-in by default where it is currently noisy.
- Keep `sdl-mcp index --diagnostics` as a per-run override for generic timing tables. Config should provide defaults; the CLI flag should still allow one-off detail.

Recommended config shape:

```json
{
  "diagnostics": {
    "enabled": true,
    "mode": "tsLS",
    "maxErrors": 50,
    "timeoutMs": 2000,
    "scope": "changedFiles",
    "output": {
      "enabled": true,
      "index": {
        "enabled": true,
        "genericTimingTable": false,
        "providerFirst": {
          "timings": false,
          "coverage": true,
          "providerUnusable": true,
          "semanticEligibility": false,
          "callProof": false,
          "legacyFallback": false,
          "fallbackFiles": false
        },
        "scip": {
          "generatorCache": true,
          "skippedGeneratedIndexes": true,
          "failures": true
        }
      }
    }
  }
}
```

## Files

- Modify: `src/config/types.ts`
  - Add Zod schemas for `DiagnosticOutputConfigSchema`, `IndexDiagnosticOutputConfigSchema`, `ProviderFirstDiagnosticOutputConfigSchema`, and `ScipDiagnosticOutputConfigSchema`.
- Modify: `src/cli/commands/index.ts`
  - Resolve diagnostic output config once per command path.
  - Gate provider-first summary sections and generic timing output through helper functions.
- Modify: `src/cli/types.ts`
  - Keep `IndexOptions.diagnostics`; optionally add `noDiagnostics?: boolean` only if the implementation adds a CLI negative override.
- Modify: `src/cli/argParsing.ts` and `src/cli/index.ts`
  - Keep `--diagnostics` as an enable override. Optionally add `--no-diagnostics` for one-off suppression over config.
- Modify: `config/sdlmcp.config.example.json`
  - Add the new `diagnostics.output` subtree.
- Modify: `config/sdlmcp.config.schema.json`
  - Regenerate or update schema so config sync checks pass.
- Modify: `docs/configuration-reference.md`
  - Document defaults, category meanings, and CLI override behavior.
- Test: `tests/unit/config-defaults.test.ts`
  - Cover default values for the new schema.
- Test: add `tests/unit/index-diagnostics-output-config.test.ts`
  - Cover formatter gating behavior without running a full index.

## Chunk 1: Config Schema And Defaults

### Task 1: Add Diagnostic Output Config Schema

**Files:**
- Modify: `src/config/types.ts`
- Test: `tests/unit/config-defaults.test.ts`

- [ ] **Step 1: Write failing config default tests**

Add tests that parse `DiagnosticsConfigSchema.parse({})` and assert:

```ts
assert.strictEqual(result.output.enabled, true);
assert.strictEqual(result.output.index.enabled, true);
assert.strictEqual(result.output.index.genericTimingTable, false);
assert.strictEqual(result.output.index.providerFirst.timings, false);
assert.strictEqual(result.output.index.providerFirst.coverage, true);
assert.strictEqual(result.output.index.providerFirst.providerUnusable, true);
assert.strictEqual(result.output.index.providerFirst.semanticEligibility, false);
assert.strictEqual(result.output.index.providerFirst.callProof, false);
assert.strictEqual(result.output.index.providerFirst.legacyFallback, false);
assert.strictEqual(result.output.index.providerFirst.fallbackFiles, false);
assert.strictEqual(result.output.index.scip.failures, true);
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
npm run build && node --test dist/tests/unit/config-defaults.test.js
```

Expected: fail because `DiagnosticsConfigSchema.output` does not exist yet.

- [ ] **Step 3: Implement schemas**

Add focused Zod schemas near `DiagnosticsConfigSchema`:

```ts
export const ProviderFirstDiagnosticOutputConfigSchema = z.object({
  timings: z.boolean().default(false),
  coverage: z.boolean().default(true),
  providerUnusable: z.boolean().default(true),
  semanticEligibility: z.boolean().default(false),
  callProof: z.boolean().default(false),
  legacyFallback: z.boolean().default(false),
  fallbackFiles: z.boolean().default(false),
});

export const ScipDiagnosticOutputConfigSchema = z.object({
  generatorCache: z.boolean().default(true),
  skippedGeneratedIndexes: z.boolean().default(true),
  failures: z.boolean().default(true),
});

export const IndexDiagnosticOutputConfigSchema = z.object({
  enabled: z.boolean().default(true),
  genericTimingTable: z.boolean().default(false),
  providerFirst: ProviderFirstDiagnosticOutputConfigSchema.default({}),
  scip: ScipDiagnosticOutputConfigSchema.default({}),
});

export const DiagnosticOutputConfigSchema = z.object({
  enabled: z.boolean().default(true),
  index: IndexDiagnosticOutputConfigSchema.default({}),
});
```

Then extend `DiagnosticsConfigSchema`:

```ts
output: DiagnosticOutputConfigSchema.default({}),
```

- [ ] **Step 4: Run config tests**

Run:

```bash
npm run build && node --test dist/tests/unit/config-defaults.test.js
```

Expected: pass.

## Chunk 2: Index Output Routing

### Task 2: Add A Single Diagnostic Output Resolver

**Files:**
- Modify: `src/cli/commands/index.ts`
- Test: `tests/unit/index-diagnostics-output-config.test.ts`

- [ ] **Step 1: Add tests for category decisions**

Create tests around a small exported helper, for example:

```ts
resolveIndexDiagnosticOutput(config, options)
```

Cover:

- default config hides `providerFirst.legacyFallback`
- default config shows `providerFirst.coverage`
- `diagnostics.output.enabled=false` disables every diagnostic output category
- `diagnostics.output.index.enabled=false` disables index diagnostic categories only
- `--diagnostics` enables `genericTimingTable` for that run
- config `genericTimingTable=true` enables generic timing table without CLI flag

- [ ] **Step 2: Implement resolver**

Add a small helper near the index command top-level helpers:

```ts
function resolveIndexDiagnosticOutput(
  config: AppConfig,
  options: IndexOptions,
): ResolvedIndexDiagnosticOutput {
  const output = config.diagnostics?.output;
  const index = output?.index;
  const enabled = output?.enabled !== false && index?.enabled !== false;
  const providerFirst = index?.providerFirst;
  const scip = index?.scip;

  return {
    enabled,
    genericTimingTable:
      enabled && (options.diagnostics === true || index?.genericTimingTable === true),
    providerFirst: {
      timings: enabled && providerFirst?.timings === true,
      coverage: enabled && providerFirst?.coverage !== false,
      providerUnusable: enabled && providerFirst?.providerUnusable !== false,
      semanticEligibility: enabled && providerFirst?.semanticEligibility === true,
      callProof: enabled && providerFirst?.callProof === true,
      legacyFallback: enabled && providerFirst?.legacyFallback === true,
      fallbackFiles: enabled && providerFirst?.fallbackFiles === true,
    },
    scip: {
      generatorCache: enabled && scip?.generatorCache !== false,
      skippedGeneratedIndexes: enabled && scip?.skippedGeneratedIndexes !== false,
      failures: enabled && scip?.failures !== false,
    },
  };
}
```

Use the exact inferred config types instead of `any`.

- [ ] **Step 3: Run the focused helper tests**

Run:

```bash
npm run build && node --test dist/tests/unit/index-diagnostics-output-config.test.js
```

Expected: pass.

### Task 3: Gate Provider-First Diagnostic Sections

**Files:**
- Modify: `src/cli/commands/index.ts`
- Test: `tests/unit/index-diagnostics-output-config.test.ts`

- [ ] **Step 1: Extend formatter tests**

Add formatter tests that pass a synthetic `ProviderFirstExecutionSummary` with:

- phase timings
- coverage
- provider-unusable diagnostics
- semantic eligibility diagnostics
- call-proof diagnostics
- legacy fallback diagnostics

Assert only enabled categories produce lines.

- [ ] **Step 2: Update formatter signature**

Change:

```ts
formatProviderFirstExecutionSummaryLines(execution)
```

to:

```ts
formatProviderFirstExecutionSummaryLines(execution, diagnosticOutput)
```

Then gate the sections:

- `execution.phaseTimings` behind `providerFirst.timings`
- `execution.coverage` behind `providerFirst.coverage`
- provider-unusable block behind `providerFirst.providerUnusable`
- semantic eligibility block behind `providerFirst.semanticEligibility`
- call-proof block behind `providerFirst.callProof`
- `execution.legacyFallbackDiagnostics` behind `providerFirst.legacyFallback`
- fallback file sample line behind `providerFirst.fallbackFiles`

Keep non-diagnostic status lines such as `Provider-first: ...` visible.

- [ ] **Step 3: Update all call sites**

Pass the resolved output config from:

- delegated-server completion event path
- direct index path

- [ ] **Step 4: Run formatter tests**

Run:

```bash
npm run build && node --test dist/tests/unit/index-diagnostics-output-config.test.js
```

Expected: pass.

## Chunk 3: Generic Timing And SCIP Output

### Task 4: Gate Generic Timing Table And SCIP Diagnostic Lines

**Files:**
- Modify: `src/cli/commands/index.ts`
- Test: `tests/unit/index-diagnostics-output-config.test.ts`

- [ ] **Step 1: Add tests for generic timing table**

Verify:

- no generic `Timings (total=...)` table when config default is used
- table appears with `--diagnostics`
- table appears with `diagnostics.output.index.genericTimingTable=true`
- table is suppressed when `diagnostics.output.enabled=false`

- [ ] **Step 2: Replace direct `options.diagnostics` output checks**

Change the print condition from:

```ts
if (options.diagnostics && stats.timings) {
```

to:

```ts
if (diagnosticOutput.genericTimingTable && stats.timings) {
```

Keep `includeTimings` true when either `options.diagnostics` or config `genericTimingTable` is true.

- [ ] **Step 3: Gate SCIP informational diagnostics**

Apply:

- `generatorCache` gate to the cache-line print
- `skippedGeneratedIndexes` gate to generated index skipped lines
- `failures` gate to SCIP failure lines

Keep actual command failure behavior unchanged; this only controls summary text.

- [ ] **Step 4: Run tests**

Run:

```bash
npm run build && node --test dist/tests/unit/index-diagnostics-output-config.test.js
```

Expected: pass.

## Chunk 4: Config Surfaces And Documentation

### Task 5: Update Example Config, JSON Schema, And Docs

**Files:**
- Modify: `config/sdlmcp.config.example.json`
- Modify: `config/sdlmcp.config.schema.json`
- Modify: `docs/configuration-reference.md`
- Modify: `src/config/admin-metadata.ts` only if the admin UI needs labels for nested fields
- Test: config sync tests

- [ ] **Step 1: Update example config**

Add `diagnostics.output` to the existing `diagnostics` block.

- [ ] **Step 2: Regenerate or update JSON schema**

Run the existing schema sync workflow if available:

```bash
npm run check:schema-sync
```

If it reports generated drift, run the repo's schema generation command or update `config/sdlmcp.config.schema.json` manually to match the Zod schema.

- [ ] **Step 3: Update docs**

In `docs/configuration-reference.md`, replace the current provider-first fallback diagnostics note with:

- default behavior
- category list
- examples for quiet and profiling modes

Example quiet mode:

```json
{
  "diagnostics": {
    "output": {
      "index": {
        "providerFirst": {
          "legacyFallback": false,
          "timings": false
        }
      }
    }
  }
}
```

Example profiling mode:

```json
{
  "diagnostics": {
    "output": {
      "index": {
        "genericTimingTable": true,
        "providerFirst": {
          "timings": true,
          "legacyFallback": true,
          "fallbackFiles": true,
          "semanticEligibility": true,
          "callProof": true
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run config checks**

Run:

```bash
npm run build
npm run check:config-sync
npm run check:schema-sync
node --test dist/tests/unit/config-defaults.test.js
node --test dist/tests/unit/config-loading.test.js
```

Expected: all pass.

## Chunk 5: Integration Verification

### Task 6: Verify CLI Behavior

**Files:**
- No new source files unless tests reveal a bug.

- [ ] **Step 1: Run a quiet config smoke**

Create a temporary config variant with:

```json
{
  "diagnostics": {
    "output": {
      "index": {
        "providerFirst": {
          "legacyFallback": false,
          "timings": false
        }
      }
    }
  }
}
```

Run a small indexing fixture or existing focused provider-first smoke.

Expected:

- no `Provider-first timings` line
- no `Provider-first legacy fallback diagnostics` block
- standard summary lines still print

- [ ] **Step 2: Run a profiling config smoke**

Enable:

```json
{
  "diagnostics": {
    "output": {
      "index": {
        "genericTimingTable": true,
        "providerFirst": {
          "timings": true,
          "legacyFallback": true,
          "fallbackFiles": true
        }
      }
    }
  }
}
```

Expected:

- `Provider-first timings` line appears
- `Provider-first legacy fallback diagnostics` block appears
- generic `Timings (total=...)` table appears

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

Commit after tests pass:

```bash
git add src/config/types.ts src/cli/commands/index.ts src/cli/types.ts src/cli/argParsing.ts src/cli/index.ts config/sdlmcp.config.example.json config/sdlmcp.config.schema.json docs/configuration-reference.md tests/unit/config-defaults.test.ts tests/unit/index-diagnostics-output-config.test.ts
git commit -m "feat: add granular index diagnostic output config"
```

## Open Questions For Implementation

- Should `--diagnostics` enable every provider-first category, or only the generic timing table? Recommendation: make it a profiling override for all index diagnostic categories, because that matches operator intent.
- Should there be `--no-diagnostics`? Recommendation: add it only if needed after config rollout. The config solves the normal noise problem.
- Should `diagnostics.output.enabled=false` hide SCIP failure summaries? Recommendation: no, failures should remain visible unless a narrower `scip.failures=false` is explicitly set. If the implementation keeps that behavior, document it as safety-first output.

## Acceptance Criteria

- A default config no longer prints noisy provider-first legacy fallback diagnostic details during normal indexing.
- Users can enable provider-first timings, fallback diagnostics, fallback file samples, semantic eligibility, call proof, SCIP summary categories, and generic timing table independently.
- Existing TypeScript diagnostics behavior remains backward-compatible.
- `sdl-mcp index --diagnostics` still gives one-off verbose profiling output.
- Config example, JSON schema, and configuration docs are updated.
- Focused unit tests prove default quiet behavior and category opt-ins.
