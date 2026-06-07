# C++ Provider-First Call-Proof Correctness Implementation Plan

> **For agentic workers:** REQUIRED: Use `sdl-mcp-agent-workflow` before repository work. Use `subagent-driven-development` if subagents are available, or `executing-plans` if work stays in one session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make C++ SCIP provider-first call proof accurate enough to distinguish real LLVM-scale provider/source drift from normal C++ spelling differences, while keeping shadow activation blocked until graph-derived readiness is genuinely safe.

**Architecture:** Keep provider-first coverage strict by default, then add a bounded C++ source-token proof path that runs only after the existing exact source-text comparison fails. The proof path should accept only invocation-shaped references whose local source window and normalized SCIP symbol candidates agree on the callable token, and it should emit precise diagnostics for every unresolved case.

**Tech Stack:** TypeScript 5.9, Node.js built-in test runner, SCIP/scip-clang `cxx` symbols, provider-first normalizer/materializer, LadybugDB shadow activation, SDL-MCP CLI.

---

## Context

The current LLVM result is a partial provider-first index, not a complete semantic index. The existing gate is doing the right thing by keeping graph-derived readiness dirty and skipping shadow activation when provider-primary files have call-proof gaps.

Prior validation established two important boundaries:

- The LLVM `index.scip` / `cpp.scip` artifacts can validate structurally cleanly, so the primary correctness work belongs in SDL-MCP provider-first normalization and proof, not in `scip-io` structural validation.
- The earlier duplicate-symbol failure was downstream identity/normalization logic, not proof that `scip-clang` output is globally corrupt.

The current proof path in `src/indexer/provider-first/scip-normalizer.ts` mostly compares expected symbol text to the exact source substring at the SCIP occurrence range, then requires invocation syntax. That is safe, but C++ makes the source substring/range shape noisy at scale:

- Qualified calls can expose `llvm::foo`, `Namespace::Class::method`, `obj.method`, `ptr->method`, or only one token inside those chains.
- Template and overload syntax can put `<...>`, `(...)`, hashes, operator names, destructors, and constructors around the bare callable name.
- Macros and location-only descriptors already need special handling.
- Multi-line member chains and formatted template calls can put the invocation suffix outside the single retained line.
- Large files and occurrence-retention caps can hide diagnostic samples unless source loading records why proof was unavailable.

Do not solve this by globally relaxing expected/actual comparison. That would make false exact call edges look valid and could activate a shadow graph with incorrect edges. The disproportionate leverage is a small, language-scoped proof module with strong diagnostics, because it can reduce LLVM false negatives without weakening TypeScript/Python/Rust behavior.

## Recommended Approach

Use **Option B: C++ token-window proof after strict mismatch**.

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| A. Keep exact range comparison and add a few string exceptions | Lowest implementation risk; preserves current strictness | Does not explain LLVM-scale mismatches; exceptions will grow ad hoc | Reject as insufficient |
| B. Add C++ token-window proof after strict mismatch | High leverage; bounded to C++/clang schemes; can classify failures; avoids global relaxation | Needs careful tests for false positives and multi-line windows | Recommended |
| C. Use tree-sitter/AST proof for every unresolved C++ call | Stronger syntactic proof for hard cases | Higher runtime and dependency cost during provider-first normalization; more complex failure handling | Defer unless B leaves important gaps |

## File Map

- Create: `src/indexer/provider-first/source-call-proof.ts`
  - Owns reusable source occurrence proof types plus the default exact-text proof.
  - Exports `proveSourceOccurrenceCall(...)`, `hasInvocationSuffix(...)`, and diagnostic helpers currently embedded in `scip-normalizer.ts`.
- Create: `src/indexer/provider-first/cpp-call-proof.ts`
  - Owns C++/clang-specific token-window proof.
  - Handles `scip-clang` and `cxx` schemes only.
  - Accepts qualifiers, member access, templates, constructors/destructors, operator names, and location-only macros only when invocation syntax is proven.
- Modify: `src/indexer/provider-first/scip-normalizer.ts`
  - Delegate proof work to the new modules.
  - Keep coverage accounting and edge creation behavior in place.
  - Preserve current neutral handling of readable non-call references.
- Modify: `src/indexer/provider-first/executor.ts`
  - Expand retained source lines for C++ reference occurrences by a small bounded radius so multi-line invocation proof has enough local text.
  - Preserve max-file-byte and source-unavailable reason reporting.
