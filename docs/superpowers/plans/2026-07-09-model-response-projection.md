# Model-facing Response Projection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three redundant model-facing fields while preserving raw tool results, actionable code-window evidence, deterministic key ordering, and the existing compact projection contract.

**Architecture:** Keep raw handler and policy objects unchanged. Add a small tool-aware, top-level projection rule in `context-response-projection.ts`; compact usage projection returns no duplicate structured summary, while full-detail projection retains all other fields. Update the historical token-economy note from fresh test evidence.

**Tech Stack:** TypeScript 5.9, Node.js 24 built-in test runner, SDL-MCP model projection, JSON determinism/golden fixtures.

---

Use `@sdl-mcp-agent-workflow` for repository inspection and edits, `@test-driven-development` for every behavior change, `@test-scope` for focused verification, and `@verification-before-completion` before each commit.

## Chunk 1: Model-facing Response Projection

### File responsibility map

- Modify: `src/mcp/context-response-projection.ts:197-209,391-501,699-705,908-940` — preserve generic projection behavior while applying the three direct-tool omissions at the model boundary. The file is currently about 942 lines; keep this surgical change below 1,000 lines and do not add an unrelated extraction.
- Modify: `tests/unit/context-response-projection.test.ts:637-650` — replace the stale compact usage expectation and add direct raw/compact/full code-window coverage.
- Modify: `devdocs/plans/notes/2026-07-05-token-economy-status.md` — this plan owns the shipped search/projection/full-suite corrections and commits them before benchmark documentation begins. `2026-07-09-external-benchmark-isolation.md` owns only the later benchmark-status handoff after Task 3 commits, preventing concurrent edits.
- Inspect only: `tests/integration/determinism.fixtures.json` — retain the existing justified allowlist entries for stateful `sdl.usage.stats` and governed `sdl.code.needWindow`; do not invent cache-stable fixtures.
- Modify only if validation proves an intentional snapshot delta: existing golden files selected by `npm run test:golden`.

### Task 1: Lock the projection contract with failing tests

**Files:**
- Modify: `tests/unit/context-response-projection.test.ts:637-650`

- [ ] **Step 1: Replace the stale compact usage test**

Keep the existing raw fields but assert that compact model content no longer repeats `formattedSummary`:

```typescript
it("omits the duplicate compact usage summary without mutating the raw result", () => {
  const raw = {
    formattedSummary: "summary",
    session: { callCount: 1 },
    history: { snapshots: [], aggregate: {} },
    wire: { packed: { encodings: 1 } },
  };

  const projected = projectToolResultForModelContent("usage.stats", raw, {});

  assert.deepEqual(projected, {});
  assert.equal(raw.formattedSummary, "summary");
  assert.deepEqual(raw.session, { callCount: 1 });
});
```

- [ ] **Step 2: Add full-detail usage coverage**

Full detail must omit only the duplicate summary and retain the other raw fields in their original order:

```typescript
it("omits only formattedSummary from full-detail usage model content", () => {
  const raw = {
    formattedSummary: "summary",
    session: { callCount: 1 },
    history: { snapshots: [], aggregate: {} },
    wire: { packed: { encodings: 1 } },
  };

  const projected = projectToolResultForModelContent(
    "sdl.usage.stats",
    raw,
    { detail: "full" },
  );

  assert.deepEqual(projected, {
    session: { callCount: 1 },
    history: { snapshots: [], aggregate: {} },
    wire: { packed: { encodings: 1 } },
  });
  assert.equal(raw.formattedSummary, "summary");
  assert.deepEqual(
    Object.keys(projected as Record<string, unknown>),
    ["session", "history", "wire"],
  );
});
```

- [ ] **Step 3: Add approved code-window coverage**

Use both canonical and compatibility tool names across the tests. The compact approved projection must remove `whyApproved` and `estimatedTokens`, restore `matchedLineNumbers` for this tool, and retain all other evidence:

```typescript
it("omits only redundant approval fields from compact code.needWindow model content", () => {
  const raw = {
    approved: true,
    status: "approved",
    whyApproved: ["matched requested identifier"],
    estimatedTokens: 240,
    matchedIdentifiers: ["resolveTarget"],
    matchedLineNumbers: [120],
    range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
    continuation: { cursor: 1 },
    diagnostic: {
      whyApproved: "nested evidence",
      matchedLineNumbers: [999],
    },
  };

  const projected = projectToolResultForModelContent("code.needWindow", raw, {});

  assert.deepEqual(projected, {
    approved: true,
    status: "approved",
    matchedIdentifiers: ["resolveTarget"],
    matchedLineNumbers: [120],
    range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
    continuation: { cursor: 1 },
    diagnostic: {
      whyApproved: "nested evidence",
    },
  });
  assert.deepEqual(raw.whyApproved, ["matched requested identifier"]);
  assert.equal(raw.estimatedTokens, 240);
  assert.deepEqual(
    Object.keys(projected as Record<string, unknown>),
    [
      "approved",
      "status",
      "matchedIdentifiers",
      "matchedLineNumbers",
      "range",
      "continuation",
      "diagnostic",
    ],
  );
});
```

- [ ] **Step 4: Add downgraded compact coverage**

Add this standalone test and assert exact key order:

```typescript
it("preserves downgraded guidance while omitting redundant fields", () => {
  const downgraded = {
    approved: false,
    status: "downgraded",
    whyApproved: [],
    estimatedTokens: 400,
    downgradedTo: "skeleton",
    reason: "raw window not required",
    nextBestAction: "Use codeSkeleton",
    matchedIdentifiers: ["resolveTarget"],
    matchedLineNumbers: [120],
    sessionRef: "s4",
    contentRef: "response-1",
  };

  const projected = projectToolResultForModelContent(
    "sdl.code.needWindow",
    downgraded,
    {},
  ) as Record<string, unknown>;

  assert.deepEqual(projected, {
    approved: false,
    status: "downgraded",
    downgradedTo: "skeleton",
    reason: "raw window not required",
    nextBestAction: "Use codeSkeleton",
    matchedIdentifiers: ["resolveTarget"],
    matchedLineNumbers: [120],
    sessionRef: "s4",
    contentRef: "response-1",
  });
  assert.deepEqual(Object.keys(projected), [
    "approved",
    "status",
    "downgradedTo",
    "reason",
    "nextBestAction",
    "matchedIdentifiers",
    "matchedLineNumbers",
    "sessionRef",
    "contentRef",
  ]);
});
```

- [ ] **Step 5: Add full-detail and nested-object coverage**

Use an approved direct result with the same top-level fields plus a nested diagnostic object. Full detail must omit the two direct redundant fields, retain every other top-level key in order, and leave nested `whyApproved` untouched:

```typescript
it("applies full-detail omissions only at the direct tool-result root", () => {
  const raw = {
    approved: true,
    status: "approved",
    whyApproved: ["top-level duplicate"],
    estimatedTokens: 240,
    matchedIdentifiers: ["resolveTarget"],
    matchedLineNumbers: [120],
    range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
    diagnostic: { whyApproved: "nested evidence" },
  };

  const projected = projectToolResultForModelContent(
    "code.needWindow",
    raw,
    { detail: "full" },
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(projected), [
    "approved",
    "status",
    "matchedIdentifiers",
    "matchedLineNumbers",
    "range",
    "diagnostic",
  ]);
  assert.deepEqual(projected.diagnostic, {
    whyApproved: "nested evidence",
  });
  assert.equal("whyApproved" in projected, false);
  assert.equal("estimatedTokens" in projected, false);
});
```

- [ ] **Step 6: Build and run the focused test to prove the red state**

Run through SDL `runtimeExecute`:

```powershell
npm run build
node --test tests/unit/context-response-projection.test.ts
```

Expected: the usage assertions fail because `formattedSummary` is still copied; the code-window assertions fail because `whyApproved` remains and compact `matchedLineNumbers` is currently removed.

