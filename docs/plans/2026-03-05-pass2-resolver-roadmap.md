# Pass2 Resolver, Confidence Metadata, and Multi-Language Import Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the TS/JS-only pass2 pipeline with a resolver framework, bump the graph schema version, persist confidence and provenance on `CALLS` edges, ship a Go pass2 resolver first, add shared import-resolution adapters for Java/Kotlin, Rust, and PHP, and expose confidence-aware filtering through MCP slice and query APIs.

**Architecture:** Introduce a resolver registry that owns pass2 capability by language and file type. Keep pass1 extraction as the source of symbols/imports/basic calls, then let pass2 resolvers upgrade unresolved or low-confidence calls using shared resolver context and language-specific import adapters. Bump the graph schema version up front so `CALLS` edges and graph capability checks can evolve cleanly, then persist confidence and provenance so MCP tools can filter, rank, and explain graph results without treating heuristic edges as equivalent to compiler-backed edges.

**Tech Stack:** TypeScript, Node.js, KuzuDB, existing TS compiler-backed resolver, tree-sitter/native indexer, Zod, node test runner with `tsx`.

---

## Working Assumptions

- Preserve current TS pass2 behavior as the correctness baseline.
- Add confidence metadata without breaking current clients; confidence filtering is opt-in first.
- Avoid fuzzy global matching in pass2 unless it is explicitly marked low confidence.
- Bump the graph schema version as part of this roadmap and require reindex for upgraded graphs instead of building an in-place migration for relationship property changes.
- Keep resolver logic inside the indexer layer; the DB layer only stores and queries edge metadata.

## Data Model Decisions

- Extend `CALLS` edges with:
  - `confidence: DOUBLE`
  - `resolutionReason: STRING`
  - `resolverId: STRING`
  - `resolutionPhase: STRING`
- Normalize `resolutionReason` values to a closed set:
  - `same-file`
  - `same-package`
  - `import-alias`
  - `module-qualified`
  - `receiver-type`
  - `reexport`
  - `barrel-export`
  - `global-fallback`
  - `compiler-semantic`
  - `unresolved-promoted`
- Normalize `resolverId` values to a closed set:
  - `pass1-generic`
  - `pass2-ts`
  - `pass2-go`
  - future language resolvers as added
- Clamp `confidence` to `[0, 1]`.
- Treat `confidence >= 0.9` as semantic/high-trust, `0.6-0.89` as import-backed, and `< 0.6` as heuristic.

## Graph Schema Versioning Decisions

- Increase `KUZU_SCHEMA_VERSION` in `src/db/kuzu-schema.ts` as part of Task 3.
- Treat the version bump as the contract boundary for:
  - `CALLS` edge metadata
  - future resolver capability discovery
  - stricter graph-health checks in CLI and MCP diagnostics
- Update all hard-coded schema-version expectations, including health/doctor checks and schema tests, in the same change.
- Prefer a clean reindex path over compatibility shims. Older graphs remain readable only by older builds unless a dedicated migration is written later.
- Use this bump to audit other edge/property defaults so the graph contract is more explicit before more language resolvers land.

## Task 1: Introduce the pass2 resolver interface and registry

**Files:**
- Create: `src/indexer/pass2/types.ts`
- Create: `src/indexer/pass2/registry.ts`
- Create: `src/indexer/pass2/context.ts`
- Modify: `src/indexer/indexer.ts`
- Modify: `src/indexer/edge-builder/telemetry.ts`
- Test: `tests/unit/pass2-registry.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- the registry returns the TS resolver for `.ts`, `.tsx`, `.js`, `.jsx`
- the registry returns no resolver for unsupported languages
- `indexRepo` stops hard-coding TS/JS file extensions and instead asks the registry whether pass2 is supported

Suggested test skeleton:

```ts
test('registry selects resolver by language and path', () => {
  const registry = createPass2ResolverRegistry([new FakeResolver('ts')]);
  expect(registry.getResolver({ language: 'typescript', path: 'src/a.ts' })?.id).toBe('ts');
  expect(registry.getResolver({ language: 'python', path: 'src/a.py' })).toBeUndefined();
});
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
node --import tsx --test tests/unit/pass2-registry.test.ts
```

Expected: FAIL because the registry and resolver types do not exist.

**Step 3: Add the resolver contracts**

Create `src/indexer/pass2/types.ts` with:

```ts
export interface Pass2Target {
  repoId: string;
  fileId: string;
  filePath: string;
  language: string;
}

export interface ResolvedCallEdge {
  fromSymbolId: string;
  toSymbolId: string;
  confidence: number;
  resolutionReason: string;
  resolverId: string;
  resolutionPhase: 'pass1' | 'pass2';
}

