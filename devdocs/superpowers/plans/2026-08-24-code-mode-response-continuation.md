# Code Mode Response Continuation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make stored-response paging a direct sdl.retrieve responseGet continuation in exclusive Code Mode while preserving the seven-tool surface and all existing response.get safeguards.

**Architecture:** Extend the existing retrieve operation map and generated wire schema so responseGet dispatches to the authoritative response.get Action Definition. Reuse the strict projected response.get output builders with a Code Mode nextAction schema, rematerialize validated response.get recovery as a nested sdl.retrieve call, and bypass only the outer artifact boundary for this operation.

**Tech Stack:** TypeScript, Zod 4, MCP SDK, Node.js node:test, existing SDL Dispatch Spine and response-artifact store.

---

## Approved Baseline Exception

The isolated branch starts at fe2b9dc1. npm run typecheck passes. npm run test:tool-output-contract reports 94/95 passing with one unrelated pre-existing documentation-contract failure: CHANGELOG.md lacks the migration marker for replacing repo.status detail:"minimal" with detail:"compact". The full npm test command exceeded the five-minute tool timeout and modified generated fixtures; those fixture changes were restored and the worktree is clean.

Do not fix that unrelated baseline failure in this feature. Targeted tests for every changed behavior must be green, and the final full-suite run must show no additional failures.

## Mandatory Working Directory

Every command, edit, stage, and commit in this plan runs from:

    F:\Claude\projects\sdl-mcp\sdl-mcp\.worktrees\code-mode-response-continuation

Before each task, verify git branch --show-current returns codex/code-mode-response-continuation. Never run plan commands from the main checkout.

## File Responsibility Map

- Modify src/code-mode/retrieve-schema.ts: append the responseGet operation without reordering existing operations.
- Modify src/code-mode/retrieve.ts: map responseGet to response.get, enforce envelope-owned repoId, and add the strict response-get output arm.
- Modify src/mcp/tools.ts: expose a narrow projected response.get schema builder that accepts the public nextAction schema and typed continuation-argument extractor while retaining the existing default schemas.
- Modify src/mcp/response-projection/types.ts: expose the validated logical action on the internal recovery result.
- Modify src/mcp/response-projection/recovery.ts: preserve validated logical args independently of public-surface materialization.
- Modify src/code-mode/action-reference-projection.ts: rematerialize validated response.get recovery as nested sdl.retrieve arguments.
- Modify src/mcp/response-projection/projectors/retrieval.ts: project responseGet results using the response.get action profile.
- Modify src/server.ts: make responseGet page-native only at the outer response-mode boundary.
- Modify tests/unit/code-mode-retrieve.test.ts: unit contract for schema generation, dispatch, output validation, projection routing, and exclusive continuation projection.
- Modify tests/unit/tool-registration.test.ts: exact seven-tool exclusive registration order.
- Modify tests/unit/recovery-validation.test.ts: internal validated logical-action contract.
- Modify tests/integration/response-artifact-recovery.test.ts: real artifact paging, replay, responseMode, and security/lifecycle coverage.
- Modify tests/integration/mcp-output-schema-wire.test.ts: advertised structured-output and error-envelope coverage.
- Modify src/code-mode/descriptions.ts and docs/feature-deep-dives/code-mode.md: document responseGet as continuation, not general retrieval.
- Modify tests/integration/determinism.fixtures.json: add stable compact/full sdl.retrieve responseGet contract cases.
- Regenerate docs/generated/tool-inventory.md using the repository generator; do not hand-edit generated output.
- Modify CHANGELOG.md: add only the response-continuation feature entry; do not repair the unrelated baseline marker.

## Chunk 1: Direct Retrieve Contract

### Task 1: Add the responseGet operation and secure dispatch

**Files:**
- Modify: src/code-mode/retrieve-schema.ts
- Modify: src/code-mode/retrieve.ts
- Modify: src/mcp/response-projection/projectors/retrieval.ts
- Test: tests/unit/code-mode-retrieve.test.ts
- Test: tests/unit/tool-registration.test.ts

- [ ] **Step 1: Extend the operation-map test and add wire-schema and ownership tests**

Update the existing maps retrieval ops test so the expected object appends:

~~~ts
responseGet: "response.get",
~~~

Add a generated-wire-schema assertion that finds the responseGet args arm and proves handle is required while repoId is absent from nested properties and required fields.

