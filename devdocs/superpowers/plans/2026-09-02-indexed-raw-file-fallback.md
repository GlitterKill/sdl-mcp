# Indexed Raw File Fallback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit targeted, bounded `file.read` access to indexed source only when SDL has no parser-derived structured representation.

**Architecture:** Keep the decision in `handleFileRead`, the shared implementation used by both `file.read` and `sdl.file { op: "read" }`. Reuse current File rows plus `getFileParserState` as the server-owned capability signal, reuse `hasFileReadTargeting` and all existing read bounds, and add one deterministic response marker for the fallback path.

**Tech Stack:** TypeScript, Zod, LadybugDB query helpers, Node.js built-in test runner, Markdown workflow generators.

---

## Chunk 1: Shared Read Policy

### Task 1: Add the indexed-unparseable fallback

**Files:**
- Modify: `tests/integration/file-read-tool.test.ts`
- Modify: `src/mcp/tools/file-read.ts`
- Modify: `src/mcp/tools.ts`

- [ ] **Step 1: Add source fixtures and indexed-state helpers**

Extend the existing `beforeEach` in `tests/integration/file-read-tool.test.ts` with:

```typescript
const parseablePath = join(testDir, "src", "parseable.ts");
const unparseablePath = join(testDir, "src", "unparseable.mjs");

mkdirSync(dirname(parseablePath), { recursive: true });
writeFileSync(parseablePath, "export const value = 1;\n", "utf-8");
writeFileSync(unparseablePath, "export default function () {\n", "utf-8");

await ladybugDb.upsertFile(conn, {
  fileId: "parseable-file",
  repoId,
  relPath: "src/parseable.ts",
  contentHash: "parseable",
  language: "typescript",
  byteSize: 24,
  lastIndexedAt: now,
});
await ladybugDb.upsertFile(conn, {
  fileId: "unparseable-file",
  repoId,
  relPath: "src/unparseable.mjs",
  contentHash: "unparseable",
  language: "javascript",
  byteSize: 28,
  lastIndexedAt: now,
});
await ladybugDb.upsertFileParserStatesInTransaction(conn, [{
  stateId: JSON.stringify([repoId, "parseable-file"]),
  repoId,
  fileId: "parseable-file",
  engine: "typescript",
  engineContract: "typescript:1",
  adapterKey: "builtin:typescript:typescript:1",
  language: "typescript",
}]);
```

Use the test's existing database setup. Do not create a version row or symbol fixture because parser provenance is the conservative structured-retrieval capability gate.

- [ ] **Step 2: Write failing policy tests**

Add three tests:

```typescript
it("allows a bounded indexed source read when parser retrieval is unavailable", async () => {
  const response = await handleFileRead({
    repoId,
    filePath: "src/unparseable.mjs",
    maxTokens: 100,
  });
  assert.equal(response.retrievalFallback, "indexed-unparseable");
  assert.match(String(response.content), /export default/);
});

it("rejects an unbounded indexed source fallback", async () => {
  await assert.rejects(
    () => handleFileRead({ repoId, filePath: "src/unparseable.mjs" }),
    /structured retrieval is unavailable.*maxTokens|maxBytes|offset|limit|search/i,
  );
});

it("keeps parseable indexed source on structured retrieval", async () => {
  await assert.rejects(
    () => handleFileGateway({
      op: "read",
      repoId,
      filePath: "src/parseable.ts",
      maxTokens: 100,
    }),
    /Use sdl\.context.*sdl\.retrieve/i,
  );
});
```

The first direct call and third gateway call prove both public routes share the same policy.

- [ ] **Step 3: Build and run the tests to verify failure**

Run:

```bash
npm run build
node --test --test-concurrency=1 tests/integration/file-read-tool.test.ts
```

Expected: the new indexed-source tests fail because the extension-only guard still rejects both source files.

- [ ] **Step 4: Add the minimal server-owned capability check**

In `src/mcp/tools/file-read.ts`, add a small helper:

```typescript
type SourceReadDisposition =
  | "non-indexed"
  | "structured"
  | "indexed-unparseable";

async function getSourceReadDisposition(
  conn: Connection,
  repoId: string,
  filePath: string,
): Promise<SourceReadDisposition> {
  const file = (await ladybugDb.getFilesByPrefix(conn, repoId, filePath, 2))
    .find((candidate) => normalizePath(candidate.relPath) === filePath);
  if (!file) return "non-indexed";

  return await ladybugDb.getFileParserState(conn, repoId, file.fileId)
    ? "structured"
    : "indexed-unparseable";
}
```

Import the existing Ladybug `Connection` type from the same module used by neighboring DB helpers.

