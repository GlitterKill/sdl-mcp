# sdl.retrieve Top-Level Tool Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact top-level Code Mode tool named `sdl.retrieve` for common read-only SDL retrieval operations without the response wrapper and planning overhead of `sdl.workflow`.

**Architecture:** `sdl.retrieve` is a thin read-only gateway over the existing action map. It maps a short `op` value to an existing gateway action, injects `repoId` and `action`, applies token-efficient defaults, validates through the existing action schema, and returns the underlying handler result directly.

**Tech Stack:** TypeScript ESM, Zod, existing SDL-MCP Code Mode gateway/action map, Node built-in test runner, generated tool inventory docs.

---

## Scope

Add a new top-level MCP tool:

```ts
sdl.retrieve({
  repoId: string,
  op:
    | "symbolSearch"
    | "symbolGetCard"
    | "sliceBuild"
    | "codeSkeleton"
    | "codeHotPath"
    | "codeNeedWindow",
  args?: Record<string, unknown>,
  responseMode?: "inline" | "auto" | "handle",
  includeDiagnostics?: boolean,
})
```

Use an `args` object instead of a large discriminated union. That keeps the advertised top-level schema small while reusing existing action-map validation for each operation.

| `sdl.retrieve` op | Existing action | Default behavior |
| --- | --- | --- |
| `symbolSearch` | `symbol.search` | Default `wireFormat: "auto"` when omitted. |
| `symbolGetCard` | `symbol.getCard` | No extra defaults beyond existing schema. |
| `sliceBuild` | `slice.build` | Default `wireFormat: "auto"`, `cardDetail: "compact"`, and no optional evidence/process/legend fields unless requested. |
| `codeSkeleton` | `code.getSkeleton` | Reuse existing schema and handler. |
| `codeHotPath` | `code.getHotPath` | Reuse existing focused identifier requirements. |
| `codeNeedWindow` | `code.needWindow` | Include it, but keep existing `reason`, `expectedLines`, and `identifiersToFind` requirements. |

## Non-Goals

- Do not add workflow chaining, `$N` references, transforms, runtime execution, edits, mutations, dry runs, or tracing.
- Do not expose `repo.status`, `runtime.execute`, `file.write`, `search.edit`, `symbol.edit`, memory, policy, or usage stats.
- Do not duplicate retrieval schemas in the top-level tool.
- Do not add a new retrieval implementation.
- Do not add automatic workflow-style ETag caching in v1. Direct callers can pass `ifNoneMatch`.

## File Map

- Create: `src/code-mode/retrieve.ts`
  - Owns `RetrieveRequestSchema`, op-to-action mapping, default normalization, dispatch, and exported helpers for tests.
- Modify: `src/code-mode/index.ts`
  - Registers `sdl.retrieve` beside `sdl.context`, `sdl.workflow`, and `sdl.file`.
- Modify: `src/code-mode/descriptions.ts`
  - Adds `RETRIEVE_DESCRIPTION` with the decision boundary between `sdl.retrieve` and `sdl.workflow`.
- Modify: `src/code-mode/action-catalog.ts`
  - Adds `sdl.retrieve` as a meta/top-level tool so `sdl.action.search` and `sdl.manual` can discover it.
- Modify: `src/code-mode/manual-generator.ts` only if the catalog change is not enough for manual output.
- Modify: `src/mcp/server-instructions.ts`
  - Prefer `sdl.retrieve` for one-hop retrieval; keep `sdl.workflow` for pipelines/runtime/transforms/mutations.
- Create: `tests/unit/code-mode-retrieve.test.ts`
  - Tests schema, op mapping, defaults, dispatch, direct response shape, and forbidden operations.
- Modify: `tests/unit/code-mode-regressions.test.ts`
  - Adds discovery/manual regression coverage if that surface is already tested there.
- Modify docs: `SDL.md`, root `AGENTS.md` if needed, and generated tool inventory docs.

---

## Chunk 1: API Contract And Failing Tests