Add a projection-routing test that calls the existing model projection entry point with toolName sdl.retrieve and op responseGet, then proves response.get projection semantics are selected. This test must fail until the duplicate RETRIEVE_ACTION_BY_OP map in src/mcp/response-projection/projectors/retrieval.ts is updated.

In tests/unit/tool-registration.test.ts, strengthen the existing registers universal and code-mode tools when exclusive mode is enabled test. It already calls the production registerTools harness and captures all registered names. Replace its membership/count-only contract with this exact-order assertion:

~~~ts
assert.deepEqual(names, [
  "sdl.action.search",
  "sdl.info",
  "sdl.manual",
  "sdl.retrieve",
  "sdl.workflow",
  "sdl.context",
  "sdl.file",
]);
~~~

Do not place this assertion in the registerCodeModeTools unit harness: that lower-level registrar owns only the final five tools.

Add a dispatch test with a strict fake response.get action:

~~~ts
const seen: unknown[] = [];
const result = await handleRetrieve(
  {
    repoId: "trusted-repo",
    op: "responseGet",
    args: {
      repoId: "attacker-repo",
      handle: "response-trusted-repo-1784866000000-deadbeefdeadbeef",
    },
  },
  {
    "response.get": {
      schema: z.object({
        repoId: z.string(),
        handle: z.string(),
      }).strict(),
      handler: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    },
  },
);

assert.deepEqual(result, { ok: true });
assert.deepEqual(seen, [{
  repoId: "trusted-repo",
  handle: "response-trusted-repo-1784866000000-deadbeefdeadbeef",
}]);
~~~

The test deliberately injects nested repoId directly into handleRetrieve because the public generated schema must reject it while the internal adapter must still make the envelope win.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

    npm run build:all
    node --experimental-strip-types --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/unit/tool-registration.test.ts

Expected: FAIL because responseGet is not a RetrieveOp, is absent from both retrieve action maps, and the current repoId merge order allows nested args to override the envelope. The production registration-order assertion should already pass and protect the unchanged seven-tool surface.

- [ ] **Step 3: Implement the minimum direct adapter**

Append responseGet to RetrieveOpSchema.

Append the mapping in both retrieve action maps:

~~~ts
responseGet: "response.get",
~~~

In handleRetrieve, reverse only the merge order so the trusted envelope wins:

~~~ts
const actionArgs = {
  ...request.args,
  repoId: request.repoId,
};
~~~

Do not add a response-specific handler or duplicate ResponseGetRequestSchema. buildRetrieveWireSchema already derives each nested args arm from the Action Definition and removes repoId.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run the same build and two-file node:test command.

Expected: PASS with the existing six operation assertions unchanged, the new responseGet ownership assertions green, and the production exclusive registration order exactly seven tools.

- [ ] **Step 5: Commit the direct adapter**

    git add src/code-mode/retrieve-schema.ts src/code-mode/retrieve.ts src/mcp/response-projection/projectors/retrieval.ts tests/unit/code-mode-retrieve.test.ts tests/unit/tool-registration.test.ts
    git commit -m "feat: expose response retrieval through sdl.retrieve"

## Chunk 2: Strict Continuation and Delivery

### Task 2: Reuse strict projected response schemas with a direct nextAction

**Files:**
- Modify: src/mcp/tools.ts
- Modify: src/code-mode/retrieve.ts
- Test: tests/unit/code-mode-retrieve.test.ts

- [ ] **Step 1: Add strict output-schema tests**

Add one complete response.get page and one incomplete page to the existing RetrieveOutputSchema tests. The incomplete case must use this direct continuation shape:

~~~ts
nextAction: {
  action: "sdl.retrieve",
  args: {
    repoId: "repo",
    op: "responseGet",
    args: {
      handle: "response-repo-1784866000000-deadbeefdeadbeef",
      view: "model",
      cursor: { offsetBytes: 8192 },
      full: false,
      maxBytes: 8192,
      offsetBytes: 0,
      raw: false,
    },
  },
},
~~~

Assert the direct form parses, the previous one-step sdl.workflow wrapper does not parse in the responseGet arm, unknown page fields fail, and object key order remains stable after JSON serialization.