export interface Pass2Resolver {
  readonly id: string;
  supports(target: Pass2Target): boolean;
  resolve(target: Pass2Target, context: Pass2ResolverContext): Promise<ResolvedCallEdge[]>;
}
```

**Step 4: Add the registry**

Create `src/indexer/pass2/registry.ts` with:
- `createPass2ResolverRegistry(resolvers)`
- `getResolver(target)`
- `supports(target)`
- `listResolvers()`

Keep the registry dumb. First matching resolver wins. Do not add priority logic yet.

**Step 5: Add shared resolver context**

Create `src/indexer/pass2/context.ts` with a `Pass2ResolverContext` that exposes:
- graph query helpers from `src/db/kuzu-queries.ts`
- logger access
- repo root/config
- symbol/import lookup helpers

Keep this interface narrow. Do not pass the whole indexer object through.

**Step 6: Rewire the indexer**

Modify `src/indexer/indexer.ts` so:
- pass2 candidate selection uses `registry.supports(target)`
- pass2 execution asks the registry for a resolver per file
- telemetry records `resolverId`, file count, edge count, and elapsed time by resolver

**Step 7: Re-run the tests**

Run:

```bash
node --import tsx --test tests/unit/pass2-registry.test.ts
npm run typecheck
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/indexer/pass2/types.ts src/indexer/pass2/registry.ts src/indexer/pass2/context.ts src/indexer/indexer.ts src/indexer/edge-builder/telemetry.ts tests/unit/pass2-registry.test.ts
git commit -m "refactor: generalize pass2 behind resolver registry"
```

## Task 2: Port the existing TS pass2 into the resolver framework

**Files:**
- Create: `src/indexer/pass2/resolvers/ts-pass2-resolver.ts`
- Modify: `src/indexer/edge-builder/pass2.ts`
- Modify: `src/indexer/indexer.ts`
- Test: `tests/unit/ts-pass2-resolver.test.ts`
- Test: `tests/unit/native-parser-chaos.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- the TS resolver returns the same edges as the old `resolveTsCallEdgesPass2`
- TS files still use the compiler-backed resolver path
- parser-chaos fallbacks still work when native helpers are absent

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/ts-pass2-resolver.test.ts tests/unit/native-parser-chaos.test.ts
```

Expected: FAIL because the new resolver adapter does not exist.

**Step 3: Create the adapter**

Move the orchestration logic in `src/indexer/edge-builder/pass2.ts` behind `TsPass2Resolver`:
- keep `TsCallResolver` as the semantic engine
- keep existing dedupe logic
- return `ResolvedCallEdge[]` with:
  - `confidence = 0.98`
  - `resolutionReason = 'compiler-semantic'`
  - `resolverId = 'pass2-ts'`
  - `resolutionPhase = 'pass2'`

Do not change matching behavior in this task.

**Step 4: Make the old entrypoint a compatibility wrapper**

Keep `resolveTsCallEdgesPass2` temporarily, but implement it by constructing `TsPass2Resolver` and forwarding through the new registry/context path. This keeps the diff narrow while tests are being moved.

**Step 5: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/ts-pass2-resolver.test.ts tests/unit/native-parser-chaos.test.ts
npm run typecheck
npm run lint -- --quiet
```

Expected: PASS with no change in TS pass2 behavior.

**Step 6: Commit**

```bash
git add src/indexer/pass2/resolvers/ts-pass2-resolver.ts src/indexer/edge-builder/pass2.ts src/indexer/indexer.ts tests/unit/ts-pass2-resolver.test.ts tests/unit/native-parser-chaos.test.ts
git commit -m "refactor: move ts pass2 into resolver adapter"
```

## Task 3: Persist confidence and resolution metadata on `CALLS` edges