Replace the extension-only rejection with:

```typescript
let retrievalFallback: "indexed-unparseable" | undefined;
if (SDL_SOURCE_EXTENSIONS.has(ext)) {
  const disposition = await getSourceReadDisposition(
    conn,
    request.repoId,
    filePath,
  );
  if (disposition === "structured") {
    throw new ValidationError(
      "Indexed source has structured retrieval. Use sdl.context or sdl.retrieve.",
    );
  }
  if (
    disposition === "indexed-unparseable" &&
    !hasFileReadTargeting(request)
  ) {
    throw new ValidationError(
      "Structured retrieval is unavailable for this indexed source. Retry file.read with search, maxTokens, maxBytes, offset, or limit.",
    );
  }
  if (disposition === "indexed-unparseable") {
    retrievalFallback = disposition;
  }
}
```

Define one local `finalize` wrapper inside `handleFileRead` that adds
`retrievalFallback` before calling `finalizeFileReadResponse`, then route the
existing returns through it. Do not duplicate the marker at each response
construction site.

- [ ] **Step 5: Extend the response schema**

Add this optional field to `FileReadInlineResponseSchema` in
`src/mcp/tools.ts`, preserving key order:

```typescript
retrievalFallback: z.literal("indexed-unparseable").optional(),
```

Change the `filePath` request description from "Only non-indexed file types
allowed" to "Non-indexed files, or bounded indexed source when structured
retrieval is unavailable."

- [ ] **Step 6: Rebuild and run the focused test**

Run:

```bash
npm run build
node --test --test-concurrency=1 tests/integration/file-read-tool.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit the shared policy**

```bash
git add src/mcp/tools/file-read.ts src/mcp/tools.ts tests/integration/file-read-tool.test.ts
git commit -m "fix: allow bounded raw fallback for unparseable source"
```

## Chunk 2: Public Guidance

### Task 2: Update server and tool descriptions

**Files:**
- Modify: `src/code-mode/descriptions.ts`
- Modify: `src/mcp/server-instructions.ts`
- Modify: `src/cli/commands/init.ts`
- Modify: `tests/unit/agent-workflow-sync.test.ts`
- Modify if required by validation: `tests/integration/determinism.fixtures.json`

- [ ] **Step 1: Add a failing workflow contract test**

In `tests/unit/agent-workflow-sync.test.ts`, add a test that checks these
canonical runtime surfaces:

```typescript
const workflowSurfaces = [
  "templates/SDL.md",
  "SDL.md",
  "tests/stress/fixtures/SDL.md",
  "templates/sdl-mcp-agent-workflow/SKILL.md",
  "src/mcp/server-instructions.ts",
  "src/cli/commands/init.ts",
];