Add three direct nested-continuation negative cases against the real response page invariants: a handle mismatch, a cursor that does not follow the returned byte range, and bounded-control violations such as full: true, raw: true, or a nonzero legacy offsetBytes value (for example 4096 while cursor.offsetBytes is 8192). Each must fail through nextAction.args.args, not a synthetic flat response.get action.

- [ ] **Step 2: Run the unit test and verify RED**

Run:

    npm run build:all
    node --experimental-strip-types --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts

Expected: FAIL because RetrieveOutputSchema has no response.get arm and the authoritative projected response schemas currently require nextAction.action response.get.

- [ ] **Step 3: Parameterize the existing response.get projected-schema builder**

In src/mcp/tools.ts, parameterize both the incomplete-page nextAction schema and the continuation arguments consumed by the existing superRefine invariants. Keep the flat response.get behavior as the default:

~~~ts
type ProjectedResponseGetContinuationArgs = Omit<
  z.infer<typeof ProjectedResponseGetRequestSchema>,
  "repoId"
>;

type ProjectedResponseGetContinuationExtractor =
  (nextAction: unknown) => ProjectedResponseGetContinuationArgs;

function buildProjectedResponseGetSchema(
  range: z.ZodType,
  truncatedWhenComplete: z.ZodType | undefined,
  nextActionSchema: z.ZodType = ProjectedResponseGetNextActionSchema,
  extractContinuationArgs: ProjectedResponseGetContinuationExtractor =
    (nextAction) => ProjectedResponseGetNextActionSchema.parse(nextAction).args,
): z.ZodType
~~~

Use nextActionSchema only for the incomplete variant. In superRefine, replace the fixed value.nextAction.args access with extractContinuationArgs(value.nextAction), then keep every existing handle, cursor, pagination, and bounded-control check unchanged.

Export one narrow helper that requires the caller-supplied nextAction schema and its typed extractor, and passes both through for compact and full response pages:

~~~ts
export function buildProjectedResponseGetSuccessOutputSchema(
  nextActionSchema: z.ZodType,
  extractContinuationArgs: ProjectedResponseGetContinuationExtractor,
): z.ZodType {
  return z.union([
    buildProjectedResponseGetSchema(
      ProjectedResponseGetCompactRangeSchema,
      undefined,
      nextActionSchema,
      extractContinuationArgs,
    ),
    buildProjectedResponseGetSchema(
      ProjectedResponseGetFullRangeSchema,
      z.literal(false),
      nextActionSchema,
      extractContinuationArgs,
    ),
  ]);
}
~~~

Do not broaden the response.get schemas and do not duplicate their fields or invariant logic.

In src/code-mode/retrieve.ts, define a strict responseGet retrieve envelope by extending RetrieveRequestSchema with op literal responseGet and nested ResponseGetRequestSchema without repoId. Define a strict nextAction around that envelope. Pass both the nextAction schema and an extractor that parses that schema and returns nextAction.args.args to the new helper, then append the returned schema to RetrieveOutputSchema. This is the only shape-specific hook; the response.get invariant implementation remains shared.

- [ ] **Step 4: Re-run the unit test and verify GREEN**

Run the same build and targeted node:test command.

Expected: PASS for complete/incomplete pages, direct nested continuation, nested handle/cursor/bounded-control invariant rejections, workflow/unknown-field rejection, and the pre-existing retrieve success cases.

- [ ] **Step 5: Commit the strict output contract**

    git add src/mcp/tools.ts src/code-mode/retrieve.ts tests/unit/code-mode-retrieve.test.ts
    git commit -m "feat: validate direct response continuations"

### Task 3: Rematerialize validated recovery and prevent re-artifactization

**Files:**
- Modify: src/mcp/response-projection/types.ts
- Modify: src/mcp/response-projection/recovery.ts
- Modify: src/code-mode/action-reference-projection.ts
- Modify: src/server.ts
- Test: tests/unit/recovery-validation.test.ts
- Test: tests/unit/code-mode-retrieve.test.ts
- Test: tests/integration/response-artifact-recovery.test.ts
- Test: tests/integration/mcp-output-schema-wire.test.ts

- [ ] **Step 1: Add failing recovery-contract and exclusive-recovery tests**

In tests/unit/recovery-validation.test.ts, add direct and workflow-fallback cases proving buildValidatedRecoveryAction returns a validatedAction with the logical action name response.get and schema-parsed stable args, independently of the materialized public nextAction. Invalid recovery must not expose validatedAction.