### Task 1: Add Unit Tests For The Retrieval Gateway

**Files:**
- Create: `tests/unit/code-mode-retrieve.test.ts`

- [ ] **Step 1: Write the failing op mapping test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  handleRetrieve,
  normalizeRetrieveArgs,
  RETRIEVE_ACTION_BY_OP,
  RetrieveRequestSchema,
} from "../../dist/code-mode/retrieve.js";

describe("sdl.retrieve", () => {
  it("maps retrieval ops to existing read-only gateway actions", () => {
    assert.deepEqual(RETRIEVE_ACTION_BY_OP, {
      symbolSearch: "symbol.search",
      symbolGetCard: "symbol.getCard",
      sliceBuild: "slice.build",
      codeSkeleton: "code.getSkeleton",
      codeHotPath: "code.getHotPath",
      codeNeedWindow: "code.needWindow",
    });
  });
});
```

- [ ] **Step 2: Add compact schema tests**

```ts
it("keeps the public schema compact", () => {
  const parsed = RetrieveRequestSchema.parse({
    repoId: "repo",
    op: "symbolSearch",
    args: { query: "executeWorkflow" },
  });

  assert.equal(parsed.repoId, "repo");
  assert.equal(parsed.op, "symbolSearch");
  assert.deepEqual(parsed.args, { query: "executeWorkflow" });
});

it("rejects non-retrieval operations", () => {
  assert.throws(
    () => RetrieveRequestSchema.parse({
      repoId: "repo",
      op: "runtimeExecute",
      args: { runtime: "shell" },
    }),
    /Invalid option|invalid/i,
  );
});
```

- [ ] **Step 3: Add token-efficient default tests**

```ts
it("defaults symbolSearch to packed/auto output", () => {
  assert.deepEqual(
    normalizeRetrieveArgs("symbolSearch", { query: "foo" }, {}),
    { query: "foo", wireFormat: "auto" },
  );
});

it("defaults sliceBuild to compact auto output", () => {
  assert.deepEqual(
    normalizeRetrieveArgs("sliceBuild", { taskText: "debug foo" }, {}),
    {
      taskText: "debug foo",
      wireFormat: "auto",
      cardDetail: "compact",
      includeLegend: false,
      includeRetrievalEvidence: false,
      includeProcesses: false,
    },
  );
});

it("defaults codeNeedWindow to auto response handles without weakening justification", () => {
  assert.deepEqual(
    normalizeRetrieveArgs(
      "codeNeedWindow",
      {
        symbolId: "sym",
        reason: "Need exact branch condition.",
        expectedLines: 20,
        identifiersToFind: ["branch"],
      },
      {},
    ),
    {
      symbolId: "sym",
      reason: "Need exact branch condition.",
      expectedLines: 20,
      identifiersToFind: ["branch"],
      responseMode: "auto",
    },
  );
});
```

- [ ] **Step 4: Add dispatch and response-shape tests**

```ts
it("dispatches through the existing action map and returns the handler result directly", async () => {
  const calls: unknown[] = [];
  const actionMap = {
    "symbol.search": {
      schema: z.object({
        repoId: z.string(),
        action: z.literal("symbol.search"),
        query: z.string(),
        wireFormat: z.literal("auto"),
      }).passthrough(),
      handler: async (args: unknown) => {
        calls.push(args);
        return { results: [{ symbolId: "sym-1", name: "foo" }] };
      },
    },
  };

  const result = await handleRetrieve(
    { repoId: "repo", op: "symbolSearch", args: { query: "foo" } },
    actionMap as never,
  );

  assert.deepEqual(result, { results: [{ symbolId: "sym-1", name: "foo" }] });
  assert.deepEqual(calls, [{
    repoId: "repo",
    action: "symbol.search",
    query: "foo",
    wireFormat: "auto",
  }]);
  assert.equal(Object.hasOwn(result as object, "totalTokens"), false);
  assert.equal(Object.hasOwn(result as object, "durationMs"), false);
});
```

- [ ] **Step 5: Run the new test and verify it fails**

```bash
npm run build:all
node --experimental-strip-types --test tests/unit/code-mode-retrieve.test.ts
```

Expected: FAIL because `dist/code-mode/retrieve.js` does not exist yet.

---

## Chunk 2: Minimal Retrieval Dispatcher

### Task 2: Implement `src/code-mode/retrieve.ts`

**Files:**
- Create: `src/code-mode/retrieve.ts`

- [ ] **Step 1: Add request schema and op mapping**

```ts
import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import type { ToolContext } from "../server.js";
import type { ActionMap } from "../gateway/router.js";

