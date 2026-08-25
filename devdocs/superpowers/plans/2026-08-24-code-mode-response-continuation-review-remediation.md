# Code Mode Response Continuation Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore non-exclusive retrieval compatibility, preserve outer response projection controls across direct responseGet pages, and add production-boundary coverage for structured and raw continuation.

**Architecture:** Keep canonical `response.get` as the artifact authority. Make nested responseGet arguments projection-free, let the late MCP response boundary own successful direct continuation and final error normalization, and retain the early exclusive catch solely to preserve typed-error recovery before error materialization.

**Tech Stack:** TypeScript, Zod 4, MCP SDK, Node.js `node:test`, existing SDL dispatch and response-artifact infrastructure.

**Design:** `devdocs/superpowers/specs/2026-08-24-code-mode-response-continuation-review-remediation-design.md`

---

## File map

- Modify `src/mcp/tools.ts`: make the responseGet continuation child schema projection-free.
- Modify `src/code-mode/retrieve.ts`: validate responseGet child arguments, advertise the projection-free nested variant, and extend the existing next-action envelope with optional outer projection controls.
- Modify `src/code-mode/action-reference-projection.ts`: preserve responseGet success for the late boundary and rematerialize outer projection controls deterministically.
- Modify `src/server.ts`: gate late projection to responseGet and pass resolved outer controls.
- Modify focused tests under `tests/unit/` and `tests/integration/`.
- Update existing public-contract or determinism fixtures only when intentional schema/output changes require them.

## Plan preservation

Before production edits, force-add this ignored reviewed plan and commit it:

```bash
git add -f devdocs/superpowers/plans/2026-08-24-code-mode-response-continuation-review-remediation.md
git commit -m "docs: plan response continuation review fixes"
```

The later clean-worktree check must therefore include the plan.

## Chunk 1: Make the responseGet schema honest and enforceable

### Task 1: Add RED schema and runtime-validation tests

**Files:**
- Modify: `tests/unit/code-mode-retrieve.test.ts`
- Modify: `tests/integration/mcp-output-schema-wire.test.ts`
- Modify: `tests/integration/response-artifact-recovery.test.ts`

- [ ] **Step 1: Add a tools/list schema assertion**

Use the production-registered `sdl.retrieve` tool schema. Locate the
`responseGet` nested `args` variant and assert:

```ts
assert.ok(outerProperties.detail);
assert.ok(outerProperties.includeDiagnostics);
assert.equal(responseGetArgsProperties.detail, undefined);
assert.equal(responseGetArgsProperties.includeDiagnostics, undefined);
```

- [ ] **Step 2: Add next-action schema assertions**

Extend the existing `RetrieveOutputSchema` responseGet tests by cloning the
existing valid incomplete-page fixture and replacing only its `nextAction`:

```ts
const validPage = makeValidIncompleteResponsePage();

const direct = {
  action: "sdl.retrieve",
  args: {
    repoId: "repo-a",
    op: "responseGet",
    args: { handle: validPage.handle },
    detail: "full",
    includeDiagnostics: true,
  },
};
assert.equal(
  RetrieveOutputSchema.safeParse({ ...validPage, nextAction: direct }).success,
  true,
);

const nested = {
  action: "sdl.retrieve",
  args: {
    repoId: "repo-a",
    op: "responseGet",
    args: {
      handle: validPage.handle,
      detail: "full",
      includeDiagnostics: true,
    },
  },
};
assert.equal(
  RetrieveOutputSchema.safeParse({ ...validPage, nextAction: nested }).success,
  false,
);
```

Reuse the surrounding valid response-page fixture so handle, pagination, and
range invariants remain valid.

- [ ] **Step 3: Add production tools/call rejection coverage**

Call the production `sdl.retrieve` registration and assert typed validation
errors for:

```ts
{ repoId, op: "responseGet", args: { handle, detail: "full" } }
{ repoId, op: "responseGet", args: { handle, includeDiagnostics: true } }
{ repoId, op: "responseGet", args: { handle }, detail: 42 }
{ repoId, op: "responseGet", args: { handle }, includeDiagnostics: "yes" }
```