- Modify: `src/indexer/provider-first/types.ts`
  - Add reason codes only if they improve operator diagnostics. Prefer existing `symbolTextMismatch`, `multiLineRange`, `rangeOutOfBounds`, `sourceTooLarge`, and `sourceUnavailable` unless the current codes lose actionable detail.
- Modify: `src/scip/kind-mapping.ts`
  - Extend `normalizeClangDescriptors(...)` only for descriptor forms needed by proof candidate generation, such as template specialization or operator/destructor names.
- Modify: `src/scip/symbol-matcher.ts`
  - Keep name extraction aligned with any descriptor normalization change.
- Modify: `tests/unit/provider-first-indexing.test.ts`
  - Add C++ call-proof positive and negative cases.
- Modify: `tests/unit/scip-clang-tuning.test.ts`
  - Add descriptor normalization/name extraction cases for C++ templates, operators, constructors, destructors, and `cxx` scheme forms.
- Modify: `tests/unit/provider-first-cli-output.test.ts`
  - Add grouped diagnostic output cases if new reason codes or samples are introduced.
- Modify: `docs/feature-deep-dives/provider-first-indexing.md`
  - Document C++ call-proof rules, known unsupported shapes, and why shadow activation remains blocked until proof is complete.
- Modify: `CHANGELOG.md`
  - Add a correctness entry once implementation is complete.

## Chunk 1: Baseline And Failing Tests

### Task 1: Capture Current LLVM Failure Shape

**Files:**
- Create: `devdocs/validation/llvm-cpp-provider-first-call-proof.md`

- [ ] **Step 1: Build current sources**

Run:

```bash
npm run build
```

Expected: build succeeds. If the worktree has unrelated build failures, record them in the validation doc before continuing.

- [ ] **Step 2: Validate the LLVM SCIP artifact before blaming normalization**

Run, adjusting only the artifact path if the local LLVM checkout moved:

```bash
scip-io validate --format json F:\Claude\projects\llvm-project\index.scip
```

Expected: JSON reports `valid: true`. Record `documents`, `symbols`, `occurrences`, and `languages`.

- [ ] **Step 3: Run provider-first indexing with diagnostics**

Run with the exact project config used for the prior LLVM validation:

```bash
node dist/cli/index.js index --repo-id llvm-project --diagnostics
```

Expected: output includes `Provider-first coverage`, `Provider-first call-proof diagnostics`, `Semantic readiness: deferred`, and either `Provider-first shadow staging skipped` or `Provider-first shadow DB activation skipped`.

- [ ] **Step 4: Record the failure distribution**

In `devdocs/validation/llvm-cpp-provider-first-call-proof.md`, record:

```markdown
# LLVM C++ Provider-First Call-Proof Baseline

## Artifact
- Path:
- scip-io valid:
- Documents:
- Symbols:
- Occurrences:
- Languages:

## SDL-MCP Runtime
- Command:
- Package version:
- Node version:
- Module path:

## Provider-First Result
- Provider-primary files:
- Full provider coverage:
- Partial provider coverage:
- Call-proof incomplete files:
- Top reason codes:
- Sample expected/actual mismatches:
- Shadow activation status:

## Initial Hypotheses
- Qualified/member-call range mismatch:
- Template/operator spelling mismatch:
- Multi-line invocation window:
- Source loader limit:
```

Expected: the document explains the current blocked state before code changes.

### Task 2: Add C++ Proof Tests That Fail Today

**Files:**
- Modify: `tests/unit/provider-first-indexing.test.ts`

- [ ] **Step 1: Add a `provider-first C++ call proof` describe block**

Add tests using `normalizeScipProviderFacts(...)` with inline C++ source and minimal SCIP documents. Include these cases:

```typescript
it("proves a cxx qualified free function call when the range covers the bare name", () => {});
it("proves a cxx namespace-qualified call when the range starts at the qualifier", () => {});
it("proves a cxx member call through dot and arrow access", () => {});
it("proves a cxx template function call with explicit template arguments", () => {});
it("keeps a cxx readable non-call mismatch neutral", () => {});
it("keeps a cxx invocation-shaped mismatch incomplete when the callable token differs", () => {});
it("records a bounded diagnostic when a cxx multi-line invocation needs more source context", () => {});
```

Expected assertions for positive call cases:

```typescript
assert.equal(facts.edges.some((edge) => edge.edgeType === "call"), true);
assert.equal(facts.coverage[0]?.callProofCoverage, "full");
assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
```

