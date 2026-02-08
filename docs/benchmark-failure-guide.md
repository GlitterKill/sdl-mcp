# Benchmark CI Failures: Interpretation and Remediation

This guide helps developers understand benchmark CI failures and take appropriate action.

## Quick Reference: What to Do When CI Fails

1. **Check the failure type** (see Failure Types below)
2. **Review the detailed results** in `.benchmark/latest-result.json`
3. **Determine if the failure is expected** (legitimate change) or unexpected (regression)
4. **Follow the remediation steps** for your failure type

## Finding Failure Details

### In GitHub Actions CI

Check the "Run Benchmark CI Guardrails" step logs:

```yaml
=== Benchmark Metrics ===
Indexing:
  Time per file:      250ms  # Current value
  Time per symbol:    6ms
...

=== Threshold Evaluation ===
Status: ❌ FAILED
Total: 10
Passed: 8
Failed: 2

Failed thresholds:
  - indexing.indexTimePerFile: Increased by 12.5% (threshold: 10%)
  - tokenEfficiency.avgCardTokens: Increased by 15.2% (threshold: 10%)

=== Regression Summary ===
Status: ❌ FAILED
Improved: 0
Degraded: 2
Neutral: 8

Recommendations:
  - Indexing time regression detected
  - Consider: indexing concurrency, large file handling, or file filtering
```

### Locally

Run the same benchmark locally for faster iteration:

```bash
# Run benchmark (skip indexing for speed)
npm run build
node dist/cli/index.js benchmark:ci --skip-indexing --json > local-results.json

# View results
cat local-results.json | jq '.thresholdResult'
cat local-results.json | jq '.regressionReport'
```

## Failure Types and Remediation

### Type 1: Performance Regression (Time Degradation)

**Symptoms:**

- `indexTimePerFile` or `indexTimePerSymbol` increased beyond threshold
- `sliceBuildTimeMs` or `avgSkeletonTimeMs` increased
- Message: "Increased by X% (threshold: Y%)"

**Common Causes:**

1. Added inefficient algorithms or data structures
2. Reduced concurrency or parallelism
3. Added unnecessary computation in hot paths
4. Introduced blocking operations
5. Increased memory usage causing GC pressure

**Investigation Steps:**

1. **Profile the changed code:**

   ```bash
   # If you added new indexing logic, measure its impact
   node --prof dist/cli/index.js index
   node --prof-process isolate-0x*.log > profile.txt
   ```

2. **Check for blocking operations:**
   - Look for `await` in loops
   - Check for synchronous file I/O
   - Verify database query patterns

3. **Review data structure changes:**
   - Did you replace O(1) operations with O(n)?
   - Are you doing unnecessary deep copies?
   - Are you iterating over large arrays repeatedly?

**Remediation:**

```typescript
// BAD: Blocking synchronous processing
for (const file of files) {
  processFileSync(file); // Blocks on I/O
}

// GOOD: Parallel async processing
await Promise.all(files.map((file) => processFileAsync(file)));
```

**Acceptable Performance Trade-offs:**

If the degradation is intentional and justified:

1. **Document the trade-off:**

   ```markdown
   ## Performance Impact

   The added validation increases indexTimePerFile by 15%.
   Trade-off: Improved correctness > slightly slower indexing.

   Mitigation:

   - Validation only runs on changed files
   - Can be disabled via config flag
   - Will optimize in follow-up issue #123
   ```

2. **Update thresholds** (after team approval):
   - Modify `config/benchmark.config.json`
   - Get tech lead approval
   - Update baseline together with threshold change

### Type 2: Quality Degradation

**Symptoms:**

- `symbolsPerFile`, `edgesPerSymbol`, or `graphConnectivity` decreased
- `exportedSymbolRatio` decreased
- Message: "Decreased by X% (threshold: Y%)"

**Common Causes:**

1. Parser bugs or regressions
2. Incorrect language adapter changes
3. Overly aggressive filtering
4. Symbol resolution logic changes

**Investigation Steps:**

1. **Check specific file examples:**

   ```bash
   # Compare symbol extraction before/after
   git diff HEAD~1 src/indexer/adapters/typescript.ts

   # Test specific file
   node dist/cli/index.js index --file src/complex/file.ts
   node dist/cli/index.js query --file src/complex/file.ts
   ```

2. **Review adapter changes:**
   - Did you change parsing logic?
   - Are you filtering too aggressively?
   - Are edge detection rules correct?

3. **Verify with real code:**
   ```typescript
   // Manually verify symbol extraction
   const symbols = await extractSymbols("test-file.ts");
   console.log(`Found ${symbols.length} symbols (expected: N)`);
   symbols.forEach((s) => {
     console.log(`${s.name}: ${s.kind}, exported: ${s.exported}`);
   });
   ```