Check the public error classification; do not assert internal Zod text.

- [ ] **Step 4: Run RED tests**

Run:

```bash
npm run build:all
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/response-artifact-recovery.test.ts
```

Expected: failures show nested controls remain advertised/accepted and outer
responseGet next actions reject projection controls.

### Task 2: Implement the minimal schema/runtime fix

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/code-mode/retrieve.ts`

- [ ] **Step 1: Make continuation child arguments projection-free**

Replace the current projection-wrapped continuation schema with:

```ts
export const ResponseGetContinuationRequestSchema =
  ResponseGetRequestObjectSchema.omit({ repoId: true }).strict();
```

Keep `ResponseGetRequestSchema` unchanged for canonical `response.get` and
workflow `responseGet`.

- [ ] **Step 2: Extend the existing responseGet next-action envelope**

Keep the existing branch and add only optional outer controls:

```ts
const RetrieveResponseGetRequestSchema = RetrieveRequestSchema.extend({
  op: z.literal("responseGet"),
  args: ResponseGetContinuationRequestSchema,
  detail: z.enum(["compact", "standard", "full"]).optional(),
  includeDiagnostics: z.boolean().optional(),
}).strict();
```

Do not add another union branch.

- [ ] **Step 3: Override only the responseGet nested wire variant**

Inside `buildRetrieveWireSchema()`:

```ts
const variant = zodSchemaToJsonSchema(
  op === "responseGet"
    ? ResponseGetContinuationRequestSchema
    : action.schema,
);
```

The common MCP projection augmentation remains responsible for outer
`detail` and `includeDiagnostics`.

- [ ] **Step 4: Validate nested responseGet arguments inside existing error conversion**

Keep the child parse inside `handleRetrieve`'s existing `try` block so its
`ZodError` follows the current `ValidationError` conversion:

```ts
try {
  const operationArgs =
    request.op === "responseGet"
      ? ResponseGetContinuationRequestSchema.parse(request.args)
      : request.args;

  const actionArgs = {
    ...operationArgs,
    repoId: request.repoId,
  };

  return await dispatchAction(
    actionName,
    actionArgs,
    actionMap,
    { kind: "retrieve", responseMode: request.responseMode },
    context,
  );
} catch (error) {
  // Keep the existing conversion block unchanged.
}
```

The trusted envelope `repoId` remains authoritative and nested validation
errors retain the established public classification.

- [ ] **Step 5: Run GREEN tests**

Run:

```bash
npm run build:all
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/response-artifact-recovery.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit Chunk 1**

```bash
git add src/mcp/tools.ts src/code-mode/retrieve.ts tests/unit/code-mode-retrieve.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/response-artifact-recovery.test.ts
git commit -m "fix: enforce response continuation envelope"
```

## Chunk 2: Restore projection compatibility and continuation controls

### Task 3: Add RED boundary and replay tests

**Files:**
- Modify: `tests/unit/code-mode-retrieve.test.ts`
- Modify: `tests/unit/server-unit.test.ts`
- Modify: `tests/integration/response-artifact-recovery.test.ts`

- [ ] **Step 1: Lock unrelated non-exclusive compatibility**

Use a deterministic non-exclusive `codeNeedWindow` response containing a flat
`sdl.code.getSkeleton` recovery reference. Capture exact serialized
`structuredContent`, including key order, and assert it matches the
pre-feature expectation.

Add the paired exclusive assertion proving the same reference remains projected
to a callable Code Mode gateway.

- [ ] **Step 2: Lock responseGet typed-error behavior**

Through production MCP boundaries, trigger the same typed responseGet error
in exclusive and non-exclusive modes. Compare each complete serialized error
envelope with its approved exact expectation, including key order, and assert
that each contains exactly one direct `sdl.retrieve` recovery action. Preserve
the existing early exclusive catch test.

- [ ] **Step 3: Add full structured paging replay**

Create equivalent JSON response artifacts in exclusive and non-exclusive
production servers. Run the complete paging replay in both modes. Call:

```ts
{
  repoId,
  op: "responseGet",
  args: { handle, jsonPath: "evidence", offset: 0, limit: 2 },
  detail: "full",
  includeDiagnostics: true,
}
```

For every page:

1. Validate `structuredContent` against the production advertised output
   schema.
2. Assert returned `nextAction.args.detail === "full"`.
3. Assert returned `nextAction.args.includeDiagnostics === true`.
4. Replay `nextAction.action` and `nextAction.args` unchanged.
5. Continue until no next action remains and assert the complete array.

- [ ] **Step 4: Add raw replay success**

Call production `tools/call` with nested `raw: true` and verify exact raw
content is returned without moving `raw` to the outer envelope.

- [ ] **Step 5: Add focused projector route and key-order tests**

Place a validated canonical `response.get` recovery action in each supported
location: `nextAction`, `nextBestAction`, every entry of `nextCalls`, and a
nested record traversed by `projectRecoveryValue`. Pass the non-default outer
control snapshot and assert every rematerialized direct action retains it.

For each action, assert exact key order:

```ts
assert.deepEqual(
  Object.keys(projectedAction.args),
  ["args", "op", "repoId", "detail", "includeDiagnostics"],
);
```

Add the `responseMode` variant and assert it appears between `repoId` and
`detail`. Compare the serialized projected actions byte-for-byte.

- [ ] **Step 6: Run RED tests**

Run:

```bash
npm run build:all
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/unit/server-unit.test.ts tests/integration/response-artifact-recovery.test.ts
```

Expected failures:

- unrelated non-exclusive recovery is rewritten;
- full/diagnostic controls disappear from the next action;
- full continuation replay falls back to compact output.

### Task 4: Implement final-boundary projection

**Files:**
- Modify: `src/code-mode/action-reference-projection.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Skip only early successful responseGet projection**

In `withExclusiveCodeModeRecoveryProjection()`, identify
`request.op === "responseGet"`. On success, project only when exclusive and
the request is not responseGet. Leave the catch block unchanged:

```ts
const deferSuccessfulResponseGet =
  isRecord(request) && ownString(request, "op") === "responseGet";

try {
  const result = await call();
  return exclusive && !deferSuccessfulResponseGet
    ? projectExclusiveCodeModeRecovery(result, repoId)
    : result;
} catch (error) {
  if (exclusive) projectExclusiveCodeModeRecovery(error, repoId);
  throw error;
}
```

- [ ] **Step 2: Thread a narrow outer-control snapshot**

Add an optional internal parameter through
`projectExclusiveCodeModeRecovery()`, `projectRecoveryValue()`, and
`projectNextAction()`. Pass it at every `projectNextAction()` call site for
`nextAction`, `nextBestAction`, and `nextCalls`, and preserve it through each
iterative nested-record traversal:

```ts
type ResponseContinuationProjectionOptions = Readonly<{
  detail?: "standard" | "full";
  includeDiagnostics?: true;
}>;
```

Apply it only when rematerializing validated `response.get` recovery.

- [ ] **Step 3: Keep artifact and projection controls separated**

Before parsing the nested continuation child, remove canonical projection
fields from `childArgs`:

```ts
delete childArgs.detail;
delete childArgs.includeDiagnostics;
```

Continue removing existing default-only artifact fields. Build and canonicalize
the base envelope first, preserving `args`, `op`, `repoId`, and optional
`responseMode`. Then append optional `detail` and
`includeDiagnostics` with `defineOwn`; do not recanonicalize that nested
envelope afterward.

- [ ] **Step 4: Gate the late server projection and pass resolved controls**

Replace the unconditional block with:

```ts
if (toolName === "sdl.retrieve" && toolArgs.op === "responseGet") {
  const repoId =
    typeof toolArgs.repoId === "string" ? toolArgs.repoId : undefined;
  const responseContinuationOptions = {
    ...(projectionOptions.detail === "standard" ||
    projectionOptions.detail === "full"
      ? { detail: projectionOptions.detail }
      : {}),
    ...(projectionOptions.includeDiagnostics
      ? { includeDiagnostics: true as const }
      : {}),
  };
  const value = projectExclusiveCodeModeRecovery(
    projection.value,
    repoId,
    responseContinuationOptions,
  );
  // Preserve the existing measurement/stat update.
}
```

The late block continues to run for both success and error envelopes. It is
idempotent when the early exclusive catch already projected typed-error
recovery.

- [ ] **Step 5: Run GREEN tests**

Run:

```bash
npm run build:all
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/unit/server-unit.test.ts tests/integration/response-artifact-recovery.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit Chunk 2**