### Task 2: Implement the minimal tool-aware projection

**Files:**
- Modify: `src/mcp/context-response-projection.ts:197-209,391-453,699-705,908-940`

- [ ] **Step 1: Add canonical tool-name sets and a top-level omission predicate**

Place these near the existing projection field constants:

```typescript
const USAGE_STATS_TOOLS = new Set(["usage.stats", "sdl.usage.stats"]);
const CODE_NEED_WINDOW_TOOLS = new Set([
  "code.needWindow",
  "sdl.code.needWindow",
]);

function shouldOmitToolSpecificModelField(
  toolName: string,
  key: string,
): boolean {
  if (USAGE_STATS_TOOLS.has(toolName)) {
    return key === "formattedSummary";
  }
  if (CODE_NEED_WINDOW_TOOLS.has(toolName)) {
    return key === "whyApproved" || key === "estimatedTokens";
  }
  return false;
}
```

- [ ] **Step 2: Add a key-order-preserving full-detail filter**

This helper filters only the direct tool-result object. It must not recursively rewrite nested workflow results:

```typescript
function stripTopLevelToolSpecificFieldsForModel(
  toolName: string,
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (!shouldOmitToolSpecificModelField(toolName, key)) {
      projected[key] = itemValue;
    }
  }
  return projected;
}
```

- [ ] **Step 3: Track compact projection depth before applying direct-tool rules**

Add a required `depth` parameter to `shouldKeepModelField` and an optional root default to the recursive projector:

```typescript
function shouldKeepModelField(
  toolName: string,
  key: string,
  options: ModelContentProjectionOptions,
  depth: number,
): boolean {
  if (PRECONDITION_MODEL_FIELDS.has(key)) {
    return false;
  }
  if (depth === 0 && shouldOmitToolSpecificModelField(toolName, key)) {
    return false;
  }
  if (isFullDetail(options)) {
    return true;
  }

  // Keep direct code-window line evidence without exposing nested fields that
  // the established generic projection intentionally removes.
  if (key === "matchedLineNumbers") {
    return depth === 0 && CODE_NEED_WINDOW_TOOLS.has(toolName);
  }

  // Preserve the rest of the existing checks in their current order.
}
```

Change the recursive signature, then make these two exact call-site substitutions in the array branch and object loop:

```diff
 function projectGenericValueForModel(
   toolName: string,
   value: unknown,
   options: ModelContentProjectionOptions,
+  depth = 0,
 ): unknown {

-      projectGenericValueForModel(toolName, item, options),
+      projectGenericValueForModel(toolName, item, options, depth + 1),

-    const projectedValue = projectGenericValueForModel(toolName, itemValue, options);
+    const projectedValue = projectGenericValueForModel(
+      toolName,
+      itemValue,
+      options,
+      depth + 1,
+    );

-    if (!shouldKeepModelField(toolName, key, options)) {
+    if (!shouldKeepModelField(toolName, key, options, depth)) {
```

Do not change any other array, record, policy-decision, diagnostics, retrieval-evidence, or empty-object branch.
Keep `estimatedTokens`, `originalLines`, `generatedAt`, and `tokenMetrics` in the established generic omission group. Remove only `matchedLineNumbers` from that group because its depth-aware branch now handles it. The compact nested-object regression must prove that nested `whyApproved` remains while nested `matchedLineNumbers` remains omitted.

- [ ] **Step 4: Stop compact usage projection from copying the duplicate**

Replace `projectUsageStatsForModel` with an explicit empty compact projection:

```typescript
function projectUsageStatsForModel(): Record<string, unknown> {
  return {};
}
```

Update its call site to pass no unused argument.

- [ ] **Step 5: Apply direct-tool omissions after full-detail hidden-field filtering**

Change the full-detail branch in `projectToolResultForModelContent`:

```typescript
if (isFullDetail(options)) {
  return stripTopLevelToolSpecificFieldsForModel(
    toolName,
    stripFullDetailHiddenFieldsForModel(result),
  );
}
```