Expected assertions for false-positive guards:

```typescript
assert.equal(facts.edges.some((edge) => edge.edgeType === "call"), false);
assert.equal(facts.coverage[0]?.callProofCoverage, "none");
assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
  { code: "symbolTextMismatch", references: 1 },
]);
```

- [ ] **Step 2: Run only the new tests and verify they fail for the right reason**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "provider-first C++ call proof"
```

Expected: positive C++ proof tests fail because no call edge is emitted or coverage remains incomplete. Negative guard tests should pass or fail only if the new setup is wrong.

### Task 3: Add Descriptor Normalization Tests

**Files:**
- Modify: `tests/unit/scip-clang-tuning.test.ts`

- [ ] **Step 1: Add failing descriptor tests**

Add cases for:

```typescript
normalizeClangDescriptors("llvm/SmallVector<int>#push_back(const T&).");
normalizeClangDescriptors("llvm/isa<T>(const U&).");
normalizeClangDescriptors("llvm/Foo#~Foo().");
normalizeClangDescriptors("llvm/Foo#Foo().");
normalizeClangDescriptors("llvm/Optional#operator bool().");
```

Expected: normalization keeps enough identity for kind/name extraction while stripping parameter and overload noise.

- [ ] **Step 2: Verify focused failures**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/scip-clang-tuning.test.ts --test-name-pattern "scip-clang tuning"
```

Expected: new cases fail where current normalization does not produce source-text candidates that C++ proof can use.

## Chunk 2: Extract Existing Proof Logic Without Behavior Change

### Task 4: Move Generic Proof Helpers

**Files:**
- Create: `src/indexer/provider-first/source-call-proof.ts`
- Modify: `src/indexer/provider-first/scip-normalizer.ts`

- [ ] **Step 1: Move helper functions**

Move these functions out of `scip-normalizer.ts` without changing logic:

```typescript
sourceLineMatchForOccurrence
hasInvocationSuffix
hasInvocationCandidateAfterMismatch
isIdentifierContinue
expandIdentifierText
truncateCallProofSampleText
```

Export a single generic entry point:

```typescript
export function proveSourceOccurrenceCall(params: SourceCallProofParams): SourceCallProofResult {
  // First run exact source-text proof. Language-specific proof hooks run later.
}
```

- [ ] **Step 2: Keep old tests green before adding C++ behavior**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "call-proof|source loader|multi-line SCIP ranges"
```

Expected: existing call-proof tests still pass, including invocation-shaped mismatch and readable non-call mismatch cases.

- [ ] **Step 3: Commit the no-behavior extraction**

Run:

```bash
git add src/indexer/provider-first/source-call-proof.ts src/indexer/provider-first/scip-normalizer.ts
git commit -m "refactor: isolate provider source call proof"
```

Expected: commit contains only the mechanical extraction.

## Chunk 3: Implement C++ Token-Window Proof

### Task 5: Add C++-Specific Proof Module

**Files:**
- Create: `src/indexer/provider-first/cpp-call-proof.ts`
- Modify: `src/indexer/provider-first/source-call-proof.ts`
- Modify: `src/indexer/provider-first/scip-normalizer.ts`

- [ ] **Step 1: Define the C++ proof contract**

Add types:

```typescript
export interface CppCallProofInput {
  providerSymbolId: string;
  expectedNames: readonly string[];
  lineWindow: readonly SourceLine[];
  range: ScipRange;
}

export type CppCallProofResult =
  | { matched: true; line: string; invocationEndLine: number }
  | { matched: false; reason: CallProofUnavailableReasonCode; actualText?: string; callCandidate?: boolean };