In tests/unit/code-mode-retrieve.test.ts, add a projectExclusiveCodeModeRecovery test whose candidate is response.get with repoId, handle, cursor, and maxBytes. Assert the exact result is:

~~~ts
{
  nextAction: {
    action: "sdl.retrieve",
    args: {
      args: {
        cursor: { offsetBytes: 8192 },
        handle: "response-repo-1784866000000-deadbeefdeadbeef",
        maxBytes: 8192,
      },
      op: "responseGet",
      repoId: "repo",
    },
  },
}
~~~

Assert child repoId is absent, the envelope repoId wins, keys are canonical, an invalid handle removes only nextAction, and unrelated recovery mappings remain unchanged.

- [ ] **Step 2: Add failing real-artifact delivery tests**

Extend response-artifact-recovery.test.ts using its existing temporary artifact store and MCPServer helpers:

1. Store a multi-page JSON artifact requiring the same session.
2. Call exclusive sdl.retrieve with op responseGet and outer responseMode auto.
3. Assert structuredContent is the actual response page, not a new responseArtifact handle.
4. Replay the returned sdl.retrieve nextAction until complete.
5. Repeat the first page with outer responseMode handle and assert it is still not re-artifactized.
6. Exercise wrong repository, wrong session, expired handle, active-epoch invalidation, invalid metadata, and decompression-bound failures through sdl.retrieve and compare their typed codes with response.get.

Add an MCP output-wire assertion that a responseGet failure uses the generic structured error envelope and the advertised sdl.retrieve output schema accepts the projected success shape.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

    npm run build:all
    node --experimental-strip-types --test-concurrency=1 --test tests/unit/recovery-validation.test.ts tests/unit/code-mode-retrieve.test.ts tests/integration/response-artifact-recovery.test.ts tests/integration/mcp-output-schema-wire.test.ts

Expected: FAIL because response.get still becomes a one-step workflow and sdl.retrieve is not recognized as page-native for responseGet.

- [ ] **Step 4: Implement validated direct rematerialization**

Add this public reference without changing existing entries:

~~~ts
"sdl.response.get": { tool: "sdl.retrieve", op: "responseGet" },
~~~

Keep buildValidatedRecoveryAction as the authority for action-schema validation. Extend the internal RecoveryBuildResult with an optional validatedAction field. After the authoritative action schema parses activeArgs, construct:

~~~ts
const validatedAction = {
  action: definition.action,
  args: stableRecord(activeArgs),
};
~~~

Return that same validatedAction alongside either the direct public nextAction or the workflow fallback; invalid recovery returns neither. Keep byte bounds on the public nextAction unchanged and add no new MCP output field.

For response.get candidates only, action-reference-projection must consume validated.validatedAction, never candidate args or the workflow step:

1. Confirm validatedAction.action is response.get.
2. Take repoId from fallbackRepoId or validatedAction.args.repoId.
3. Remove repoId from child args.
4. Build { repoId, op: "responseGet", args: canonicalRecord(childArgs) }.
5. Parse that envelope with RetrieveRequestSchema.
6. Return { action: "sdl.retrieve", args: canonicalRecord(parsedEnvelope) }.

Preserve the current workflow fallback for every action without a direct Code Mode adapter.

In src/server.ts, make page-native ownership argument-aware:

~~~ts
function ownsPageNativeResponseMode(
  toolName: string,
  toolArgs: Readonly<Record<string, unknown>>,
): boolean {
  return PAGE_NATIVE_RESPONSE_MODE_TOOLS.has(toolName)
    || (toolName === "sdl.retrieve" && toolArgs.op === "responseGet");
}
~~~

Pass toolArgs from enforceProjectedResponseMode. Do not add all of sdl.retrieve to PAGE_NATIVE_RESPONSE_MODE_TOOLS.

- [ ] **Step 5: Re-run focused tests and verify GREEN**

Run the same four-file command.

Expected: PASS for exact direct nesting, repeated paging, outer auto/handle bypass, security/lifecycle errors, and output-schema validation.

- [ ] **Step 6: Commit continuation and delivery behavior**

    git add src/mcp/response-projection/types.ts src/mcp/response-projection/recovery.ts src/code-mode/action-reference-projection.ts src/server.ts tests/unit/recovery-validation.test.ts tests/unit/code-mode-retrieve.test.ts tests/integration/response-artifact-recovery.test.ts tests/integration/mcp-output-schema-wire.test.ts
    git commit -m "feat: continue stored responses through sdl.retrieve"

