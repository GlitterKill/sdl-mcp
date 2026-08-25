# Delta Preview Output Schema Tightening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require complete delta preview metadata, preserve valid normal warnings, and align projection and producer tests with the real preview shape.

**Architecture:** Keep canonical `DeltaPackSchema` and `handleDeltaGet` unchanged. Build one strict projected delta base, then validate preview and normal results through an explicit union; use the existing projection inventory and delta paging integration harness for regression coverage.

**Tech Stack:** TypeScript, Zod, Node.js `node:test`, SDL-MCP repository workflow, LadybugDB integration fixture.

---

## Chunk 1: Tighten and verify the delta preview contract

### Task 0: Commit the reviewed schema-fix baseline

**Files:**
- Commit existing modifications: `CHANGELOG.md`
- Commit existing modifications: `src/mcp/tools.ts`
- Commit existing modifications: `tests/fixtures/response-projection/agent-output-cases.ts`
- Commit existing modifications: `tests/fixtures/tool-contract/public-tool-contract-cases.ts`
- Commit existing modifications: `tests/unit/response-projection-inventory.test.ts`

- [ ] **Step 1: Verify the baseline boundary**

Run:

```powershell
git diff --name-only HEAD
```

Expected: exactly the five files listed above. Stop if any other tracked file appears.

- [ ] **Step 2: Reverify the reviewed baseline**

Run:

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/response-projection-inventory.test.ts
node --experimental-strip-types --test-concurrency=1 --test tests/integration/mcp-output-schema-wire.test.ts
```

Expected: build exits 0, the projection inventory reports `0/27 tests failed`, and the wire suite reports `0/29 tests failed`.

- [ ] **Step 3: Stage and inspect the complete baseline**

Run:

```powershell
git add CHANGELOG.md src/mcp/tools.ts tests/fixtures/response-projection/agent-output-cases.ts tests/fixtures/tool-contract/public-tool-contract-cases.ts tests/unit/response-projection-inventory.test.ts
git diff --cached --name-only
git diff --cached
```

Expected: the cached name list contains exactly the five reviewed files, and the full cached diff contains only the already-reviewed structured-output schema fix. Do not commit if any unrelated hunk appears.

- [ ] **Step 4: Commit the reviewed baseline**

Run:

```powershell
git commit -m "fix: align strict MCP output schemas"
```

Expected: one commit containing the five-file reviewed baseline. The follow-up tasks now start from a clean tracked worktree.

### Task 1: Add failing projected-schema contract tests

**Files:**
- Modify: `tests/unit/response-projection-inventory.test.ts:1121-1140`
- Test: `tests/unit/response-projection-inventory.test.ts`

- [ ] **Step 1: Add the incomplete-metadata regression test**

Add this test immediately after `accepts the canonical full delta through its deduplicated public schema`:

```typescript
  it("rejects incomplete delta preview metadata", () => {
    const fixture = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "delta.get",
    );
    assert.ok(fixture);
    const projected = projectToolResultForModelContent(
      fixture.action,
      fixture.canonicalResultFactory(),
      { ...fixture.publicRequest, detail: "full", includeDiagnostics: false },
    ) as Record<string, unknown> & { delta: Record<string, unknown> };
    const schema = withProjectionSuccessOutputSchema(
      "delta.get",
      DeltaGetResponseSchema,
    );
    const {
      mode: _mode,
      totalChanges: _totalChanges,
      sampleSize: _sampleSize,
      ...normalDelta
    } = projected.delta;
    const partials: readonly Record<string, unknown>[] = [
      { mode: "preview" },
      { totalChanges: 1 },
      { sampleSize: 1 },
      { mode: "preview", totalChanges: 1 },
      { mode: "preview", sampleSize: 1 },
      { totalChanges: 1, sampleSize: 1 },
    ];

    for (const partial of partials) {
      const candidate = {
        ...projected,
        delta: { ...normalDelta, ...partial },
      };
      assert.equal(
        schema.safeParse(candidate).success,
        false,
        JSON.stringify(partial),
      );
    }
  });
