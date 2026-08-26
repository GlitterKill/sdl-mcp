# Complete Release Summary Coverage Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SDL-MCP releases from publishing concise grouped summaries that fail to account for work in the complete previous-tag-to-release-tag commit range.

**Architecture:** A dependency-free release-notes module owns the canonical Git inventory, strict hidden coverage-marker parser, validation, and final body rendering. `prepare-release` invokes validation before expensive gates; the repository release skills require final-tag rendering before `gh release create --notes-file`.

**Tech Stack:** Node.js 24 ESM, Node standard library, Git CLI, `node:test`, existing SDL-MCP release scripts.

---

## Chunk 1: Validator and renderer

### Task 1: Establish assertion-level RED

**Files:**
- Create: `tests/unit/build-release-notes.test.ts`
- Create bootstrap only: `scripts/build-release-notes.mjs`
- Reference: `devdocs/superpowers/specs/2026-08-25-release-summary-coverage-design.md`

- [ ] **Step 1: Write the initial import test**

Import the wished-for exports:

```typescript
import {
  buildReleaseNotes,
  extractVersionSection,
  readReleaseInventory,
  validateReleaseNoteCoverage,
} from "../../scripts/build-release-notes.mjs";
```

- [ ] **Step 2: Run once and capture bootstrap RED**

```bash
node --experimental-strip-types --test-concurrency=1 --test tests/unit/build-release-notes.test.ts
```

Expected: FAIL because `scripts/build-release-notes.mjs` does not exist.

- [ ] **Step 3: Add skeletal exports only**

Create exports that throw `new Error("not implemented")`. Do not add parsing, Git, validation, or rendering behavior.

- [ ] **Step 4: Write behavior tests**

Use full synthetic 40-hex object IDs. Assert:

- exact version-section extraction;
- one visible summary bullet may cover multiple commits;
- the renderer emits one `## Commits since <baseTag>` appendix;
- missing, duplicate, unknown, abbreviated, include-plus-omit, malformed, orphaned, and out-of-section markers fail;
- only `merge-only` is accepted, and only for a commit with multiple parents;
- the final tagged release commit is implicitly allowed only when its sole parent equals `preReleaseTargetOid`, its subject is `chore: release v<version>`, and all changed paths are in the exact allowlist.

Create disposable repositories with `mkdtempSync`, `git init`, commits, and an annotated tag. Assert:

- refs resolve through `^{commit}`;
- a missing ref or non-ancestor base tag fails;
- shallow repositories fail;
- inventory includes merge commits;
- bounded buffer overflow fails rather than returning partial data.

- [ ] **Step 5: Run and capture assertion-level RED**

Run the focused test.

Expected: parser, inventory, renderer, and final-release-commit assertions fail with `not implemented`, proving each behavior is exercised.

### Task 2: Implement the minimum dependency-free module

**Files:**
- Modify: `scripts/build-release-notes.mjs`
- Test: `tests/unit/build-release-notes.test.ts`

- [ ] **Step 1: Implement strict section and marker parsing**

Export:

```javascript
export function extractVersionSection(markdown, version) {}
export function validateReleaseNoteCoverage(options) {}
```

Use line-based parsing only. Accept exactly:

```text
  <!-- release-note-commits: <40hex>[ <40hex>...] -->
<!-- release-note-omit: <40hex> merge-only -->
```

Bind include markers only to the immediately preceding summary bullet inside the exact version section. Reject every malformed or duplicate assignment.

- [ ] **Step 2: Implement canonical Git inventory**

Export:

```javascript
export function readReleaseInventory({ cwd, baseTag, target }) {}
```

Use `execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024 })`; never invoke a shell. Resolve `baseTag^{commit}` and `target^{commit}`, reject shallow repositories and non-ancestor ranges, and collect full object ID, parents, subject, and changed paths for every commit in `baseTag..target`.

- [ ] **Step 3: Implement final body rendering**

Export:

```javascript
export function buildReleaseNotes(options) {}
```

In build mode, read the changelog from the immutable target commit with `git show <target>^{commit}:CHANGELOG.md`, not from the working tree. Validate the grouped section, allow only the mechanically valid final release commit exception, then append exactly one deterministic commit appendix from the same inventory.