## Chunk 3: Public Contract and Final Verification

### Task 4: Update descriptions, documentation, and deterministic fixtures

**Files:**
- Modify: src/code-mode/descriptions.ts
- Modify: docs/feature-deep-dives/code-mode.md
- Modify: tests/integration/determinism.fixtures.json
- Regenerate: docs/generated/tool-inventory.md
- Modify: CHANGELOG.md

- [ ] **Step 1: Update the public description source**

Extend RETRIEVE_DESCRIPTION to name responseGet only as stored-response continuation. Keep the multi-step workflow guidance unchanged.

- [ ] **Step 2: Update the Code Mode deep dive**

In the sdl.retrieve section:

- Add responseGet to the bounded operation list.
- Show the direct nested continuation example.
- State that outer responseMode is ignored for responseGet because byte/page controls belong to response.get.
- Preserve the exact seven-tool exclusive list.

- [ ] **Step 3: Add deterministic fixtures**

In both compact and full determinism fixture groups, append a stable sdl.retrieve responseGet call after the existing sdl.retrieve fixture. Use a syntactically valid fixed missing handle so the deterministic typed not-found projection is exercised without timestamps or a mutable stored artifact.

Do not reorder existing fixture entries.

- [ ] **Step 4: Regenerate and verify documentation**

Run:

    npm run docs:tools:generate
    npm run docs:tools:check

Expected: PASS. The Code Mode exclusive count remains 7. Include docs/generated/tool-inventory.md only if the generator changes it.

- [ ] **Step 5: Add the changelog entry**

Under Unreleased, add one feature bullet for direct stored-response continuation through sdl.retrieve responseGet. Do not add or repair the unrelated repo.status migration marker.

- [ ] **Step 6: Commit the public contract**

    git add src/code-mode/descriptions.ts docs/feature-deep-dives/code-mode.md tests/integration/determinism.fixtures.json CHANGELOG.md
    git add docs/generated/tool-inventory.md
    git commit -m "docs: describe Code Mode response continuation"

If the generated inventory is unchanged, omit it from git add.

### Task 5: Run final verification and record the baseline exception

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run static checks**

    npm run typecheck
    npm run lint

Expected: PASS.

- [ ] **Step 2: Run focused behavior tests**

    npm run build:all
    node --experimental-strip-types --test-concurrency=1 --test tests/unit/code-mode-retrieve.test.ts tests/integration/response-artifact-recovery.test.ts tests/integration/mcp-output-schema-wire.test.ts

Expected: PASS with zero failures.

- [ ] **Step 3: Run public-contract checks**

    npm run test:golden
    npm run docs:tools:check
    node --experimental-strip-types --test-concurrency=1 --test tests/integration/determinism.test.ts

Expected: PASS with zero failures. Confirm the exact exclusive Code Mode registration assertion remains:

    sdl.action.search, sdl.info, sdl.manual, sdl.retrieve, sdl.workflow, sdl.context, sdl.file

- [ ] **Step 4: Run the broader output-contract suite**

    npm run test:tool-output-contract

Expected: no feature-related failures. The approved baseline exception may remain as the single unrelated CHANGELOG migration-marker failure; compare the failure name and message exactly.

- [ ] **Step 5: Run the full suite through SDL with a long timeout**

From the main checkout's SDL session, execute:

~~~ts
sdl.workflow({
  repoId: "sdl-mcp",
  steps: [{
    fn: "runtimeExecute",
    args: {
      runtime: "powershell",
      relativeCwd: ".worktrees/code-mode-response-continuation",
      code: "npm test\nexit $LASTEXITCODE",
      timeoutMs: 900000,
      outputMode: "digest",
      persistOutput: true,
      maxResponseLines: 200,
    },
  }],
  onError: "stop",
  onlyFinalResult: true,
});
~~~

Expected: no new failures. If the call times out, report the timeout separately from test failures and retain the runtime artifactHandle for focused runtimeQueryOutput follow-up.

- [ ] **Step 6: Verify scope and history**

    git status --short
    git diff main...HEAD --stat
    git log --oneline main..HEAD

Expected: only the files listed in this plan, no generated fixture drift, and focused commits for direct adapter, strict schema, continuation delivery, and docs.