export const RETRIEVE_ACTION_BY_OP = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  sliceBuild: "slice.build",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
} as const;

export const RetrieveOpSchema = z.enum([
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "codeSkeleton",
  "codeHotPath",
  "codeNeedWindow",
]);

export const RetrieveRequestSchema = z.object({
  repoId: z.string().min(1),
  op: RetrieveOpSchema,
  args: z.record(z.string(), z.unknown()).optional().default({}),
  responseMode: z.enum(["inline", "auto", "handle"]).optional(),
  includeDiagnostics: z.boolean().optional().default(false),
});
```

- [ ] **Step 2: Add default normalization**

```ts
type RetrieveOp = z.infer<typeof RetrieveOpSchema>;
type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

export function normalizeRetrieveArgs(
  op: RetrieveOp,
  args: Record<string, unknown>,
  opts: Pick<RetrieveRequest, "responseMode" | "includeDiagnostics">,
): Record<string, unknown> {
  const normalized = { ...args };

  if (op === "symbolSearch" && normalized.wireFormat === undefined) {
    normalized.wireFormat = "auto";
  }

  if (op === "sliceBuild") {
    normalized.wireFormat ??= "auto";
    normalized.cardDetail ??= "compact";
    normalized.includeLegend ??= false;
    normalized.includeRetrievalEvidence ??= false;
    normalized.includeProcesses ??= false;
  }

  if (op === "codeNeedWindow" && normalized.responseMode === undefined) {
    normalized.responseMode = opts.responseMode ?? "auto";
  }

  if (opts.includeDiagnostics) {
    normalized.includeDiagnostics = true;
  }

  return normalized;
}
```

- [ ] **Step 3: Add dispatch through the existing action map**

```ts
export async function handleRetrieve(
  rawArgs: unknown,
  actionMap: ActionMap,
  context?: ToolContext,
): Promise<unknown> {
  const request = RetrieveRequestSchema.parse(rawArgs);
  const actionName = RETRIEVE_ACTION_BY_OP[request.op];
  const action = actionMap[actionName];

  if (!action) {
    throw new ValidationError(
      `Retrieval action ${actionName} is not available in this server configuration.`,
    );
  }

  const normalizedArgs = normalizeRetrieveArgs(request.op, request.args, {
    responseMode: request.responseMode,
    includeDiagnostics: request.includeDiagnostics,
  });

  const gatewayArgs = {
    repoId: request.repoId,
    action: actionName,
    ...normalizedArgs,
  };

  const parsedArgs = action.schema.parse(gatewayArgs);
  return action.handler(parsedArgs, context);
}
```

- [ ] **Step 4: Run the focused test**

```bash
npm run build:all
node --experimental-strip-types --test tests/unit/code-mode-retrieve.test.ts
```

Expected: PASS for mapping, schema, defaulting, and dispatch tests.

---

## Chunk 3: Top-Level Tool Registration

### Task 3: Register `sdl.retrieve`

**Files:**
- Modify: `src/code-mode/descriptions.ts`
- Modify: `src/code-mode/index.ts`

- [ ] **Step 1: Add the tool description**

```ts
export const RETRIEVE_DESCRIPTION =
  "Retrieve compact SDL graph/code context in one step. Use for symbolSearch, symbolGetCard, sliceBuild, codeSkeleton, codeHotPath, and justified codeNeedWindow calls. Prefer sdl.workflow for multi-step pipelines, transforms, runtime execution, mutations, or $N result piping.";