- [ ] **Step 4: Add the CLI**

Support:

```text
node scripts/build-release-notes.mjs validate --version <version> --base-tag <tag> --target <ref>
node scripts/build-release-notes.mjs build --version <version> --base-tag <tag> --target <tag> --pre-release-target <oid> --output <path>
```

Validation prints machine-readable JSON containing `preReleaseTargetOid`. Build mode writes the validated body only after every check passes.

- [ ] **Step 5: Run focused tests and capture GREEN**

Run the focused test command.

Expected: all tests pass with zero failures.

- [ ] **Step 6: Run syntax and diff checks**

```bash
git diff --check
node --check scripts/build-release-notes.mjs
```

Expected: both exit 0.

## Chunk 2: Release workflow integration and documentation

### Task 3: Gate release preparation

**Files:**
- Modify: `scripts/prepare-release.mjs`
- Test: `tests/unit/build-release-notes.test.ts`

- [ ] **Step 1: Add a failing prepare-release integration assertion**

Assert the release script imports or invokes the canonical validator before its existing expensive build/test commands and requires an explicit `--base-tag`.

- [ ] **Step 2: Run focused test and capture RED**

Expected: FAIL because `prepare-release` does not invoke coverage validation.

- [ ] **Step 3: Add the minimal integration**

Parse `--base-tag <tag>`, invoke validation with package version and `HEAD` before expensive gates, and print the returned full `preReleaseTargetOid`. Preserve every existing release check and exit-code contract.

- [ ] **Step 4: Run focused tests and capture GREEN**

Expected: all focused tests pass.

### Task 4: Synchronize required release instructions

**Files:**
- Modify: `.codex/skills/release-notes/SKILL.md`
- Modify: `.agents/skills/release-notes/SKILL.md`
- Test: `tests/unit/build-release-notes.test.ts`

- [ ] **Step 1: Add failing guidance assertions**

For each skill file independently, assert it requires:

- the complete unbounded range;
- concise grouped summaries;
- hidden coverage markers;
- no second visible commit list;
- preservation of `preReleaseTargetOid`;
- final body generation from the annotated tag;
- `gh release create --notes-file`.

Do not require unrelated bytes in the two skill files to remain identical.

- [ ] **Step 2: Run focused test and capture RED**

Expected: FAIL because current skills lack the coverage-ledger and final-tag steps.

- [ ] **Step 3: Update both skill copies**

Keep the existing categories and concise grouped-summary rules. Add the explicit ledger/build workflow. Do not expose hashes twice in rendered output.

- [ ] **Step 4: Run focused test and capture GREEN**

Expected: all focused tests pass.

## Chunk 3: Verification and handoff

### Task 5: Verify the implementation

**Files:**
- Verify all files above.

- [ ] **Step 1: Run the focused regression**

```bash
node --experimental-strip-types --test-concurrency=1 --test tests/unit/build-release-notes.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run affected release/tooling checks**

```bash
npm run typecheck
npm run lint
git diff --check
```

Expected: typecheck and diff check exit 0; lint has zero errors, with only known warnings if present.

- [ ] **Step 3: Exercise final-tag rendering in a synthetic repository**

Create a disposable tagged fixture containing grouped summaries and hidden coverage markers, then run build mode against its immutable annotated tag.

Expected: validation succeeds, grouped prose is concise, and one appendix contains every fixture commit exactly once.

- [ ] **Step 4: Verify historical inventory separately**

Call `readReleaseInventory({ cwd: process.cwd(), baseTag: "v0.13.4", target: "v0.13.5" })` from a one-line Node ESM command.

Expected: 35 commits, with no attempt to validate pre-marker historical changelog content and no external mutation.

- [ ] **Step 5: Review the final diff**

Confirm every changed line traces to full-range grouped-summary enforcement. Confirm no package, lockfile, workflow, tag, or release mutation.

- [ ] **Step 6: Commit only if explicitly authorized**

If commit authorization is confirmed, create one implementation commit separate from the approved design and plan commits. Otherwise leave the verified implementation uncommitted and report that state.
