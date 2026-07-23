# Single Session Workflow Instruction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advertise the SDL-MCP workflow exactly once in each deterministic `tools/list` catalog while preserving fallback guidance for clients without the installed workflow skill.

**Architecture:** Remove workflow guidance from the MCP initialization options because some clients copy server instructions into every imported tool. Prefix the canonical workflow text only to the first tool description while constructing the ordered `tools/list` response. Keep the transformation stateless so repeated catalog requests remain byte-identical.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@1.29.0`, Zod, Node.js `node:test`, SDL-MCP runtime and edit tools.

**Design:** [Single Session Workflow Instruction Injection](../specs/2026-07-22-single-session-workflow-instruction-design.md)

---

## File Map

- Modify `src/server.ts`: remove initialization instructions and prefix the first advertised description.
- Modify `tests/unit/server-unit.test.ts`: add a real in-memory MCP client/server regression.
- Modify `tests/integration/determinism.fixtures.json`: declare the expected workflow-copy count and catalog index.
- Modify `tests/integration/determinism.test.ts`: assert the fixture-backed catalog instruction contract.
- Modify `docs/prompt-cache-hygiene.md`: document the one-copy catalog rule and refresh behavior.
- Modify `CHANGELOG.md`: record the fix under Unreleased.
- No new production modules or dependencies.

## Chunk 1: Behavior and Regression

### Task 1: Prove the current duplication boundary

**Files:**
- Modify: `tests/unit/server-unit.test.ts:1-10,169-188`
- Test: `tests/unit/server-unit.test.ts`

- [ ] **Step 1: Add SDK test imports**

Add the external imports after the Node built-ins and import the existing package-version reader:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { getPackageVersion } from "../../dist/util/package-info.js";
```

Keep the existing `MCPServer` and `SDL_MCP_SERVER_INSTRUCTIONS` imports.

- [ ] **Step 2: Add the failing catalog regression**

Add this test to the constructor section:

```typescript
it("advertises the session workflow once in a deterministic tool catalog", async () => {
  server.registerTool("tool-a", "desc-a", z.object({}), async () => ({}));
  server.registerTool("tool-b", "desc-b", z.object({}), async () => ({}));

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.getServer().connect(serverTransport),
  ]);

  try {
    assert.strictEqual(client.getInstructions(), undefined);

    const first = await client.listTools();
    const second = await client.listTools();
    const descriptions = first.tools.map((tool) => tool.description ?? "");

    assert.strictEqual(JSON.stringify(second), JSON.stringify(first));
    assert.deepStrictEqual(Object.keys(first), ["tools"]);
    assert.deepStrictEqual(
      first.tools.map((tool) => Object.keys(tool)),
      [
        ["name", "title", "description", "inputSchema", "annotations"],
        ["name", "title", "description", "inputSchema", "annotations"],
      ],
    );
    assert.deepStrictEqual(
      first.tools.map((tool) => tool.name),
      ["tool-a", "tool-b"],
    );
    assert.strictEqual(
      descriptions[0],
      `${SDL_MCP_SERVER_INSTRUCTIONS}\n\ndesc-a [SDL-MCP v${getPackageVersion()}]`,
    );
    assert.strictEqual(
      descriptions[1],
      `desc-b [SDL-MCP v${getPackageVersion()}]`,
    );
    assert.strictEqual(
      descriptions.filter((description) =>
        description.includes(SDL_MCP_SERVER_INSTRUCTIONS),
      ).length,
      1,
    );
  } finally {
    await client.close();
  }
});
```

- [ ] **Step 3: Build the unchanged implementation**

Run:

```powershell
npm.cmd run build
```

Expected: PASS.

- [ ] **Step 4: Run the new regression and verify RED**

Run:

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/server-unit.test.ts
```

Expected: FAIL because `client.getInstructions()` still returns `SDL_MCP_SERVER_INSTRUCTIONS`.

### Task 2: Move the workflow into one catalog entry

**Files:**
- Modify: `src/server.ts:494-508,533-554`
- Test: `tests/unit/server-unit.test.ts`

- [ ] **Step 1: Remove MCP initialization instructions**

Remove this property from the `Server` options object:

```typescript
instructions: SDL_MCP_SERVER_INSTRUCTIONS,
```

Keep the capabilities object unchanged.

- [ ] **Step 2: Prefix only the first advertised description**

Change the existing map callback to receive `index`, calculate the versioned description once, and preserve the current response key order:

```typescript
tools: Array.from(this.tools.values()).map((tool, index) => {
  const description =
    tool.presentation.includeVersionInDescription === false
      ? tool.description
      : buildVersionedToolDescription(tool.description);

  return {
    name: this.formatToolNameForClient(tool.name),
    title: tool.presentation.title,
    // Some clients repeat server instructions for every tool. Keep one
    // deterministic fallback copy in the first advertised catalog entry.
    description:
      index === 0
        ? `${SDL_MCP_SERVER_INSTRUCTIONS}\n\n${description}`
        : description,
    annotations: {
      title: tool.presentation.title,
    } satisfies ToolAnnotations,
    inputSchema:
      tool.wireSchema ??
      convertSchema(tool.inputSchema, this._gatewayMode),
    ...(tool.outputSchema
      ? { outputSchema: convertSchema(tool.outputSchema, this._gatewayMode) }
      : {}),
  };
}),
```

Keep the source object order as `name`, `title`, `description`, `annotations`, `inputSchema`; this is the existing wire order. The SDK client normalizes the observable parsed object to `name`, `title`, `description`, `inputSchema`, `annotations`, which is the order asserted by the unit regression.

Do not add session state, a helper abstraction, or a new tool.

- [ ] **Step 3: Rebuild and verify GREEN**

Run the build and focused test as separate commands:

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/server-unit.test.ts
```