```bash
git add src/code-mode/action-reference-projection.ts src/server.ts tests/unit/code-mode-retrieve.test.ts tests/unit/server-unit.test.ts tests/integration/response-artifact-recovery.test.ts
git commit -m "fix: preserve direct response continuation"
```

## Chunk 3: Synchronize contracts and verify

### Task 5: Update and verify intentional public contracts

**Files:**
- Modify: `tests/integration/determinism.fixtures.json`
- Modify if required: `tests/fixtures/tool-contract/public-tool-contract-cases.ts`
- Modify if required: existing golden outputs produced by repository scripts

- [ ] **Step 1: Run contract checks before fixture updates**

```bash
npm run build:all
npm run test:golden
npm run docs:tools:check
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/tool-registration.test.ts tests/unit/response-projection-inventory.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/determinism.test.ts
```

Expected RED: the deterministic public `sdl.retrieve` schema expectation still
advertises responseGet projection controls inside nested `args`.

- [ ] **Step 2: Update the deterministic responseGet contract**

Update the existing `sdl.retrieve` determinism fixture so the responseGet
variant records outer `detail` and `includeDiagnostics` and omits both from
nested `args`. Preserve all unrelated fixture bytes and ordering.

Update public tool-contract or golden outputs only when the focused commands
show the same intentional responseGet schema delta. Do not accept unrelated
fixture churn.

- [ ] **Step 3: Re-run every contract check**

Run the Step 1 command. Expected: zero failures.

- [ ] **Step 4: Account for golden output explicitly**

Run `git status --short`. If golden files changed intentionally, stage their
exact paths in the contract commit. If no golden files changed, prove it with:

```bash
git diff --exit-code -- tests/golden
```

- [ ] **Step 5: Commit intentional contract changes**

```bash
git add tests/integration/determinism.fixtures.json
# Add exact public-contract or golden paths only when Step 4 proves they changed intentionally.
git commit -m "test: update response continuation contracts"
```

### Task 6: Final verification and review

- [ ] **Step 1: Build before dist-backed tests**

```bash
npm run build:all
```

Expected: exit 0.

- [ ] **Step 2: Run focused regression suites**

```bash
node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/unit/server-unit.test.ts tests/integration/response-artifact-recovery.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/unit/tool-registration.test.ts tests/unit/response-projection-inventory.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Run static and documentation checks**

```bash
npm run typecheck
npm run lint
npm run docs:workflows:check
npm run docs:tools:check
npm run test:golden
git diff --check
```

Expected: typecheck/build/docs/golden exit 0; lint has zero errors and only the
existing warning baseline.

- [ ] **Step 4: Attempt the affected full unit suite within the SDL runtime bound**

```bash
npm test
```

Treat a 300-second runtime timeout as no result, not as pass or failure. Verify
that any test-generated fixture changes are content-identical before clearing
them.

- [ ] **Step 5: Run the fresh review and verification loop**

Request fresh code and documentation review of the complete remediation diff
against the design and this plan.

If the review finds a Critical or Important issue:

1. Add or update a RED regression before the production fix.
2. Apply the minimal fix.
3. Rerun Task 6 Steps 1–4.
4. When schema, output, or generated contracts can be affected, rerun Task 5
   Step 3 as well.
5. Request another fresh code and documentation review.

Repeat until the latest verified diff has no Critical or Important findings.

- [ ] **Step 6: Commit final verified review fixes**

Stage only intended files after the latest verification and clean review. Commit
the fixes. Do not merge or push.

- [ ] **Step 7: Verify clean worktree**

```bash
git status --short --branch
```

Expected: only the branch header.