**Remediation:**

```typescript
// BAD: Overly aggressive filtering
const symbols = allSymbols.filter(
  (s) =>
    s.name.length > 3 && // Too arbitrary
    !s.name.startsWith("_") && // May exclude valid symbols
    s.kind !== "unknown", // Might exclude new symbol types
);

// GOOD: Clear, justified filtering
const symbols = allSymbols.filter(
  (s) =>
    s.kind in VALID_SYMBOL_TYPES && // Based on adapter spec
    !isTestSymbol(s) && // Well-defined test detection
    hasValidSignature(s), // Based on parsing rules
);
```

**Acceptable Quality Trade-offs:**

If quality decrease is intentional (e.g., filtering noise):

1. **Justify the change:**

   ```markdown
   ## Quality Impact

   Reduced avgCardTokens by 10% by filtering auto-generated symbols.
   Trade-off: Less noise > slightly fewer symbols.

   Impact:

   - Auto-generated symbols now excluded (improves signal/noise)
   - Exported symbols unaffected
   - Can be toggled via includeGenerated config option
   ```

2. **Update thresholds and baseline** (approved by team)

### Type 3: Token Efficiency Regression

**Symptoms:**

- `avgCardTokens` or `avgSkeletonTokens` increased
- Cards/skeletons are larger than expected

**Common Causes:**

1. Added verbose fields to cards/skeletons
2. Included unnecessary context
3. Duplicate information
4. Poor compression/caching

**Investigation Steps:**

1. **Sample actual output:**

   ```typescript
   const card = buildCardFromSymbol(symbol);
   const tokens = estimateTokens(JSON.stringify(card));
   console.log(`Card tokens: ${tokens}`);
   console.log(`Card:`, JSON.stringify(card, null, 2));
   ```

2. **Check field usage:**
   - Are all fields actually used?
   - Are any fields duplicated?
   - Can you reference instead of embed?

3. **Review skeleton generation:**

   ```typescript
   // BAD: Including entire function body
   skeleton: `
     ${docstring}
     ${functionBody} // Can be huge
   `;

   // GOOD: Concise signature and context
   skeleton: `
     ${docstring}
     ${signature}
     // Body: ${bodySummary} // Summary only
   `;
   ```

**Remediation:**

```typescript
// Before: Verbose card with duplication
const card = {
  name: symbol.name,
  fullName: symbol.qualifiedName, // Duplicate of name + namespace
  signature: symbol.signature,
  signatureText: stringifySignature(symbol.signature), // Duplicate
  fullDocumentation: symbol.docs,
  summary: summarizeDocs(symbol.docs), // Duplicate
  // ... many more fields
};

// After: Concise, non-duplicative card
const card = {
  symbolId: symbol.id,
  name: symbol.name,
  signature: symbol.signature,
  docs: {
    summary: summarizeDocs(symbol.docs),
    full: symbol.docs,
  },
};
```

### Type 4: Coverage Regression

**Symptoms:**

- `callEdgeCoverage` or `importEdgeCoverage` decreased
- Fewer edges detected than baseline

**Common Causes:**

1. Edge detection logic bugs
2. Scope handling changes
3. Import/call resolution errors
4. Symbol matching failures

**Investigation Steps:**

1. **Check edge counts by type:**

   ```bash
   # Before your change
   node dist/cli/index.js query --edges > edges-before.json

   # After your change
   node dist/cli/index.js query --edges > edges-after.json

   # Compare
   diff edges-before.json edges-after.json
   ```

2. **Test specific patterns:**

   ```typescript
   // Verify specific edge cases
   const testCases = [
     "direct import",
     "namespace import",
     "dynamic import",
     "call via reference",
     "call via property",
   ];

   for (const testCase of testCases) {
     const edges = await detectEdges(testCase);
     console.log(`${testCase}: ${edges.length} edges`);
   }
   ```

**Remediation:**

```typescript
// BAD: Missing edge cases
if (importPath.startsWith("./") || importPath.startsWith("../")) {
  // Only relative imports
}

// GOOD: Comprehensive edge detection
if (
  isRelativeImport(importPath) ||
  isNodeModuleImport(importPath) ||
  isWorkspaceImport(importPath) ||
  isAliasImport(importPath, aliases)
) {
  // All import types
}
```

### Type 5: Flaky Failures (Inconsistent Results)

**Symptoms:**

- CI passes sometimes, fails other times
- Large variance across runs
- No clear pattern

**Common Causes:**

1. CI resource contention
2. Inadequate statistical smoothing
3. Timing-dependent code
4. Non-deterministic operations