Expected: build passes and exactly 22/22 server unit tests pass.

- [ ] **Step 4: Commit the behavior change**

```powershell
git add src/server.ts tests/unit/server-unit.test.ts
git commit -m "fix: advertise workflow instructions once"
```

## Chunk 2: Determinism and Documentation

### Task 3: Lock the catalog instruction contract in determinism fixtures

**Files:**
- Modify: `tests/integration/determinism.fixtures.json`
- Modify: `tests/integration/determinism.test.ts:12-19,281-294`
- Test: `tests/integration/determinism.test.ts`

- [ ] **Step 1: Add catalog expectations to the fixture**

Add this top-level object after `fixtureRepo`:

```json
"toolCatalogExpectations": {
  "workflowInstructionCopies": 1,
  "workflowInstructionToolIndex": 0
},
```

- [ ] **Step 2: Assert the fixture-backed catalog contract**

Import the canonical workflow constant:

```typescript
import { SDL_MCP_SERVER_INSTRUCTIONS } from "../../dist/mcp/server-instructions.js";
```

After `const tools = await server.client.listTools();`, add:

```typescript
const workflowInstructionIndexes = tools.tools.flatMap((tool, index) =>
  tool.description?.includes(SDL_MCP_SERVER_INSTRUCTIONS) ? [index] : [],
);

assert.strictEqual(
  workflowInstructionIndexes.length,
  fixtures.toolCatalogExpectations.workflowInstructionCopies,
);
assert.strictEqual(
  workflowInstructionIndexes[0],
  fixtures.toolCatalogExpectations.workflowInstructionToolIndex,
);
```

The existing canonical comparison continues to verify full `tools/list` byte stability across repeated legs and fresh server processes.

- [ ] **Step 3: Run the determinism integration test**

Run:

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
```

Expected: PASS with one workflow copy at catalog index zero and identical catalogs across legs.

### Task 4: Document the prompt-cache contract

**Files:**
- Modify: `docs/prompt-cache-hygiene.md:13-21`
- Modify: `CHANGELOG.md:34-45`

- [ ] **Step 1: Update prompt-cache hygiene**

Add this paragraph after **Static tool surface**:

```markdown
**Single-copy session guidance.** SDL-MCP leaves MCP initialization instructions unset because clients may flatten that field into every imported tool description. The ordered `tools/list` response prefixes the canonical workflow only to its first tool description. Repeated catalog snapshots remain byte-identical; clients must replace an old snapshot when handling `listChanged` rather than append it.
```

- [ ] **Step 2: Update the Unreleased changelog**

Add this bullet under **Fixed**:

```markdown
- **Session workflow instruction duplication**: MCP initialization no longer supplies workflow text that clients can repeat across every imported tool. The deterministic tool catalog carries one fallback copy in its first advertised description.
```

- [ ] **Step 3: Run documentation checks**

Run:

```powershell
npm.cmd run docs:tools:check
```

Expected: PASS.

- [ ] **Step 4: Commit fixture and documentation changes**

```powershell
git add tests/integration/determinism.fixtures.json tests/integration/determinism.test.ts docs/prompt-cache-hygiene.md CHANGELOG.md
git commit -m "docs: record single-copy workflow guidance"
```

## Chunk 3: Verification

### Task 5: Run affected and repository gates

**Files:**
- Verify only.

- [ ] **Step 1: Run focused regression**

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/server-unit.test.ts
```

Expected: exactly 22/22 tests pass.

- [ ] **Step 2: Run static checks**

Run separately:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run docs:tools:check
```

Expected: PASS.

- [ ] **Step 3: Run the determinism integration test**

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the test scope selected from the final diff**

Use the `test-scope` skill to confirm whether any additional suite is affected. Run every selected suite and record fresh results.

- [ ] **Step 5: Inspect the final Git state**

```powershell
git diff --check
git status --short --branch
git log -3 --oneline
```

Expected: no unstaged changes, no retained `.bak` files, and the two implementation commits on `codex/single-session-workflow-instruction`.