for (const relativePath of workflowSurfaces) {
  const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
  assert.match(content, /structured retrieval is unavailable/i, relativePath);
  assert.match(content, /targeted, bounded[\s\S]{0,120}(?:sdl\.file|file\.read)/i, relativePath);
}
```

- [ ] **Step 2: Run the contract test to verify failure**

Run:

```bash
npm run build
node --test --test-concurrency=1 tests/unit/agent-workflow-sync.test.ts
```

Expected: FAIL because the current guidance says never to read indexed source.

- [ ] **Step 3: Update canonical source guidance**

Apply this rule consistently:

```text
Use structured SDL retrieval for indexed source. When SDL reports that
structured retrieval is unavailable, use a targeted, bounded
sdl.file { op: "read" } fallback. Do not retry broad raw reads or use
runtimeExecute to inspect files.
```

Update:

- `FILE_GATEWAY_DESCRIPTION` in `src/code-mode/descriptions.ts`.
- Rules 7 and 8 in `src/mcp/server-instructions.ts`.
- `RUNTIME_REPOSITORY_TOOLING_GUIDANCE`, `INDEXED_READ_REASON`, and
  `NON_INDEXED_READ_REASON` in `src/cli/commands/init.ts`.

Do not change runtime inspection policy. It must continue blocking shell-based
file inspection.

- [ ] **Step 4: Validate schema and determinism coverage**

Run:

```bash
npm run build
node --test --test-concurrency=1 tests/unit/agent-workflow-sync.test.ts tests/unit/server-unit.test.ts
node --test --test-concurrency=1 tests/integration/determinism.test.ts
```

If the determinism inventory reports the changed `sdl.file.read` surface is
uncovered, add one bounded unparseable-source fixture to
`tests/integration/determinism.fixtures.json`. Do not change fixtures
speculatively when the existing compact/full entries satisfy the inventory.

- [ ] **Step 5: Commit public source guidance**

```bash
git add src/code-mode/descriptions.ts src/mcp/server-instructions.ts src/cli/commands/init.ts tests/unit/agent-workflow-sync.test.ts tests/integration/determinism.fixtures.json
git commit -m "docs: route unparseable source through bounded file reads"
```

Omit the fixture path from `git add` if it did not change.

## Chunk 3: Generated Workflows

### Task 3: Synchronize templates and generated files

**Files:**
- Modify: `templates/SDL.md`
- Modify: `templates/AGENTS.md.template`
- Modify: `templates/CLAUDE.md.template`
- Modify: `templates/CODEX.md.template`
- Modify: `templates/GEMINI.md.template`
- Modify: `templates/OPENCODE.md.template`
- Modify: `templates/sdl-mcp-agent-workflow/SKILL.md`
- Modify: `docs/agent-workflows.md`
- Regenerate: `SDL.md`, `AGENTS.md`, `CLAUDE.md`, `CODEX.md`,
  `GEMINI.md`, `OPENCODE.md`, `tests/stress/fixtures/SDL.md`, and agent
  instruction assets produced by `scripts/check-agent-workflows.mjs`
- Update after repository verification:
  `C:\Users\glitt\.codex\skills\sdl-mcp-agent-workflow\SKILL.md`

- [ ] **Step 1: Replace absolute prohibition language in canonical templates**

Preserve structured retrieval as the default. Replace only statements that say
`file.read` is never allowed for indexed source. Keep `codeNeedWindow` as the
last structured-retrieval rung and keep native file reads blocked.

- [ ] **Step 2: Update public workflow documentation**

In `docs/agent-workflows.md`, document `sdl.file.read` as a non-indexed
reader plus a targeted, bounded fallback for indexed files without structured
retrieval. Update the "Do not" section to prohibit broad raw reads, not the
approved fallback.

- [ ] **Step 3: Regenerate repository-owned workflow copies**

Run:

```bash
npm run docs:workflows:write
npm run docs:workflows:check
```

Expected: both commands exit 0. Review the generated diff and preserve any
user-maintained sections not owned by the generator.

- [ ] **Step 4: Run workflow synchronization tests**

Run:

```bash
npm run build
node --test --test-concurrency=1 tests/unit/agent-workflow-sync.test.ts tests/unit/init-enforcement.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit synchronized workflows**

```bash
git add templates/SDL.md templates/AGENTS.md.template templates/CLAUDE.md.template templates/CODEX.md.template templates/GEMINI.md.template templates/OPENCODE.md.template templates/sdl-mcp-agent-workflow/SKILL.md docs/agent-workflows.md SDL.md AGENTS.md CLAUDE.md CODEX.md GEMINI.md OPENCODE.md tests/stress/fixtures/SDL.md .codex/agents/explore-sdl.toml .claude/agents/explore-sdl.md
git commit -m "docs: synchronize bounded file-read fallback guidance"
```

- [ ] **Step 6: Update the installed workflow skill**

After all repository checks pass, apply the same rule to
`C:\Users\glitt\.codex\skills\sdl-mcp-agent-workflow\SKILL.md`. This is an
installed generated copy outside the repository and requires the filesystem
approval boundary. Verify the exact old sentence before replacing it.

## Chunk 4: Verification

### Task 4: Verify behavior and repository hygiene

**Files:**
- Verify only

- [ ] **Step 1: Run focused behavior and documentation checks**

```bash
npm run build
node --test --test-concurrency=1 tests/integration/file-read-tool.test.ts tests/unit/agent-workflow-sync.test.ts tests/unit/server-unit.test.ts tests/unit/init-enforcement.test.ts
npm run docs:tools:check
```

Expected: all checks pass.

- [ ] **Step 2: Run static checks**

```bash
npm run typecheck
npm run lint
git diff --check
```

Expected: zero errors. Existing unrelated warnings may remain.

- [ ] **Step 3: Verify the original behavior directly**

Against the test repository:

1. A bounded `sdl.file { op: "read" }` call for an indexed source file without
   parser state succeeds and returns
   `retrievalFallback: "indexed-unparseable"`.
2. The same call without targeting fails with bounded retry guidance.
3. A bounded call for indexed source with parser state remains denied.
4. A normal non-indexed read has no fallback marker.

- [ ] **Step 4: Confirm unrelated responsiveness changes remain intact**

Run `git status --short` and confirm the pre-existing edits in
`src/indexer/indexer.ts`, `src/retrieval/health.ts`,
`tests/unit/derived-refresh-queue.test.ts`, and
`tests/unit/retrieval-coverage-cache.test.ts` were neither reverted nor folded
into the file-read commits.