```

The six entries enumerate every non-empty proper subset of `mode`, `totalChanges`, and `sampleSize`.

- [ ] **Step 2: Add the normal-warning compatibility test**

Add a separate test after the rejection case:

```typescript
  it("accepts a normal delta with a large-delta warning", () => {
    const fixture = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "delta.get",
    );
    assert.ok(fixture);
    const projected = projectToolResultForModelContent(
      fixture.action,
      fixture.canonicalResultFactory(),
      { ...fixture.publicRequest, detail: "full", includeDiagnostics: false },
    ) as Record<string, unknown> & { delta: Record<string, unknown> };
    const schema = withProjectionSuccessOutputSchema(
      "delta.get",
      DeltaGetResponseSchema,
    );
    const {
      mode: _mode,
      totalChanges: _totalChanges,
      sampleSize: _sampleSize,
      ...normalDelta
    } = projected.delta;
    const normal = {
      ...projected,
      delta: {
        ...normalDelta,
        largeDeltaWarning: "Narrow the version range.",
      },
    };

    assert.deepEqual(schema.parse(normal), normal);
  });
```

- [ ] **Step 3: Build unchanged production code for the dist-importing test**

Run:

```powershell
npm run build:all
```

Expected: exit code 0.

- [ ] **Step 4: Run the focused inventory and verify RED**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/response-projection-inventory.test.ts
```

Expected: the new `rejects incomplete delta preview metadata` test fails because at least one partial metadata object is accepted. The normal-warning compatibility test passes. Do not edit production code until this RED is observed.

### Task 2: Implement the strict normal/preview union

**Files:**
- Modify: `src/mcp/tools.ts:5258-5268`
- Modify after generated failures: `tests/fixtures/tool-contract/public-tool-contract-cases.ts:1059-1093`
- Modify after generated failures: `tests/unit/response-projection-inventory.test.ts:584-605`
- Test: `tests/unit/response-projection-inventory.test.ts`

- [ ] **Step 1: Replace the independently optional metadata schema**

Replace the current projected delta schema with:

```typescript
const ProjectedDeltaPackBaseSchema = DeltaPackSchema.extend({
  largeDeltaWarning: z.string().optional(),
  blastRadius: DeltaPackSchema.shape.blastRadius.optional(),
}).strict();

const ProjectedDeltaGetCompactResponseSchema = DeltaGetResponseSchema.extend({
  delta: z.union([
    ProjectedDeltaPackBaseSchema.extend({
      mode: z.literal("preview"),
      totalChanges: z.number().int().nonnegative(),
      sampleSize: z.number().int().nonnegative(),
    }).strict(),
    ProjectedDeltaPackBaseSchema,
  ]),
}).strict();
```

Keep the preview arm first. Do not modify `DeltaPackSchema`, `DeltaGetResponseSchema`, or `handleDeltaGet`.

- [ ] **Step 2: Rebuild the generated dist**

Run:

```powershell
npm run build:all
```

Expected: exit code 0.

- [ ] **Step 3: Run the focused inventory**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/response-projection-inventory.test.ts
```

Expected: the partial-metadata regression becomes GREEN. Checked schema-node or public output-arm coverage assertions may fail because the intended union changes the static public schema.

- [ ] **Step 4: Update only generated contract expectations proven stale**

If the focused inventory reports a stale `delta.get.output.union` key, replace it in `tests/fixtures/tool-contract/public-tool-contract-cases.ts` with the exact newly required key from the failure output. If it reports an exceeded `sdl.retrieve` node count, set the comment to the observed count and raise the budget by no more than ten nodes above that count.

Do not hand-invent fingerprints, relax global checks, or change unrelated exclusions.

- [ ] **Step 5: Rerun the focused inventory to GREEN**

Run the same focused command.

Expected: `0/29 tests failed` or the exact increased total with zero failures.

- [ ] **Step 6: Commit the strict schema contract**

Stage only:

```powershell
git add src/mcp/tools.ts tests/unit/response-projection-inventory.test.ts tests/fixtures/tool-contract/public-tool-contract-cases.ts
git diff --cached --name-only
git diff --cached
git commit -m "fix: tighten projected delta metadata"
```

Before committing, run `git diff --cached --name-only` and `git diff --cached`. Verify the name list contains exactly those files and the full cached diff contains only the Task 1 and Task 2 follow-up changes.

### Task 3: Align the fixture and protect producer behavior

**Files:**
- Modify: `tests/fixtures/response-projection/agent-output-cases.ts:251-260`
- Modify: `tests/integration/delta-paging-contract.test.ts:18-48`
- Modify: `tests/integration/delta-paging-contract.test.ts:190-230`
- Modify: `CHANGELOG.md:16-20`
- Test: `tests/integration/delta-paging-contract.test.ts`

- [ ] **Step 1: Make the projection fixture match preview output**

In the `delta.get` fixture, override the inherited blast radius immediately after spreading `fixtureDeltaPack()`:

```typescript
      delta: {
        ...fixtureDeltaPack(),
        blastRadius: [],
        mode: "preview",
        totalChanges: 1,
        sampleSize: 1,
        largeDeltaWarning: "Narrow the version range.",
      },
