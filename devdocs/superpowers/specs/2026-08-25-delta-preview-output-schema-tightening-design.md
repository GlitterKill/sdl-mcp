# Delta Preview Output Schema Tightening

Status: Approved for spec review  
Date: 2026-08-25

## Context

`handleDeltaGet` returns two valid delta result shapes. Preview results always emit `mode: "preview"`, `totalChanges`, and `sampleSize` together, return an empty `blastRadius`, and may emit `largeDeltaWarning`. Normal results omit the three preview-only fields but may also emit `largeDeltaWarning` for a large automatically resolved delta.

The current projected output schema declares all four metadata fields independently optional. It therefore accepts impossible partial preview shapes. The current projection fixture also inherits a non-empty blast radius from the shared delta fixture even though the preview producer returns an empty array.

## Goals

- Require the preview metadata trio as one valid shape.
- Reject preview-only metadata from normal results.
- Preserve `largeDeltaWarning` on both valid shapes.
- Match the preview fixture to the producer's empty blast radius.
- Add producer-level coverage for the empty blast radius and complete preview metadata.
- Preserve canonical `DeltaPackSchema`, producer output, compact projection behavior, deterministic ordering, and diagnostic defaults.

## Non-goals

- Do not require `blastRadius` to be present or empty in the public schema.
- Do not change `handleDeltaGet`, paging, blast-radius computation, or warning thresholds.
- Do not repair unrelated delta metadata or the existing `repo.status` changelog-contract failure.
- Do not add custom error reporting for schema rejection.

## Design

Create one strict projected delta base schema by extending `DeltaPackSchema` with:

- optional `largeDeltaWarning`;
- optional projected `blastRadius`, preserving compact omission.

Define the projected delta response as a union with preview first:

1. The preview arm extends the base schema and requires `mode: "preview"`, non-negative integer `totalChanges`, and non-negative integer `sampleSize`.
2. The normal arm uses the strict base schema and therefore rejects all preview-only fields.

Both arms accept `largeDeltaWarning`. The canonical `DeltaPackSchema` remains unchanged.

The union uses structural validation rather than `superRefine`. This keeps generated schemas, model-facing tool contracts, and runtime validation aligned.

## Fixture and Producer Coverage

Update the `delta.get` response-projection fixture in `tests/fixtures/response-projection/agent-output-cases.ts` to override `blastRadius: []` after spreading `fixtureDeltaPack()`.

Add a producer-level case to `tests/integration/delta-paging-contract.test.ts`. The case calls `handleDeltaGet` with `preview: true` and a bounded sample size, then asserts:

- `mode` equals `"preview"`;
- `totalChanges` and `sampleSize` match the seeded delta;
- `changedSymbols` contains only the requested sample;
- `blastRadius` is empty.

The hand-authored fixture documents the public projection shape. The integration case protects actual producer behavior.

## Test-first Sequence

1. Add focused output-schema tests that accept a normal large warning, accept a complete preview shape, and reject each incomplete preview-metadata combination.
2. Run the response-projection inventory and confirm RED because the current schema accepts partial metadata.
3. Add the strict projected union and rerun the focused inventory to GREEN.
4. Add the realistic fixture override and producer characterization case.
5. Run the delta paging integration test after `npm run build:all`.
6. Update checked output-arm coverage fingerprints and schema-node budgets only when failing tests show the exact generated values.

## Compatibility and Determinism

Valid normal and preview responses remain byte-identical because the producer and projector do not change. Only invalid partial shapes become rejected. The tool schema changes intentionally but remains static for the server process, deterministic across builds, diagnostics-free by default, and free of volatile fields.

The connected SDL-MCP process must restart after rebuilding `dist` before live calls use the tightened validator.

## Verification

Run:

- `npm run build:all`
- the focused response-projection inventory
- `tests/integration/delta-paging-contract.test.ts`
- `tests/integration/mcp-output-schema-wire.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run test:golden`
- `npm run docs:tools:check`
- `npm run test:tool-output-contract`
- `git diff --check`

The known unrelated changelog-marker failure remains reportable if it still occurs.