```

- [ ] **Step 2: Import handler/schema and description**

In `src/code-mode/index.ts`:

```ts
import {
  handleRetrieve,
  RetrieveRequestSchema,
} from "./retrieve.js";
```

Also import `RETRIEVE_DESCRIPTION` from `./descriptions.js`.

- [ ] **Step 3: Register the tool next to other Code Mode top-level tools**

```ts
server.registerTool(
  "sdl.retrieve",
  RETRIEVE_DESCRIPTION,
  RetrieveRequestSchema,
  async (rawArgs: unknown, context?: ToolContext) =>
    handleRetrieve(rawArgs, actionMap, context),
);
```

- [ ] **Step 4: Add a registration test**

Use the fake-server pattern from `tests/unit/code-mode-regressions.test.ts` and assert that `registerCodeModeTools(...)` registers `sdl.retrieve`.

- [ ] **Step 5: Run focused registration tests**

```bash
npm run build:all
node --experimental-strip-types --test tests/unit/code-mode-retrieve.test.ts tests/unit/code-mode-regressions.test.ts
```

Expected: PASS.

---

## Chunk 4: Discovery, Manual, And Instructions

### Task 4: Make `sdl.retrieve` Discoverable Without Bloated Schemas

**Files:**
- Modify: `src/code-mode/action-catalog.ts`
- Modify: `src/code-mode/manual-generator.ts` only if needed
- Modify: `src/mcp/server-instructions.ts`

- [ ] **Step 1: Add retrieve to meta-tool schemas**

Import `RetrieveRequestSchema` and add it to the existing meta schema map. Match the key style used by the current top-level tools.

```ts
import { RetrieveRequestSchema } from "./retrieve.js";
```

- [ ] **Step 2: Add catalog metadata and a compact example**

Example payload:

```json
{
  "repoId": "my-repo",
  "op": "symbolSearch",
  "args": { "query": "executeWorkflow", "limit": 5 }
}
```

- [ ] **Step 3: Update server instructions**

Add this guidance:

```text
Use sdl.retrieve for single-step retrieval: symbolSearch, symbolGetCard, sliceBuild, codeSkeleton, codeHotPath, or a bounded codeNeedWindow.
Use sdl.context for task-shaped explain/debug/review/implement context.
Use sdl.workflow for multi-step pipelines, runtime execution, data transforms, batch operations, mutations, or $N result piping.
```

- [ ] **Step 4: Add discovery regression tests**

In `tests/unit/code-mode-regressions.test.ts`, assert that `generateManual()` or `handleActionSearch({ query: "retrieve" })` exposes `sdl.retrieve`, `symbolSearch`, and `codeNeedWindow`.

- [ ] **Step 5: Run focused docs/discovery tests**

```bash
npm run build:all
node --experimental-strip-types --test tests/unit/code-mode-regressions.test.ts
```

Expected: PASS.

---

## Chunk 5: Tool Inventory And User Docs

### Task 5: Update SDL Agent Workflow Documentation

**Files:**
- Modify: `SDL.md`
- Modify: `AGENTS.md` if the root workflow section lists the top-level retrieval path
- Generated docs from `npm run docs:tools:generate`

- [ ] **Step 1: Update retrieval ladder docs**

```markdown
Use `sdl.context` for task-shaped understanding.
Use `sdl.retrieve` for one-hop retrieval: `symbolSearch`, `symbolGetCard`, `sliceBuild`, `codeSkeleton`, `codeHotPath`, or a bounded `codeNeedWindow`.
Use `sdl.workflow` only when steps need result piping, transforms, runtime execution, batch operations, or mutations.
```

- [ ] **Step 2: Update root agent instructions if needed**

Change any instruction that says to batch all follow-up retrieval through `sdl.workflow` to prefer `sdl.retrieve` for one-hop retrieval. Keep `sdl.workflow` for multi-step chains.

- [ ] **Step 3: Regenerate and check tool docs**

```bash
npm run docs:tools:generate
npm run docs:tools:check
```

Expected: PASS and generated docs include `sdl.retrieve`.

---

## Chunk 6: Verification

### Task 6: Add A Response-Shape Regression

**Files:**
- Modify: `tests/unit/code-mode-retrieve.test.ts`

- [ ] **Step 1: Assert direct retrieval does not return workflow wrapper fields**

```ts
assert.equal("results" in result || "symbols" in result, true);
assert.equal(Object.hasOwn(result as object, "totalTokens"), false);
assert.equal(Object.hasOwn(result as object, "intermediateResultsSuppressed"), false);
```

- [ ] **Step 2: Run focused tests**

```bash
npm run build:all
node --experimental-strip-types --test tests/unit/code-mode-retrieve.test.ts tests/unit/code-mode-regressions.test.ts tests/unit/code-mode-workflow-executor.test.ts
```

Expected: PASS.

### Task 7: Run Full Verification

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Golden validation**

```bash
npm run test:golden
```

Expected: PASS. If snapshots intentionally change because tool inventory changed, regenerate with `npm run golden:update`, inspect the diff, then rerun `npm run test:golden`.

- [ ] **Step 4: Full test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Optional token-overhead smoke**

Compare a one-step compact workflow response with the equivalent `sdl.retrieve` call:

```json
{
  "workflow": {
    "repoId": "sdl-mcp",
    "onlyFinalResult": true,
    "detail": "compact",
    "defaultMaxResponseTokens": 1200,
    "steps": [
      {
        "fn": "symbolSearch",
        "args": { "query": "executeWorkflow", "limit": 5, "wireFormat": "auto" }
      }
    ]
  },
  "retrieve": {
    "repoId": "sdl-mcp",
    "op": "symbolSearch",
    "args": { "query": "executeWorkflow", "limit": 5 }
  }
}
```

Record only the response byte/token delta in the PR notes. Do not add this as a brittle automated test unless the repo already has a stable token-budget harness for tool payloads.

---

## Acceptance Criteria

- `sdl.retrieve` is registered as a top-level Code Mode tool.
- `sdl.retrieve` supports exactly `symbolSearch`, `symbolGetCard`, `sliceBuild`, `codeSkeleton`, `codeHotPath`, and `codeNeedWindow`.
- `codeNeedWindow` remains policy-gated and keeps existing required justification fields.
- Single-step retrieval returns the underlying handler result directly, not a workflow-shaped `{ results, totalTokens, durationMs }` envelope.
- Defaults are token-conscious: packed/auto where supported, compact slice/card output, no diagnostics unless requested, auto handles for large code windows.
- `sdl.workflow` remains the documented path for pipelines, transforms, runtime execution, mutations, and `$N` result piping.
- `sdl.action.search` and/or `sdl.manual` can discover `sdl.retrieve`.
- Tool inventory/docs are updated and pass `npm run docs:tools:check`.
- Focused tests, typecheck, lint, golden validation, and full tests pass.

## Commit Plan

- [ ] Commit 1: `test: cover sdl retrieve gateway contract`
- [ ] Commit 2: `feat: add sdl retrieve top-level tool`
- [ ] Commit 3: `docs: document sdl retrieve retrieval path`

If the implementation remains small, one commit is acceptable:

```bash
git add src/code-mode src/mcp tests/unit SDL.md AGENTS.md docs
git commit -m "feat: add compact sdl.retrieve tool"
```

## Risk Notes

- The highest-risk mistake is duplicating retrieval schemas in the top-level tool. Use `args` plus existing action-map validation instead.
- The second risk is accidentally turning `sdl.retrieve` into another workflow tool. Keep one op per call and no `$N` references.
- The third risk is weakening `codeNeedWindow` policy. Reuse the existing action schema and handler so policy behavior stays unchanged.
- If tool-schema inventory expands too much, measure advertised schema size before adding more discoverability metadata.