**Files:**
- Modify: `src/db/kuzu-schema.ts`
- Modify: `src/db/kuzu-queries.ts`
- Modify: `src/indexer/parser/process-file.ts`
- Modify: `src/indexer/parser/rust-process-file.ts`
- Modify: `src/indexer/edge-builder/pass2.ts`
- Modify: `src/indexer/edge-builder/pending.ts`
- Test: `tests/unit/kuzu-call-edge-metadata.test.ts`
- Test: `tests/integration/index-call-confidence.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- `insertEdges` writes `confidence`, `resolutionReason`, `resolverId`, and `resolutionPhase`
- pass1-generated calls get metadata
- pass2-generated calls get metadata
- graph reads return the metadata unchanged

Suggested assertion:

```ts
expect(edge).toMatchObject({
  type: 'CALLS',
  confidence: 0.98,
  resolutionReason: 'compiler-semantic',
  resolverId: 'pass2-ts',
  resolutionPhase: 'pass2',
});
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
node --import tsx --test tests/unit/kuzu-call-edge-metadata.test.ts tests/integration/index-call-confidence.test.ts
```

Expected: FAIL because the schema and edge row types do not include the new fields.

**Step 3: Update the DB schema**

Modify `src/db/kuzu-schema.ts`:
- add the four properties to the `CALLS` relationship definition
- if Kuzu cannot alter the relationship in place, bump schema version and make the init path require reindex

Modify `src/db/kuzu-queries.ts`:
- extend the `EdgeRow` or `CallEdgeRow` type
- update prepared statements for `CALLS`
- add read-side query projection for the new fields

**Step 4: Update pass1 edge creation**

Modify `src/indexer/parser/process-file.ts` and `src/indexer/parser/rust-process-file.ts` so generic pass1 calls always emit metadata:
- exact same-file match: `0.9`, `same-file`, `pass1-generic`, `pass1`
- import-backed match: `0.75`, `import-alias`, `pass1-generic`, `pass1`
- weak fallback: `0.45`, `global-fallback`, `pass1-generic`, `pass1`

Do not add new heuristics yet. Only label existing ones.

**Step 5: Update pass2 edge creation**

Make all pass2 resolvers populate the same metadata fields. This includes the TS compatibility wrapper so the data model is consistent before Go is added.

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/kuzu-call-edge-metadata.test.ts tests/integration/index-call-confidence.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/db/kuzu-schema.ts src/db/kuzu-queries.ts src/indexer/parser/process-file.ts src/indexer/parser/rust-process-file.ts src/indexer/edge-builder/pass2.ts src/indexer/edge-builder/pending.ts tests/unit/kuzu-call-edge-metadata.test.ts tests/integration/index-call-confidence.test.ts
git commit -m "feat: persist confidence metadata on call edges"
```

## Task 4: Build shared import-resolution adapters for Go, Java/Kotlin, Rust, and PHP

**Files:**
- Create: `src/indexer/import-resolution/types.ts`
- Create: `src/indexer/import-resolution/go-adapter.ts`
- Create: `src/indexer/import-resolution/java-kotlin-adapter.ts`
- Create: `src/indexer/import-resolution/rust-adapter.ts`
- Create: `src/indexer/import-resolution/php-adapter.ts`
- Modify: `src/indexer/parser/process-file.ts`
- Modify: `src/indexer/pass2/context.ts`
- Test: `tests/unit/import-resolution/go-adapter.test.ts`
- Test: `tests/unit/import-resolution/java-kotlin-adapter.test.ts`
- Test: `tests/unit/import-resolution/rust-adapter.test.ts`
- Test: `tests/unit/import-resolution/php-adapter.test.ts`

**Step 1: Write the failing tests**

Add small fixture-backed tests that prove:
- Go adapter resolves `module/pkg` imports using `go.mod`
- Java/Kotlin adapter resolves package imports and wildcard imports
- Rust adapter normalizes `crate::`, `self::`, `super::`, and aliasing through `use`
- PHP adapter resolves namespaces using `composer.json` PSR-4 rules

**Step 2: Run the tests**

Run:

```bash
node --import tsx --test tests/unit/import-resolution/*.test.ts
```

Expected: FAIL because the adapters do not exist.

**Step 3: Define the shared contract**

Create `src/indexer/import-resolution/types.ts`:

```ts
export interface ImportResolutionAdapter {
  readonly id: string;
  supports(language: string): boolean;
  resolveImport(specifier: string, context: ImportResolutionContext): ResolvedImportCandidate[];
}
```

Return structured candidates with:
- `symbolId?`
- `fileId?`
- `packageName`
- `confidence`
- `reason`

**Step 4: Implement the adapters**

Implement only deterministic resolution in this task:
- Go: `go.mod`, package names, import aliases
- Java/Kotlin: package declarations, explicit imports, wildcard imports
- Rust: module hierarchy and `use` alias expansion
- PHP: namespace declarations and PSR-4 autoload roots

Do not resolve reflection, dynamic imports, macros, or runtime-generated symbols.

**Step 5: Wire adapters into shared context**