Do not modify handler response types, policy construction, formatter input, workflow envelopes, telemetry, or raw results.

- [ ] **Step 6: Rebuild and run the focused test to prove green**

```powershell
npm run build
node --test tests/unit/context-response-projection.test.ts
```

Expected: all tests in the file pass, including compact/full usage and approved/downgraded code-window cases.

- [ ] **Step 7: Run focused static checks**

```powershell
npm run typecheck
npm run lint
```

Expected: both commands exit 0; lint may report pre-existing warnings but no errors.

- [ ] **Step 8: Commit the projection behavior**

```powershell
git add src/mcp/context-response-projection.ts tests/unit/context-response-projection.test.ts
git commit -m "perf: trim redundant model response fields"
```

### Task 3: Reconcile the token-economy note

**Files:**
- Modify: `devdocs/plans/notes/2026-07-05-token-economy-status.md`

- [ ] **Step 1: Correct stale status entries from current code evidence**

Record these facts in active voice:

- `buildIdentifierAwareFtsQuery` ships identifier-aware FTS splitting.
- `buildOverlaySearchTerms` ships live-overlay camel-case and Pascal-case subword matching.
- The full-suite failure was resolved by updating `tool-output-visibility.test.ts`, with the existing 596/596 and 597/597 evidence retained.
- Compact/full model projection now omits `usage.stats.formattedSummary`.
- Direct code-window model projection omits `whyApproved` and `estimatedTokens` while retaining actionable evidence.
- `buildCardForSymbol` construction remains an unchecked profiling task because projection already removes those fields from the wire.
- External benchmark status belongs to the benchmark-isolation plan; do not claim it green without that plan's persisted artifact.

- [ ] **Step 2: Remove or mark stale unchecked entries as shipped**

Do not erase historical artifact handles. Change only claims that current code and fresh verification establish; keep the benchmark and card-builder work unchecked until their own gates pass.

- [ ] **Step 3: Run documentation checks**

```powershell
npm run docs:workflows:check
npm run docs:tools:check
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the note**

```powershell
git add devdocs/plans/notes/2026-07-05-token-economy-status.md
git commit -m "docs: reconcile token economy status"
```

### Task 4: Verify determinism and golden compatibility

**Files:**
- Inspect only: `tests/integration/determinism.fixtures.json`
- Modify only on an intentional generated delta: golden snapshot files selected by the generator

- [ ] **Step 1: Confirm fixture policy remains valid**

Verify that `sdl.code.needWindow` remains allowlisted because governed raw-code access is not cache-stable and `sdl.usage.stats` remains allowlisted because session telemetry is stateful. Do not add fake deterministic calls.

- [ ] **Step 2: Run the determinism integration test**

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/integration/determinism.test.ts
```

Expected: exit 0 with no byte-stability diff.

- [ ] **Step 3: Validate goldens**

```powershell
npm run test:golden
```

Expected: exit 0 because both affected direct tools are intentionally excluded from cache-stable determinism/golden fixtures.

- [ ] **Step 4: Classify any unexpected golden failure before changing files**

If Step 3 fails, use the failure output to identify the exact tool/snapshot. Stop when it is unrelated to `usage.stats.formattedSummary`, `code.needWindow.whyApproved`, or `code.needWindow.estimatedTokens`; record it as a blocker and do not regenerate snapshots.

- [ ] **Step 5: Regenerate and inspect only a proven intentional snapshot delta**

Only when Step 4 proves a current snapshot directly exercises one of the three omissions, run:

```powershell
npm run golden:update
git diff --name-only -- tests
npm run test:golden
```

Expected: the name-only diff lists only the directly affected generated snapshot, and validation then exits 0. Commit that file with the projection behavior; never refresh unrelated snapshots.

- [ ] **Step 6: Record fresh evidence for final backlog reconciliation**

Save the SDL runtime artifact handles for the focused test, typecheck, lint, docs checks, determinism, and golden validation. Do not mark the entire backlog batch complete; the integration plan owns that decision.