```

This fixture documents the projected shape. It does not replace producer coverage.

- [ ] **Step 2: Extend the local integration result type**

Add the preview fields to the nested `DeltaPage.delta` test type:

```typescript
    mode?: "preview";
    totalChanges?: number;
    sampleSize?: number;
```

Do not add them to the canonical domain type.

- [ ] **Step 3: Add deterministic producer characterization**

Add this integration case after the deterministic boundary-count test:

```typescript
  it("returns a bounded preview with complete metadata and no blast radius", async () => {
    const versions = await seedPair("preview", [
      "symbol-c",
      "symbol-a",
      "symbol-b",
    ]);

    const preview = (await handleDeltaGet({
      repoId: REPO_ID,
      ...versions,
      preview: true,
      previewSampleSize: 2,
    })) as DeltaPage;

    assert.equal(preview.delta.mode, "preview");
    assert.equal(preview.delta.totalChanges, 3);
    assert.equal(preview.delta.sampleSize, 2);
    assert.deepEqual(
      preview.delta.changedSymbols.map(({ symbolId }) => symbolId),
      ["symbol-a", "symbol-b"],
    );
    assert.deepEqual(preview.delta.blastRadius, []);
  });
```

The seeded symbols and expected order are explicit. This test characterizes existing producer behavior and may pass immediately; the RED requirement belongs to Task 1's schema behavior change.

- [ ] **Step 4: Update the existing changelog bullet**

Revise the current Unreleased structured-output bullet so it states that strict public schemas accept the emitted fields and reject incomplete delta preview metadata. Do not add a second bullet or repair the unrelated `repo.status` marker.

- [ ] **Step 5: Rebuild and run producer and projection tests**

Run:

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/integration/delta-paging-contract.test.ts
node --experimental-strip-types --test-concurrency=1 --test tests/unit/response-projection-inventory.test.ts
```

Expected: both test files report zero failures. The preview test returns exactly `symbol-a` and `symbol-b`, complete metadata, and an empty blast radius.

- [ ] **Step 6: Commit fixture, producer coverage, and documentation**

Stage only:

```powershell
git add CHANGELOG.md tests/fixtures/response-projection/agent-output-cases.ts tests/integration/delta-paging-contract.test.ts
git diff --cached --name-only
git diff --cached
git commit -m "test: cover delta preview producer contract"
```

Before committing, run `git diff --cached --name-only` and `git diff --cached`. Verify the name list contains exactly those files and the full cached diff contains only the Task 3 follow-up changes.

### Task 4: Run scoped final verification

**Files:**
- Verify all files changed by Tasks 1-3.
- Do not modify unrelated files or normalize line endings.

- [ ] **Step 1: Run build and type validation**

Run:

```powershell
npm run build:all
npm run typecheck
npm run lint
```

Expected: build and typecheck exit 0. Lint reports 0 errors; existing warnings remain reportable.

- [ ] **Step 2: Run focused schema and producer suites**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/response-projection-inventory.test.ts
node --experimental-strip-types --test-concurrency=1 --test tests/integration/delta-paging-contract.test.ts
node --experimental-strip-types --test-concurrency=1 --test tests/integration/mcp-output-schema-wire.test.ts
```

Expected: zero failures in all three files.

- [ ] **Step 3: Run golden and documentation checks**

Run:

```powershell
npm run test:golden
npm run docs:tools:check
npm run test:tool-output-contract
```

Expected: golden and docs checks pass. The output-contract command may remain `104/105` only for the known unrelated missing `repo.status detail:"minimal"` to `detail:"compact"` changelog marker; report any different failure as a regression.

- [ ] **Step 4: Verify the final worktree**

Run:

```powershell
git diff --check
git status --short --untracked-files=all
git ls-files --eol -- tests/unit/response-projection-inventory.test.ts
```

Expected: no whitespace errors and only intended files remain modified or committed. Report the existing mixed-EOL warning for `response-projection-inventory.test.ts`; do not normalize the file without explicit authorization.

- [ ] **Step 5: Restart boundary**

Do not restart or replace the currently connected SDL-MCP process without explicit authorization. Report that the rebuilt `dist` is verified in fresh processes and that the live connected process must restart before it uses the tightened validator.