Update `src/indexer/pass2/context.ts` so pass2 resolvers can ask for normalized import candidates by language. Update `src/indexer/parser/process-file.ts` to consume the same adapter outputs where that reduces duplicated import logic.

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/import-resolution/*.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/indexer/import-resolution/types.ts src/indexer/import-resolution/go-adapter.ts src/indexer/import-resolution/java-kotlin-adapter.ts src/indexer/import-resolution/rust-adapter.ts src/indexer/import-resolution/php-adapter.ts src/indexer/parser/process-file.ts src/indexer/pass2/context.ts tests/unit/import-resolution/*.test.ts
git commit -m "feat: add shared import-resolution adapters"
```

## Task 5: Implement the Go pass2 resolver

**Files:**
- Create: `src/indexer/pass2/resolvers/go-pass2-resolver.ts`
- Modify: `src/indexer/pass2/registry.ts`
- Modify: `src/indexer/pass2/context.ts`
- Modify: `src/indexer/indexer.ts`
- Test: `tests/unit/go-pass2-resolver.test.ts`
- Test: `tests/integration/go-pass2-indexing.test.ts`
- Test: `tests/fixtures/go/pass2/*`

**Step 1: Write the failing tests**

Add tests that prove the Go resolver handles:
- same-package function calls
- imported package selector calls such as `service.Handle()`
- receiver method calls when the receiver type is statically known
- alias imports such as `svc "repo/service"`
- re-exports only when the adapter can prove the path

Suggested integration assertion:

```ts
expect(calls).toContainEqual(
  expect.objectContaining({
    resolutionReason: 'module-qualified',
    resolverId: 'pass2-go',
    confidence: 0.9,
  }),
);
```

**Step 2: Run the tests**

Run:

```bash
node --import tsx --test tests/unit/go-pass2-resolver.test.ts tests/integration/go-pass2-indexing.test.ts
```

Expected: FAIL because the Go resolver does not exist.

**Step 3: Implement the resolver**

Create `GoPass2Resolver` with this algorithm:
- load import candidates from the Go adapter
- build a package-local symbol map from the resolver context
- resolve in priority order:
  1. same-package direct function
  2. imported package selector
  3. same-package receiver method
  4. imported package receiver method when the type is known
- emit no edge if multiple equally strong candidates remain

Confidence mapping:
- same-package exact: `0.92`
- imported package selector exact: `0.9`
- receiver type exact: `0.85`
- alias import exact: `0.82`

Do not add fuzzy name matching in this task.

**Step 4: Register the resolver**

Update `src/indexer/pass2/registry.ts` so Go files are routed to `GoPass2Resolver`. Update telemetry in `src/indexer/indexer.ts` to show `pass2-go` separately from `pass2-ts`.

**Step 5: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/go-pass2-resolver.test.ts tests/integration/go-pass2-indexing.test.ts
npm run typecheck
npm run lint -- --quiet
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/indexer/pass2/resolvers/go-pass2-resolver.ts src/indexer/pass2/registry.ts src/indexer/pass2/context.ts src/indexer/indexer.ts tests/unit/go-pass2-resolver.test.ts tests/integration/go-pass2-indexing.test.ts tests/fixtures/go/pass2
git commit -m "feat: add go pass2 resolver"
```

## Task 6: Expose confidence-aware filtering through MCP slice and query APIs

**Files:**
- Modify: `src/mcp/types.ts`
- Modify: `src/mcp/tools/slice.ts`
- Modify: `src/mcp/tools/symbol.ts`
- Modify: `src/policy/types.ts`
- Modify: `src/policy/defaults.ts`
- Modify: `src/db/kuzu-queries.ts`
- Test: `tests/unit/mcp-slice-confidence-filter.test.ts`
- Test: `tests/unit/mcp-symbol-card-confidence.test.ts`
- Test: `tests/integration/mcp-confidence-filtering.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- slice requests can specify `minCallConfidence`
- symbol-card or graph query responses can include call metadata when requested
- the default API behavior remains unchanged when no threshold is provided

Suggested API shape:

```ts
type SliceBuildInput = {
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
};
```

**Step 2: Run the tests**

Run:

```bash
node --import tsx --test tests/unit/mcp-slice-confidence-filter.test.ts tests/unit/mcp-symbol-card-confidence.test.ts tests/integration/mcp-confidence-filtering.test.ts
```

Expected: FAIL because the MCP request/response types do not include the new fields.

**Step 3: Extend the query layer**

Modify `src/db/kuzu-queries.ts` so graph queries can:
- filter `CALLS` edges by `minCallConfidence`
- optionally project `confidence`, `resolutionReason`, `resolverId`, and `resolutionPhase`

Do not make confidence filtering mandatory. Default to current behavior when the field is absent.

**Step 4: Extend MCP request/response types**

Modify `src/mcp/types.ts` and tool handlers so:
- `slice.build` accepts `minCallConfidence?`
- symbol-card or slice responses can include resolution metadata under a stable field name such as `callResolution`
- policy defaults can define a server-side default threshold later without breaking clients now

**Step 5: Update policy defaults**

Add a policy/config placeholder in `src/policy/types.ts` and `src/policy/defaults.ts`:
- `defaultMinCallConfidence?: number`

Set the default to `undefined` for this release. That keeps behavior stable while enabling future tuning.

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/mcp-slice-confidence-filter.test.ts tests/unit/mcp-symbol-card-confidence.test.ts tests/integration/mcp-confidence-filtering.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/mcp/types.ts src/mcp/tools/slice.ts src/mcp/tools/symbol.ts src/policy/types.ts src/policy/defaults.ts src/db/kuzu-queries.ts tests/unit/mcp-slice-confidence-filter.test.ts tests/unit/mcp-symbol-card-confidence.test.ts tests/integration/mcp-confidence-filtering.test.ts
git commit -m "feat: expose confidence-aware graph filtering"
```

## Task 7: Add telemetry, rollout guards, and release docs

**Files:**
- Modify: `src/indexer/edge-builder/telemetry.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `README.md`
- Modify: `docs/configuration-reference.md`
- Modify: `CHANGELOG.md`
- Test: `tests/unit/doctor-confidence-capabilities.test.ts`

**Step 1: Write the failing test**

Add a doctor test that proves the CLI reports:
- registered pass2 resolvers
- whether confidence metadata is present in the schema
- whether confidence filtering is enabled by request only or policy default

**Step 2: Run the test**

Run:

```bash
node --import tsx --test tests/unit/doctor-confidence-capabilities.test.ts
```

Expected: FAIL because doctor does not report the new capabilities.

**Step 3: Add telemetry**

Extend telemetry output to include:
- pass2 resolver ID
- files processed per resolver
- edges emitted per resolver
- confidence buckets (`>=0.9`, `0.6-0.89`, `<0.6`)
- unresolved-call count

**Step 4: Update doctor and docs**

Update `src/cli/commands/doctor.ts`, `README.md`, `docs/configuration-reference.md`, and `CHANGELOG.md` so operators can see:
- which languages have pass2 support
- what confidence metadata means
- how to filter low-confidence edges in MCP queries
- whether a reindex is required after schema changes

**Step 5: Run final validation**

Run:

```bash
node --import tsx --test tests/unit/doctor-confidence-capabilities.test.ts
npm run typecheck
npm run lint -- --quiet
npm test
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/indexer/edge-builder/telemetry.ts src/cli/commands/doctor.ts README.md docs/configuration-reference.md CHANGELOG.md tests/unit/doctor-confidence-capabilities.test.ts
git commit -m "docs: surface pass2 confidence capabilities"
```

## Order of Execution

Implement tasks strictly in this order:
1. registry and contracts
2. TS adapter migration
3. call-edge metadata
4. import adapters
5. Go pass2
6. MCP confidence filtering
7. telemetry and docs

This order keeps the data model stable before adding the first new language resolver and keeps the MCP surface until the persistence layer is ready.

## Risks and Mitigations

- **Risk: relationship schema migration is awkward in Kuzu**
  - Mitigation: version the graph schema and require reindex rather than partial schema mutation.
- **Risk: Go receiver-method resolution becomes ambiguous**
  - Mitigation: emit no edge when two candidates tie; never guess at high confidence.
- **Risk: pass2 runtime grows too much**
  - Mitigation: add per-resolver telemetry and batch DB writes once per file, reusing the existing transaction fixes.
- **Risk: clients over-trust low-confidence edges**
  - Mitigation: keep confidence filtering opt-in at first and surface metadata in MCP responses.
- **Risk: adapter logic duplicates pass1 import heuristics**
  - Mitigation: move shared import normalization into the adapter layer and consume it from both pass1 and pass2.

## Acceptance Criteria

- `indexRepo` no longer hard-codes pass2 eligibility to TS/JS file extensions.
- TS pass2 behavior remains unchanged except for attached metadata.
- `CALLS` edges persist confidence and provenance metadata end-to-end.
- Go files gain pass2 call resolution with deterministic import-backed behavior.
- Java/Kotlin, Rust, and PHP import semantics are normalized behind shared adapters.
- MCP slice and symbol queries can filter low-confidence call edges on demand.
- CLI telemetry and doctor output report resolver coverage and confidence capability.

## Recommended First Execution Slice

If time is tight, implement through Task 3 first. That delivers the architectural seam and the metadata model before any new language-specific behavior. After that, Go pass2 can land independently without reworking the DB or MCP surfaces again.