**Investigation Steps:**

1. **Check variance:**

   ```bash
   # Run multiple times locally
   for i in {1..5}; do
     node dist/cli/index.js benchmark:ci --skip-indexing --json > run-$i.json
   done

   # Extract key metrics
   for i in {1..5}; do
     cat run-$i.json | jq '.metrics.indexTimePerFile'
   done
   ```

2. **Review smoothing config:**
   ```json
   {
     "smoothing": {
       "warmupRuns": 2, // Try increasing to 3-5
       "sampleRuns": 3, // Try increasing to 5-7
       "outlierMethod": "iqr" // Consider "stddev" for noisy data
     }
   }
   ```

**Remediation:**

1. **Increase smoothing** (temporary fix):

   ```bash
   # Edit config/benchmark.config.json
   {
     "smoothing": {
       "warmupRuns": 5,
       "sampleRuns": 7,
       "iqrMultiplier": 2.0
     }
   }
   ```

2. **Fix underlying issue** (long-term fix):

   ```typescript
   // BAD: Timing-dependent logic
   const startTime = Date.now();
   await operation();
   const elapsed = Date.now() - startTime; // Varies wildly

   // GOOD: Deterministic measurement
   const metrics = await measureOperation(() => operation(), {
     iterations: 10,
     warmup: 2,
   });
   ```

## Decision Tree: Pass or Fail?

```
CI Failed?
├─ Are all failures in ONE category (e.g., only indexing time)?
│  ├─ YES: Is the degradation small (<5%) and understood?
│  │  ├─ YES: Consider updating threshold (get approval)
│  │  └─ NO: Fix the regression
│  └─ NO: Multiple categories failing?
│     └─ Fix the regressions (don't update thresholds)
├─ Is the degradation due to intentional improvements elsewhere?
│  ├─ YES: Document trade-off, update thresholds (get approval)
│  └─ NO: Fix the regression
└─ Is the failure flaky (inconsistent)?
   └─ Investigate flakiness, increase smoothing, fix underlying issue
```

## Getting Help

### Stuck on Investigation?

1. **Check recent changes:**

   ```bash
   # Find all changed files in your PR
   git diff main --name-only

   # Focus on likely culprits
   git diff main src/indexer/
   git diff main src/graph/
   ```

2. **Review similar issues:**

   ```bash
   # Search GitHub issues
   gh issue list --label "performance" --state closed

   # Check commit history for similar fixes
   git log --grep="performance" --oneline
   ```

3. **Ask for help:**
   - Tag a maintainer in your PR
   - Comment with specific metrics and context
   - Include: baseline value, current value, threshold, suspected cause

### Example Request for Help:

```markdown
@tech-lead Need help with benchmark regression

**Context:**
Working on improved error handling in slice building.

**Failure:**
```

sliceBuildTimeMs: Increased by 25% (threshold: 15%)
Baseline: 430ms
Current: 537ms

```

**Changes:**
- Added try/catch around slice operations
- Added error logging on failures
- See: src/graph/slice.ts:245-260

**Investigation:**
- Profiled the code - overhead from error logging
- Tried disabling logging - drops to 460ms (still above threshold)
- Suspected: additional try/catch blocks adding overhead

**Question:**
Is this overhead acceptable for improved error handling?
Should we adjust the threshold or optimize further?
```

## Preventing Future Regressions

### Best Practices

1. **Profile before optimizing**

   ```bash
   # Measure first
   node dist/cli/index.js benchmark:ci --json > before.json

   # Make changes
   # ... code changes ...

   # Measure again
   node dist/cli/index.js benchmark:ci --json > after.json

   # Compare
   node -e "console.log(require('./before.json'), require('./after.json'))"
   ```

2. **Add performance tests**

   ```typescript
   // tests/performance/slice-build.test.ts
   describe('Slice Building Performance', () => {
     it('should complete within threshold', async () => {
       const start = performance.now();
       await buildSlice({...});
       const elapsed = performance.now() - start;

       expect(elapsed).toBeLessThan(500); // Threshold
     });
   });
   ```

3. **Use efficient algorithms**
   - Prefer O(1) over O(n) lookups (Maps/Sets)
   - Batch database operations
   - Use streaming for large datasets
   - Cache expensive computations

4. **Monitor trends**
   - Watch for gradual degradation over time
   - Set up alerts for threshold breaches
   - Review metrics weekly during active development

## References

- [Benchmark Guardrails Documentation](./benchmark-guardrails.md)
- [Baseline Management Policy](./benchmark-baseline-management.md)
- [Threshold Configuration Reference](../config/benchmark.config.json)
- [CI Workflow](../.github/workflows/ci.yml)