```

- [ ] **Step 2: Tokenize only the local C++ source window**

Implement a small scanner that recognizes:

- identifiers and `::`
- `.`, `->`, and `->*`
- `<...>` template argument spans with nesting
- `operator` spellings such as `operator bool`
- destructor spelling such as `~Foo`
- invocation suffix `(` after optional whitespace/template args

Do not parse full C++. The scanner is only a proof filter around the provider occurrence range.

- [ ] **Step 3: Match expected names against callable tokens**

Accept when:

- the callable token equals one of `sourceTextCandidatesForScipSymbol(...)`
- the token is the terminal member in a qualified/member chain
- the token is followed by invocation syntax in the local window
- the occurrence range intersects the callable token, qualifier chain, or template argument span for that call

Reject when:

- the source token differs from all expected candidates
- invocation syntax is absent
- the proof would require crossing outside the retained local window
- the reference is a field/property read rather than a call

- [ ] **Step 4: Preserve the current exact proof fast path**

In `proveSourceOccurrenceCall(...)`, run generic exact proof first. Invoke C++ proof only when:

```typescript
isClangStyleSymbolScheme(parseScipSymbol(occurrence.symbol).scheme) &&
genericResult.matched === false &&
genericResult.reason === "symbolTextMismatch"
```

Expected: non-C++ behavior is unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "provider-first C++ call proof|invocation-shaped symbol-text mismatches|readable non-call"
```

Expected: new positive C++ cases pass; existing false-positive guard tests still pass.

### Task 6: Extend Descriptor Candidate Generation

**Files:**
- Modify: `src/scip/kind-mapping.ts`
- Modify: `src/scip/symbol-matcher.ts`
- Modify: `src/indexer/provider-first/scip-normalizer.ts`
- Modify: `tests/unit/scip-clang-tuning.test.ts`

- [ ] **Step 1: Normalize C++ descriptor noise needed for source proof**

Extend `normalizeClangDescriptors(...)` only for descriptor shapes captured by tests. Keep it idempotent.

- [ ] **Step 2: Generate source candidates for constructors/destructors/operators**

Extend `sourceTextCandidatesForScipSymbol(...)` so C++ symbols can produce candidates such as:

```typescript
["Foo", "~Foo", "operator bool", "operator"]
```

Use the narrowest candidate that matches source syntax. Do not accept `operator` alone unless the local source token window proves the complete operator spelling and invocation.

- [ ] **Step 3: Run descriptor tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/scip-clang-tuning.test.ts
```

Expected: descriptor tests pass and existing non-clang cases remain unchanged.

## Chunk 4: Improve Source Windows And Diagnostics

### Task 7: Retain Bounded C++ Source Windows

**Files:**
- Modify: `src/indexer/provider-first/executor.ts`
- Modify: `src/indexer/provider-first/source-call-proof.ts`
- Modify: `tests/unit/provider-first-indexing.test.ts`

- [ ] **Step 1: Expand needed lines for C++ references**

In `collectNeededSourceLines(...)`, when a document language is C++ or a symbol scheme is `cxx`/`scip-clang`, retain a bounded window around reference occurrences:

```typescript
const CPP_CALL_PROOF_LINE_WINDOW_RADIUS = 2;
```

Keep the existing max-file-byte gate. Do not read whole files into retained facts for large provider-first runs.

- [ ] **Step 2: Add tests for multi-line calls**

Cover:

```cpp
llvm::cast<
  Foo
>(value);

object
  .method();

ptr
  ->method();
```

Expected: calls are proven only when the bounded window contains both callable token and invocation suffix. If not, diagnostics should explain the source window limit rather than recording a generic mismatch.

- [ ] **Step 3: Run source-loader tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "source loader|multi-line|provider-first C++ call proof"
```

Expected: source-too-large and source-read-failed cases still report their existing reason codes.

### Task 8: Make Diagnostics Actionable

**Files:**
- Modify: `src/indexer/provider-first/types.ts`
- Modify: `src/indexer/provider-first/scip-normalizer.ts`
- Modify: `src/cli/commands/index.ts`
- Modify: `tests/unit/provider-first-cli-output.test.ts`

- [ ] **Step 1: Decide whether new reason codes are necessary**

Prefer existing codes unless the LLVM baseline shows too many distinct root causes collapsed under `symbolTextMismatch`.

If new codes are justified, add only these:

```typescript
"cppCallableTokenMismatch"
"cppInvocationOutsideRetainedWindow"
"cppUnsupportedOperatorSpelling"
```

- [ ] **Step 2: Preserve bounded expected/actual samples**

Keep sample text bounded by `CALL_PROOF_SAMPLE_TEXT_LIMIT`. Include the source path and range, not full source windows.

- [ ] **Step 3: Run CLI output tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-cli-output.test.ts --test-name-pattern "call-proof diagnostics"
```

Expected: CLI groups C++ call-proof diagnostics by reason and shows bounded samples.

## Chunk 5: Shadow Readiness And LLVM Validation

### Task 9: Keep Activation Gated On Complete Call Proof

**Files:**
- Modify only if needed: `src/indexer/provider-first/shadow-activation.ts`
- Modify only if needed: `tests/unit/provider-first-indexing.test.ts`

- [ ] **Step 1: Verify the current readiness gate still blocks incomplete proof**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "shadow activation|call-proof"
```

Expected: activation remains skipped whenever graph-derived state is not ready or finalized shadow graph parity is incomplete.

- [ ] **Step 2: Add a regression test only if the proof changes readiness calculation**

If call-proof result plumbing changes, add a test proving:

```typescript
assert.equal(activation.status, "skipped");
assert.match(activation.reasons.join(" "), /graph-derived state is not ready/);
```

Expected: C++ proof improvements cannot bypass the readiness gate.

### Task 10: Re-run LLVM And Compare

**Files:**
- Modify: `devdocs/validation/llvm-cpp-provider-first-call-proof.md`

- [ ] **Step 1: Run provider-first indexing again**

Run:

```bash
npm run build
node dist/cli/index.js index --repo-id llvm-project --diagnostics
```

Expected: output includes the same runtime identity lines as baseline. If a long-lived HTTP server delegates indexing, record the server runtime too.

- [ ] **Step 2: Compare proof distribution**

Update the validation document with:

```markdown
## Post-Fix Result
- Provider-primary files:
- Call-proof incomplete files:
- Top reason codes before:
- Top reason codes after:
- Call edges emitted:
- Shadow staging/finalization status:
- Shadow activation status:
```

Expected:

- True-positive C++ call proof improves.
- False-positive guard tests stay green.
- Shadow activation occurs only if call-proof coverage is complete and finalized shadow parity is valid.
- If remaining gaps exist, activation stays skipped and diagnostics identify the next exact C++ shape to tune.

## Chunk 6: Documentation And Final Verification

### Task 11: Update User-Facing Documentation

**Files:**
- Modify: `docs/feature-deep-dives/provider-first-indexing.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the C++ proof rule**

Add a short paragraph explaining:

- exact source-text proof still runs first
- C++ token-window proof is scoped to `scip-clang` / `cxx`
- qualified/member/template calls can be accepted when the local source window proves invocation syntax
- unresolved or source-unavailable cases remain neutral facts and keep graph-derived readiness dirty

- [ ] **Step 2: Update changelog**

Add an entry under the next unreleased section:

```markdown
- Improved C++ provider-first call proof for scip-clang/cxx references while preserving shadow activation gating when proof is incomplete.
```

### Task 12: Run Focused Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/unit/scip-clang-tuning.test.ts
node --experimental-strip-types --test tests/unit/provider-first-indexing.test.ts --test-name-pattern "provider-first C++ call proof|call-proof|shadow activation|source loader|multi-line SCIP ranges"
node --experimental-strip-types --test tests/unit/provider-first-cli-output.test.ts --test-name-pattern "call-proof diagnostics|Provider-first coverage"
```

Expected: all focused tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run docs checks if generated surfaces changed**

Run only if config/tool/schema surfaces changed:

```bash
npm run docs:tools:check
npm run check:config-sync
npm run check:schema-sync
```

Expected: no generated-doc drift.

- [ ] **Step 4: Commit final work**

Run:

```bash
git add src/indexer/provider-first src/scip tests/unit docs/feature-deep-dives/provider-first-indexing.md CHANGELOG.md devdocs/validation/llvm-cpp-provider-first-call-proof.md
git commit -m "fix: tune C++ provider-first call proof"
```

Expected: commit includes source, tests, docs, and the LLVM validation note.

## Acceptance Criteria

- Existing readable non-call mismatch behavior remains neutral.
- Existing invocation-shaped mismatch behavior remains incomplete unless C++ token-window proof validates the actual callable token.
- `scip-clang` and `cxx` schemes share descriptor/candidate behavior.
- C++ qualified, member, template, macro, constructor, destructor, and operator call cases are covered by tests or documented as unsupported diagnostics.
- LLVM provider-first diagnostics show fewer false call-proof gaps, or remaining gaps are classified well enough to drive the next tuning pass.
- Shadow activation remains skipped unless call-proof coverage is complete, graph-derived state is ready, finalized shadow rows match active rows, and activation handoff succeeds.

## Follow-Up If Option B Is Not Enough

If the post-fix LLVM run still has a large number of C++ proof gaps with source available and invocation-shaped samples, do not add more string exceptions. Add a second plan for **Option C: targeted C++ AST proof fallback** that uses tree-sitter only for unresolved C++ references in sampled files and measures added normalization time before enabling it broadly.
